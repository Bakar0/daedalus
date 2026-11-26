import type { AgentSessionDto, TeamDto } from "@daedalus/protocol";

/** The team a session leads or belongs to, and its handle there. */
export type SessionTeam =
  | { team: TeamDto; role: "lead"; handle: "lead" }
  | { team: TeamDto; role: "member"; handle: string };

export function teamLookup(
  teams: readonly TeamDto[],
): (session: AgentSessionDto) => SessionTeam | undefined {
  const byLead = new Map(teams.map((team) => [team.leadId, team]));
  const byId = new Map(teams.map((team) => [team.id, team]));
  return (session) => {
    const led = byLead.get(session.id);
    if (led) return { team: led, role: "lead", handle: "lead" };
    const joined = session.teamId ? byId.get(session.teamId) : undefined;
    return joined && session.teamHandle
      ? { team: joined, role: "member", handle: session.teamHandle }
      : undefined;
  };
}

const NO_WORKERS: ReadonlySet<string> = new Set();

/** The agent a plan's worker was started by; none for any other session. */
const workerLead = (
  session: AgentSessionDto,
  workers: ReadonlySet<string>,
): string | undefined =>
  !session.teamId && workers.has(session.id)
    ? (session.spawnedBy ?? undefined)
    : undefined;

/** A session as the sidebar lists it, and how many leads it sits under. */
export interface SessionRow {
  session: AgentSessionDto;
  depth: number;
}

/**
 * The order a workspace's sessions are listed in, given them in their
 * manual order. Pinned sessions sit above the rest, in the order they were
 * pinned; the manual order holds within each group. Teams nest: a member
 * sits right under its lead when the lead is in the list, and a member that
 * leads a team of its own has its members under it in turn, one level
 * deeper. Each session is listed once. Display only: the stored order is
 * what reordering changes.
 */
export function sessionDisplayRows(
  manual: readonly AgentSessionDto[],
  teams: readonly TeamDto[],
  /**
   * The sessions started for one task of a plan. Each sits under the agent
   * that started it, as a member sits under its lead.
   */
  workers: ReadonlySet<string> = NO_WORKERS,
): SessionRow[] {
  const listed = new Set(manual.map((session) => session.id));
  const teamsByLead = new Map(teams.map((team) => [team.leadId, team]));
  const leadOfTeam = new Map(teams.map((team) => [team.id, team.leadId]));
  const ordered = [...manual].sort((left, right) =>
    left.pinnedAt && right.pinnedAt
      ? left.pinnedAt.localeCompare(right.pinnedAt)
      : Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt)),
  );
  // Under its lead when the lead is listed, whether or not it leads too.
  const underLead = (session: AgentSessionDto) => {
    const lead = session.teamId
      ? leadOfTeam.get(session.teamId)
      : workerLead(session, workers);
    return lead !== undefined && lead !== session.id && listed.has(lead);
  };
  const rows: SessionRow[] = [];
  const seen = new Set<string>();
  const visit = (session: AgentSessionDto, depth: number) => {
    if (seen.has(session.id)) return;
    seen.add(session.id);
    rows.push({ session, depth });
    const led = teamsByLead.get(session.id);
    if (led)
      for (const member of ordered)
        if (member.teamId === led.id) visit(member, depth + 1);
    for (const worker of ordered)
      if (workerLead(worker, workers) === session.id) visit(worker, depth + 1);
  };
  for (const session of ordered) if (!underLead(session)) visit(session, 0);
  // A loop of leads has no top; list what it left out rather than lose it.
  for (const session of ordered) visit(session, 0);
  return rows;
}

/** The sessions of `sessionDisplayRows`, in that order. */
export function sessionDisplayOrder(
  manual: readonly AgentSessionDto[],
  teams: readonly TeamDto[],
  workers: ReadonlySet<string> = NO_WORKERS,
): AgentSessionDto[] {
  return sessionDisplayRows(manual, teams, workers).map((row) => row.session);
}

/** What a folded member's dot says: it works, it waits for the user, or neither. */
export type MemberMark = "working" | "waits" | "quiet";

export interface FoldedSessionRow extends SessionRow {
  /**
   * On a lead: its members that lead no team of their own, every one of
   * them, whether or not it has a row. Empty on everything else.
   */
  members: { session: AgentSessionDto; mark: MemberMark }[];
}

/**
 * The rows of `sessionDisplayRows` with each team's members folded into
 * their lead. A lead keeps its row, also a lead that is another team's
 * member. A member keeps its row only while its lead's list is open, while
 * it waits for the user, or while it is the session on screen.
 */
export function foldMemberRows(
  rows: readonly SessionRow[],
  teams: readonly TeamDto[],
  options: {
    markOf: (session: AgentSessionDto) => MemberMark;
    /** The leads whose member lists are open. */
    open: ReadonlySet<string>;
    /** The session on screen, never hidden. */
    shown?: string | undefined;
    /** A plan's workers: folded into the agent that started them. */
    workers?: ReadonlySet<string> | undefined;
  },
): FoldedSessionRow[] {
  const leads = new Set(teams.map((team) => team.leadId));
  const leadOfTeam = new Map(teams.map((team) => [team.id, team.leadId]));
  const listed = new Set(rows.map((row) => row.session.id));
  const leadOf = (session: AgentSessionDto) => {
    const lead = session.teamId
      ? leadOfTeam.get(session.teamId)
      : workerLead(session, options.workers ?? NO_WORKERS);
    return lead !== undefined &&
      lead !== session.id &&
      listed.has(lead) &&
      !leads.has(session.id)
      ? lead
      : undefined;
  };
  const membersOf = new Map<string, FoldedSessionRow["members"]>();
  for (const { session } of rows) {
    const lead = leadOf(session);
    if (lead === undefined) continue;
    const members = membersOf.get(lead) ?? [];
    members.push({ session, mark: options.markOf(session) });
    membersOf.set(lead, members);
  }
  return rows.flatMap((row) => {
    const lead = leadOf(row.session);
    if (
      lead !== undefined &&
      !options.open.has(lead) &&
      row.session.id !== options.shown &&
      options.markOf(row.session) !== "waits"
    )
      return [];
    return [{ ...row, members: membersOf.get(row.session.id) ?? [] }];
  });
}

/**
 * `1 needs you · 2 working · 5 members`, leaving out the zeros. What matters
 * most comes first, since a narrow sidebar cuts the end.
 */
export function membersSummary(
  members: readonly { mark: MemberMark }[],
  /** What one of them is called: a team's `member`, a plan's `worker`. */
  noun: "member" | "worker" = "member",
): string {
  const working = members.filter((one) => one.mark === "working").length;
  const waits = members.filter((one) => one.mark === "waits").length;
  return [
    waits ? `${waits} ${waits === 1 ? "needs" : "need"} you` : "",
    working ? `${working} working` : "",
    `${members.length} ${noun}${members.length === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

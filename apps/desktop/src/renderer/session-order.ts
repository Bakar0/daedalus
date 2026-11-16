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
    const lead = session.teamId ? leadOfTeam.get(session.teamId) : undefined;
    return lead !== undefined && lead !== session.id && listed.has(lead);
  };
  const rows: SessionRow[] = [];
  const seen = new Set<string>();
  const visit = (session: AgentSessionDto, depth: number) => {
    if (seen.has(session.id)) return;
    seen.add(session.id);
    rows.push({ session, depth });
    const led = teamsByLead.get(session.id);
    if (!led) return;
    for (const member of ordered)
      if (member.teamId === led.id) visit(member, depth + 1);
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
): AgentSessionDto[] {
  return sessionDisplayRows(manual, teams).map((row) => row.session);
}

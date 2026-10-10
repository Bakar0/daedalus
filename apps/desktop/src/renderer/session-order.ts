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

/**
 * The order a workspace's sessions are listed in, given them in their
 * manual order. Pinned sessions sit above the rest, in the order they were
 * pinned; the manual order holds within each group. Members sit right under
 * their lead when it is in the list. Display only: the stored order is what
 * reordering changes.
 */
export function sessionDisplayOrder(
  manual: readonly AgentSessionDto[],
  teams: readonly TeamDto[],
): AgentSessionDto[] {
  const teamOf = teamLookup(teams);
  const teamsByLead = new Map(teams.map((team) => [team.leadId, team]));
  const ordered = [...manual].sort((left, right) =>
    left.pinnedAt && right.pinnedAt
      ? left.pinnedAt.localeCompare(right.pinnedAt)
      : Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt)),
  );
  return ordered.flatMap((session) => {
    const team = teamOf(session);
    if (
      team?.role === "member" &&
      ordered.some((item) => item.id === team.team.leadId)
    )
      return [];
    const lead = teamsByLead.get(session.id);
    return lead
      ? [session, ...ordered.filter((item) => item.teamId === lead.id)]
      : [session];
  });
}

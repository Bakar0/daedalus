import type { AgentSession } from "../domain";
import type { SqliteRepositories } from "../repositories";

/** How many levels a team tree goes below its top lead. */
export const TEAM_MAX_DEPTH = 3;
/** How many members one lead has at a time, archived ones not counted. */
export const TEAM_MAX_MEMBERS = 5;

/**
 * The leads above a session, nearest first: its own lead, that lead's lead,
 * and so on up to the top lead. Empty for a session in no team. A session is
 * a member of at most one team, so the chain is a line.
 */
export function teamAncestors(
  repositories: SqliteRepositories,
  sessionId: string,
): AgentSession[] {
  const leads: AgentSession[] = [];
  const seen = new Set<string>([sessionId]);
  let current = repositories.findAgent(sessionId);
  while (current?.teamId) {
    const team = repositories.abilities.find(current.teamId);
    if (!team?.enabled || seen.has(team.sessionId)) break;
    const lead = repositories.findAgent(team.sessionId);
    if (!lead) break;
    leads.push(lead);
    seen.add(lead.id);
    current = lead;
  }
  return leads;
}

/** The members a session leads now, deepest last; empty if it leads none. */
export function teamDescendants(
  repositories: SqliteRepositories,
  sessionId: string,
): AgentSession[] {
  const found: AgentSession[] = [];
  const seen = new Set<string>([sessionId]);
  const visit = (leadId: string) => {
    const team = repositories.abilities.findForSession(leadId, "orchestration");
    if (!team?.enabled) return;
    for (const member of repositories.listTeamMembers(team.id)) {
      if (seen.has(member.id)) continue;
      seen.add(member.id);
      found.push(member);
      visit(member.id);
    }
  };
  visit(sessionId);
  return found;
}

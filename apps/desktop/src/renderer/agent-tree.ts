import type { AgentSessionDto, TeamDto } from "@daedalus/protocol";

/** An agent and the agents it created, in the order they were given. */
export interface AgentNode {
  session: AgentSessionDto;
  children: AgentNode[];
}

export interface AgentTree {
  /** The agents nobody in the list created: the ones the user started. */
  roots: AgentNode[];
  /** Created agents the user pinned, in pin order. The left list shows them too. */
  pinned: AgentSessionDto[];
  /** The root an agent sits under; a root answers itself. */
  rootOf: (sessionId: string) => string | undefined;
  /** The node of an agent, wherever it sits. */
  nodeOf: (sessionId: string) => AgentNode | undefined;
}

/**
 * Who created each agent. A team member sits under its lead; any other
 * agent sits under the session that spawned it. A parent that is not in
 * the list (archived, another workspace) leaves the agent a root.
 */
export function agentTree(
  sessions: readonly AgentSessionDto[],
  teams: readonly TeamDto[],
): AgentTree {
  const listed = new Set(sessions.map((session) => session.id));
  const leadOfTeam = new Map(teams.map((team) => [team.id, team.leadId]));
  const parentId = (session: AgentSessionDto): string | undefined => {
    const lead = session.teamId ? leadOfTeam.get(session.teamId) : undefined;
    const parent =
      lead !== undefined && lead !== session.id
        ? lead
        : (session.spawnedBy ?? undefined);
    return parent !== undefined && parent !== session.id && listed.has(parent)
      ? parent
      : undefined;
  };
  const nodes = new Map<string, AgentNode>(
    sessions.map((session) => [session.id, { session, children: [] }]),
  );
  const parents = new Map<string, string>();
  for (const session of sessions) {
    const parent = parentId(session);
    if (parent !== undefined) parents.set(session.id, parent);
  }
  // A loop of parents has no top: cut it at the first agent that closes it.
  for (const session of sessions) {
    const walked = new Set<string>([session.id]);
    let at = parents.get(session.id);
    while (at !== undefined) {
      if (walked.has(at)) {
        parents.delete(session.id);
        break;
      }
      walked.add(at);
      at = parents.get(at);
    }
  }
  const roots: AgentNode[] = [];
  for (const session of sessions) {
    const node = nodes.get(session.id)!;
    const parent = parents.get(session.id);
    if (parent === undefined) roots.push(node);
    else nodes.get(parent)!.children.push(node);
  }
  const rootOf = (sessionId: string) => {
    if (!nodes.has(sessionId)) return undefined;
    let at = sessionId;
    for (;;) {
      const parent = parents.get(at);
      if (parent === undefined) return at;
      at = parent;
    }
  };
  const pinned = sessions
    .filter((session) => session.pinnedAt && parents.has(session.id))
    .sort((left, right) => left.pinnedAt!.localeCompare(right.pinnedAt!));
  return { roots, pinned, rootOf, nodeOf: (id) => nodes.get(id) };
}

/** A node and everything under it, parents before children. */
export function flattenAgents(
  node: AgentNode,
  depth = 0,
): { session: AgentSessionDto; depth: number }[] {
  return [
    { session: node.session, depth },
    ...node.children.flatMap((child) => flattenAgents(child, depth + 1)),
  ];
}

/**
 * Where a session is on the Factory page: the row it is in, the blocks to
 * open down to its box, and the names along the way.
 */
import type {
  FactoryBlockDto,
  FactoryLevelDto,
  FactoryPageDto,
} from "@daedalus/protocol";

export interface FactoryWhere {
  /** The row's key: `agent:<session id>` or `plan:<path>`. */
  row: string;
  /** The key of the block opened at each level, from the row down. */
  path: string[];
  /** The box the session is at; none for an agent outside a workflow step. */
  leaf: string | undefined;
  /** What a reader is told: the plan, the task, the step. */
  labels: string[];
}

export const agentRowKey = (sessionId: string) => `agent:${sessionId}`;
export const planRowKey = (path: string) => `plan:${path}`;

/** The step a workflow level is at. */
const stepAt = (level: FactoryLevelDto): FactoryBlockDto | undefined =>
  level.blocks.find(
    (block) =>
      block.kind === "step" &&
      (block.state === "doing" || block.state === "waiting"),
  );

/**
 * An agent drawn under the one that started it: the block that holds its
 * level, searched from a level down.
 */
function agentUnder(
  level: FactoryLevelDto,
  sessionId: string,
  chain: string[],
): Omit<FactoryWhere, "row"> | undefined {
  for (const block of level.blocks) {
    const inside = block.inside;
    if (!inside) continue;
    if (
      block.kind !== "task" &&
      (inside.kind === "workflow" || inside.kind === "agent") &&
      inside.owner?.sessionId === sessionId
    ) {
      const step = inside.kind === "workflow" ? stepAt(inside) : undefined;
      return {
        path: [...chain, block.key],
        leaf: step?.key,
        labels:
          inside.kind === "workflow"
            ? [inside.title, ...(step ? [step.title] : [])]
            : [],
      };
    }
    const found = agentUnder(inside, sessionId, [...chain, block.key]);
    if (found) return found;
  }
  return undefined;
}

/** The task started in the session, searched from a level down. */
function taskOf(
  level: FactoryLevelDto,
  sessionId: string,
  chain: string[],
  plan: string | undefined,
): Omit<FactoryWhere, "row"> | undefined {
  const title = level.kind === "plan" ? level.title : plan;
  for (const block of level.blocks) {
    if (
      block.kind === "task" &&
      block.owner?.sessionId === sessionId &&
      (!block.inside || block.inside.kind === "workflow")
    ) {
      const step = block.inside ? stepAt(block.inside) : undefined;
      return {
        path: block.inside ? [...chain, block.key] : chain,
        leaf: step?.key ?? block.key,
        labels: [
          ...(title ? [title] : []),
          block.title,
          ...(step ? [step.title] : []),
        ],
      };
    }
    if (block.inside) {
      const found = taskOf(
        block.inside,
        sessionId,
        [...chain, block.key],
        title,
      );
      if (found) return found;
    }
  }
  return undefined;
}

export function factoryWhere(
  page: FactoryPageDto | undefined,
  sessionId: string,
): FactoryWhere | undefined {
  if (!page) return undefined;
  // An agent with a row of its own is at a step of its workflow.
  const own = page.agents.find((agent) => agent.sessionId === sessionId);
  if (own) {
    const step = own.level.kind === "workflow" ? stepAt(own.level) : undefined;
    return {
      row: agentRowKey(sessionId),
      path: [],
      leaf: step?.key,
      labels:
        own.level.kind === "workflow"
          ? [own.level.title, ...(step ? [step.title] : [])]
          : [],
    };
  }
  // One started by another agent is under that agent's row.
  for (const agent of page.agents) {
    const found = agentUnder(agent.level, sessionId, []);
    if (found) return { row: agentRowKey(agent.sessionId), ...found };
  }
  // Any other is a plan's worker: at the task started in it.
  for (const agent of page.agents) {
    const found = taskOf(agent.level, sessionId, [], undefined);
    if (found) return { row: agentRowKey(agent.sessionId), ...found };
  }
  for (const plan of page.plans) {
    const found = taskOf(plan.level, sessionId, [], undefined);
    if (found) return { row: planRowKey(plan.path), ...found };
  }
  return undefined;
}

/**
 * The factory page: a workspace's work as the job tree draws it. Every
 * piece of work is a row, every job under it a block, and the jobs under a
 * job a level inside its block. Nothing is guessed: what stands under what,
 * who does it and what it waits for are all read from the jobs.
 */
import {
  isContainerJob,
  isTerminalJob,
  jobChildren,
  type Job,
  type JobTree,
} from "./jobs";
import { planOwnerState, type PlanOwnerState } from "./plans";

/** A block's state. `waiting` waits for the user. */
export type FactoryState =
  "draft" | "todo" | "doing" | "waiting" | "done" | "blocked" | "dropped";

export interface FactoryOwner {
  handle: string;
  sessionId: string | null;
  sessionName: string | null;
  state: PlanOwnerState;
}

export interface FactoryBlock {
  /** The job's id. */
  key: string;
  /**
   * `task` is a plan's task, `agent` a job another session does than the
   * one above it, `step` any other job.
   */
  kind: "task" | "step" | "plan" | "agent";
  title: string;
  state: FactoryState;
  /** Who does it, where that is another session than the job above. */
  owner: FactoryOwner | null;
  /** In a line: what it waits for, what came out, or where its agent is. */
  detail: string | null;
  /** The job's instructions. */
  description: string | null;
  /** What it handed over when it finished: its result and its outputs. */
  result: string | null;
  /** Open threads pinned to the plan task it stands for. */
  threads: number;
  questions: string[];
  line: number | null;
  /** Where it is drawn in its level; blocks sharing one run in parallel. */
  column: number;
  /** The keys of the blocks in its level it needs done first. */
  needs: string[];
  /** When this round of it started; null before that. */
  startedAt: string | null;
  inside: FactoryLevel | null;
}

export interface FactoryLevel {
  kind: "plan" | "tasks" | "workflow" | "agent" | "plans";
  title: string;
  owner: FactoryOwner | null;
  file?: string;
  flowErrors?: string[];
  /** Whether the columns say what comes first. */
  ordered: boolean;
  blocks: FactoryBlock[];
}

export type FactoryPlanState = "waiting" | "working" | "idle" | "done";

/** A piece of work: a root job, with the jobs under it as its level. */
export interface FactoryAgentRow {
  /** The session doing the root job; empty before one does. */
  sessionId: string;
  title: string;
  state: FactoryPlanState;
  /** Blocks under it that wait for the user. */
  waiting: number;
  level: FactoryLevel;
}

export interface FactorySession {
  id: string;
  name: string;
  teamHandle: string | null;
  status: string;
  archivedAt: string | null;
  startedAt: string;
  activity: string | undefined;
  needsAttention: boolean;
}

/** An agent's chip. An archived agent is shown as not running. */
export const factoryAgentOwner = (session: FactorySession): FactoryOwner => ({
  handle: session.teamHandle ?? session.name,
  sessionId: session.id,
  sessionName: session.name,
  state: planOwnerState(
    session.archivedAt ? { status: "archived" } : session,
    session.activity,
    session.archivedAt ? false : session.needsAttention,
  ),
});

/** Blocks of a level, and of the levels inside them, that wait for the user. */
export function factoryWaiting(level: FactoryLevel): number {
  return level.blocks.reduce(
    (count, block) =>
      count +
      (block.state === "waiting" ? 1 : 0) +
      (block.inside ? factoryWaiting(block.inside) : 0),
    0,
  );
}

const STATE: Record<Job["state"], FactoryState> = {
  pending: "todo",
  ready: "todo",
  running: "doing",
  held: "waiting",
  done: "done",
  failed: "blocked",
  skipped: "dropped",
};

export interface FactoryJobsInput {
  tree: JobTree;
  /** When each job was added and when its round started. */
  times: (jobId: string) => { createdAt: string; startedAt: string | null };
  sessions: readonly FactorySession[];
  /** Open threads pinned to the plan task a job stands for. */
  threads?: (job: Job) => number;
}

/**
 * The rows of a workspace's job trees, the newest first. A piece of work
 * that is over and whose agent is archived is left out.
 */
export function buildFactoryRows(input: FactoryJobsInput): FactoryAgentRow[] {
  const { tree } = input;
  const sessions = new Map(input.sessions.map((item) => [item.id, item]));
  const ownerOf = (job: Job, above: Job | undefined): FactoryOwner | null => {
    if (!job.sessionId || job.sessionId === above?.sessionId) return null;
    const session = sessions.get(job.sessionId);
    return session
      ? factoryAgentOwner(session)
      : {
          handle: job.sessionId.slice(0, 8),
          sessionId: null,
          sessionName: null,
          state: "none",
        };
  };
  /** The job a job's session is on under it, by title. */
  const at = (job: Job): string | null => {
    const under = (id: string): Job[] =>
      jobChildren(tree, id).flatMap((child) => [child, ...under(child.id)]);
    const found = under(job.id)
      .filter(
        (item) =>
          item.sessionId === job.sessionId &&
          !isContainerJob(item) &&
          (item.state === "running" || item.state === "held"),
      )
      .at(-1);
    return found ? found.title : null;
  };
  const level = (parent: Job, owner: FactoryOwner | null): FactoryLevel => {
    // A first-message job a plan task took over is the same work drawn
    // twice. `daedal job tree` still lists it.
    const children = jobChildren(tree, parent.id).filter(
      (child) =>
        !(
          child.state === "skipped" &&
          !child.source &&
          !jobChildren(tree, child.id).length
        ),
    );
    // A workflow is one job around its steps. Alone under its job it is
    // that job's work under a second name, so its steps stand in its place.
    const only = children.length === 1 ? children[0] : undefined;
    if (
      only?.source?.startsWith("workflow:") &&
      only.sessionId === parent.sessionId &&
      jobChildren(tree, only.id).length
    )
      return { ...level(only, owner), title: parent.title };
    const byName = new Map(children.map((child) => [child.name, child]));
    const columns = new Map<string, number>();
    const column = (
      job: Job,
      seen: ReadonlySet<string> = new Set(),
    ): number => {
      const known = columns.get(job.id);
      if (known !== undefined) return known;
      const before = job.needs.flatMap((need) => {
        const found = byName.get(need);
        return found && !seen.has(found.id) ? [found] : [];
      });
      const value = before.length
        ? 1 +
          Math.max(
            ...before.map((item) => column(item, new Set([...seen, job.id]))),
          )
        : 0;
      columns.set(job.id, value);
      return value;
    };
    // The plan its tasks were declared in, as a path inside the workspace.
    const plan = children
      .map((child) => child.source)
      .find((source) => source?.startsWith("plan:"));
    const planPath = plan?.slice("plan:".length, plan.lastIndexOf("#"));
    const file = planPath?.includes("/plans/")
      ? planPath.slice(planPath.lastIndexOf("/plans/") + 1)
      : planPath;
    return {
      ...(file ? { file } : {}),
      kind: parent.source?.startsWith("workflow:")
        ? "workflow"
        : owner
          ? "agent"
          : "tasks",
      title: parent.title,
      owner,
      ordered: true,
      blocks: children.map((job) => block(job, parent, column(job), byName)),
    };
  };
  const block = (
    job: Job,
    above: Job,
    column: number,
    beside: ReadonlyMap<string, Job>,
  ): FactoryBlock => {
    const owner = ownerOf(job, above);
    const asks =
      job.state === "running" && owner?.state === "waiting" ? "waiting" : null;
    const handed =
      job.state === "done"
        ? [
            job.result ?? "",
            ...job.outputs.map((output) => `${output.name} = ${output.value}`),
          ]
            .filter(Boolean)
            .join("\n")
        : null;
    return {
      key: job.id,
      kind: job.source?.startsWith("plan:") ? "task" : owner ? "agent" : "step",
      title: job.title,
      state: asks ?? STATE[job.state],
      owner,
      detail:
        job.state === "held"
          ? (job.hold?.why ?? job.result)
          : job.state === "done"
            ? job.result
            : job.state === "failed" || job.state === "skipped"
              ? job.why
              : job.state === "running" && owner
                ? at(job)
                : null,
      description: job.instructions.trim() || null,
      result: handed || null,
      threads: input.threads?.(job) ?? 0,
      questions: [],
      line: null,
      column,
      needs: job.needs.flatMap((need) => beside.get(need)?.id ?? []),
      startedAt: input.times(job.id).startedAt,
      inside: jobChildren(tree, job.id).length ? level(job, owner) : null,
    };
  };
  const working = (found: FactoryLevel): boolean =>
    found.owner?.state === "working" ||
    found.blocks.some(
      (item) =>
        item.owner?.state === "working" ||
        (item.inside ? working(item.inside) : false),
    );
  return jobChildren(tree, null)
    .filter((root) => {
      const session = root.sessionId ? sessions.get(root.sessionId) : undefined;
      return !(isTerminalJob(root) && (!session || session.archivedAt));
    })
    .sort((a, b) =>
      input.times(b.id).createdAt.localeCompare(input.times(a.id).createdAt),
    )
    .map((root) => {
      const owner = ownerOf(root, undefined);
      const found = level(root, owner);
      const waiting = factoryWaiting(found) + (root.state === "held" ? 1 : 0);
      return {
        sessionId: root.sessionId ?? "",
        title: root.title,
        state:
          waiting || owner?.state === "waiting"
            ? "waiting"
            : isTerminalJob(root)
              ? "done"
              : working(found)
                ? "working"
                : "idle",
        waiting: waiting || (owner?.state === "waiting" ? 1 : 0),
        level: { ...found, kind: "agent" },
      };
    });
}

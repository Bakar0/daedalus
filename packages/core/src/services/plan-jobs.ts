import type { Job } from "../domain/jobs";
import type { PlanFlow } from "../domain/plan-flow";
import {
  planTaskDetails,
  type PlanDocument,
  type PlanTask,
  type PlanTaskState,
} from "../domain/plans";
import type { JobDraft } from "./jobs";

/** The `source` of a job that stands for a plan's task. */
export const planJobSource = (planPath: string, taskId: string): string =>
  `plan:${planPath}#${taskId}`;

/** The plan task a job stands for, or null for any other job. */
export function planTaskOfJob(
  source: string | null,
): { planPath: string; taskId: string } | null {
  if (!source?.startsWith("plan:")) return null;
  const hash = source.lastIndexOf("#");
  if (hash === -1) return null;
  return {
    planPath: source.slice("plan:".length, hash),
    taskId: source.slice(hash + 1),
  };
}

const nested = (task: PlanTask): PlanTask[] =>
  task.body.flatMap((part) => (part.kind === "task" ? [part.task] : []));

/** A task that becomes a job: it has an id and is neither a draft nor closed. */
const open = (task: PlanTask): boolean =>
  !!task.id &&
  task.state !== "draft" &&
  task.state !== "done" &&
  task.state !== "dropped";

/**
 * A plan's tasks as jobs to add under one job, the tasks nested in a task
 * under its job.
 *
 * - A task with an owner is that session's job, and so are the tasks nested
 *   in it. No agent is started for them.
 * - A task with nested tasks and no owner only holds them: it is done when
 *   they are.
 * - Any other task gets a new agent.
 *
 * The plan's flow gives the needs. A job waits for jobs beside it only, so a
 * need for a task elsewhere in the plan becomes a need between the two
 * tasks' ancestors that stand side by side. Drafts, closed tasks, tasks
 * without an id, tasks in `known` and tasks whose owner is no session are
 * left out.
 */
export function planJobDrafts(input: {
  plan: PlanDocument;
  flow: PlanFlow;
  planPath: string;
  /** The session a handle names, or null. */
  owner: (handle: string) => string | null;
  /** Task ids that are jobs already. */
  known?: ReadonlySet<string>;
}): JobDraft[] {
  const top = input.plan.blocks.flatMap((part) =>
    part.kind === "task" ? [part.task] : [],
  );
  const parentOf = new Map<string, string | null>();
  const index = (tasks: PlanTask[], parent: string | null) => {
    for (const task of tasks) {
      if (task.id) parentOf.set(task.id, parent);
      index(nested(task), task.id ?? parent);
    }
  };
  index(top, null);
  const chain = (id: string): string[] => {
    const parent = parentOf.get(id);
    return parent ? [id, ...chain(parent)] : [id];
  };
  const needs = new Map<string, Set<string>>();
  for (const [id, wanted] of input.flow.needs)
    for (const need of wanted) {
      if (!parentOf.has(id) || !parentOf.has(need)) continue;
      const mine = chain(id);
      const theirs = chain(need);
      // One is nested in the other: the tree orders them already.
      if (mine.includes(need) || theirs.includes(id)) continue;
      for (const here of mine) {
        const beside = theirs.find(
          (there) => parentOf.get(there) === parentOf.get(here),
        );
        if (!beside) continue;
        needs.set(here, (needs.get(here) ?? new Set()).add(beside));
        break;
      }
    }
  const draft = (task: PlanTask, owned: boolean): JobDraft[] => {
    if (!open(task) || !task.id) return [];
    const session = task.owner ? input.owner(task.owner) : null;
    if (task.owner && !session) return [];
    const children = nested(task).flatMap((child) =>
      draft(child, owned || !!session),
    );
    const details = planTaskDetails(task).trim();
    return [
      {
        name: task.id,
        title: task.title.replace(/[`*_~]/g, "").trim() || task.id,
        instructions: [
          details,
          `This is the task ^${task.id} of the plan at ${input.planPath}. Read the whole plan first for context, and do this task only.`,
        ]
          .filter(Boolean)
          .join("\n\n"),
        needs: [...(needs.get(task.id) ?? [])],
        runner: session
          ? { kind: "session", sessionId: session }
          : owned || children.length
            ? { kind: "inline" }
            : { kind: "agent" },
        auto: !session && !owned && children.length > 0,
        source: planJobSource(input.planPath, task.id),
        children,
      },
    ];
  };
  return top
    .filter((task) => !task.id || !input.known?.has(task.id))
    .flatMap((task) => draft(task, false));
}

/**
 * The mark a job's state puts on its task's line. Null leaves the line as
 * it is.
 */
export function planMarkOf(
  job: Pick<Job, "state" | "hold">,
): PlanTaskState | null {
  switch (job.state) {
    case "pending":
    case "ready":
      return "todo";
    case "running":
      return "doing";
    case "held":
      // A result that waits for approval is still being worked on.
      return job.hold?.reason === "hold" ? "blocked" : "doing";
    case "done":
      return "done";
    case "failed":
      return "blocked";
    case "skipped":
      return "dropped";
  }
}

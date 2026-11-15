import type { UUID } from "./index";

/**
 * A step is one building block of a workflow: research, review, deploy. Its
 * file in `instructions/steps/` holds what the agent does in it, either full
 * instructions or one line naming a command or skill.
 */
/**
 * Where a step waits for the user:
 * - `start`: before the agent starts it, such as before pushing.
 * - `result`: after the agent did it. The step is done once the user
 *   approves what came out, and the next one cannot start before.
 */
export type WorkflowGate = "start" | "result";

/**
 * A gate as a file or a stored run spells it. `before` and `user` were the
 * first names for `start` and `result`, and still read as them. Undefined
 * for anything else.
 */
export function parseGate(
  value: string | null | undefined,
): WorkflowGate | null | undefined {
  if (value === null || value === undefined) return null;
  if (value === "start" || value === "before") return "start";
  if (value === "result" || value === "user") return "result";
  return undefined;
}

export interface WorkflowStepDefinition {
  name: string;
  description: string;
  gate: WorkflowGate | null;
  body: string;
}

/**
 * A `steps` entry naming another workflow rather than a step: `@release`.
 * Returns the workflow's name, or null for a plain step.
 */
export function includedWorkflow(entry: string): string | null {
  return entry.startsWith("@") ? entry.slice(1) : null;
}

/**
 * How deep included workflows may nest: a workflow including one that
 * includes one that includes one, so a step id has at most three workflow
 * names before it (`a/b/c/step`).
 */
export const MAX_WORKFLOW_NESTING = 3;

/**
 * A run step's id is its step name, qualified by the included workflows it
 * came from: `review`, `release/review`, `a/b/review`. Step and workflow
 * names never hold a `/`, so the id splits back unambiguously.
 */
export const stepBaseName = (id: string): string =>
  id.slice(id.lastIndexOf("/") + 1);

/** The included workflow a step id belongs to, `a/b` for `a/b/step`; empty at the top. */
export const stepGroupId = (id: string): string => {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? "" : id.slice(0, slash);
};

/** Whether a step id lies inside an included workflow's group, at any depth. */
export const inStepGroup = (id: string, groupId: string): boolean =>
  id.startsWith(`${groupId}/`);

/** An ordered list of steps, and when the agent should pick it. */
export interface WorkflowDefinition {
  name: string;
  description: string;
  /** What work this workflow fits, in the user's words. */
  when: string;
  /**
   * Empty for a dynamic workflow: the agent names the steps at start. An
   * entry `@name` includes that workflow's steps in its place.
   */
  steps: string[];
  /** `steps: dynamic`: no fixed steps; each run lists its own. */
  dynamic: boolean;
  /**
   * A circular workflow: the step it goes back to after its last step, so
   * the run starts its next iteration instead of ending. Null for none.
   */
  loop: string | null;
  /** For a circular workflow: when to stop going round, in the user's words. */
  until: string;
  /** Notes for the agent on running this workflow as a whole. */
  body: string;
}

/**
 * - `pending`: not reached yet.
 * - `waiting`: a gated step waiting for the user: to start, for a `before`
 *   gate, or to approve what came out, for a `user` gate.
 * - `active`: the step the agent is doing now.
 * - `done`, `skipped`: finished, with a note saying why when skipped.
 */
export type WorkflowStepState =
  "pending" | "waiting" | "active" | "done" | "skipped";

export interface WorkflowRunStep {
  name: string;
  description: string;
  gate: WorkflowGate | null;
  state: WorkflowStepState;
  startedAt: string | null;
  endedAt: string | null;
  approvedAt: string | null;
  /** The session waiting on a gated step, whose attention approval clears. */
  waitingSessionId: string | null;
  /** What the agent said it would do in this step when it started it. */
  plan: string | null;
  /** What came out, said when the step was done or skipped. */
  note: string | null;
  /**
   * A step with no file, added for this run only. Its description is all
   * the instructions it has.
   */
  dynamic: boolean;
}

/**
 * A workflow included in a run with `@name`, expanded in place: its steps
 * are the run's steps whose ids start with `<id>/`. Its own `loop` goes
 * round inside the group only.
 */
export interface WorkflowRunGroup {
  /** `release`, or `feature-part/release` when nested. */
  id: string;
  /** The included workflow's name: the id's last part. */
  workflow: string;
  /** The step id the group goes back to after its last step; null for none. */
  loopTo: string | null;
  until: string;
  /** Which time round the group is on, from 1. */
  iteration: number;
  /**
   * The group's steps as they were before it last went round, while none of
   * the new round has started: moving past the group puts them back, which
   * is how a run leaves a group's loop.
   */
  lastRound: WorkflowRunStep[] | null;
}

/** A step as one finished iteration of a circular run left it. */
export interface WorkflowStepRecord {
  iteration: number;
  name: string;
  state: WorkflowStepState;
  startedAt: string | null;
  endedAt: string | null;
  note: string | null;
}

/**
 * One piece of work going through a workflow, owned by the session doing it.
 * A session has at most one open run. The steps are copied from the files
 * when the run starts, so editing a workflow changes the next run, not the
 * one in flight.
 */
export interface WorkflowRun {
  id: UUID;
  workspaceId: UUID;
  /** The session the run belongs to; a rebirth moves it to the successor. */
  sessionId: UUID | null;
  workflow: string;
  /** In order, included workflows' steps expanded in place with qualified ids. */
  steps: WorkflowRunStep[];
  /** The workflows included with `@name`, outermost first; empty for none. */
  groups: WorkflowRunGroup[];
  /** Built for this run alone; `workflow` is its label, not a file. */
  dynamic: boolean;
  /** Steps were added or removed after a maintained workflow started. */
  modified: boolean;
  /** The step a circular run goes back to after its last; null for none. */
  loopTo: string | null;
  until: string;
  /** Which time round a circular run is on, from 1. */
  iteration: number;
  /** Earlier iterations of a circular run, oldest first. */
  history: WorkflowStepRecord[];
  /** Why the run was ended before its steps finished, when it was. */
  endNote: string | null;
  startedAt: string;
  updatedAt: string;
  /** Set when every step is done or skipped, or the run was replaced. */
  endedAt: string | null;
}

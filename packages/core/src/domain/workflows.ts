import type { UUID } from "./index";

/**
 * A step is one building block of a workflow: research, review, deploy. Its
 * file in `instructions/steps/` holds what the agent does in it, either full
 * instructions or one line naming a command or skill.
 */
export interface WorkflowStepDefinition {
  name: string;
  description: string;
  /** `user`: the agent waits for the user's approval before doing the step. */
  gate: "user" | null;
  body: string;
}

/** An ordered list of steps, and when the agent should pick it. */
export interface WorkflowDefinition {
  name: string;
  description: string;
  /** What work this workflow fits, in the user's words. */
  when: string;
  /** Empty for a dynamic workflow: the agent names the steps at start. */
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
 * - `waiting`: a gated step the agent reached; it waits for the user.
 * - `active`: the step the agent is doing now.
 * - `done`, `skipped`: finished, with a note saying why when skipped.
 */
export type WorkflowStepState =
  "pending" | "waiting" | "active" | "done" | "skipped";

export interface WorkflowRunStep {
  name: string;
  description: string;
  gate: "user" | null;
  state: WorkflowStepState;
  startedAt: string | null;
  endedAt: string | null;
  approvedAt: string | null;
  /** The session waiting on a gated step, which approval tells to go on. */
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
  steps: WorkflowRunStep[];
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

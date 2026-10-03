import type { UUID } from "./index";

/**
 * On duty or paused, plus `draining`: the scheduler has stopped delivering
 * runs and waits for those in flight before a handoff.
 */
export type RoutineAgentState = "on_duty" | "draining" | "paused";

/**
 * Who owns the agent's input. In `manual` the user talks to it; in `auto`
 * the input is locked and only Daedalus types, so routines run.
 */
export type RoutineAgentMode = "manual" | "auto";

/**
 * A named Claude session in an ordinary workspace that runs routines. Its
 * folder (`<workspace>/worktrees/agents/<slug>`) never moves, so Claude's
 * per-directory memory carries across handoffs.
 */
export interface RoutineAgent {
  id: UUID;
  workspaceId: UUID;
  /** Unique within the workspace; names the folder. */
  slug: string;
  name: string;
  model: string | null;
  /** Context share at which the agent drains and hands off. */
  autoHandoffPercent: number;
  state: RoutineAgentState;
  /** The current session; moves to the successor on every handoff. */
  sessionId: UUID | null;
  drainingSince: string | null;
  mode: RoutineAgentMode;
  /** The user's last keystroke in its terminal; starts the countdown. */
  lastInputAt: string | null;
  /** Unsent text cleared from the input box on locking, restored on unlock. */
  stashedDraft: string | null;
  createdAt: string;
}

export type RoutineSchedule =
  | { kind: "every"; everyMs: number; text: string }
  | { kind: "cron"; expression: string; text: string }
  | { kind: "at"; at: string; text: string };

/**
 * What a routine's reports become: a task and a notification, a
 * notification only, or nothing (a routine that only starts others).
 */
export type RoutineOutput = "task" | "notify" | "none";

/** One routine file, parsed. The file is the definition; SQLite is not. */
export interface Routine {
  name: string;
  /** Absolute path of the file it was read from. */
  path: string;
  schedule: RoutineSchedule;
  /** The routine deletes itself after this time. */
  until: string | null;
  model: string | null;
  timeoutMs: number;
  output: RoutineOutput;
  enabled: boolean;
  vars: Record<string, string>;
  body: string;
}

/** A routine file that did not parse, shown with its error. */
export interface RoutineFileError {
  path: string;
  name: string;
  error: string;
}

export interface RoutineState {
  routineAgentId: UUID;
  name: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
}

export type RoutineRunStatus =
  "queued" | "running" | "done" | "failed" | "skipped";
export type RoutineRunOutcome = "quiet" | "notified" | "task";

export interface RoutineRun {
  id: number;
  routineAgentId: UUID;
  routine: string;
  sessionId: UUID | null;
  status: RoutineRunStatus;
  queuedAt: string;
  /** When the line was typed into the agent's pane. */
  deliveredAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: RoutineRunOutcome | null;
  summary: string | null;
  /** How overdue the routine was when it was queued. */
  missedMs: number;
}

export type RoutineReportState = "open" | "resolved" | "closed";
export type RoutineReportVerdict = "useful" | "noise";

/** What a routine run handed back, one row per key over its life. */
export interface RoutineReport {
  id: UUID;
  routineAgentId: UUID;
  routine: string;
  key: string;
  /** The open report this one was merged into. */
  sameAs: string | null;
  /** Gets through Focus mode. */
  urgent: boolean;
  title: string;
  url: string | null;
  taskId: UUID | null;
  state: RoutineReportState;
  verdict: RoutineReportVerdict | null;
  openedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  reopenCount: number;
}

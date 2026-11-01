import type { UUID } from "./index";

/** A routine's stored schedule text, parsed. */
export type RoutineSchedule =
  | { kind: "every"; everyMs: number; text: string }
  | { kind: "cron"; expression: string; text: string }
  | { kind: "at"; at: string; text: string };

/**
 * A prompt that runs on a schedule in a workspace folder, as a headless
 * provider session that no live session holds.
 */
export interface Routine {
  id: UUID;
  name: string;
  /** Null runs in the workspaces root, for chores across every workspace. */
  workspaceId: UUID | null;
  /** As stored: `every 30m`, `cron "0 9 * * 1-5"` or `at <date>`. */
  schedule: string;
  prompt: string;
  model: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** Set by `daedal routine run`; the app's tick starts the run. */
  runRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RoutineRunStatus = "running" | "done" | "failed" | "skipped";
export type RoutineTrigger = "schedule" | "manual";

export interface RoutineRun {
  id: number;
  routineId: UUID;
  trigger: RoutineTrigger;
  status: RoutineRunStatus;
  /** The provider's conversation id, which a continue resumes. */
  providerSessionId: string | null;
  workingDirectory: string;
  startedAt: string;
  finishedAt: string | null;
  /** The last thing the agent said, or why the run failed or was skipped. */
  summary: string | null;
  /** The session a continue made from this run. */
  continuedSessionId: UUID | null;
  /** When the user opened the finished run; null is unread. */
  seenAt: string | null;
}

import type { UUID } from "./index";

/**
 * A prompt that runs on a schedule in a workspace folder, as a headless
 * provider session that no live session holds.
 */
export interface WorkspaceRoutine {
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
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceRoutineRunStatus =
  "running" | "done" | "failed" | "skipped";
export type WorkspaceRoutineTrigger = "schedule" | "manual";

export interface WorkspaceRoutineRun {
  id: number;
  routineId: UUID;
  trigger: WorkspaceRoutineTrigger;
  status: WorkspaceRoutineRunStatus;
  /** The provider's conversation id, which a continue resumes. */
  providerSessionId: string | null;
  workingDirectory: string;
  startedAt: string;
  finishedAt: string | null;
  /** The last thing the agent said, or why the run failed or was skipped. */
  summary: string | null;
  /** The session a continue made from this run. */
  continuedSessionId: UUID | null;
}

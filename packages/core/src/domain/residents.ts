import type { UUID } from "./index";

/**
 * What the user chose for a resident, plus `draining`: the scheduler has
 * stopped delivering runs and waits for those in flight before a handoff.
 */
export type ResidentState = "on_duty" | "draining" | "paused" | "stopped";

/**
 * A named, long-lived agent that owns a workspace. Its session runs at the
 * workspace root and never moves, so the provider's per-directory memory
 * carries across handoffs.
 */
export interface Resident {
  id: UUID;
  slug: string;
  name: string;
  workspaceId: UUID;
  provider: "claude" | "codex";
  model: string | null;
  /** Context share at which the resident drains and hands off. */
  autoHandoffPercent: number;
  state: ResidentState;
  /** The session on duty; moves to the successor on every handoff. */
  sessionId: UUID | null;
  drainingSince: string | null;
  createdAt: string;
}

export type RoutineSchedule =
  | { kind: "every"; everyMs: number; text: string }
  | { kind: "cron"; expression: string; text: string }
  | { kind: "at"; at: string; text: string };

export type RoutineFindings = "task" | "notify" | "none";

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
  findings: RoutineFindings;
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
  residentId: UUID;
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
  residentId: UUID;
  routine: string;
  sessionId: UUID | null;
  status: RoutineRunStatus;
  queuedAt: string;
  /** When the line was typed into the resident's pane. */
  deliveredAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: RoutineRunOutcome | null;
  summary: string | null;
  /** How overdue the routine was when it was queued. */
  missedMs: number;
}

export type FindingSeverity = "info" | "warn" | "urgent";
export type FindingState = "open" | "cleared" | "closed";
export type FindingVerdict = "useful" | "noise";

export interface Finding {
  id: UUID;
  residentId: UUID;
  routine: string;
  key: string;
  /** The open finding this one was merged into. */
  sameAs: string | null;
  severity: FindingSeverity;
  title: string;
  url: string | null;
  taskId: UUID | null;
  state: FindingState;
  verdict: FindingVerdict | null;
  openedAt: string;
  lastSeenAt: string;
  clearedAt: string | null;
  closedAt: string | null;
  reopenCount: number;
}

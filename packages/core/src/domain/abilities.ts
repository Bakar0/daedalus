import type { UUID } from "./index";

/** The colors a session can be marked with. */
export const SESSION_COLORS = [
  "red",
  "orange",
  "gold",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
] as const;

export type SessionColor = (typeof SESSION_COLORS)[number];

/**
 * What a session can be granted on top of being a session. Routines is the
 * only one so far.
 */
export type AbilityId = "routines";

/**
 * An ability a session holds. Its data hangs off `id`, which stays the same
 * when a handoff moves the ability to the successor session.
 */
export interface SessionAbility {
  id: UUID;
  /** The current session; a handoff moves it to the successor. */
  sessionId: UUID;
  ability: AbilityId;
  /** False after a revoke. The row and its data stay for a later grant. */
  enabled: boolean;
  /** The user's Pause: delivery stops, the ability stays granted. */
  paused: boolean;
  /** For routines: `purpose`, what the session's routines are for. */
  config: Record<string, string>;
  /** A line Daedalus still has to type into the session. */
  pendingNote: string | null;
  grantedAt: string;
  revokedAt: string | null;
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

/** What a routine is, as the user and the session wrote it. */
export interface RoutineDefinition {
  name: string;
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

/** A routine as stored: its definition and the scheduler's state. */
export interface Routine extends RoutineDefinition {
  id: UUID;
  abilityId: UUID;
  /** A template never fires; `routine add --from` copies it. */
  isTemplate: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

export type RoutineRunStatus =
  "queued" | "running" | "done" | "failed" | "skipped";
export type RoutineRunOutcome = "quiet" | "notified" | "task";

export interface RoutineRun {
  id: number;
  abilityId: UUID;
  routine: string;
  sessionId: UUID | null;
  status: RoutineRunStatus;
  queuedAt: string;
  /** When the line was typed into the session. */
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
  abilityId: UUID;
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

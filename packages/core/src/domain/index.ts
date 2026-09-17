export type UUID = string;
export type TaskStatus =
  "todo" | "in_progress" | "blocked" | "done" | "cancelled";
export type TaskPriority = "low" | "normal" | "high";
export type AgentProviderName = "claude" | "codex" | "custom";

export interface Workspace {
  id: UUID;
  slug: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /**
   * Where the user put this workspace in the list, ascending. Sparse: a new
   * workspace takes `MIN(position) - 1` so it lands on top without renumbering
   * its neighbours. Ties fall back to id, so the order is always total.
   */
  position: number;
}

export interface Task {
  id: UUID;
  workspaceId: UUID;
  number: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type AgentSessionStatus = "starting" | "running" | "exited" | "lost";
export type SessionKind = "agent" | "terminal";

export interface AgentSession {
  id: UUID;
  workspaceId: UUID;
  taskId: UUID | null;
  name: string;
  provider: AgentProviderName;
  kind: SessionKind;
  tmuxSession: string;
  command: string;
  args: string[];
  workingDirectory: string;
  status: AgentSessionStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  providerSessionId: string | null;
  archivedAt: string | null;
  resumeCount: number;
  /** Where the user put this session within its workspace. See `Workspace`. */
  position: number;
}

export interface IntegratedTerminal {
  id: UUID;
  name: string;
  tmuxSession: string;
  command: string;
  args: string[];
  workingDirectory: string;
  status: AgentSessionStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

export type WorkspaceRepositoryAccess = "write" | "reference";

export interface RepositoryLibraryEntry {
  id: UUID;
  name: string;
  remoteUrl: string;
  gitDirectory: string;
  defaultBranch: string;
  lastFetchedAt: string;
  createdAt: string;
}

export interface WorkspaceRepository {
  id: UUID;
  workspaceId: UUID;
  name: string;
  canonicalPath: string;
  access: WorkspaceRepositoryAccess;
  libraryRepositoryId: UUID | null;
  referencePath: string | null;
  baseBranch: string | null;
  baseCommit: string | null;
  fetchedAt: string | null;
  createdAt: string;
  gitStatus?: {
    state:
      "clean" | "modified" | "ahead" | "behind" | "diverged" | "unavailable";
    changedFiles: number;
    ahead: number;
    behind: number;
  };
}

export interface SessionWorktree {
  sessionId: UUID;
  repositoryId: UUID;
  path: string;
  branchName: string;
  createdAt: string;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink";
}

export interface WorkspaceFile {
  name: string;
  path: string;
  content: string;
  format: "markdown" | "text";
}

export interface WorkspaceContent {
  workspaceId: UUID;
  brief: string;
  journal: string;
  files: WorkspaceFileEntry[];
  repositories: WorkspaceRepository[];
  worktrees: SessionWorktree[];
}

/**
 * What an agent is doing right now, as opposed to whether its process is
 * alive. `AgentSessionStatus` answers "is the session running"; this answers
 * "does it need me". The two attention states are the only ones that change
 * what the user does next, so every surface treats them as a separate tier.
 */
export type AgentActivity =
  | "unknown"
  | "working"
  | "needs_permission"
  | "needs_input"
  | "idle"
  | "done"
  | "error";

/**
 * Where an observation came from, ordered by how much it can be trusted.
 * `agent` is the agent reporting on itself through `daedal attention`, `hook`
 * is a provider lifecycle hook, and `pane` is a guess derived from terminal
 * output. Surfaces must render a `pane` reading as lower confidence rather
 * than as a fact.
 */
export type AgentActivitySource = "agent" | "hook" | "transcript" | "pane";

export const ATTENTION_ACTIVITIES: readonly AgentActivity[] = [
  "needs_permission",
  "needs_input",
];

export const isAttentionActivity = (activity: AgentActivity): boolean =>
  ATTENTION_ACTIVITIES.includes(activity);

export interface AgentActivityState {
  sessionId: UUID;
  activity: AgentActivity;
  /** Free text describing the activity: "Bash(git push)", "Editing agents.ts". */
  detail: string | null;
  /** When this activity began; unchanged while the activity repeats. */
  since: string;
  /** When the activity was last observed. */
  observedAt: string;
  source: AgentActivitySource;
}

/**
 * The persisted shape, which carries the debounce bookkeeping the DTO has no
 * business exposing: what was last alerted for this session, and when.
 */
export interface StoredAgentActivity extends AgentActivityState {
  notifiedActivity: AgentActivity | null;
  notifiedAt: string | null;
}

export interface AttentionReason {
  id: UUID;
  text: string;
  raisedAt: string;
  source: AgentActivitySource;
  /**
   * True when Daedalus derived this text from an observation rather than the
   * agent writing it. Several hooks describe one block — a `PermissionRequest`
   * and the `Notification` that follows it are the same wait seen twice — so
   * an inferred reason replaces the previous inferred one instead of stacking
   * beside it. Only what the agent actually said accumulates.
   */
  generated?: boolean;
}

/**
 * One badge per session holding a *set of open reasons*, never a counter of
 * events. A badge that outlives its cause trains people to ignore badges, so
 * clearing is all-or-nothing and happens on the transition out of attention
 * whether or not the user ever looked.
 */
export interface SessionAttention {
  sessionId: UUID;
  workspaceId: UUID;
  reasons: AttentionReason[];
  /** When the badge was first raised, for "waiting 4m". */
  raisedAt: string;
  updatedAt: string;
}

export type NotificationLevel = "info" | "success" | "error";
export type NotificationChannel = "badge" | "toast" | "desktop";

export interface PendingNotification {
  id: UUID;
  sessionId: UUID | null;
  workspaceId: UUID | null;
  channel: "toast" | "desktop";
  level: NotificationLevel;
  title: string;
  body: string;
  createdAt: string;
}

/**
 * Where the user actually is, sampled by the desktop app. Notifications route
 * on presence rather than merely being suppressed on focus, because a toast
 * sent to a backgrounded app is a dropped alert, not a quiet one.
 */
export interface PresenceState {
  appRunning: boolean;
  appForeground: boolean;
  workspaceId: string | null;
  sessionId: string | null;
  userIdleSeconds: number;
  observedAt: string;
}

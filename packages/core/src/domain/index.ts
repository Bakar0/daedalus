import type { SessionColor } from "./abilities";

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
  /**
   * Whether clicking Start on a board card moves a `todo` or `blocked` task
   * to `in_progress`. The click is the user deciding to begin, so it is the
   * one status change the app makes for them; on by default.
   */
  startSetsInProgress: boolean;
  /**
   * Context share, in percent, at which a session is asked to hand off to a
   * fresh one. Null is off.
   */
  autoHandoffPercent: number | null;
  /** What Start and Start next launch when the user does not choose. */
  defaultProvider: "claude" | "codex" | null;
  /**
   * What every session of `defaultProvider` starts with when nothing names a
   * model, or null for the provider's own default. Never set without a
   * provider: a model belongs to one, and clearing the provider clears it.
   */
  defaultModel: string | null;
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
  /**
   * When the title or brief last changed, or null if never since creation.
   * `updatedAt` also moves on a status change, so it cannot answer this.
   */
  briefUpdatedAt: string | null;
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
  /**
   * Why a `lost` session could not be brought back, or null when nothing has
   * tried yet. A reboot makes every live session `lost` at once, so the ones
   * that cannot be resumed have to say what is wrong with them rather than
   * look identical to the ones that simply have not been reached.
   */
  lostReason: string | null;
  /**
   * Set when this session was archived by quitting the app with "Quit and
   * stop sessions", and cleared when startup brings it back. It is what makes
   * that a pause rather than a farewell: see `migrations/014_quit_resume.sql`.
   */
  resumeOnStart: boolean;
  /** When this session was last asked to hand its work to a fresh one. */
  handoffRequestedAt: string | null;
  /** Where the user put this session within its workspace. See `Workspace`. */
  position: number;
  /** When the user pinned it to the top of its workspace's list, or null. */
  pinnedAt: string | null;
  /** The mark on its card, its World figure and its routines' tasks. */
  color: SessionColor | null;
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
  /**
   * When this terminal was reopened after its tmux server died. A terminal has
   * no conversation to resume, so it comes back as a fresh login shell in the
   * same directory and the scrollback is genuinely gone — which the tab says
   * rather than presenting an empty screen as continuity.
   */
  revivedAt: string | null;
}

export type WorkspaceRepositoryAccess = "write" | "reference";

/**
 * An attachment exists from the moment it is asked for. Cloning a large
 * history takes minutes, and holding a modal open for it made the wait the
 * user's problem; the workspace shows the repository being prepared instead.
 */
export type WorkspaceRepositoryStatus = "ready" | "preparing" | "failed";

export interface RepositoryLibraryEntry {
  id: UUID;
  name: string;
  remoteUrl: string;
  gitDirectory: string;
  defaultBranch: string;
  lastFetchedAt: string;
  createdAt: string;
}

export interface GitStatus {
  state: "clean" | "modified" | "ahead" | "behind" | "diverged" | "unavailable";
  /** Uncommitted paths in the working tree. */
  changedFiles: number;
  ahead: number;
  behind: number;
  /**
   * Files the committed work touches relative to the base branch: the size of
   * the diff a reviewer would read. Measured only when `ahead` is non-zero.
   */
  filesAhead?: number;
  /**
   * Commits here that no branch on `origin` holds: work that exists only on
   * this machine. Measured only when `ahead` is non-zero. A pushed branch has
   * none, however far ahead of the base branch it is.
   */
  unpushed?: number;
}

/**
 * A pull request `gh` found for a worktree's branch. Visibility only: nothing
 * in Daedalus reviews or merges from it.
 */
/** What one fetch did to one workspace checkout. */
export interface RepositoryFetchOutcome {
  repositoryId: UUID;
  name: string;
  /** The checkout's commit before the fetch and after it. */
  from: string | null;
  to: string | null;
  /** How many commits the checkout moved forward by. */
  newCommits: number;
  /** The newest of those, at most 20, newest first. */
  commits: Array<{ hash: string; subject: string }>;
  /** Commits the remote has that the checkout did not take, when it stayed. */
  behind: number;
  /** Why it stayed behind: its own changes, or history that diverged. */
  heldBack?: "local-changes" | "diverged";
  /** The fetch itself failed, for instance offline. */
  error?: string;
}

export interface PullRequestRef {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  title?: string;
  /** GitHub's merge time, present once merged. */
  mergedAt?: string;
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
  status: WorkspaceRepositoryStatus;
  /** Why preparation failed, kept so the row can explain itself. */
  statusError: string | null;
  gitStatus?: GitStatus;
}

export interface SessionWorktree {
  sessionId: UUID;
  repositoryId: UUID;
  path: string;
  branchName: string;
  createdAt: string;
  /** Measured against the repository's base branch, not the worktree's own
   * upstream: the question a worktree row answers is how far this agent has
   * moved from the branch it started on. */
  gitStatus?: GitStatus;
  /** Absent when `gh` is missing, signed out, or found nothing. */
  pullRequest?: PullRequestRef;
  /**
   * The branch's pull request is merged and its head holds this tree's HEAD,
   * so the work is on the base branch even when a squash merge left none of
   * these commits there.
   */
  landed?: boolean;
}

/** One file with uncommitted changes in a session's worktree. */
export interface ChangedFile {
  /** Workspace-relative, so the editor can open it as any other file. */
  path: string;
  /** Inside the repository, which is what git and the diff's original need. */
  repositoryPath: string;
  /** Where a renamed file came from, repository-relative. */
  originalRepositoryPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  /** Absent for a binary file or an untracked one. */
  additions?: number;
  deletions?: number;
}

/** One session worktree's `git status`: what is not committed yet. */
export interface WorktreeChanges {
  sessionId: string;
  repositoryId: string;
  repositoryName: string;
  branchName: string;
  /** The worktree's folder, workspace-relative. */
  root: string;
  /** HEAD, which the changes are measured from; null when git could not say. */
  base: string | null;
  files: ChangedFile[];
}

/** One commit a session worktree made since it branched. */
export interface WorktreeCommit {
  sha: string;
  shortSha: string;
  author: string;
  /** ISO 8601, the author date. */
  date: string;
  subject: string;
  /** On a branch on `origin`; false for a commit that exists only here. */
  pushed?: boolean;
}

/** Where a path printed in a terminal points, when it is a workspace file. */
export interface FileLinkTarget {
  workspaceId: string;
  path: string;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink";
  /** Whether it can be renamed, moved or removed. See `WorkspaceFileEntryDto`. */
  mutable: boolean;
  /** Why not, in one short phrase the menu can show. */
  immutableReason?: string;
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

/**
 * A reason that was on a badge and has been cleared. The badge itself only
 * ever holds open reasons; this is what lets the task timeline show what an
 * agent asked before. Capped at five per session.
 */
export interface ClearedAttentionReason {
  id: UUID;
  sessionId: UUID;
  workspaceId: UUID;
  text: string;
  source: AgentActivitySource;
  raisedAt: string;
  clearedAt: string;
}

/**
 * A pull request that merged, remembered after its worktree is gone. Written
 * once, the first time a refresh sees it merged.
 */
export interface ShippedPullRequest {
  url: string;
  workspaceId: UUID;
  sessionId: UUID | null;
  taskId: UUID | null;
  repositoryId: UUID | null;
  number: number;
  title: string | null;
  branchName: string;
  mergedAt: string;
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

export * from "./abilities";

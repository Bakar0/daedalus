export type ErrorCode =
  "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "DEPENDENCY" | "INTERNAL";

export type TaskStatus =
  "todo" | "in_progress" | "blocked" | "done" | "cancelled";
export type TaskPriority = "low" | "normal" | "high";
export type AgentProviderName = "claude" | "codex" | "custom";
export type AgentSessionStatus = "starting" | "running" | "exited" | "lost";
export type SessionKind = "agent" | "terminal";

/** A secret's name. A value only travels when the user asks to see it. */
export interface SecretDto {
  name: string;
  /** Null for a global secret. */
  workspaceId: string | null;
  /** A global secret the workspace has its own of the same name for. */
  overridden: boolean;
  updatedAt: string;
}

export interface WorkspaceDto {
  id: string;
  slug: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  available: boolean;
  /** Manual list order, ascending. Lists arrive already sorted by it. */
  position: number;
  /** Start on a board card moves a `todo` or `blocked` task to `in_progress`. */
  startSetsInProgress: boolean;
  /** Context percent that triggers an automatic handoff; null is off. */
  autoHandoffPercent: number | null;
  /** What Start and Start next launch with; null leaves it to the app. */
  defaultProvider: "claude" | "codex" | null;
  /** A provider model id, or null for that provider's default. */
  defaultModel: string | null;
  /** The account each provider's sessions start on; null is the default. */
  defaultClaudeAccount: string | null;
  defaultCodexAccount: string | null;
}

export interface TaskDto {
  id: string;
  workspaceId: string;
  number: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** When the title or brief last changed; null if never since creation. */
  briefUpdatedAt: string | null;
  /**
   * Other tasks in the same workspace this brief names as `#N`, resolved.
   * `hard` is "depends on", "after" or "blocked by". Present on snapshot
   * tasks; single-task responses leave it out.
   */
  references?: TaskReferenceDto[];
}

export interface TaskReferenceDto {
  taskId: string;
  number: number;
  hard: boolean;
}

export interface AgentSessionDto {
  id: string;
  workspaceId: string;
  taskId: string | null;
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
   * Why a `lost` session could not be revived, or null when nothing has tried.
   * A reboot makes every live session `lost` at once, so the few that cannot
   * come back have to say what is wrong rather than look like the rest.
   */
  lostReason: string | null;
  /** Set once a handoff was requested, by the user or the automatic sweep. */
  handoffRequestedAt: string | null;
  /** Manual list order within the workspace, ascending. */
  position: number;
  /** When it was pinned to the top of its workspace's list, or null. */
  pinnedAt: string | null;
  color: SessionColorDto | null;
  /** The account profile it runs on, or null for the provider's default. */
  account: string | null;
  /** The team it is a member of (the lead's orchestration ability id). */
  teamId: string | null;
  /** Its handle in the team chat, such as `server`. */
  teamHandle: string | null;
}

export type SessionColorDto =
  "red" | "orange" | "gold" | "green" | "teal" | "blue" | "purple" | "pink";

export type AbilityIdDto = "routines" | "orchestration";

export interface IntegratedTerminalDto {
  id: string;
  name: string;
  tmuxSession: string;
  workingDirectory: string;
  status: AgentSessionStatus;
  startedAt: string;
  endedAt: string | null;
  /** Reopened after a restart as a fresh shell: the scrollback is not back. */
  revivedAt: string | null;
}

export type WorkspaceRepositoryAccess = "write" | "reference";

export interface RepositoryLibraryDto {
  id: string;
  name: string;
  remoteUrl: string;
  defaultBranch: string;
  lastFetchedAt: string;
}

export interface GitHubRepositoryDto {
  name: string;
  nameWithOwner: string;
  remoteUrl: string;
}

export interface RepositoryDiscoveryDto {
  githubCliAvailable: boolean;
  authenticated: boolean;
  repositories: GitHubRepositoryDto[];
  error?: string;
}

export type WorkspaceRepositoryStatus = "ready" | "preparing" | "failed";

export interface WorkspaceRepositoryDto {
  id: string;
  workspaceId: string;
  name: string;
  canonicalPath: string;
  access: WorkspaceRepositoryAccess;
  libraryRepositoryId: string | null;
  referencePath: string | null;
  baseBranch: string | null;
  baseCommit: string | null;
  fetchedAt: string | null;
  createdAt: string;
  status: WorkspaceRepositoryStatus;
  statusError: string | null;
  gitStatus?: GitStatusDto;
}

export interface GitStatusDto {
  state: "clean" | "modified" | "ahead" | "behind" | "diverged" | "unavailable";
  /** Uncommitted paths. */
  changedFiles: number;
  ahead: number;
  behind: number;
  /** Files the commits ahead of base touch; present only when `ahead > 0`. */
  filesAhead?: number;
  /** Commits no branch on `origin` holds; present only when `ahead > 0`. */
  unpushed?: number;
}

/** What one fetch did to one workspace checkout. */
export interface RepositoryFetchOutcomeDto {
  repositoryId: string;
  name: string;
  from: string | null;
  to: string | null;
  newCommits: number;
  /** At most 20, newest first. */
  commits: Array<{ hash: string; subject: string }>;
  behind: number;
  heldBack?: "local-changes" | "diverged";
  error?: string;
}

/** A link `gh` found for a branch. Visibility only; nothing merges from it. */
export interface PullRequestRefDto {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  title?: string;
  /** GitHub's merge time, present once merged. */
  mergedAt?: string;
}

/** A merged pull request, remembered after its worktree is gone. */
export interface ShippedPullRequestDto {
  url: string;
  workspaceId: string;
  sessionId: string | null;
  taskId: string | null;
  repositoryId: string | null;
  number: number;
  title: string | null;
  branchName: string;
  mergedAt: string;
}

export interface SessionWorktreeDto {
  sessionId: string;
  repositoryId: string;
  path: string;
  branchName: string;
  createdAt: string;
  gitStatus?: GitStatusDto;
  /** Absent when `gh` is missing, signed out, or found nothing. */
  pullRequest?: PullRequestRefDto;
  /** The merged pull request holds this tree's HEAD: nothing here to push. */
  landed?: boolean;
}

export interface ChangedFileDto {
  path: string;
  repositoryPath: string;
  originalRepositoryPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  additions?: number;
  deletions?: number;
}

export interface WorktreeChangesDto {
  sessionId: string;
  repositoryId: string;
  repositoryName: string;
  branchName: string;
  root: string;
  base: string | null;
  files: ChangedFileDto[];
}

export interface WorktreeCommitDto {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
  /** On a branch on `origin`; false for a commit that exists only here. */
  pushed?: boolean;
}

export interface FileLinkTargetDto {
  workspaceId: string;
  path: string;
}

export interface WorkspaceContentDto {
  workspaceId: string;
  brief: string;
  journal: string;
  files: WorkspaceFileEntryDto[];
  repositories: WorkspaceRepositoryDto[];
  worktrees: SessionWorktreeDto[];
}

export interface WorkspaceFileEntryDto {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink";
  /**
   * Whether this entry can be renamed, moved or removed.
   *
   * Computed by the service, which is the only thing that knows the answer —
   * a read-only checkout, a folder Daedalus points at by path, a registered
   * working tree, or a file it regenerates. The renderer greys out its menu
   * from this rather than keeping a second list, because two lists drift and
   * the drift shows up as a menu offering what the service refuses.
   */
  mutable: boolean;
  /** Why not, in one short phrase the menu can show. */
  immutableReason?: string;
}

/** One coalesced filesystem change, relative to the workspace root. */
export interface WorkspaceFileChangeDto {
  path: string;
  kind: "added" | "updated" | "deleted";
  /** `null` for a deletion, where there is nothing left to stat. */
  entryKind: "file" | "directory" | null;
}

export interface WorkspaceFileDto {
  name: string;
  path: string;
  content: string;
  format: "markdown" | "text";
}

export interface ProviderAvailabilityDto {
  name: string;
  executable: string;
  available: boolean;
}

/** One account a provider can run sessions on. */
export interface AccountDto {
  provider: "claude" | "codex";
  /** `default`, or a profile id. */
  account: string;
  name: string;
  /** The configuration folder the provider reads for it. */
  directory: string;
  createdAt: string | null;
  /** `api-key`: a Claude key kept in the Keychain; `login` otherwise. */
  kind: "login" | "api-key";
  /** Claude login accounts: which login Sign in runs. */
  login?: ClaudeLoginDto;
}

export type ClaudeLoginDto = "subscription" | "sso" | "console";

export type SignInStateDto = "missing" | "signed-out" | "signed-in" | "unknown";

export interface InstallCommandDto {
  label: string;
  command: string;
}

/** What the provider says about one account's login, asked just now. */
export interface AccountStatusDto extends AccountDto {
  state: SignInStateDto;
  /** How the provider says it is signed in ("Claude subscription", …). */
  method?: string;
  email?: string;
  organization?: string;
  plan?: string;
  detail?: string;
  executable: string;
  checkedAt: string;
  /** Present when the provider is not installed: how to install it. */
  install?: InstallCommandDto[];
}

export interface ProviderModelDto {
  id: string;
  label: string;
  resolvedModel?: string;
  description?: string;
}

export interface ProviderModelCatalogDto {
  provider: "codex" | "claude";
  defaultModel?: string;
  models: ProviderModelDto[];
  source: "provider" | "aliases";
}

/**
 * What the user chose on the way out. `keep` leaves every session running and
 * is what reopening reconnects to; `shutdown` is the real close, ending them
 * and the tmux server with them; `cancel` leaves the app open.
 */
export type QuitChoice = "keep" | "shutdown" | "cancel";

/**
 * What the window shows about a newer release. `null` in its place means
 * there is nothing to say.
 *
 * - `available`: `version` is newer than the running one and not dismissed.
 * - `downloading`: the user chose Update; the bundle is being fetched.
 * - `restarting`: downloaded; the app is replacing itself and will reopen.
 * - `current`: a check the user asked for found nothing newer.
 * - `error`: a check the user asked for, or an install, failed; see `message`.
 */
export interface AppUpdateDto {
  state: "available" | "downloading" | "restarting" | "current" | "error";
  currentVersion: string;
  version?: string;
  message?: string;
}

export interface ShutdownSessionTargetDto {
  id: string;
  name: string;
  workspaceId: string;
  provider: AgentProviderName;
  /** `stop` means this session has no conversation to preserve. */
  disposition: "archive" | "stop";
}

/**
 * What quitting would leave running, so the dialog can name it rather than
 * make the user count cards.
 */
export interface ShutdownPlanDto {
  sessions: ShutdownSessionTargetDto[];
  terminals: { id: string; name: string }[];
}

/**
 * A skill the providers can see. Reported per directory it was found in
 * rather than merged, because a provider lists a name found twice twice.
 */
export interface DiscoveredSkillDto {
  name: string;
  description: string;
  skillPath: string;
  providers: Array<"claude" | "codex" | "cursor">;
  origin: "daedalus" | "user" | "plugin";
  source:
    "claude-personal" | "agents-personal" | "cursor-personal" | "claude-plugin";
  /** The directory it was found in, which is the group it is listed under. */
  sourcePath: string;
  /** The plugin's name, when the source is one plugin rather than a provider. */
  sourceName?: string;
  invocation: "auto" | "user-only" | "model-only";
  visibility: "on" | "off";
  managedId?: string;
  problem?: "unreadable-frontmatter" | "name-mismatch" | "broken-link";
}

export interface ManagedSkillArtifactDto {
  kind: "skill" | "style" | "instructions" | "selection";
  path: string;
  present: boolean;
  /** Something that is not Daedalus's sits here, so it was left alone. */
  blocked: boolean;
}

export interface ManagedSkillDto {
  id: string;
  title: string;
  summary: string;
  supportsAlways: boolean;
  enabled: boolean;
  mode: "on-demand" | "always";
  source?: { kind: "path" | "git"; ref: string; subpath?: string };
  artifacts: ManagedSkillArtifactDto[];
}

export interface SkillListingDto {
  managed: ManagedSkillDto[];
  discovered: DiscoveredSkillDto[];
}

export interface SkillDoctorFindingDto {
  level: "ok" | "warn";
  message: string;
}

export interface DesktopSettingsDto {
  /** The running build, so "did my update install?" is answerable in the app. */
  version: string;
  /** `stable`, or the suffix of a channelled home such as `dev`. */
  channel: string;
  home: string;
  workspaceRoot: string;
  databasePath: string;
  repositoryRoot: string;
  tmuxAvailable: boolean;
  tmuxVersion?: string;
  workspaceInstructionFilesEnabled: boolean;
  autoRestoreSessionsEnabled: boolean;
  trustSessionFoldersEnabled: boolean;
  focusMode: boolean;
  providers: ProviderAvailabilityDto[];
  /** Every account, default ones first. Sign-in state is `accountStatus`. */
  accounts: AccountDto[];
}

export interface UsageWindowDto {
  label: string;
  usedPercent: number;
  resetsAt?: string;
}

export interface ProviderUsageDto {
  provider: "codex" | "claude";
  windows: UsageWindowDto[];
  observedAt: string;
  /** The account profile, absent for the provider's default account. */
  account?: string;
}

/**
 * What an agent is doing, as opposed to whether its process is alive. The two
 * attention activities are the only ones that change what the user does next,
 * so every surface renders them as their own tier.
 */
export type AgentActivity =
  | "unknown"
  | "working"
  | "needs_permission"
  | "needs_input"
  | "idle"
  | "done"
  | "error";

/** `pane` is a guess from terminal output and must render as lower confidence. */
export type AgentActivitySource = "agent" | "hook" | "transcript" | "pane";

export interface AgentActivityDto {
  sessionId: string;
  activity: AgentActivity;
  detail: string | null;
  since: string;
  observedAt: string;
  source: AgentActivitySource;
}

export interface AttentionReasonDto {
  id: string;
  text: string;
  raisedAt: string;
  source: AgentActivitySource; /** True when Daedalus inferred this text rather than the agent writing it. */
  generated?: boolean;
}

/** One badge per session holding a set of open reasons, capped at five. */
export interface SessionAttentionDto {
  sessionId: string;
  workspaceId: string;
  reasons: AttentionReasonDto[];
  raisedAt: string;
  updatedAt: string;
}

export type NotificationLevel = "info" | "success" | "error";

export interface ToastDto {
  id: string;
  sessionId: string | null;
  workspaceId: string | null;
  level: NotificationLevel;
  title: string;
  body: string;
  createdAt: string;
}

export interface PresenceStateDto {
  appRunning: boolean;
  appForeground: boolean;
  workspaceId: string | null;
  sessionId: string | null;
  userIdleSeconds: number;
  observedAt: string;
  focusMode: boolean;
}

export interface SessionTelemetryDto {
  sessionId: string;
  model?: string;
  /** Codex only; absent for Claude, which shows its own mode in its input. */
  permissionMode?: string;
  context?: {
    usedTokens: number;
    totalTokens?: number;
    usedPercent?: number;
  };
  observedAt: string;
}

/** One thing that happened to a task. See `TaskTimelineEvent` in the core. */
export interface TaskTimelineEventDto {
  kind:
    | "created"
    | "brief_edited"
    | "session_spawned"
    | "worktree_created"
    | "attention_raised"
    | "attention_cleared"
    | "session_stopped"
    | "session_archived"
    | "journal"
    | "done"
    | "cancelled";
  /** ISO time, a bare `YYYY-MM-DD` for a dated journal heading, or null. */
  at: string | null;
  text: string;
  detail?: string;
  sessionId?: string;
  /** For a journal entry: the heading as written, to scroll the journal to. */
  journalHeading?: string;
  /** For a raised reason: still open on the badge. */
  open?: boolean;
}

/** Sessions, wall time, peak context and models across a task's sessions. */
export interface TaskCostDto {
  sessions: number;
  firstStartedAt: string | null;
  /** Null while any session is still live; wall time then runs to now. */
  lastEndedAt: string | null;
  running: boolean;
  peakContextPercent?: number;
  models: string[];
}

export interface TaskTimelineDto {
  taskId: string;
  events: TaskTimelineEventDto[];
  cost: TaskCostDto;
}

/** An ability a session holds, or held before a revoke. */
export interface SessionAbilityDto {
  id: string;
  sessionId: string;
  ability: AbilityIdDto;
  enabled: boolean;
  paused: boolean;
  /** For routines: what the session's routines are for. */
  purpose: string | null;
  /** A grant or revoke note is still waiting to be typed in. */
  noteWaiting: boolean;
  grantedAt: string;
}

export type DeliveryHoldReasonDto =
  | "paused"
  | "stopped"
  | "handoff"
  | "typing"
  | "busy"
  | "waiting-on-user"
  | "input-text"
  | "in-flight-limit"
  | "skill-missing";

/** What the routine bar above a session's terminal shows. */
export interface RoutinesStatusDto {
  abilityId: string;
  sessionId: string;
  paused: boolean;
  /** Runs waiting to be typed in, oldest first. */
  waiting: Array<{ runId: number; routine: string; queuedAt: string }>;
  /** Runs typed in and not finished. */
  running: number;
  /** Why the waiting runs are not going in, when they are not. */
  hold: {
    reason: DeliveryHoldReasonDto;
    text: string;
    /** For `typing`: when the quiet time after a keystroke ends. */
    until?: string;
  } | null;
  nextRun: { routine: string; at: string } | null;
  lastKeystrokeAt: string | null;
  routines: number;
  openReports: number;
  openUrgentReports: number;
  openReportTasks: number;
}

export interface RoutineReportDto {
  id: string;
  abilityId: string;
  routine: string;
  key: string;
  sameAs: string | null;
  urgent: boolean;
  title: string;
  url: string | null;
  taskId: string | null;
  state: "open" | "resolved" | "closed";
  verdict: "useful" | "noise" | null;
  openedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  reopenCount: number;
}

export interface RoutineDto {
  name: string;
  /** What the routine asks the session to do, before placeholders are filled. */
  prompt: string;
  schedule: string;
  until: string | null;
  model: string | null;
  timeoutMs: number;
  output: "task" | "notify" | "none";
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  consecutiveFailures: number;
  lastRun: RoutineRunDto | null;
}

export interface RoutineRunDto {
  id: number;
  routine: string;
  status: "queued" | "running" | "done" | "failed" | "skipped";
  queuedAt: string;
  deliveredAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: "quiet" | "notified" | "task" | null;
  summary: string | null;
  missedMs: number;
  /** Set by Run now when the routine already had a run waiting. */
  alreadyQueued?: boolean;
}

/** A team, named after its lead's session. */
export interface TeamDto {
  /** The lead's orchestration ability id. */
  id: string;
  leadId: string;
  name: string;
  goal: string | null;
}

export interface TeamMemberDto {
  handle: string;
  role: "lead" | "member";
  sessionId: string;
  name: string;
  /** The session's status, or `archived`. */
  status: string;
  /** Messages after its read marker that it did not write. */
  unread: number;
  /** Messages that tag it and have not reached its session. */
  undelivered: number;
  lastError: string | null;
}

export interface TeamMessageDto {
  id: number;
  /** `lead`, `user`, `daedalus` or a member's handle. */
  author: string;
  body: string;
  tags: string[];
  createdAt: string;
}

/** What the Team panel reads: the members and the newest messages. */
export interface TeamDetailDto {
  team: TeamDto;
  members: TeamMemberDto[];
  messages: TeamMessageDto[];
}

export interface TeamSayResultDto {
  message: TeamMessageDto;
  warnings: string[];
}

export interface RoutinesDetailDto {
  purpose: string | null;
  routines: RoutineDto[];
  templates: RoutineDto[];
  runs: RoutineRunDto[];
}

/**
 * Phone access through the relay. `status` is the connector's: `off` while
 * the setting is off, `waiting_for_phone` until a phone claims this Mac,
 * `locked` while the account has no access or is over its data limit.
 */
export type RemoteStatusDto =
  | "off"
  | "connecting"
  | "waiting_for_phone"
  | "online"
  | "offline"
  | "locked"
  /** The relay refused this Mac: it was removed from its account. */
  | "removed";

export interface RemoteStateDto {
  enabled: boolean;
  /** The Mac is kept from idle sleep while phone access is on. */
  keepAwake: boolean;
  status: RemoteStatusDto;
  relay: string;
  /** What phones call this Mac. */
  macName: string;
  phones: Array<{ id: string; name: string; pairedAt: string }>;
  /** Phones with an open connection right now. */
  connectedPhones: number;
  /** The account that claimed this Mac, once the relay has said. */
  account?: string;
  /** A phone that scanned the code, waiting for the user to allow it. */
  pairingRequest?: {
    phoneId: string;
    phoneName: string;
    /** Six digits the phone shows too. */
    code: string;
    expiresAt: number;
  };
}

/** One thing a phone did on this Mac, from the audit log. */
export interface RemoteActivityDto {
  at: string;
  phoneId: string;
  phone: string;
  /** A request's method, or `terminal.open` / `terminal.close`. */
  action: string;
  target?: string;
  ok: boolean;
  code?: string;
  bytesIn?: number;
  bytesOut?: number;
}

/** What the QR code says, and until when it can be used. */
export interface RemotePairingDto {
  url: string;
  expiresAt: number;
}

export interface DesktopSnapshotDto {
  workspaces: WorkspaceDto[];
  tasks: TaskDto[];
  agents: AgentSessionDto[];
  terminals: IntegratedTerminalDto[];
  repositories: RepositoryLibraryDto[];
  providerUsage: ProviderUsageDto[];
  sessionTelemetry: SessionTelemetryDto[];
  sessionActivity: AgentActivityDto[];
  attention: SessionAttentionDto[];
  /**
   * Every session worktree across every workspace, with cached git status. It
   * rides on the snapshot so the board can show a task's output without the
   * workspace view ever having been opened.
   */
  worktrees: SessionWorktreeDto[];
  /** Every merged pull request remembered, oldest first, for the World. */
  shipped: ShippedPullRequestDto[];
  toasts: ToastDto[];
  /** Every ability row, granted or revoked, for the session cards. */
  abilities: SessionAbilityDto[];
  /** One entry per session holding routines, for its bar and card badge. */
  routines: RoutinesStatusDto[];
  /** Every team: a lead holding orchestration, and what it is called. */
  teams: TeamDto[];
  /** Every routine report that has a task, for the task's card and drawer. */
  routineReports: RoutineReportDto[];
  settings: DesktopSettingsDto;
}

export interface RpcFailure {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type RpcResult<T> = { ok: true; data: T } | RpcFailure;

type Request<Params, Response> = {
  params: Params;
  response: RpcResult<Response>;
};

/** The app's own window, or the World opened in a window of its own. */
export type DesktopWindowRole = "main" | "world";

/** Stable contract shared by Electrobun's Bun and renderer runtimes. */
export interface DesktopRpcSchema {
  bun: {
    requests: {
      snapshot: Request<Record<string, never>, DesktopSnapshotDto>;
      /** Name, pin and color, any of them, on any session. */
      sessionUpdate: Request<
        {
          sessionId: string;
          name?: string;
          pinned?: boolean;
          color?: SessionColorDto | null;
        },
        AgentSessionDto
      >;
      sessionAbility: Request<
        { sessionId: string; ability: AbilityIdDto; granted: boolean },
        SessionAbilityDto
      >;
      routinesDetail: Request<{ sessionId: string }, RoutinesDetailDto>;
      /** Sends what is waiting, then reads the team as the user. */
      teamDetail: Request<{ teamId: string }, TeamDetailDto>;
      /** Posts to the team chat as the user. */
      teamSay: Request<{ teamId: string; body: string }, TeamSayResultDto>;
      teamGoal: Request<{ teamId: string; goal: string }, TeamDto>;
      routinesControl: Request<
        {
          sessionId: string;
          action: "pause" | "resume";
        },
        SessionAbilityDto
      >;
      routinesPurpose: Request<
        { sessionId: string; purpose: string },
        SessionAbilityDto
      >;
      routineSetEnabled: Request<
        { sessionId: string; name: string; enabled: boolean },
        { name: string; enabled: boolean }
      >;
      /**
       * Run now. With a name, queues that routine; without one, the oldest
       * waiting run. Either way the next line skips the quiet time after
       * typing, and every other rule still holds.
       */
      routineRunNow: Request<
        { sessionId: string; name?: string },
        RoutineRunDto
      >;
      routineReportVerdict: Request<
        { id: string; verdict: "useful" | "noise" | null },
        RoutineReportDto
      >;
      /**
       * The loopback WebSocket the renderer attaches terminals to. It carries
       * a per-launch token, and the `views://` handler resolves a URL as a
       * resource path — a query string or fragment makes the page itself fail
       * to load — so it is fetched over RPC rather than passed in the URL.
       */
      terminalEndpoint: Request<Record<string, never>, { endpoint: string }>;
      remoteGet: Request<Record<string, never>, RemoteStateDto>;
      remoteSetEnabled: Request<{ enabled: boolean }, RemoteStateDto>;
      remoteSetKeepAwake: Request<{ enabled: boolean }, RemoteStateDto>;
      /** An empty name goes back to the computer's own name. */
      remoteSetMacName: Request<{ name: string }, RemoteStateDto>;
      /** A new one-time pairing code; any earlier one stops working. */
      remotePairingCode: Request<Record<string, never>, RemotePairingDto>;
      /** Forgets a phone on this Mac, so it can no longer connect to it. */
      remotePhoneRemove: Request<{ id: string }, RemoteStateDto>;
      /** Allow or decline the phone waiting to pair. */
      remoteConfirmPairing: Request<{ allow: boolean }, RemoteStateDto>;
      /** Take this Mac off its relay account and start over. */
      remoteLeaveAccount: Request<Record<string, never>, RemoteStateDto>;
      /** After the relay removed this Mac: a new identity, no phones. */
      remoteStartOver: Request<Record<string, never>, RemoteStateDto>;
      remoteActivity: Request<Record<string, never>, RemoteActivityDto[]>;
      workspaceCreate: Request<
        {
          name: string;
          slug?: string;
          path?: string;
          /** A profile id, or null for the default account. */
          defaultClaudeAccount?: string | null;
          defaultCodexAccount?: string | null;
        },
        WorkspaceDto
      >;
      workspaceGet: Request<{ reference: string }, WorkspaceDto>;
      workspaceUpdate: Request<
        {
          reference: string;
          name?: string;
          slug?: string;
          startSetsInProgress?: boolean;
          /** 10 to 100, or null to turn automatic handoff off. */
          autoHandoffPercent?: number | null;
          defaultProvider?: "claude" | "codex" | null;
          defaultModel?: string | null;
          /** A profile id, or null for the default account. */
          defaultClaudeAccount?: string | null;
          defaultCodexAccount?: string | null;
        },
        WorkspaceDto
      >;
      workspaceRemove: Request<
        { reference: string; deleteFiles: boolean; force: true },
        { workspace: WorkspaceDto; filesDeleted: boolean }
      >;
      /**
       * The new order of the workspaces named, which may be a subset — the
       * ones left out keep their places. Returns the whole list as it now
       * stands.
       */
      workspaceReorder: Request<{ references: string[] }, WorkspaceDto[]>;
      workspaceArchive: Request<{ reference: string }, WorkspaceDto>;
      workspaceRestore: Request<{ reference: string }, WorkspaceDto>;
      /** Archived workspaces only; deletes the folder and everything in it. */
      workspaceDelete: Request<{ reference: string }, WorkspaceDto>;
      workspaceContentGet: Request<{ workspace: string }, WorkspaceContentDto>;
      workspaceDirectoryList: Request<
        { workspace: string; path?: string },
        WorkspaceFileEntryDto[]
      >;
      workspaceFileRead: Request<
        { workspace: string; path: string },
        WorkspaceFileDto
      >;
      workspaceFileWrite: Request<
        {
          workspace: string;
          path: string;
          content: string;
          expectedContent: string;
        },
        WorkspaceFileDto
      >;
      workspaceEntryCreate: Request<
        {
          workspace: string;
          parentPath?: string;
          name: string;
          kind: "file" | "directory";
        },
        WorkspaceFileEntryDto
      >;
      /** `name` is one path segment; crossing folders is `workspaceEntryMove`. */
      workspaceEntryRename: Request<
        { workspace: string; path: string; name: string },
        WorkspaceFileEntryDto
      >;
      /** `destinationPath` is a folder, or `""` for the workspace root. */
      workspaceEntryMove: Request<
        { workspace: string; path: string; destinationPath: string },
        WorkspaceFileEntryDto
      >;
      /**
       * Recursive for a folder. Moves it to Daedalus's trash and returns the
       * entry as it was, with the `trashId` that restores it.
       */
      workspaceEntryRemove: Request<
        { workspace: string; path: string },
        WorkspaceFileEntryDto & { trashId: string }
      >;
      /** Puts a removed entry back where it was. */
      workspaceEntryRestore: Request<
        { workspace: string; trashId: string },
        WorkspaceFileEntryDto
      >;
      /**
       * Copies absolute paths (workspace entries or files from Finder) into a
       * workspace folder; a taken name gets a " copy" suffix.
       */
      /** Each session worktree's changes since it branched from its base. */
      workspaceChanges: Request<{ workspace: string }, WorktreeChangesDto[]>;
      /** A changed file as it was at its worktree's base, for a diff. */
      workspaceChangeOriginal: Request<
        {
          workspace: string;
          root: string;
          repositoryPath: string;
          /** A commit, or `<sha>^` for its parent; the base when absent. */
          ref?: string;
        },
        { content: string; binary: boolean }
      >;
      /** The commits a session worktree made since it branched, newest first. */
      workspaceCommits: Request<
        { workspace: string; root: string },
        WorktreeCommitDto[]
      >;
      /** The files one commit of a session worktree changed. */
      workspaceCommitFiles: Request<
        { workspace: string; root: string; sha: string },
        ChangedFileDto[]
      >;
      /** Where a path printed in a terminal points, if it is a workspace file. */
      fileLinkResolve: Request<
        { path: string; baseDirectories: string[] },
        FileLinkTargetDto | null
      >;
      workspaceEntriesCopy: Request<
        { workspace: string; sources: string[]; destinationPath: string },
        WorkspaceFileEntryDto[]
      >;
      /**
       * Names the workspaces whose files the window is showing, which is the
       * only thing the host needs in order to watch the right trees. An empty
       * list stops watching — a view that is not the explorer has no tree to
       * keep fresh, and a watcher is a kernel resource.
       */
      workspaceWatchSet: Request<
        { workspaces: string[] },
        { watching: string[] }
      >;
      workspaceInstructionFilesSet: Request<
        { enabled: boolean },
        { enabled: boolean }
      >;
      autoRestoreSessionsSet: Request<
        { enabled: boolean },
        { enabled: boolean }
      >;
      trustSessionFoldersSet: Request<
        { enabled: boolean },
        { enabled: boolean }
      >;
      focusModeSet: Request<{ enabled: boolean }, { enabled: boolean }>;
      /**
       * The skill system. Global, so none of these takes a workspace: a skill
       * is installed once and applies to every session on the machine.
       */
      skillList: Request<Record<string, never>, SkillListingDto>;
      skillSet: Request<
        { id: string; enabled: boolean; mode?: "on-demand" | "always" },
        ManagedSkillDto
      >;
      skillVisibilitySet: Request<
        {
          name: string;
          visibility: "on" | "off";
        },
        { name: string; visibility: string }
      >;
      skillRemove: Request<{ name: string }, { removed: string }>;
      /** The text of one discovered SKILL.md, for the viewer in the panel. */
      skillRead: Request<
        { path: string },
        { path: string; content: string; truncated: boolean }
      >;
      skillDoctor: Request<
        Record<string, never>,
        { findings: SkillDoctorFindingDto[] }
      >;
      /**
       * Acknowledges that the quit dialog is on screen. The host quits on its
       * own if this never arrives, so a renderer that cannot draw the dialog
       * degrades to today's keep-everything-running quit rather than to a
       * Cmd+Q that does nothing.
       */
      quitDialogShown: Request<Record<string, never>, { acknowledged: true }>;
      /** The user's answer. `cancel` is the only one that does not quit. */
      quitDecision: Request<{ choice: QuitChoice }, { accepted: true }>;
      /**
       * The update prompt as it stands, for a window that opens after the
       * host's check already ran. Changes after that arrive as
       * `appUpdateChanged`.
       */
      appUpdateGet: Request<Record<string, never>, AppUpdateDto | null>;
      /** Checks now and reports even when nothing is newer. */
      appUpdateCheck: Request<Record<string, never>, AppUpdateDto | null>;
      /**
       * Downloads the offered version, replaces the app and reopens it.
       * Sessions keep running, as with any quit.
       */
      appUpdateInstall: Request<Record<string, never>, AppUpdateDto | null>;
      /**
       * Hides the prompt. For an offered `version` it stays hidden until a
       * newer one is released; without one it only clears a result.
       */
      appUpdateDismiss: Request<{ version?: string }, AppUpdateDto | null>;
      /**
       * Published by the renderer whenever the user moves, so notifications
       * can route on where the user actually is rather than merely being
       * suppressed when the window has focus.
       */
      presencePublish: Request<
        {
          appForeground: boolean;
          workspaceId: string | null;
          sessionId: string | null;
        },
        PresenceStateDto
      >;
      attentionRaise: Request<
        { sessionId: string; reason: string },
        SessionAttentionDto | null
      >;
      /** All-or-nothing, and never suppressed: see `SessionAttentionDto`. */
      attentionClear: Request<{ sessionId: string }, { cleared: number }>;
      toastsAcknowledge: Request<{ ids: string[] }, { acknowledged: number }>;
      workspaceRepositoryAttach: Request<
        {
          workspace: string;
          libraryRepositoryId: string;
        },
        WorkspaceRepositoryDto
      >;
      /**
       * Attaches without waiting for the clone: the row comes back
       * `preparing` and becomes `ready` or `failed` on its own.
       */
      repositoryAddAndAttachStart: Request<
        {
          workspace: string;
          remoteUrl: string;
          name?: string;
          githubNameWithOwner?: string;
        },
        WorkspaceRepositoryDto
      >;
      /**
       * Cloning and attaching in one call. Two calls meant the attach half
       * re-fetched the clone the add half had just made.
       */
      repositoryAddAndAttach: Request<
        {
          workspace: string;
          remoteUrl: string;
          name?: string;
          githubNameWithOwner?: string;
        },
        WorkspaceRepositoryDto
      >;
      workspaceRepositorySync: Request<{ id: string }, WorkspaceRepositoryDto>;
      /** Fetches, and moves the workspace checkout to the fetched tip. */
      workspaceRepositoryFetch: Request<{ id: string }, WorkspaceRepositoryDto>;
      /**
       * Fetches every repository in a workspace, or the ones named, and says
       * what each checkout took.
       */
      workspaceRepositoriesFetch: Request<
        {
          workspace: string;
          ids?: string[];
          /** Also move each checkout to the latest base branch (default). */
          pull?: boolean;
        },
        RepositoryFetchOutcomeDto[]
      >;
      /**
       * Removing a working tree destroys whatever is only in it, so without
       * `force` it succeeds only when nothing can be lost.
       */
      sessionWorktreeRemove: Request<
        { session: string; repository: string; force?: boolean },
        SessionWorktreeDto
      >;
      /**
       * Opens the worktree in the first editor installed (VS Code, Cursor,
       * Zed), or in Finder. The path comes from the registry, not the caller.
       */
      sessionWorktreeOpen: Request<
        { session: string; repository: string },
        { path: string; openedWith: string }
      >;
      /** Publishes an agent's branch. Never implicit: only this call pushes. */
      sessionWorktreePush: Request<
        { session: string; repository: string },
        { worktree: SessionWorktreeDto; alreadyUpToDate: boolean }
      >;
      repositoryLibraryAdd: Request<
        {
          remoteUrl: string;
          name?: string;
          githubNameWithOwner?: string;
        },
        RepositoryLibraryDto
      >;
      repositoryDiscovery: Request<
        Record<string, never>,
        RepositoryDiscoveryDto
      >;
      workspaceRepositoryDetach: Request<
        { id: string },
        WorkspaceRepositoryDto
      >;
      workspaceJournalAppend: Request<
        {
          workspace: string;
          kind:
            | "decision"
            | "progress"
            | "blocker"
            | "question"
            | "handoff"
            | "completed";
          summary: string;
        },
        WorkspaceContentDto
      >;
      taskCreate: Request<
        {
          workspace: string;
          title: string;
          description?: string;
          priority?: TaskPriority;
        },
        TaskDto
      >;
      taskGet: Request<{ id: string }, TaskDto>;
      taskUpdate: Request<
        {
          id: string;
          title?: string;
          description?: string;
          priority?: TaskPriority;
        },
        TaskDto
      >;
      taskSetStatus: Request<{ id: string; status: TaskStatus }, TaskDto>;
      /**
       * Assembled on demand, so it is a request rather than a snapshot field:
       * it reads `JOURNAL.md` and would otherwise ride along on every tick.
       */
      taskTimeline: Request<{ id: string }, TaskTimelineDto>;
      taskRemove: Request<{ id: string; force: true }, TaskDto>;
      agentGet: Request<{ id: string }, AgentSessionDto>;
      agentSpawn: Request<
        {
          workspace: string;
          taskId?: string;
          name?: string;
          provider?: "codex" | "claude";
          model?: string;
          /** A profile id, or `default`. Omitted: the workspace's default. */
          account?: string;
          message?: string;
          command?: string;
          terminal?: boolean;
          abilities?: AbilityIdDto[];
          color?: SessionColorDto;
          pinned?: boolean;
          /**
           * Joins this team as a member the user added; `message` holds its
           * instructions, and the lead is told. The workspace and provider
           * are the lead's.
           */
          teamId?: string;
        },
        AgentSessionDto
      >;
      agentModels: Request<
        { provider: "codex" | "claude"; account?: string },
        ProviderModelCatalogDto
      >;
      /**
       * Asks each provider about its accounts' logins now. A few tenths of a
       * second per account, so it is its own request rather than part of
       * every snapshot.
       */
      accountStatus: Request<
        { provider?: "claude" | "codex"; account?: string },
        AccountStatusDto[]
      >;
      accountAdd: Request<
        {
          provider: "claude" | "codex";
          name: string;
          kind?: "login" | "api-key";
          /** Claude login accounts: which login Sign in will run. */
          login?: ClaudeLoginDto;
        },
        AccountDto
      >;
      /** Sets which login an account's Sign in runs (Claude). */
      accountSetLogin: Request<
        { provider: "claude"; account: string; login: ClaudeLoginDto },
        { provider: "claude" | "codex"; account: string; login: ClaudeLoginDto }
      >;
      /**
       * The secrets a workspace's commands can use: its own, then the global
       * ones. With a null workspace, only the global ones.
       */
      secretList: Request<{ workspaceId: string | null }, SecretDto[]>;
      /** Adds a secret or replaces its value; null is global. */
      secretSet: Request<
        { workspaceId: string | null; name: string; value: string },
        SecretDto
      >;
      secretRemove: Request<
        { workspaceId: string | null; name: string },
        { name: string }
      >;
      /** One secret's value, read from the Keychain for the user to see. */
      secretReveal: Request<
        { workspaceId: string | null; name: string },
        { value: string }
      >;
      /** Stores an API-key account's key in the Keychain. */
      accountSetApiKey: Request<
        { provider: "claude"; account: string; key: string },
        AccountDto
      >;
      accountRename: Request<
        { provider: "claude" | "codex"; account: string; name: string },
        AccountDto
      >;
      /** Signs the account out and deletes its folder. */
      accountRemove: Request<
        {
          provider: "claude" | "codex";
          account: string;
          /** Archive the sessions running on it first, instead of refusing. */
          archiveSessions?: boolean;
        },
        AccountDto
      >;
      /**
       * Opens the provider's own sign-in for one account in an integrated
       * terminal, and returns that terminal so the app can show it.
       */
      accountSignIn: Request<
        {
          provider: "claude" | "codex";
          account: string;
          /** Claude only: its subscription, SSO or Console login. */
          variant?: "subscription" | "sso" | "console";
        },
        IntegratedTerminalDto
      >;
      accountSignOut: Request<
        { provider: "claude" | "codex"; account: string },
        { provider: "claude" | "codex"; account: string }
      >;
      agentSend: Request<{ id: string; text: string }, AgentSessionDto>;
      agentStop: Request<{ id: string; force: boolean }, AgentSessionDto>;
      agentRemove: Request<{ id: string }, AgentSessionDto>;
      /** Archived sessions only; deletes their worktrees and folder. */
      agentDelete: Request<{ id: string }, AgentSessionDto>;
      /** As `workspaceReorder`, scoped to one workspace's sessions. */
      agentReorder: Request<
        { workspace: string; sessionIds: string[] },
        AgentSessionDto[]
      >;
      agentArchive: Request<{ id: string; force?: boolean }, AgentSessionDto>;
      agentRestore: Request<{ id: string }, AgentSessionDto>;
      /**
       * Resumes a session that lost its tmux server, typically to a machine
       * reboot. Nothing is sent to the agent: it comes back idle at its
       * prompt with its history loaded.
       */
      agentRevive: Request<{ id: string }, AgentSessionDto>;
      /**
       * Asks a running agent to write a handoff note and continue its work
       * in a fresh session. The agent does the rest, so the new session
       * appears once it has written the note.
       */
      agentRequestHandoff: Request<{ id: string }, AgentSessionDto>;
      /**
       * Continues a session's work in a fresh one without a handoff note, for
       * an agent too far gone to write one. Returns the new session.
       */
      agentContinue: Request<{ id: string }, AgentSessionDto>;
      terminalCreate: Request<
        { workspace?: string; name?: string; workingDirectory?: string },
        IntegratedTerminalDto
      >;
      terminalClose: Request<{ id: string }, IntegratedTerminalDto>;
      openExternal: Request<{ url: string }, { opened: boolean }>;
      /**
       * Puts text on the system clipboard. A terminal program copies by
       * sending OSC 52, and the webview's own clipboard API refuses a write
       * that does not come straight from a click, which this never does.
       */
      clipboardWrite: Request<{ text: string }, { written: boolean }>;
      /** The files on the macOS pasteboard, as Finder's Copy leaves them. */
      clipboardFilesRead: Request<Record<string, never>, { paths: string[] }>;
      /** Puts files on the macOS pasteboard, so Finder can paste them. */
      clipboardFilesWrite: Request<{ paths: string[] }, { written: number }>;
      /**
       * Which window is asking: the main app, or the World on its own. Both
       * load the same page, and a `views://` URL carries no parameters, so a
       * page learns what to draw by asking.
       */
      windowRole: Request<Record<string, never>, { role: DesktopWindowRole }>;
      /** Opens the World in a window of its own, or brings it forward. */
      worldWindowOpen: Request<Record<string, never>, { opened: boolean }>;
      /**
       * Brings the main window forward on a session, for a click in the
       * World window: the session opens where its terminal lives.
       */
      sessionFocus: Request<{ sessionId: string }, { focused: boolean }>;
    };
    messages: Record<never, never>;
  };
  webview: {
    requests: {
      /** Electrobun's built-in renderer evaluator, used by packaged UI probes. */
      evaluateJavascriptWithResponse: {
        params: { script: string };
        response: unknown;
      };
    };
    messages: {
      dataChanged: { revision: number; source: "desktop" | "external" };
      /**
       * A workspace's files changed on disk. Already coalesced and debounced
       * by the host; `overflow` means the batch was too large to describe and
       * `changes` is empty, so the renderer should re-read what it is showing
       * rather than trust a partial list.
       */
      workspaceFilesChanged: {
        workspaceId: string;
        changes: WorkspaceFileChangeDto[];
        overflow: boolean;
      };
      command: { command: DesktopCommand };
      windowResized: { width: number; height: number };
      /**
       * Raised by `daedal focus`, which is what a clicked notification runs.
       * Without the deep link people learn to ignore notifications.
       */
      focusSession: { sessionId: string };
      /** The same, for a clicked routine notification: opens its task. */
      focusTask: { taskId: string };
      /**
       * Quit was requested while something was still live. The renderer draws
       * the dialog and answers with `quitDecision`; the host has already
       * decided that asking is the right thing to do.
       */
      quitRequested: { plan: ShutdownPlanDto };
      /** The update prompt changed; `null` hides it. */
      appUpdateChanged: { update: AppUpdateDto | null };
    };
  };
}

/**
 * Menu actions the host handles itself rather than forwarding to the window.
 * `{ role: "quit" }` is a native macOS role that never reaches our code, so
 * the quit item carries an action instead.
 */
export const QUIT_MENU_ACTION = "quit-requested";
export const SHUTDOWN_MENU_ACTION = "quit-and-shut-down";
export const CHECK_FOR_UPDATES_MENU_ACTION = "check-for-updates";
export const OPEN_WORLD_WINDOW_MENU_ACTION = "open-world-window";

export const DESKTOP_COMMANDS = [
  "view-board",
  "view-session",
  "view-workspace",
  "view-world",
  "toggle-terminal",
] as const;

export type DesktopCommand = (typeof DESKTOP_COMMANDS)[number];

export const isDesktopCommand = (value: unknown): value is DesktopCommand =>
  typeof value === "string" &&
  (DESKTOP_COMMANDS as readonly string[]).includes(value);

export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type TerminalServerMessage =
  | {
      type: "status";
      status: "live" | "reconnected" | "exited" | "lost";
      agentId: string;
    }
  | { type: "overflow"; droppedBytes: number }
  | { type: "error"; message: string };

export interface DoctorCheck {
  name: string;
  ok: boolean;
  version?: string;
  detail: string;
}

export interface CliSuccess<T> {
  ok: true;
  data: T;
}

export type CliFailure = RpcFailure;

export type CliEnvelope<T> = CliSuccess<T> | CliFailure;

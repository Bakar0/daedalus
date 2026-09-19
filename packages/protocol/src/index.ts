export type ErrorCode =
  "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "DEPENDENCY" | "INTERNAL";

export type TaskStatus =
  "todo" | "in_progress" | "blocked" | "done" | "cancelled";
export type TaskPriority = "low" | "normal" | "high";
export type AgentProviderName = "claude" | "codex" | "custom";
export type AgentSessionStatus = "starting" | "running" | "exited" | "lost";
export type SessionKind = "agent" | "terminal";

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
  /** Manual list order within the workspace, ascending. */
  position: number;
}

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
  changedFiles: number;
  ahead: number;
  behind: number;
}

export interface SessionWorktreeDto {
  sessionId: string;
  repositoryId: string;
  path: string;
  branchName: string;
  createdAt: string;
  gitStatus?: GitStatusDto;
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

/** See `QuitBehavior` in core: whether Cmd+Q confirms before closing. */
export type QuitBehavior = "keep" | "ask";

/** The quit dialog only confirms. `cancel` leaves the app open. */
export type QuitChoice = "keep" | "cancel";

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
  focusMode: boolean;
  quitBehavior: QuitBehavior;
  providers: ProviderAvailabilityDto[];
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
  context?: {
    usedTokens: number;
    totalTokens?: number;
    usedPercent?: number;
  };
  observedAt: string;
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
  toasts: ToastDto[];
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

/** Stable contract shared by Electrobun's Bun and renderer runtimes. */
export interface DesktopRpcSchema {
  bun: {
    requests: {
      snapshot: Request<Record<string, never>, DesktopSnapshotDto>;
      /**
       * The loopback WebSocket the renderer attaches terminals to. It carries
       * a per-launch token, and the `views://` handler resolves a URL as a
       * resource path — a query string or fragment makes the page itself fail
       * to load — so it is fetched over RPC rather than passed in the URL.
       */
      terminalEndpoint: Request<Record<string, never>, { endpoint: string }>;
      workspaceCreate: Request<
        { name: string; slug?: string; path?: string },
        WorkspaceDto
      >;
      workspaceGet: Request<{ reference: string }, WorkspaceDto>;
      workspaceUpdate: Request<
        { reference: string; name?: string; slug?: string },
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
      workspaceInstructionFilesSet: Request<
        { enabled: boolean },
        { enabled: boolean }
      >;
      autoRestoreSessionsSet: Request<
        { enabled: boolean },
        { enabled: boolean }
      >;
      focusModeSet: Request<{ enabled: boolean }, { enabled: boolean }>;
      quitBehaviorSet: Request<
        { behavior: QuitBehavior },
        { behavior: QuitBehavior }
      >;
      /**
       * Acknowledges that the quit dialog is on screen. The host quits on its
       * own if this never arrives, so a renderer that cannot draw the dialog
       * degrades to today's keep-everything-running quit rather than to a
       * Cmd+Q that does nothing.
       */
      quitDialogShown: Request<Record<string, never>, { acknowledged: true }>;
      /** The user's answer. `cancel` is the only one that does not quit. */
      quitDecision: Request<
        { choice: QuitChoice; remember: boolean },
        { accepted: true }
      >;
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
      /** Updates the shared clone only; no working tree is touched. */
      workspaceRepositoryFetch: Request<{ id: string }, WorkspaceRepositoryDto>;
      /**
       * Removing a working tree destroys whatever is only in it, so without
       * `force` it succeeds only when nothing can be lost.
       */
      sessionWorktreeRemove: Request<
        { session: string; repository: string; force?: boolean },
        SessionWorktreeDto
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
      taskRemove: Request<{ id: string; force: true }, TaskDto>;
      agentGet: Request<{ id: string }, AgentSessionDto>;
      agentSpawn: Request<
        {
          workspace: string;
          taskId?: string;
          name?: string;
          provider?: "codex" | "claude";
          model?: string;
          message?: string;
          command?: string;
          terminal?: boolean;
        },
        AgentSessionDto
      >;
      agentModels: Request<
        { provider: "codex" | "claude" },
        ProviderModelCatalogDto
      >;
      agentSend: Request<{ id: string; text: string }, AgentSessionDto>;
      agentStop: Request<{ id: string; force: boolean }, AgentSessionDto>;
      agentRemove: Request<{ id: string }, AgentSessionDto>;
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
      terminalCreate: Request<
        { workspace?: string; name?: string; workingDirectory?: string },
        IntegratedTerminalDto
      >;
      terminalClose: Request<{ id: string }, IntegratedTerminalDto>;
      openExternal: Request<{ url: string }, { opened: boolean }>;
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
      command: { command: DesktopCommand };
      windowResized: { width: number; height: number };
      /**
       * Raised by `daedal focus`, which is what a clicked notification runs.
       * Without the deep link people learn to ignore notifications.
       */
      focusSession: { sessionId: string };
      /**
       * Quit was requested while something was still live. The renderer draws
       * the dialog and answers with `quitDecision`; the host has already
       * decided that asking is the right thing to do.
       */
      quitRequested: { plan: ShutdownPlanDto };
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

export const DESKTOP_COMMANDS = [
  "view-board",
  "view-sessions",
  "view-workspace",
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

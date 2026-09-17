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
}

export interface IntegratedTerminalDto {
  id: string;
  name: string;
  tmuxSession: string;
  workingDirectory: string;
  status: AgentSessionStatus;
  startedAt: string;
  endedAt: string | null;
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
  gitStatus?: {
    state:
      "clean" | "modified" | "ahead" | "behind" | "diverged" | "unavailable";
    changedFiles: number;
    ahead: number;
    behind: number;
  };
}

export interface SessionWorktreeDto {
  sessionId: string;
  repositoryId: string;
  path: string;
  branchName: string;
  createdAt: string;
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

export interface DesktopSettingsDto {
  home: string;
  workspaceRoot: string;
  databasePath: string;
  repositoryRoot: string;
  tmuxAvailable: boolean;
  tmuxVersion?: string;
  workspaceInstructionFilesEnabled: boolean;
  focusMode: boolean;
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
  source: AgentActivitySource;
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
      focusModeSet: Request<{ enabled: boolean }, { enabled: boolean }>;
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
      workspaceRepositorySync: Request<{ id: string }, WorkspaceRepositoryDto>;
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
      agentArchive: Request<{ id: string; force?: boolean }, AgentSessionDto>;
      agentRestore: Request<{ id: string }, AgentSessionDto>;
      terminalCreate: Request<
        { workspace?: string; name?: string },
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
    };
  };
}

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

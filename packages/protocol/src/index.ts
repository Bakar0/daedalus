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
}

export interface ProviderAvailabilityDto {
  name: string;
  executable: string;
  available: boolean;
}

export interface DesktopSettingsDto {
  home: string;
  workspaceRoot: string;
  databasePath: string;
  tmuxAvailable: boolean;
  tmuxVersion?: string;
  providers: ProviderAvailabilityDto[];
}

export interface DesktopSnapshotDto {
  workspaces: WorkspaceDto[];
  tasks: TaskDto[];
  agents: AgentSessionDto[];
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
          command?: string;
          terminal?: boolean;
        },
        AgentSessionDto
      >;
      agentSend: Request<{ id: string; text: string }, AgentSessionDto>;
      agentStop: Request<{ id: string; force: boolean }, AgentSessionDto>;
      agentRemove: Request<{ id: string }, AgentSessionDto>;
    };
    messages: Record<never, never>;
  };
  webview: {
    requests: Record<never, never>;
    messages: {
      dataChanged: { revision: number; source: "desktop" | "external" };
    };
  };
}

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

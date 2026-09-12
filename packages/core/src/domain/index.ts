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
}

export interface Task {
  id: UUID;
  workspaceId: UUID;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type AgentSessionStatus = "starting" | "running" | "exited" | "lost";

export interface AgentSession {
  id: UUID;
  workspaceId: UUID;
  taskId: UUID | null;
  provider: AgentProviderName;
  tmuxSession: string;
  command: string;
  args: string[];
  workingDirectory: string;
  status: AgentSessionStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

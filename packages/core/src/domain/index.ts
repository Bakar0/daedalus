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

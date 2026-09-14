import { Database } from "bun:sqlite";
import type {
  AgentSession,
  AgentSessionStatus,
  IntegratedTerminal,
  RepositoryLibraryEntry,
  SessionWorktree,
  Task,
  TaskPriority,
  TaskStatus,
  Workspace,
  WorkspaceRepository,
  WorkspaceRepositoryAccess,
} from "../domain";

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  path: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface TaskIdRow {
  task_number: number;
}

interface TaskRow {
  id: string;
  workspace_id: string;
  number: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface AgentRow {
  id: string;
  workspace_id: string;
  task_id: string | null;
  name: string;
  provider: "claude" | "codex" | "custom";
  kind: "agent" | "terminal";
  tmux_session: string;
  command: string;
  args: string;
  working_directory: string;
  status: AgentSessionStatus;
  exit_code: number | null;
  started_at: string;
  ended_at: string | null;
  provider_session_id: string | null;
  archived_at: string | null;
  resume_count: number;
}

interface IntegratedTerminalRow {
  id: string;
  name: string;
  tmux_session: string;
  command: string;
  args: string;
  working_directory: string;
  status: AgentSessionStatus;
  exit_code: number | null;
  started_at: string;
  ended_at: string | null;
}

interface WorkspaceRepositoryRow {
  id: string;
  workspace_id: string;
  name: string;
  canonical_path: string;
  access: WorkspaceRepositoryAccess;
  library_repository_id: string | null;
  reference_path: string | null;
  base_branch: string | null;
  base_commit: string | null;
  fetched_at: string | null;
  created_at: string;
}

interface RepositoryLibraryRow {
  id: string;
  name: string;
  remote_url: string;
  git_directory: string;
  default_branch: string;
  last_fetched_at: string;
  created_at: string;
}

interface SessionWorktreeRow {
  session_id: string;
  repository_id: string;
  path: string;
  branch_name: string;
  created_at: string;
}

const workspaceFromRow = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  path: row.path,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at,
});

const taskFromRow = (row: TaskRow): Task => ({
  id: row.id,
  workspaceId: row.workspace_id,
  number: row.number,
  title: row.title,
  description: row.description,
  status: row.status,
  priority: row.priority,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

const agentFromRow = (row: AgentRow): AgentSession => ({
  id: row.id,
  workspaceId: row.workspace_id,
  taskId: row.task_id,
  name: row.name,
  provider: row.provider,
  kind: row.kind,
  tmuxSession: row.tmux_session,
  command: row.command,
  args: JSON.parse(row.args) as string[],
  workingDirectory: row.working_directory,
  status: row.status,
  exitCode: row.exit_code,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  providerSessionId: row.provider_session_id,
  archivedAt: row.archived_at,
  resumeCount: row.resume_count,
});

const integratedTerminalFromRow = (
  row: IntegratedTerminalRow,
): IntegratedTerminal => ({
  id: row.id,
  name: row.name,
  tmuxSession: row.tmux_session,
  command: row.command,
  args: JSON.parse(row.args) as string[],
  workingDirectory: row.working_directory,
  status: row.status,
  exitCode: row.exit_code,
  startedAt: row.started_at,
  endedAt: row.ended_at,
});

const workspaceRepositoryFromRow = (
  row: WorkspaceRepositoryRow,
): WorkspaceRepository => ({
  id: row.id,
  workspaceId: row.workspace_id,
  name: row.name,
  canonicalPath: row.canonical_path,
  access: row.access,
  libraryRepositoryId: row.library_repository_id,
  referencePath: row.reference_path,
  baseBranch: row.base_branch,
  baseCommit: row.base_commit,
  fetchedAt: row.fetched_at,
  createdAt: row.created_at,
});

const repositoryLibraryFromRow = (
  row: RepositoryLibraryRow,
): RepositoryLibraryEntry => ({
  id: row.id,
  name: row.name,
  remoteUrl: row.remote_url,
  gitDirectory: row.git_directory,
  defaultBranch: row.default_branch,
  lastFetchedAt: row.last_fetched_at,
  createdAt: row.created_at,
});

const sessionWorktreeFromRow = (row: SessionWorktreeRow): SessionWorktree => ({
  sessionId: row.session_id,
  repositoryId: row.repository_id,
  path: row.path,
  branchName: row.branch_name,
  createdAt: row.created_at,
});

export class SqliteRepositories {
  readonly database: Database;

  constructor(databasePath: string) {
    this.database = new Database(databasePath, { create: true });
    this.database.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
    );
  }

  close(): void {
    this.database.close();
  }

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }

  createWorkspace(workspace: Workspace): void {
    this.database
      .query(
        `INSERT INTO workspaces
         (id, slug, name, path, created_at, updated_at, archived_at,
          task_id_prefix)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspace.id,
        workspace.slug,
        workspace.name,
        workspace.path,
        workspace.createdAt,
        workspace.updatedAt,
        workspace.archivedAt,
        workspace.slug,
      );
  }

  listWorkspaces(): Workspace[] {
    return this.database
      .query<WorkspaceRow, []>(
        "SELECT * FROM workspaces ORDER BY created_at, id",
      )
      .all()
      .map(workspaceFromRow);
  }

  findWorkspace(reference: string): Workspace | undefined {
    const byId = this.database
      .query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ?")
      .get(reference);
    const row =
      byId ??
      this.database
        .query<WorkspaceRow, [string]>(
          "SELECT * FROM workspaces WHERE slug = ?",
        )
        .get(reference);
    return row ? workspaceFromRow(row) : undefined;
  }

  updateWorkspace(workspace: Workspace): void {
    this.database
      .query(
        "UPDATE workspaces SET slug = ?, name = ?, path = ?, updated_at = ?, archived_at = ? WHERE id = ?",
      )
      .run(
        workspace.slug,
        workspace.name,
        workspace.path,
        workspace.updatedAt,
        workspace.archivedAt,
        workspace.id,
      );
  }

  deleteWorkspace(id: string): void {
    this.database.query("DELETE FROM workspaces WHERE id = ?").run(id);
  }

  createWorkspaceRepository(repository: WorkspaceRepository): void {
    this.database
      .query(
        `INSERT INTO workspace_repositories
         (id, workspace_id, name, canonical_path, access,
          library_repository_id, reference_path, base_branch, base_commit,
          fetched_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repository.id,
        repository.workspaceId,
        repository.name,
        repository.canonicalPath,
        repository.access,
        repository.libraryRepositoryId,
        repository.referencePath,
        repository.baseBranch,
        repository.baseCommit,
        repository.fetchedAt,
        repository.createdAt,
      );
  }

  updateWorkspaceRepository(repository: WorkspaceRepository): void {
    this.database
      .query(
        `UPDATE workspace_repositories
         SET name = ?, canonical_path = ?, access = ?,
             library_repository_id = ?, reference_path = ?, base_branch = ?,
             base_commit = ?, fetched_at = ?
         WHERE id = ?`,
      )
      .run(
        repository.name,
        repository.canonicalPath,
        repository.access,
        repository.libraryRepositoryId,
        repository.referencePath,
        repository.baseBranch,
        repository.baseCommit,
        repository.fetchedAt,
        repository.id,
      );
  }

  createRepositoryLibraryEntry(repository: RepositoryLibraryEntry): void {
    this.database
      .query(
        `INSERT INTO repository_library
         (id, name, remote_url, git_directory, default_branch, last_fetched_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repository.id,
        repository.name,
        repository.remoteUrl,
        repository.gitDirectory,
        repository.defaultBranch,
        repository.lastFetchedAt,
        repository.createdAt,
      );
  }

  updateRepositoryLibraryEntry(repository: RepositoryLibraryEntry): void {
    this.database
      .query(
        `UPDATE repository_library SET name = ?, default_branch = ?,
         last_fetched_at = ? WHERE id = ?`,
      )
      .run(
        repository.name,
        repository.defaultBranch,
        repository.lastFetchedAt,
        repository.id,
      );
  }

  listRepositoryLibrary(): RepositoryLibraryEntry[] {
    return this.database
      .query<RepositoryLibraryRow, []>(
        "SELECT * FROM repository_library ORDER BY name COLLATE NOCASE, created_at, id",
      )
      .all()
      .map(repositoryLibraryFromRow);
  }

  findRepositoryLibraryEntry(
    reference: string,
  ): RepositoryLibraryEntry | undefined {
    const row = this.database
      .query<RepositoryLibraryRow, [string, string]>(
        "SELECT * FROM repository_library WHERE id = ? OR remote_url = ?",
      )
      .get(reference, reference);
    return row ? repositoryLibraryFromRow(row) : undefined;
  }

  listWorkspaceRepositories(workspaceId?: string): WorkspaceRepository[] {
    const rows = workspaceId
      ? this.database
          .query<WorkspaceRepositoryRow, [string]>(
            "SELECT * FROM workspace_repositories WHERE workspace_id = ? ORDER BY created_at, id",
          )
          .all(workspaceId)
      : this.database
          .query<WorkspaceRepositoryRow, []>(
            "SELECT * FROM workspace_repositories ORDER BY created_at, id",
          )
          .all();
    return rows.map(workspaceRepositoryFromRow);
  }

  findWorkspaceRepository(id: string): WorkspaceRepository | undefined {
    const row = this.database
      .query<WorkspaceRepositoryRow, [string]>(
        "SELECT * FROM workspace_repositories WHERE id = ?",
      )
      .get(id);
    return row ? workspaceRepositoryFromRow(row) : undefined;
  }

  deleteWorkspaceRepository(id: string): void {
    this.database
      .query("DELETE FROM workspace_repositories WHERE id = ?")
      .run(id);
  }

  createSessionWorktree(worktree: SessionWorktree): void {
    this.database
      .query(
        `INSERT INTO session_worktrees
         (session_id, repository_id, path, branch_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        worktree.sessionId,
        worktree.repositoryId,
        worktree.path,
        worktree.branchName,
        worktree.createdAt,
      );
  }

  listSessionWorktrees(
    filters: {
      sessionId?: string;
      workspaceId?: string;
    } = {},
  ): SessionWorktree[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filters.sessionId) {
      clauses.push("session_worktrees.session_id = ?");
      values.push(filters.sessionId);
    }
    if (filters.workspaceId) {
      clauses.push("workspace_repositories.workspace_id = ?");
      values.push(filters.workspaceId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .query<SessionWorktreeRow, string[]>(
        `SELECT session_worktrees.* FROM session_worktrees
         JOIN workspace_repositories ON workspace_repositories.id = session_worktrees.repository_id
         ${where} ORDER BY session_worktrees.created_at, session_worktrees.path`,
      )
      .all(...values)
      .map(sessionWorktreeFromRow);
  }

  createTask(task: Task): void {
    this.database
      .query(
        `INSERT INTO tasks
         (id, workspace_id, number, title, description, status, priority,
          created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.workspaceId,
        task.number,
        task.title,
        task.description,
        task.status,
        task.priority,
        task.createdAt,
        task.updatedAt,
        task.completedAt,
      );
  }

  createNumberedTask(task: Omit<Task, "id" | "number">): Task {
    return this.transaction(() => {
      const allocated = this.database
        .query<TaskIdRow, [string]>(
          `UPDATE workspaces
           SET next_task_number = next_task_number + 1
           WHERE id = ?
           RETURNING next_task_number - 1 AS task_number`,
        )
        .get(task.workspaceId);
      if (!allocated)
        throw new Error(
          `Workspace '${task.workspaceId}' has no task ID sequence`,
        );
      const created: Task = {
        ...task,
        id: crypto.randomUUID(),
        number: allocated.task_number,
      };
      this.createTask(created);
      return created;
    });
  }

  listTasks(filters: { workspaceId?: string; status?: TaskStatus }): Task[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filters.workspaceId) {
      clauses.push("workspace_id = ?");
      values.push(filters.workspaceId);
    }
    if (filters.status) {
      clauses.push("status = ?");
      values.push(filters.status);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .query<TaskRow, string[]>(
        `SELECT * FROM tasks${where} ORDER BY created_at, id`,
      )
      .all(...values)
      .map(taskFromRow);
  }

  findTask(id: string): Task | undefined {
    const row = this.database
      .query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?")
      .get(id);
    return row ? taskFromRow(row) : undefined;
  }

  findTaskByNumber(workspaceId: string, number: number): Task | undefined {
    const row = this.database
      .query<TaskRow, [string, number]>(
        "SELECT * FROM tasks WHERE workspace_id = ? AND number = ?",
      )
      .get(workspaceId, number);
    return row ? taskFromRow(row) : undefined;
  }

  updateTask(task: Task): void {
    this.database
      .query(
        `UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?,
         updated_at = ?, completed_at = ? WHERE id = ?`,
      )
      .run(
        task.title,
        task.description,
        task.status,
        task.priority,
        task.updatedAt,
        task.completedAt,
        task.id,
      );
  }

  deleteTask(id: string): void {
    this.database.query("DELETE FROM tasks WHERE id = ?").run(id);
  }

  createAgent(agent: AgentSession): void {
    this.database
      .query(
        `INSERT INTO agent_sessions
         (id, workspace_id, task_id, name, provider, kind, tmux_session, command, args,
          working_directory, status, exit_code, started_at, ended_at,
          provider_session_id, archived_at, resume_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.id,
        agent.workspaceId,
        agent.taskId,
        agent.name,
        agent.provider,
        agent.kind,
        agent.tmuxSession,
        agent.command,
        JSON.stringify(agent.args),
        agent.workingDirectory,
        agent.status,
        agent.exitCode,
        agent.startedAt,
        agent.endedAt,
        agent.providerSessionId,
        agent.archivedAt,
        agent.resumeCount,
      );
  }

  listAgents(
    filters: { workspaceId?: string; status?: AgentSessionStatus } = {},
  ): AgentSession[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filters.workspaceId) {
      clauses.push("workspace_id = ?");
      values.push(filters.workspaceId);
    }
    if (filters.status) {
      clauses.push("status = ?");
      values.push(filters.status);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .query<AgentRow, string[]>(
        `SELECT * FROM agent_sessions${where} ORDER BY started_at, id`,
      )
      .all(...values)
      .map(agentFromRow);
  }

  findAgent(id: string): AgentSession | undefined {
    const row = this.database
      .query<AgentRow, [string]>("SELECT * FROM agent_sessions WHERE id = ?")
      .get(id);
    return row ? agentFromRow(row) : undefined;
  }

  updateAgent(agent: AgentSession): void {
    this.database
      .query(
        `UPDATE agent_sessions SET tmux_session = ?, command = ?, args = ?,
         status = ?, exit_code = ?, started_at = ?, ended_at = ?,
         provider_session_id = ?, archived_at = ?, resume_count = ? WHERE id = ?`,
      )
      .run(
        agent.tmuxSession,
        agent.command,
        JSON.stringify(agent.args),
        agent.status,
        agent.exitCode,
        agent.startedAt,
        agent.endedAt,
        agent.providerSessionId,
        agent.archivedAt,
        agent.resumeCount,
        agent.id,
      );
  }

  deleteAgent(id: string): void {
    this.database.query("DELETE FROM agent_sessions WHERE id = ?").run(id);
  }

  createIntegratedTerminal(terminal: IntegratedTerminal): void {
    this.database
      .query(
        `INSERT INTO integrated_terminals
         (id, name, tmux_session, command, args, working_directory, status,
          exit_code, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        terminal.id,
        terminal.name,
        terminal.tmuxSession,
        terminal.command,
        JSON.stringify(terminal.args),
        terminal.workingDirectory,
        terminal.status,
        terminal.exitCode,
        terminal.startedAt,
        terminal.endedAt,
      );
  }

  listIntegratedTerminals(): IntegratedTerminal[] {
    return this.database
      .query<IntegratedTerminalRow, []>(
        "SELECT * FROM integrated_terminals ORDER BY started_at, id",
      )
      .all()
      .map(integratedTerminalFromRow);
  }

  findIntegratedTerminal(id: string): IntegratedTerminal | undefined {
    const row = this.database
      .query<IntegratedTerminalRow, [string]>(
        "SELECT * FROM integrated_terminals WHERE id = ?",
      )
      .get(id);
    return row ? integratedTerminalFromRow(row) : undefined;
  }

  updateIntegratedTerminal(terminal: IntegratedTerminal): void {
    this.database
      .query(
        `UPDATE integrated_terminals SET name = ?, tmux_session = ?, command = ?,
         args = ?, working_directory = ?, status = ?, exit_code = ?,
         started_at = ?, ended_at = ? WHERE id = ?`,
      )
      .run(
        terminal.name,
        terminal.tmuxSession,
        terminal.command,
        JSON.stringify(terminal.args),
        terminal.workingDirectory,
        terminal.status,
        terminal.exitCode,
        terminal.startedAt,
        terminal.endedAt,
        terminal.id,
      );
  }

  deleteIntegratedTerminal(id: string): void {
    this.database
      .query("DELETE FROM integrated_terminals WHERE id = ?")
      .run(id);
  }
}

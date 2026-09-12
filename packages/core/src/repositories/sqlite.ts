import { Database } from "bun:sqlite";
import type {
  AgentSession,
  AgentSessionStatus,
  Task,
  TaskPriority,
  TaskStatus,
  Workspace,
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

interface TaskRow {
  id: string;
  workspace_id: string;
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
         (id, slug, name, path, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspace.id,
        workspace.slug,
        workspace.name,
        workspace.path,
        workspace.createdAt,
        workspace.updatedAt,
        workspace.archivedAt,
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

  createTask(task: Task): void {
    this.database
      .query(
        `INSERT INTO tasks
         (id, workspace_id, title, description, status, priority, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.workspaceId,
        task.title,
        task.description,
        task.status,
        task.priority,
        task.createdAt,
        task.updatedAt,
        task.completedAt,
      );
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
         (id, workspace_id, task_id, provider, kind, tmux_session, command, args,
          working_directory, status, exit_code, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.id,
        agent.workspaceId,
        agent.taskId,
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
        "UPDATE agent_sessions SET status = ?, exit_code = ?, ended_at = ? WHERE id = ?",
      )
      .run(agent.status, agent.exitCode, agent.endedAt, agent.id);
  }

  deleteAgent(id: string): void {
    this.database.query("DELETE FROM agent_sessions WHERE id = ?").run(id);
  }
}

import type { Database } from "bun:sqlite";
import type {
  WorkspaceRoutine,
  WorkspaceRoutineRun,
  WorkspaceRoutineRunStatus,
  WorkspaceRoutineTrigger,
} from "../domain";

interface WorkspaceRoutineRow {
  id: string;
  name: string;
  workspace_id: string | null;
  schedule: string;
  prompt: string;
  model: string | null;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  run_requested_at: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkspaceRoutineRunRow {
  id: number;
  routine_id: string;
  trigger: WorkspaceRoutineTrigger;
  status: WorkspaceRoutineRunStatus;
  provider_session_id: string | null;
  working_directory: string;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
  continued_session_id: string | null;
}

const routineFromRow = (row: WorkspaceRoutineRow): WorkspaceRoutine => ({
  id: row.id,
  name: row.name,
  workspaceId: row.workspace_id,
  schedule: row.schedule,
  prompt: row.prompt,
  model: row.model,
  enabled: row.enabled === 1,
  nextRunAt: row.next_run_at,
  lastRunAt: row.last_run_at,
  runRequestedAt: row.run_requested_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const runFromRow = (row: WorkspaceRoutineRunRow): WorkspaceRoutineRun => ({
  id: row.id,
  routineId: row.routine_id,
  trigger: row.trigger,
  status: row.status,
  providerSessionId: row.provider_session_id,
  workingDirectory: row.working_directory,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  summary: row.summary,
  continuedSessionId: row.continued_session_id,
});

export class WorkspaceRoutineRepository {
  constructor(private readonly database: Database) {}

  list(): WorkspaceRoutine[] {
    return this.database
      .query<WorkspaceRoutineRow, []>(
        "SELECT * FROM workspace_routines ORDER BY name",
      )
      .all()
      .map(routineFromRow);
  }

  find(idOrName: string): WorkspaceRoutine | undefined {
    const row = this.database
      .query<WorkspaceRoutineRow, [string, string]>(
        "SELECT * FROM workspace_routines WHERE id = ? OR name = ?",
      )
      .get(idOrName, idOrName);
    return row ? routineFromRow(row) : undefined;
  }

  create(routine: WorkspaceRoutine): void {
    this.database
      .query(
        `INSERT INTO workspace_routines
         (id, name, workspace_id, schedule, prompt, model, enabled,
          next_run_at, last_run_at, run_requested_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        routine.id,
        routine.name,
        routine.workspaceId,
        routine.schedule,
        routine.prompt,
        routine.model,
        routine.enabled ? 1 : 0,
        routine.nextRunAt,
        routine.lastRunAt,
        routine.runRequestedAt,
        routine.createdAt,
        routine.updatedAt,
      );
  }

  update(routine: WorkspaceRoutine): void {
    this.database
      .query(
        `UPDATE workspace_routines SET name = ?, workspace_id = ?, schedule = ?,
         prompt = ?, model = ?, enabled = ?, next_run_at = ?, last_run_at = ?,
         run_requested_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        routine.name,
        routine.workspaceId,
        routine.schedule,
        routine.prompt,
        routine.model,
        routine.enabled ? 1 : 0,
        routine.nextRunAt,
        routine.lastRunAt,
        routine.runRequestedAt,
        routine.updatedAt,
        routine.id,
      );
  }

  /** The Routines agent's session, if one was ever opened. */
  agentSessionId(): string | null {
    return (
      this.database
        .query<{ session_id: string | null }, []>(
          "SELECT session_id FROM routines_agent WHERE id = 1",
        )
        .get()?.session_id ?? null
    );
  }

  setAgentSession(sessionId: string): void {
    this.database
      .query(
        `INSERT INTO routines_agent (id, session_id) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id`,
      )
      .run(sessionId);
  }

  /** A rebirth hands the Routines agent to the successor. */
  moveAgent(from: string, to: string): void {
    this.database
      .query("UPDATE routines_agent SET session_id = ? WHERE session_id = ?")
      .run(to, from);
  }

  delete(id: string): void {
    this.database.query("DELETE FROM workspace_routines WHERE id = ?").run(id);
  }

  createRun(run: Omit<WorkspaceRoutineRun, "id">): WorkspaceRoutineRun {
    const row = this.database
      .query<WorkspaceRoutineRunRow, (string | null)[]>(
        `INSERT INTO workspace_routine_runs
         (routine_id, trigger, status, provider_session_id, working_directory,
          started_at, finished_at, summary, continued_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        run.routineId,
        run.trigger,
        run.status,
        run.providerSessionId,
        run.workingDirectory,
        run.startedAt,
        run.finishedAt,
        run.summary,
        run.continuedSessionId,
      );
    return runFromRow(row!);
  }

  updateRun(run: WorkspaceRoutineRun): void {
    this.database
      .query(
        `UPDATE workspace_routine_runs SET status = ?, finished_at = ?,
         summary = ?, continued_session_id = ? WHERE id = ?`,
      )
      .run(
        run.status,
        run.finishedAt,
        run.summary,
        run.continuedSessionId,
        run.id,
      );
  }

  findRun(id: number): WorkspaceRoutineRun | undefined {
    const row = this.database
      .query<WorkspaceRoutineRunRow, [number]>(
        "SELECT * FROM workspace_routine_runs WHERE id = ?",
      )
      .get(id);
    return row ? runFromRow(row) : undefined;
  }

  /** Newest first, across every routine or for one. */
  listRuns(filter: {
    routineId?: string;
    limit: number;
  }): WorkspaceRoutineRun[] {
    const rows = filter.routineId
      ? this.database
          .query<WorkspaceRoutineRunRow, [string, number]>(
            `SELECT * FROM workspace_routine_runs WHERE routine_id = ?
             ORDER BY id DESC LIMIT ?`,
          )
          .all(filter.routineId, filter.limit)
      : this.database
          .query<WorkspaceRoutineRunRow, [number]>(
            "SELECT * FROM workspace_routine_runs ORDER BY id DESC LIMIT ?",
          )
          .all(filter.limit);
    return rows.map(runFromRow);
  }

  runningRuns(): WorkspaceRoutineRun[] {
    return this.database
      .query<WorkspaceRoutineRunRow, []>(
        "SELECT * FROM workspace_routine_runs WHERE status = 'running'",
      )
      .all()
      .map(runFromRow);
  }
}

import type { Database } from "bun:sqlite";
import type {
  Routine,
  RoutineRun,
  RoutineRunStatus,
  RoutineTrigger,
} from "../domain";

interface RoutineRow {
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

interface RoutineRunRow {
  id: number;
  routine_id: string;
  trigger: RoutineTrigger;
  status: RoutineRunStatus;
  provider_session_id: string | null;
  working_directory: string;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
  continued_session_id: string | null;
  seen_at: string | null;
  pid: number | null;
}

const routineFromRow = (row: RoutineRow): Routine => ({
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

const runFromRow = (row: RoutineRunRow): RoutineRun => ({
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
  seenAt: row.seen_at,
  pid: row.pid,
});

export class RoutineRepository {
  constructor(private readonly database: Database) {}

  list(): Routine[] {
    return this.database
      .query<RoutineRow, []>("SELECT * FROM workspace_routines ORDER BY name")
      .all()
      .map(routineFromRow);
  }

  find(idOrName: string): Routine | undefined {
    const row = this.database
      .query<RoutineRow, [string, string]>(
        "SELECT * FROM workspace_routines WHERE id = ? OR name = ?",
      )
      .get(idOrName, idOrName);
    return row ? routineFromRow(row) : undefined;
  }

  create(routine: Routine): void {
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

  update(routine: Routine): void {
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

  createRun(run: Omit<RoutineRun, "id">): RoutineRun {
    const row = this.database
      .query<RoutineRunRow, (string | number | null)[]>(
        `INSERT INTO workspace_routine_runs
         (routine_id, trigger, status, provider_session_id, working_directory,
          started_at, finished_at, summary, continued_session_id, seen_at, pid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
        run.seenAt,
        run.pid,
      );
    return runFromRow(row!);
  }

  updateRun(run: RoutineRun): void {
    this.database
      .query(
        `UPDATE workspace_routine_runs SET status = ?, finished_at = ?,
         summary = ?, continued_session_id = ?, seen_at = ?, pid = ?
         WHERE id = ?`,
      )
      .run(
        run.status,
        run.finishedAt,
        run.summary,
        run.continuedSessionId,
        run.seenAt,
        run.pid,
        run.id,
      );
  }

  findRun(id: number): RoutineRun | undefined {
    const row = this.database
      .query<RoutineRunRow, [number]>(
        "SELECT * FROM workspace_routine_runs WHERE id = ?",
      )
      .get(id);
    return row ? runFromRow(row) : undefined;
  }

  /** Newest first, across every routine or for one. */
  listRuns(filter: { routineId?: string; limit: number }): RoutineRun[] {
    const rows = filter.routineId
      ? this.database
          .query<RoutineRunRow, [string, number]>(
            `SELECT * FROM workspace_routine_runs WHERE routine_id = ?
             ORDER BY id DESC LIMIT ?`,
          )
          .all(filter.routineId, filter.limit)
      : this.database
          .query<RoutineRunRow, [number]>(
            "SELECT * FROM workspace_routine_runs ORDER BY id DESC LIMIT ?",
          )
          .all(filter.limit);
    return rows.map(runFromRow);
  }

  /** Finished runs the user has not opened yet, newest first. */
  unseenRunIds(): number[] {
    return this.database
      .query<{ id: number }, []>(
        `SELECT id FROM workspace_routine_runs
         WHERE seen_at IS NULL AND status IN ('done', 'failed')
         ORDER BY id DESC`,
      )
      .all()
      .map((row) => row.id);
  }

  runningRuns(): RoutineRun[] {
    return this.database
      .query<RoutineRunRow, []>(
        "SELECT * FROM workspace_routine_runs WHERE status = 'running'",
      )
      .all()
      .map(runFromRow);
  }
}

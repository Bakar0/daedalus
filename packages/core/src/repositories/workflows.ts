import type { Database } from "bun:sqlite";
import {
  parseGate,
  type WorkflowRun,
  type WorkflowRunStep,
  type WorkflowStepRecord,
} from "../domain";

interface WorkflowRunRow {
  id: string;
  workspace_id: string;
  session_id: string | null;
  workflow: string;
  steps: string;
  dynamic: number;
  modified: number;
  loop_to: string | null;
  until_text: string;
  iteration: number;
  history: string;
  end_note: string | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
}

const runFromRow = (row: WorkflowRunRow): WorkflowRun => ({
  id: row.id,
  workspaceId: row.workspace_id,
  sessionId: row.session_id,
  workflow: row.workflow,
  // Steps stored before a step had a plan read as having none, and the
  // first gate names (`before`, `user`) read as `start` and `result`.
  steps: (JSON.parse(row.steps) as WorkflowRunStep[]).map((step) => ({
    ...step,
    plan: step.plan ?? null,
    gate: parseGate(step.gate) ?? null,
  })),
  dynamic: row.dynamic === 1,
  modified: row.modified === 1,
  loopTo: row.loop_to,
  until: row.until_text,
  iteration: row.iteration,
  history: JSON.parse(row.history) as WorkflowStepRecord[],
  endNote: row.end_note,
  startedAt: row.started_at,
  updatedAt: row.updated_at,
  endedAt: row.ended_at,
});

/**
 * Workflow runs. Shares the one connection `SqliteRepositories` opens, so its
 * writes join that class's transactions.
 */
export class WorkflowRepository {
  constructor(private readonly database: Database) {}

  save(run: WorkflowRun): WorkflowRun {
    this.database
      .query(
        `INSERT INTO workflow_runs
           (id, workspace_id, session_id, workflow, steps,
            dynamic, modified, loop_to, until_text, iteration, history,
            end_note, started_at, updated_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           steps = excluded.steps,
           modified = excluded.modified,
           loop_to = excluded.loop_to,
           until_text = excluded.until_text,
           iteration = excluded.iteration,
           history = excluded.history,
           end_note = excluded.end_note,
           updated_at = excluded.updated_at,
           ended_at = excluded.ended_at`,
      )
      .run(
        run.id,
        run.workspaceId,
        run.sessionId,
        run.workflow,
        JSON.stringify(run.steps),
        run.dynamic ? 1 : 0,
        run.modified ? 1 : 0,
        run.loopTo,
        run.until,
        run.iteration,
        JSON.stringify(run.history),
        run.endNote,
        run.startedAt,
        run.updatedAt,
        run.endedAt,
      );
    return run;
  }

  find(id: string): WorkflowRun | undefined {
    const row = this.database
      .query<WorkflowRunRow, [string]>(
        "SELECT * FROM workflow_runs WHERE id = ?",
      )
      .get(id);
    return row ? runFromRow(row) : undefined;
  }

  /** The session's newest run, open or ended. */
  latestForSession(sessionId: string): WorkflowRun | undefined {
    const row = this.database
      .query<WorkflowRunRow, [string]>(
        `SELECT * FROM workflow_runs WHERE session_id = ?
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId);
    return row ? runFromRow(row) : undefined;
  }

  /**
   * The newest run of each session: what the session views show. Older runs
   * stay in the table as history.
   */
  listLatest(): WorkflowRun[] {
    return this.database
      .query<WorkflowRunRow, []>(
        `SELECT * FROM workflow_runs AS run
         WHERE run.session_id IS NOT NULL
           AND run.rowid = (
             SELECT newer.rowid FROM workflow_runs AS newer
             WHERE newer.session_id = run.session_id
             ORDER BY newer.started_at DESC, newer.rowid DESC LIMIT 1
           )
         ORDER BY run.started_at`,
      )
      .all()
      .map(runFromRow);
  }

  /** A rebirth: the predecessor's runs become the successor's. */
  moveToSession(from: string, to: string): void {
    this.database
      .query("UPDATE workflow_runs SET session_id = ? WHERE session_id = ?")
      .run(to, from);
  }

  /**
   * Every run's id, steps, iteration and end, for the read model's
   * version. Not `updated_at`: two changes in one millisecond would share it.
   */
  versions(): string[] {
    return this.database
      .query<{ version: string }, []>(
        `SELECT id || ':' || iteration || ':' || coalesce(ended_at, '')
                || ':' || steps AS version
         FROM workflow_runs ORDER BY rowid`,
      )
      .all()
      .map((row) => row.version);
  }
}

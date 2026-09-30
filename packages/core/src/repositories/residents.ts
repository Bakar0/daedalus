import type { Database } from "bun:sqlite";
import type {
  Finding,
  FindingSeverity,
  FindingState,
  FindingVerdict,
  Resident,
  ResidentState,
  RoutineRun,
  RoutineRunOutcome,
  RoutineRunStatus,
  RoutineState,
} from "../domain";

interface ResidentRow {
  id: string;
  slug: string;
  name: string;
  workspace_id: string;
  provider: "claude" | "codex";
  model: string | null;
  auto_handoff_percent: number;
  state: ResidentState;
  session_id: string | null;
  draining_since: string | null;
  created_at: string;
}

interface RoutineStateRow {
  resident_id: string;
  name: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
}

interface RoutineRunRow {
  id: number;
  resident_id: string;
  routine: string;
  session_id: string | null;
  status: RoutineRunStatus;
  queued_at: string;
  delivered_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  outcome: RoutineRunOutcome | null;
  summary: string | null;
  missed_ms: number;
}

interface FindingRow {
  id: string;
  resident_id: string;
  routine: string;
  dedupe_key: string;
  same_as: string | null;
  severity: FindingSeverity;
  title: string;
  url: string | null;
  task_id: string | null;
  state: FindingState;
  verdict: FindingVerdict | null;
  opened_at: string;
  last_seen_at: string;
  cleared_at: string | null;
  closed_at: string | null;
  reopen_count: number;
}

const residentFromRow = (row: ResidentRow): Resident => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  workspaceId: row.workspace_id,
  provider: row.provider,
  model: row.model,
  autoHandoffPercent: row.auto_handoff_percent,
  state: row.state,
  sessionId: row.session_id,
  drainingSince: row.draining_since,
  createdAt: row.created_at,
});

const routineStateFromRow = (row: RoutineStateRow): RoutineState => ({
  residentId: row.resident_id,
  name: row.name,
  nextRunAt: row.next_run_at,
  lastRunAt: row.last_run_at,
  lastSuccessAt: row.last_success_at,
  consecutiveFailures: row.consecutive_failures,
});

const routineRunFromRow = (row: RoutineRunRow): RoutineRun => ({
  id: row.id,
  residentId: row.resident_id,
  routine: row.routine,
  sessionId: row.session_id,
  status: row.status,
  queuedAt: row.queued_at,
  deliveredAt: row.delivered_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  outcome: row.outcome,
  summary: row.summary,
  missedMs: row.missed_ms,
});

const findingFromRow = (row: FindingRow): Finding => ({
  id: row.id,
  residentId: row.resident_id,
  routine: row.routine,
  key: row.dedupe_key,
  sameAs: row.same_as,
  severity: row.severity,
  title: row.title,
  url: row.url,
  taskId: row.task_id,
  state: row.state,
  verdict: row.verdict,
  openedAt: row.opened_at,
  lastSeenAt: row.last_seen_at,
  clearedAt: row.cleared_at,
  closedAt: row.closed_at,
  reopenCount: row.reopen_count,
});

/** How many finished runs each resident keeps for its history. */
const KEPT_RUNS = 500;

/**
 * Residents, their routine state and runs, and their findings. Shares the one
 * connection `SqliteRepositories` opens, so its writes join that class's
 * transactions.
 */
export class ResidentRepository {
  constructor(private readonly database: Database) {}

  createResident(resident: Resident): void {
    this.database
      .query(
        `INSERT INTO residents
         (id, slug, name, workspace_id, provider, model, auto_handoff_percent,
          state, session_id, draining_since, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        resident.id,
        resident.slug,
        resident.name,
        resident.workspaceId,
        resident.provider,
        resident.model,
        resident.autoHandoffPercent,
        resident.state,
        resident.sessionId,
        resident.drainingSince,
        resident.createdAt,
      );
  }

  updateResident(resident: Resident): void {
    this.database
      .query(
        `UPDATE residents SET slug = ?, name = ?, provider = ?, model = ?,
         auto_handoff_percent = ?, state = ?, session_id = ?, draining_since = ?
         WHERE id = ?`,
      )
      .run(
        resident.slug,
        resident.name,
        resident.provider,
        resident.model,
        resident.autoHandoffPercent,
        resident.state,
        resident.sessionId,
        resident.drainingSince,
        resident.id,
      );
  }

  listResidents(): Resident[] {
    return this.database
      .query<ResidentRow, []>("SELECT * FROM residents ORDER BY created_at, id")
      .all()
      .map(residentFromRow);
  }

  findResident(reference: string): Resident | undefined {
    const row = this.database
      .query<ResidentRow, [string, string]>(
        "SELECT * FROM residents WHERE id = ? OR slug = ?",
      )
      .get(reference, reference);
    return row ? residentFromRow(row) : undefined;
  }

  findResidentBySession(sessionId: string): Resident | undefined {
    const row = this.database
      .query<ResidentRow, [string]>(
        "SELECT * FROM residents WHERE session_id = ?",
      )
      .get(sessionId);
    return row ? residentFromRow(row) : undefined;
  }

  /**
   * Hands the duty from a session to its successor. A handoff is started by
   * the agent itself, so this is the one place that learns about it.
   */
  transferResidentSession(fromSessionId: string, toSessionId: string): void {
    this.database
      .query(
        `UPDATE residents SET session_id = ?, draining_since = NULL,
         state = CASE state WHEN 'draining' THEN 'on_duty' ELSE state END
         WHERE session_id = ?`,
      )
      .run(toSessionId, fromSessionId);
  }

  deleteResident(id: string): void {
    this.database.query("DELETE FROM residents WHERE id = ?").run(id);
  }

  listRoutineStates(residentId: string): RoutineState[] {
    return this.database
      .query<RoutineStateRow, [string]>(
        "SELECT * FROM routine_state WHERE resident_id = ? ORDER BY name",
      )
      .all(residentId)
      .map(routineStateFromRow);
  }

  findRoutineState(residentId: string, name: string): RoutineState | undefined {
    const row = this.database
      .query<RoutineStateRow, [string, string]>(
        "SELECT * FROM routine_state WHERE resident_id = ? AND name = ?",
      )
      .get(residentId, name);
    return row ? routineStateFromRow(row) : undefined;
  }

  saveRoutineState(state: RoutineState): void {
    this.database
      .query(
        `INSERT INTO routine_state
         (resident_id, name, next_run_at, last_run_at, last_success_at,
          consecutive_failures)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (resident_id, name) DO UPDATE SET
           next_run_at = excluded.next_run_at,
           last_run_at = excluded.last_run_at,
           last_success_at = excluded.last_success_at,
           consecutive_failures = excluded.consecutive_failures`,
      )
      .run(
        state.residentId,
        state.name,
        state.nextRunAt,
        state.lastRunAt,
        state.lastSuccessAt,
        state.consecutiveFailures,
      );
  }

  deleteRoutineState(residentId: string, name: string): void {
    this.database
      .query("DELETE FROM routine_state WHERE resident_id = ? AND name = ?")
      .run(residentId, name);
  }

  createRoutineRun(run: Omit<RoutineRun, "id">): RoutineRun {
    const row = this.database
      .query<RoutineRunRow, (string | number | null)[]>(
        `INSERT INTO routine_runs
         (resident_id, routine, session_id, status, queued_at, delivered_at,
          started_at, finished_at, outcome, summary, missed_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        run.residentId,
        run.routine,
        run.sessionId,
        run.status,
        run.queuedAt,
        run.deliveredAt,
        run.startedAt,
        run.finishedAt,
        run.outcome,
        run.summary,
        run.missedMs,
      );
    if (!row) throw new Error("The routine run was not recorded");
    this.pruneRoutineRuns(run.residentId);
    return routineRunFromRow(row);
  }

  updateRoutineRun(run: RoutineRun): void {
    this.database
      .query(
        `UPDATE routine_runs SET session_id = ?, status = ?, delivered_at = ?,
         started_at = ?, finished_at = ?, outcome = ?, summary = ?
         WHERE id = ?`,
      )
      .run(
        run.sessionId,
        run.status,
        run.deliveredAt,
        run.startedAt,
        run.finishedAt,
        run.outcome,
        run.summary,
        run.id,
      );
  }

  findRoutineRun(id: number): RoutineRun | undefined {
    const row = this.database
      .query<RoutineRunRow, [number]>("SELECT * FROM routine_runs WHERE id = ?")
      .get(id);
    return row ? routineRunFromRow(row) : undefined;
  }

  /** Newest first. */
  listRoutineRuns(
    residentId: string,
    filters: {
      routine?: string;
      statuses?: RoutineRunStatus[];
      limit?: number;
    } = {},
  ): RoutineRun[] {
    const clauses = ["resident_id = ?"];
    const values: (string | number)[] = [residentId];
    if (filters.routine) {
      clauses.push("routine = ?");
      values.push(filters.routine);
    }
    if (filters.statuses?.length) {
      clauses.push(`status IN (${filters.statuses.map(() => "?").join(", ")})`);
      values.push(...filters.statuses);
    }
    values.push(filters.limit ?? 100);
    return this.database
      .query<RoutineRunRow, (string | number)[]>(
        `SELECT * FROM routine_runs WHERE ${clauses.join(" AND ")}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...values)
      .map(routineRunFromRow);
  }

  /** History is for reading back, so only the newest few hundred are kept. */
  private pruneRoutineRuns(residentId: string): void {
    this.database
      .query(
        `DELETE FROM routine_runs
         WHERE resident_id = ? AND status IN ('done', 'failed', 'skipped')
         AND id NOT IN (
           SELECT id FROM routine_runs WHERE resident_id = ?
           ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(residentId, residentId, KEPT_RUNS);
  }

  createFinding(finding: Finding): void {
    this.database
      .query(
        `INSERT INTO findings
         (id, resident_id, routine, dedupe_key, same_as, severity, title, url,
          task_id, state, verdict, opened_at, last_seen_at, cleared_at,
          closed_at, reopen_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        finding.id,
        finding.residentId,
        finding.routine,
        finding.key,
        finding.sameAs,
        finding.severity,
        finding.title,
        finding.url,
        finding.taskId,
        finding.state,
        finding.verdict,
        finding.openedAt,
        finding.lastSeenAt,
        finding.clearedAt,
        finding.closedAt,
        finding.reopenCount,
      );
  }

  updateFinding(finding: Finding): void {
    this.database
      .query(
        `UPDATE findings SET same_as = ?, severity = ?, title = ?, url = ?,
         task_id = ?, state = ?, verdict = ?, last_seen_at = ?, cleared_at = ?,
         closed_at = ?, reopen_count = ?
         WHERE id = ?`,
      )
      .run(
        finding.sameAs,
        finding.severity,
        finding.title,
        finding.url,
        finding.taskId,
        finding.state,
        finding.verdict,
        finding.lastSeenAt,
        finding.clearedAt,
        finding.closedAt,
        finding.reopenCount,
        finding.id,
      );
  }

  findFinding(id: string): Finding | undefined {
    const row = this.database
      .query<FindingRow, [string]>("SELECT * FROM findings WHERE id = ?")
      .get(id);
    return row ? findingFromRow(row) : undefined;
  }

  findOpenFinding(residentId: string, key: string): Finding | undefined {
    const row = this.database
      .query<FindingRow, [string, string]>(
        `SELECT * FROM findings
         WHERE resident_id = ? AND dedupe_key = ? AND state = 'open'`,
      )
      .get(residentId, key);
    return row ? findingFromRow(row) : undefined;
  }

  /** The newest finding under a key, in any state. */
  findLatestFinding(residentId: string, key: string): Finding | undefined {
    const row = this.database
      .query<FindingRow, [string, string]>(
        `SELECT * FROM findings WHERE resident_id = ? AND dedupe_key = ?
         ORDER BY opened_at DESC, rowid DESC LIMIT 1`,
      )
      .get(residentId, key);
    return row ? findingFromRow(row) : undefined;
  }

  listFindings(
    residentId: string,
    filters: { states?: FindingState[]; routine?: string } = {},
  ): Finding[] {
    const clauses = ["resident_id = ?"];
    const values: string[] = [residentId];
    if (filters.states?.length) {
      clauses.push(`state IN (${filters.states.map(() => "?").join(", ")})`);
      values.push(...filters.states);
    }
    if (filters.routine) {
      clauses.push("routine = ?");
      values.push(filters.routine);
    }
    return this.database
      .query<FindingRow, string[]>(
        `SELECT * FROM findings WHERE ${clauses.join(" AND ")}
         ORDER BY opened_at, rowid`,
      )
      .all(...values)
      .map(findingFromRow);
  }

  /** Whether any agent session was ever started on a task. */
  taskHasSessions(taskId: string): boolean {
    return Boolean(
      this.database
        .query<{ found: number }, [string]>(
          "SELECT 1 AS found FROM agent_sessions WHERE task_id = ? LIMIT 1",
        )
        .get(taskId),
    );
  }
}

import type { Database } from "bun:sqlite";
import type {
  AbilityId,
  Routine,
  RoutineOutput,
  RoutineReport,
  RoutineReportState,
  RoutineReportVerdict,
  RoutineRun,
  RoutineRunOutcome,
  RoutineRunStatus,
  RoutineSchedule,
  SessionAbility,
} from "../domain";

interface SessionAbilityRow {
  id: string;
  session_id: string;
  ability: AbilityId;
  enabled: number;
  paused: number;
  config: string;
  pending_note: string | null;
  granted_at: string;
  revoked_at: string | null;
}

interface RoutineRow {
  id: string;
  ability_id: string;
  name: string;
  schedule: string;
  until: string | null;
  model: string | null;
  timeout_ms: number;
  output: RoutineOutput;
  enabled: number;
  vars: string;
  body: string;
  is_template: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

interface RoutineRunRow {
  id: number;
  ability_id: string;
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

interface RoutineReportRow {
  id: string;
  ability_id: string;
  routine: string;
  report_key: string;
  same_as: string | null;
  urgent: number;
  title: string;
  url: string | null;
  task_id: string | null;
  state: RoutineReportState;
  verdict: RoutineReportVerdict | null;
  opened_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  closed_at: string | null;
  reopen_count: number;
}

const sessionAbilityFromRow = (row: SessionAbilityRow): SessionAbility => ({
  id: row.id,
  sessionId: row.session_id,
  ability: row.ability,
  enabled: row.enabled === 1,
  paused: row.paused === 1,
  config: JSON.parse(row.config) as Record<string, string>,
  pendingNote: row.pending_note,
  grantedAt: row.granted_at,
  revokedAt: row.revoked_at,
});

const routineFromRow = (row: RoutineRow): Routine => ({
  id: row.id,
  abilityId: row.ability_id,
  name: row.name,
  schedule: JSON.parse(row.schedule) as RoutineSchedule,
  until: row.until,
  model: row.model,
  timeoutMs: row.timeout_ms,
  output: row.output,
  enabled: row.enabled === 1,
  vars: JSON.parse(row.vars) as Record<string, string>,
  body: row.body,
  isTemplate: row.is_template === 1,
  nextRunAt: row.next_run_at,
  lastRunAt: row.last_run_at,
  lastSuccessAt: row.last_success_at,
  consecutiveFailures: row.consecutive_failures,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const routineRunFromRow = (row: RoutineRunRow): RoutineRun => ({
  id: row.id,
  abilityId: row.ability_id,
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

const routineReportFromRow = (row: RoutineReportRow): RoutineReport => ({
  id: row.id,
  abilityId: row.ability_id,
  routine: row.routine,
  key: row.report_key,
  sameAs: row.same_as,
  urgent: row.urgent === 1,
  title: row.title,
  url: row.url,
  taskId: row.task_id,
  state: row.state,
  verdict: row.verdict,
  openedAt: row.opened_at,
  lastSeenAt: row.last_seen_at,
  resolvedAt: row.resolved_at,
  closedAt: row.closed_at,
  reopenCount: row.reopen_count,
});

/** How many finished runs each ability keeps for its history. */
const KEPT_RUNS = 500;

/**
 * The abilities sessions hold. Shares the one connection `SqliteRepositories`
 * opens, so its writes join that class's transactions.
 */
export class AbilityRepository {
  constructor(private readonly database: Database) {}

  create(ability: SessionAbility): void {
    this.database
      .query(
        `INSERT INTO session_abilities
         (id, session_id, ability, enabled, paused, config, pending_note,
          granted_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ability.id,
        ability.sessionId,
        ability.ability,
        ability.enabled ? 1 : 0,
        ability.paused ? 1 : 0,
        JSON.stringify(ability.config),
        ability.pendingNote,
        ability.grantedAt,
        ability.revokedAt,
      );
  }

  update(ability: SessionAbility): void {
    this.database
      .query(
        `UPDATE session_abilities SET session_id = ?, enabled = ?, paused = ?,
         config = ?, pending_note = ?, granted_at = ?, revoked_at = ?
         WHERE id = ?`,
      )
      .run(
        ability.sessionId,
        ability.enabled ? 1 : 0,
        ability.paused ? 1 : 0,
        JSON.stringify(ability.config),
        ability.pendingNote,
        ability.grantedAt,
        ability.revokedAt,
        ability.id,
      );
  }

  /**
   * Clears the note once it is typed, unless a newer one replaced it while
   * it was being typed.
   */
  clearPendingNote(id: string, note: string): void {
    this.database
      .query(
        "UPDATE session_abilities SET pending_note = NULL WHERE id = ? AND pending_note = ?",
      )
      .run(id, note);
  }

  find(id: string): SessionAbility | undefined {
    const row = this.database
      .query<SessionAbilityRow, [string]>(
        "SELECT * FROM session_abilities WHERE id = ?",
      )
      .get(id);
    return row ? sessionAbilityFromRow(row) : undefined;
  }

  findForSession(
    sessionId: string,
    ability: AbilityId,
  ): SessionAbility | undefined {
    const row = this.database
      .query<SessionAbilityRow, [string, string]>(
        "SELECT * FROM session_abilities WHERE session_id = ? AND ability = ?",
      )
      .get(sessionId, ability);
    return row ? sessionAbilityFromRow(row) : undefined;
  }

  listForSession(sessionId: string): SessionAbility[] {
    return this.database
      .query<SessionAbilityRow, [string]>(
        "SELECT * FROM session_abilities WHERE session_id = ? ORDER BY granted_at, id",
      )
      .all(sessionId)
      .map(sessionAbilityFromRow);
  }

  /** Every row, granted or revoked, of one ability or all of them. */
  list(ability?: AbilityId): SessionAbility[] {
    return (
      ability
        ? this.database
            .query<SessionAbilityRow, [string]>(
              "SELECT * FROM session_abilities WHERE ability = ? ORDER BY granted_at, id",
            )
            .all(ability)
        : this.database
            .query<SessionAbilityRow, []>(
              "SELECT * FROM session_abilities ORDER BY granted_at, id",
            )
            .all()
    ).map(sessionAbilityFromRow);
  }

  /**
   * Hands a session's abilities to its successor. A handoff is started by
   * the agent itself, so this is the one place that learns about it.
   */
  moveToSession(fromSessionId: string, toSessionId: string): void {
    this.database
      .query("UPDATE session_abilities SET session_id = ? WHERE session_id = ?")
      .run(toSessionId, fromSessionId);
  }

  /** Archiving a session pauses what it holds; restoring resumes it. */
  setPausedForSession(sessionId: string, paused: boolean): SessionAbility[] {
    this.database
      .query("UPDATE session_abilities SET paused = ? WHERE session_id = ?")
      .run(paused ? 1 : 0, sessionId);
    return this.listForSession(sessionId);
  }
}

/** Routines, their runs and their reports, keyed by the ability's id. */
export class RoutineRepository {
  constructor(private readonly database: Database) {}

  create(routine: Routine): void {
    this.database
      .query(
        `INSERT INTO routines
         (id, ability_id, name, schedule, until, model, timeout_ms, output,
          enabled, vars, body, is_template, next_run_at, last_run_at,
          last_success_at, consecutive_failures, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        routine.id,
        routine.abilityId,
        routine.name,
        JSON.stringify(routine.schedule),
        routine.until,
        routine.model,
        routine.timeoutMs,
        routine.output,
        routine.enabled ? 1 : 0,
        JSON.stringify(routine.vars),
        routine.body,
        routine.isTemplate ? 1 : 0,
        routine.nextRunAt,
        routine.lastRunAt,
        routine.lastSuccessAt,
        routine.consecutiveFailures,
        routine.createdAt,
        routine.updatedAt,
      );
  }

  update(routine: Routine): void {
    this.database
      .query(
        `UPDATE routines SET name = ?, schedule = ?, until = ?, model = ?,
         timeout_ms = ?, output = ?, enabled = ?, vars = ?, body = ?,
         next_run_at = ?, last_run_at = ?, last_success_at = ?,
         consecutive_failures = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        routine.name,
        JSON.stringify(routine.schedule),
        routine.until,
        routine.model,
        routine.timeoutMs,
        routine.output,
        routine.enabled ? 1 : 0,
        JSON.stringify(routine.vars),
        routine.body,
        routine.nextRunAt,
        routine.lastRunAt,
        routine.lastSuccessAt,
        routine.consecutiveFailures,
        routine.updatedAt,
        routine.id,
      );
  }

  delete(id: string): void {
    this.database.query("DELETE FROM routines WHERE id = ?").run(id);
  }

  /** Live routines, or the templates, ordered by name. */
  list(abilityId: string, options: { templates?: boolean } = {}): Routine[] {
    return this.database
      .query<RoutineRow, [string, number]>(
        "SELECT * FROM routines WHERE ability_id = ? AND is_template = ? ORDER BY name",
      )
      .all(abilityId, options.templates ? 1 : 0)
      .map(routineFromRow);
  }

  find(
    abilityId: string,
    name: string,
    options: { template?: boolean } = {},
  ): Routine | undefined {
    const row = this.database
      .query<RoutineRow, [string, number, string]>(
        "SELECT * FROM routines WHERE ability_id = ? AND is_template = ? AND name = ?",
      )
      .get(abilityId, options.template ? 1 : 0, name);
    return row ? routineFromRow(row) : undefined;
  }

  createRun(run: Omit<RoutineRun, "id">): RoutineRun {
    const row = this.database
      .query<RoutineRunRow, (string | number | null)[]>(
        `INSERT INTO routine_runs
         (ability_id, routine, session_id, status, queued_at, delivered_at,
          started_at, finished_at, outcome, summary, missed_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        run.abilityId,
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
    this.pruneRuns(run.abilityId);
    return routineRunFromRow(row);
  }

  updateRun(run: RoutineRun): void {
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

  findRun(id: number): RoutineRun | undefined {
    const row = this.database
      .query<RoutineRunRow, [number]>("SELECT * FROM routine_runs WHERE id = ?")
      .get(id);
    return row ? routineRunFromRow(row) : undefined;
  }

  /** Newest first. */
  listRuns(
    abilityId: string,
    filters: {
      routine?: string;
      statuses?: RoutineRunStatus[];
      limit?: number;
    } = {},
  ): RoutineRun[] {
    const clauses = ["ability_id = ?"];
    const values: (string | number)[] = [abilityId];
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
  private pruneRuns(abilityId: string): void {
    this.database
      .query(
        `DELETE FROM routine_runs
         WHERE ability_id = ? AND status IN ('done', 'failed', 'skipped')
         AND id NOT IN (
           SELECT id FROM routine_runs WHERE ability_id = ?
           ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(abilityId, abilityId, KEPT_RUNS);
  }

  createReport(report: RoutineReport): void {
    this.database
      .query(
        `INSERT INTO routine_reports
         (id, ability_id, routine, report_key, same_as, urgent, title, url,
          task_id, state, verdict, opened_at, last_seen_at, resolved_at,
          closed_at, reopen_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.id,
        report.abilityId,
        report.routine,
        report.key,
        report.sameAs,
        report.urgent ? 1 : 0,
        report.title,
        report.url,
        report.taskId,
        report.state,
        report.verdict,
        report.openedAt,
        report.lastSeenAt,
        report.resolvedAt,
        report.closedAt,
        report.reopenCount,
      );
  }

  updateReport(report: RoutineReport): void {
    this.database
      .query(
        `UPDATE routine_reports SET same_as = ?, urgent = ?, title = ?, url = ?,
         task_id = ?, state = ?, verdict = ?, last_seen_at = ?,
         resolved_at = ?, closed_at = ?, reopen_count = ?
         WHERE id = ?`,
      )
      .run(
        report.sameAs,
        report.urgent ? 1 : 0,
        report.title,
        report.url,
        report.taskId,
        report.state,
        report.verdict,
        report.lastSeenAt,
        report.resolvedAt,
        report.closedAt,
        report.reopenCount,
        report.id,
      );
  }

  findReport(id: string): RoutineReport | undefined {
    const row = this.database
      .query<RoutineReportRow, [string]>(
        "SELECT * FROM routine_reports WHERE id = ?",
      )
      .get(id);
    return row ? routineReportFromRow(row) : undefined;
  }

  findOpenReport(abilityId: string, key: string): RoutineReport | undefined {
    const row = this.database
      .query<RoutineReportRow, [string, string]>(
        `SELECT * FROM routine_reports
         WHERE ability_id = ? AND report_key = ? AND state = 'open'`,
      )
      .get(abilityId, key);
    return row ? routineReportFromRow(row) : undefined;
  }

  /** The newest report under a key, in any state. */
  findLatestReport(abilityId: string, key: string): RoutineReport | undefined {
    const row = this.database
      .query<RoutineReportRow, [string, string]>(
        `SELECT * FROM routine_reports
         WHERE ability_id = ? AND report_key = ?
         ORDER BY opened_at DESC, rowid DESC LIMIT 1`,
      )
      .get(abilityId, key);
    return row ? routineReportFromRow(row) : undefined;
  }

  /** Every report filed on a task, oldest first. */
  listReportsForTask(taskId: string): RoutineReport[] {
    return this.database
      .query<RoutineReportRow, [string]>(
        "SELECT * FROM routine_reports WHERE task_id = ? ORDER BY opened_at, rowid",
      )
      .all(taskId)
      .map(routineReportFromRow);
  }

  /** Every report that opened a task, for the board's cards and drawer. */
  listReportsWithTasks(): RoutineReport[] {
    return this.database
      .query<RoutineReportRow, []>(
        "SELECT * FROM routine_reports WHERE task_id IS NOT NULL ORDER BY opened_at, rowid",
      )
      .all()
      .map(routineReportFromRow);
  }

  listReports(
    abilityId: string,
    filters: {
      states?: RoutineReportState[];
      routine?: string;
      /** Only reports seen at or after this time. */
      seenSince?: string;
    } = {},
  ): RoutineReport[] {
    const clauses = ["ability_id = ?"];
    const values: string[] = [abilityId];
    if (filters.states?.length) {
      clauses.push(`state IN (${filters.states.map(() => "?").join(", ")})`);
      values.push(...filters.states);
    }
    if (filters.routine) {
      clauses.push("routine = ?");
      values.push(filters.routine);
    }
    if (filters.seenSince) {
      clauses.push("last_seen_at >= ?");
      values.push(filters.seenSince);
    }
    return this.database
      .query<RoutineReportRow, string[]>(
        `SELECT * FROM routine_reports WHERE ${clauses.join(" AND ")}
         ORDER BY opened_at, rowid`,
      )
      .all(...values)
      .map(routineReportFromRow);
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

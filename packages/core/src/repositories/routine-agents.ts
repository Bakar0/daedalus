import type { Database } from "bun:sqlite";
import type {
  RoutineAgent,
  RoutineAgentMode,
  RoutineAgentState,
  RoutineReport,
  RoutineReportState,
  RoutineReportVerdict,
  RoutineRun,
  RoutineRunOutcome,
  RoutineRunStatus,
  RoutineState,
} from "../domain";

interface RoutineAgentRow {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  model: string | null;
  auto_handoff_percent: number;
  state: RoutineAgentState;
  session_id: string | null;
  draining_since: string | null;
  mode: RoutineAgentMode;
  last_input_at: string | null;
  stashed_draft: string | null;
  created_at: string;
}

interface RoutineStateRow {
  routine_agent_id: string;
  name: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
}

interface RoutineRunRow {
  id: number;
  routine_agent_id: string;
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
  routine_agent_id: string;
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

const routineAgentFromRow = (row: RoutineAgentRow): RoutineAgent => ({
  id: row.id,
  workspaceId: row.workspace_id,
  slug: row.slug,
  name: row.name,
  model: row.model,
  autoHandoffPercent: row.auto_handoff_percent,
  state: row.state,
  sessionId: row.session_id,
  drainingSince: row.draining_since,
  mode: row.mode,
  lastInputAt: row.last_input_at,
  stashedDraft: row.stashed_draft,
  createdAt: row.created_at,
});

const routineStateFromRow = (row: RoutineStateRow): RoutineState => ({
  routineAgentId: row.routine_agent_id,
  name: row.name,
  nextRunAt: row.next_run_at,
  lastRunAt: row.last_run_at,
  lastSuccessAt: row.last_success_at,
  consecutiveFailures: row.consecutive_failures,
});

const routineRunFromRow = (row: RoutineRunRow): RoutineRun => ({
  id: row.id,
  routineAgentId: row.routine_agent_id,
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
  routineAgentId: row.routine_agent_id,
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

/** How many finished runs each routine agent keeps for its history. */
const KEPT_RUNS = 500;

/**
 * Routine agents, their routine state and runs, and their reports. Shares
 * the one connection `SqliteRepositories` opens, so its writes join that
 * class's transactions.
 */
export class RoutineAgentRepository {
  constructor(private readonly database: Database) {}

  createRoutineAgent(agent: RoutineAgent): void {
    this.database
      .query(
        `INSERT INTO routine_agents
         (id, workspace_id, slug, name, model, auto_handoff_percent, state,
          session_id, draining_since, mode, last_input_at, stashed_draft,
          created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.id,
        agent.workspaceId,
        agent.slug,
        agent.name,
        agent.model,
        agent.autoHandoffPercent,
        agent.state,
        agent.sessionId,
        agent.drainingSince,
        agent.mode,
        agent.lastInputAt,
        agent.stashedDraft,
        agent.createdAt,
      );
  }

  /**
   * Saves everything but the mode, the last keystroke and the stashed draft.
   * Those change from the terminal while the scheduler holds an older copy
   * of the row, so each has its own guarded write below.
   */
  updateRoutineAgent(agent: RoutineAgent): void {
    this.database
      .query(
        `UPDATE routine_agents SET name = ?, model = ?,
         auto_handoff_percent = ?, state = ?, session_id = ?, draining_since = ?
         WHERE id = ?`,
      )
      .run(
        agent.name,
        agent.model,
        agent.autoHandoffPercent,
        agent.state,
        agent.sessionId,
        agent.drainingSince,
        agent.id,
      );
  }

  /** Records a keystroke; one while the input is locked is not the user's. */
  noteRoutineAgentInput(id: string, at: string): void {
    this.database
      .query(
        `UPDATE routine_agents SET last_input_at = ?
         WHERE id = ? AND mode = 'manual'`,
      )
      .run(at, id);
  }

  /**
   * Locks the input, unless the user typed after `quietSince`. Returns
   * whether it locked, so a keystroke that raced the scheduler wins.
   */
  lockRoutineAgent(id: string, quietSince: string): boolean {
    return (
      this.database
        .query(
          `UPDATE routine_agents SET mode = 'auto'
           WHERE id = ? AND mode = 'manual'
           AND (last_input_at IS NULL OR last_input_at <= ?)`,
        )
        .run(id, quietSince).changes > 0
    );
  }

  /** Adds text cleared from the input box to what is already stashed. */
  stashRoutineAgentDraft(id: string, draft: string): void {
    this.database
      .query(
        `UPDATE routine_agents SET stashed_draft =
           CASE WHEN stashed_draft IS NULL OR stashed_draft = '' THEN ?
           ELSE stashed_draft || char(10) || ? END
         WHERE id = ?`,
      )
      .run(draft, draft, id);
  }

  /**
   * Hands the input back to the user and starts the countdown at `at`.
   * Returns the stashed draft, which is cleared here: whoever unlocks types
   * it back. `keepDraft` leaves it stashed for a session that cannot take it.
   */
  unlockRoutineAgent(
    id: string,
    at: string | null,
    options: { keepDraft?: boolean } = {},
  ): string | null {
    return this.database.transaction(() => {
      const row = this.database
        .query<{ stashed_draft: string | null }, [string]>(
          "SELECT stashed_draft FROM routine_agents WHERE id = ?",
        )
        .get(id);
      this.database
        .query(
          `UPDATE routine_agents SET mode = 'manual', last_input_at = ?,
           stashed_draft = CASE WHEN ? THEN stashed_draft ELSE NULL END
           WHERE id = ?`,
        )
        .run(at, options.keepDraft ? 1 : 0, id);
      return options.keepDraft ? null : (row?.stashed_draft ?? null);
    })();
  }

  listRoutineAgents(workspaceId?: string): RoutineAgent[] {
    return (
      workspaceId
        ? this.database
            .query<RoutineAgentRow, [string]>(
              "SELECT * FROM routine_agents WHERE workspace_id = ? ORDER BY created_at, id",
            )
            .all(workspaceId)
        : this.database
            .query<RoutineAgentRow, []>(
              "SELECT * FROM routine_agents ORDER BY created_at, id",
            )
            .all()
    ).map(routineAgentFromRow);
  }

  findRoutineAgent(id: string): RoutineAgent | undefined {
    const row = this.database
      .query<RoutineAgentRow, [string]>(
        "SELECT * FROM routine_agents WHERE id = ?",
      )
      .get(id);
    return row ? routineAgentFromRow(row) : undefined;
  }

  /** Agents whose slug or name matches, in any workspace unless one is given. */
  findRoutineAgentsByName(
    reference: string,
    workspaceId?: string,
  ): RoutineAgent[] {
    const matches = this.database
      .query<RoutineAgentRow, [string, string]>(
        `SELECT * FROM routine_agents
         WHERE slug = ? OR lower(name) = lower(?) ORDER BY created_at, id`,
      )
      .all(reference, reference)
      .map(routineAgentFromRow);
    return workspaceId
      ? matches.filter((agent) => agent.workspaceId === workspaceId)
      : matches;
  }

  findRoutineAgentBySession(sessionId: string): RoutineAgent | undefined {
    const row = this.database
      .query<RoutineAgentRow, [string]>(
        "SELECT * FROM routine_agents WHERE session_id = ?",
      )
      .get(sessionId);
    return row ? routineAgentFromRow(row) : undefined;
  }

  /**
   * Hands the agent from a session to its successor. A handoff is started by
   * the agent itself, so this is the one place that learns about it.
   */
  transferRoutineAgentSession(
    fromSessionId: string,
    toSessionId: string,
  ): void {
    this.database
      .query(
        `UPDATE routine_agents SET session_id = ?, draining_since = NULL,
         state = CASE state WHEN 'draining' THEN 'on_duty' ELSE state END
         WHERE session_id = ?`,
      )
      .run(toSessionId, fromSessionId);
  }

  /**
   * Pauses the agent whose session this is and drops the runs nobody will
   * deliver now. Archiving the session does this; restoring it resumes.
   */
  pauseRoutineAgentBySession(
    sessionId: string,
    at: string,
    reason: string,
  ): RoutineAgent | undefined {
    const agent = this.findRoutineAgentBySession(sessionId);
    if (!agent) return undefined;
    // A paused agent runs nothing, so its input is the user's again. Its
    // session is being archived, so a stashed draft waits for a later unlock.
    const paused: RoutineAgent = {
      ...agent,
      state: "paused",
      drainingSince: null,
      mode: "manual",
    };
    this.updateRoutineAgent(paused);
    this.unlockRoutineAgent(agent.id, agent.lastInputAt, { keepDraft: true });
    this.skipUndeliveredRuns(agent.id, at, reason);
    return paused;
  }

  resumeRoutineAgentBySession(
    sessionId: string,
    at: string,
  ): RoutineAgent | undefined {
    const agent = this.findRoutineAgentBySession(sessionId);
    if (!agent || agent.state !== "paused") return agent;
    // Back from a pause, the user has just acted on it: the countdown to
    // auto starts now rather than from a keystroke days ago.
    const resumed: RoutineAgent = {
      ...agent,
      state: "on_duty",
      lastInputAt: at,
    };
    this.updateRoutineAgent(resumed);
    this.noteRoutineAgentInput(agent.id, at);
    return resumed;
  }

  deleteRoutineAgent(id: string): void {
    this.database.query("DELETE FROM routine_agents WHERE id = ?").run(id);
  }

  listRoutineStates(routineAgentId: string): RoutineState[] {
    return this.database
      .query<RoutineStateRow, [string]>(
        "SELECT * FROM routine_state WHERE routine_agent_id = ? ORDER BY name",
      )
      .all(routineAgentId)
      .map(routineStateFromRow);
  }

  findRoutineState(
    routineAgentId: string,
    name: string,
  ): RoutineState | undefined {
    const row = this.database
      .query<RoutineStateRow, [string, string]>(
        "SELECT * FROM routine_state WHERE routine_agent_id = ? AND name = ?",
      )
      .get(routineAgentId, name);
    return row ? routineStateFromRow(row) : undefined;
  }

  saveRoutineState(state: RoutineState): void {
    this.database
      .query(
        `INSERT INTO routine_state
         (routine_agent_id, name, next_run_at, last_run_at, last_success_at,
          consecutive_failures)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (routine_agent_id, name) DO UPDATE SET
           next_run_at = excluded.next_run_at,
           last_run_at = excluded.last_run_at,
           last_success_at = excluded.last_success_at,
           consecutive_failures = excluded.consecutive_failures`,
      )
      .run(
        state.routineAgentId,
        state.name,
        state.nextRunAt,
        state.lastRunAt,
        state.lastSuccessAt,
        state.consecutiveFailures,
      );
  }

  deleteRoutineState(routineAgentId: string, name: string): void {
    this.database
      .query(
        "DELETE FROM routine_state WHERE routine_agent_id = ? AND name = ?",
      )
      .run(routineAgentId, name);
  }

  createRoutineRun(run: Omit<RoutineRun, "id">): RoutineRun {
    const row = this.database
      .query<RoutineRunRow, (string | number | null)[]>(
        `INSERT INTO routine_runs
         (routine_agent_id, routine, session_id, status, queued_at,
          delivered_at, started_at, finished_at, outcome, summary, missed_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        run.routineAgentId,
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
    this.pruneRoutineRuns(run.routineAgentId);
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
    routineAgentId: string,
    filters: {
      routine?: string;
      statuses?: RoutineRunStatus[];
      limit?: number;
    } = {},
  ): RoutineRun[] {
    const clauses = ["routine_agent_id = ?"];
    const values: (string | number)[] = [routineAgentId];
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

  /** Queued runs that were never typed in end as skipped, with the reason. */
  skipUndeliveredRuns(
    routineAgentId: string,
    at: string,
    reason: string,
  ): void {
    this.database
      .query(
        `UPDATE routine_runs SET status = 'skipped', finished_at = ?, summary = ?
         WHERE routine_agent_id = ? AND status = 'queued' AND delivered_at IS NULL`,
      )
      .run(at, reason, routineAgentId);
  }

  /** History is for reading back, so only the newest few hundred are kept. */
  private pruneRoutineRuns(routineAgentId: string): void {
    this.database
      .query(
        `DELETE FROM routine_runs
         WHERE routine_agent_id = ? AND status IN ('done', 'failed', 'skipped')
         AND id NOT IN (
           SELECT id FROM routine_runs WHERE routine_agent_id = ?
           ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(routineAgentId, routineAgentId, KEPT_RUNS);
  }

  createRoutineReport(report: RoutineReport): void {
    this.database
      .query(
        `INSERT INTO routine_reports
         (id, routine_agent_id, routine, report_key, same_as, urgent, title,
          url, task_id, state, verdict, opened_at, last_seen_at, resolved_at,
          closed_at, reopen_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.id,
        report.routineAgentId,
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

  updateRoutineReport(report: RoutineReport): void {
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

  findRoutineReport(id: string): RoutineReport | undefined {
    const row = this.database
      .query<RoutineReportRow, [string]>(
        "SELECT * FROM routine_reports WHERE id = ?",
      )
      .get(id);
    return row ? routineReportFromRow(row) : undefined;
  }

  findOpenRoutineReport(
    routineAgentId: string,
    key: string,
  ): RoutineReport | undefined {
    const row = this.database
      .query<RoutineReportRow, [string, string]>(
        `SELECT * FROM routine_reports
         WHERE routine_agent_id = ? AND report_key = ? AND state = 'open'`,
      )
      .get(routineAgentId, key);
    return row ? routineReportFromRow(row) : undefined;
  }

  /** The newest report under a key, in any state. */
  findLatestRoutineReport(
    routineAgentId: string,
    key: string,
  ): RoutineReport | undefined {
    const row = this.database
      .query<RoutineReportRow, [string, string]>(
        `SELECT * FROM routine_reports
         WHERE routine_agent_id = ? AND report_key = ?
         ORDER BY opened_at DESC, rowid DESC LIMIT 1`,
      )
      .get(routineAgentId, key);
    return row ? routineReportFromRow(row) : undefined;
  }

  /** Every report filed on a task, oldest first. */
  listRoutineReportsForTask(taskId: string): RoutineReport[] {
    return this.database
      .query<RoutineReportRow, [string]>(
        "SELECT * FROM routine_reports WHERE task_id = ? ORDER BY opened_at, rowid",
      )
      .all(taskId)
      .map(routineReportFromRow);
  }

  listRoutineReports(
    routineAgentId: string,
    filters: {
      states?: RoutineReportState[];
      routine?: string;
      /** Only reports seen at or after this time. */
      seenSince?: string;
    } = {},
  ): RoutineReport[] {
    const clauses = ["routine_agent_id = ?"];
    const values: string[] = [routineAgentId];
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

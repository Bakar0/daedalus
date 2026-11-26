import type { Database } from "bun:sqlite";
import type { SessionStep } from "../domain/session-steps";

/** How many steps a session keeps; older ones go when a new turn starts. */
const STEPS_KEPT = 5000;

interface StepRow {
  kind: SessionStep["kind"];
  tool: string | null;
  detail: string | null;
  file: string | null;
  failed: number;
  duration_ms: number | null;
  created_at: string;
}

/**
 * The steps hooks report for each session (`session_steps`). Shares the one
 * connection `SqliteRepositories` opens.
 */
export class SessionStepRepository {
  constructor(private readonly database: Database) {}

  add(sessionId: string, step: SessionStep): void {
    this.database
      .query(
        `INSERT INTO session_steps
           (session_id, kind, tool, detail, file, failed, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        step.kind,
        step.tool,
        step.detail,
        step.file,
        step.failed ? 1 : 0,
        step.durationMs,
        step.at,
      );
    if (step.kind !== "prompt") return;
    this.database
      .query(
        `DELETE FROM session_steps WHERE session_id = ?1 AND id <= (
           SELECT id FROM session_steps WHERE session_id = ?1
           ORDER BY id DESC LIMIT 1 OFFSET ?2)`,
      )
      .run(sessionId, STEPS_KEPT);
  }

  /** A session's steps, oldest first. */
  forSession(sessionId: string): SessionStep[] {
    return this.database
      .query<StepRow, [string]>(
        `SELECT kind, tool, detail, file, failed, duration_ms, created_at
         FROM session_steps WHERE session_id = ? ORDER BY id`,
      )
      .all(sessionId)
      .map((row) => ({
        kind: row.kind,
        tool: row.tool,
        detail: row.detail,
        file: row.file,
        failed: row.failed === 1,
        durationMs: row.duration_ms,
        at: row.created_at,
      }));
  }
}

import type { Database } from "bun:sqlite";
import type { ThreadSuggestion } from "../domain";

interface ThreadSuggestionRow {
  id: number;
  lead_session_id: string;
  title: string;
  workspace_id: string | null;
  message: string | null;
  created_at: string;
  started_session_id: string | null;
  closed_at: string | null;
}

const suggestionFromRow = (row: ThreadSuggestionRow): ThreadSuggestion => ({
  id: row.id,
  leadSessionId: row.lead_session_id,
  title: row.title,
  workspaceId: row.workspace_id,
  message: row.message,
  createdAt: row.created_at,
  startedSessionId: row.started_session_id,
  closedAt: row.closed_at,
});

/** Threads a lead suggested for the user to start (043). */
export class ThreadRepository {
  constructor(private readonly database: Database) {}

  create(
    suggestion: Omit<ThreadSuggestion, "id" | "startedSessionId" | "closedAt">,
  ): ThreadSuggestion {
    const row = this.database
      .query<ThreadSuggestionRow, (string | null)[]>(
        `INSERT INTO thread_suggestions
         (lead_session_id, title, workspace_id, message, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        suggestion.leadSessionId,
        suggestion.title,
        suggestion.workspaceId,
        suggestion.message,
        suggestion.createdAt,
      );
    if (!row) throw new Error("The suggestion was not saved");
    return suggestionFromRow(row);
  }

  find(id: number): ThreadSuggestion | undefined {
    const row = this.database
      .query<ThreadSuggestionRow, [number]>(
        "SELECT * FROM thread_suggestions WHERE id = ?",
      )
      .get(id);
    return row ? suggestionFromRow(row) : undefined;
  }

  /** A lead's suggestions still waiting on the user, oldest first. */
  open(leadSessionId: string): ThreadSuggestion[] {
    return this.database
      .query<ThreadSuggestionRow, [string]>(
        `SELECT * FROM thread_suggestions
         WHERE lead_session_id = ? AND closed_at IS NULL ORDER BY id`,
      )
      .all(leadSessionId)
      .map(suggestionFromRow);
  }

  /**
   * Closes a suggestion still open, for one start alone: true when this
   * call closed it, false when it was already closed.
   */
  claim(id: number, closedAt: string): boolean {
    return (
      this.database
        .query(
          `UPDATE thread_suggestions SET closed_at = ?
           WHERE id = ? AND closed_at IS NULL`,
        )
        .run(closedAt, id).changes > 0
    );
  }

  /** Opens a claimed suggestion again, when its start failed. */
  release(id: number): void {
    this.database
      .query(
        `UPDATE thread_suggestions SET closed_at = NULL
         WHERE id = ? AND started_session_id IS NULL`,
      )
      .run(id);
  }

  /** Started (with the thread it became) or dismissed (without one). */
  close(id: number, closedAt: string, startedSessionId: string | null): void {
    this.database
      .query(
        `UPDATE thread_suggestions SET closed_at = ?, started_session_id = ?
         WHERE id = ?`,
      )
      .run(closedAt, startedSessionId, id);
  }

  /** A rebirth of the lead hands its suggestions to the successor. */
  moveToSession(from: string, to: string): void {
    this.database
      .query(
        "UPDATE thread_suggestions SET lead_session_id = ? WHERE lead_session_id = ?",
      )
      .run(to, from);
  }
}

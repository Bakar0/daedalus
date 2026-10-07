import type { Database } from "bun:sqlite";
import type { TeamCursor, TeamMessage } from "../domain";

interface TeamMessageRow {
  id: number;
  team_id: string;
  author: string;
  body: string;
  tags: string;
  created_at: string;
}

interface TeamCursorRow {
  team_id: string;
  handle: string;
  read_through: number;
  delivered_through: number;
  last_error: string | null;
  last_attempt_at: string | null;
}

const messageFromRow = (row: TeamMessageRow): TeamMessage => ({
  id: row.id,
  teamId: row.team_id,
  author: row.author,
  body: row.body,
  tags: JSON.parse(row.tags) as string[],
  createdAt: row.created_at,
});

const cursorFromRow = (row: TeamCursorRow): TeamCursor => ({
  teamId: row.team_id,
  handle: row.handle,
  readThrough: row.read_through,
  deliveredThrough: row.delivered_through,
  lastError: row.last_error,
  lastAttemptAt: row.last_attempt_at,
});

/**
 * Team chats and what each reader has seen. Shares the one connection
 * `SqliteRepositories` opens, so its writes join that class's transactions.
 */
export class TeamRepository {
  constructor(private readonly database: Database) {}

  addMessage(message: Omit<TeamMessage, "id">): TeamMessage {
    const row = this.database
      .query<TeamMessageRow, [string, string, string, string, string]>(
        `INSERT INTO team_messages (team_id, author, body, tags, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        message.teamId,
        message.author,
        message.body,
        JSON.stringify(message.tags),
        message.createdAt,
      );
    if (!row) throw new Error("The team message was not stored");
    return messageFromRow(row);
  }

  /** Messages after `afterId`, oldest first. */
  messages(teamId: string, afterId = 0): TeamMessage[] {
    return this.database
      .query<TeamMessageRow, [string, number]>(
        "SELECT * FROM team_messages WHERE team_id = ? AND id > ? ORDER BY id",
      )
      .all(teamId, afterId)
      .map(messageFromRow);
  }

  /** The newest `limit` messages, oldest first. */
  recentMessages(teamId: string, limit: number): TeamMessage[] {
    return this.database
      .query<TeamMessageRow, [string, number]>(
        "SELECT * FROM team_messages WHERE team_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(teamId, limit)
      .map(messageFromRow)
      .reverse();
  }

  lastMessageId(teamId: string): number {
    return (
      this.database
        .query<{ id: number | null }, [string]>(
          "SELECT MAX(id) AS id FROM team_messages WHERE team_id = ?",
        )
        .get(teamId)?.id ?? 0
    );
  }

  /** A reader's cursor; a reader that never read starts at nothing read. */
  cursor(teamId: string, handle: string): TeamCursor {
    const row = this.database
      .query<TeamCursorRow, [string, string]>(
        "SELECT * FROM team_cursors WHERE team_id = ? AND handle = ?",
      )
      .get(teamId, handle);
    return row
      ? cursorFromRow(row)
      : {
          teamId,
          handle,
          readThrough: 0,
          deliveredThrough: 0,
          lastError: null,
          lastAttemptAt: null,
        };
  }

  saveCursor(cursor: TeamCursor): void {
    this.database
      .query(
        `INSERT INTO team_cursors
         (team_id, handle, read_through, delivered_through, last_error, last_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (team_id, handle) DO UPDATE SET
           read_through = excluded.read_through,
           delivered_through = excluded.delivered_through,
           last_error = excluded.last_error,
           last_attempt_at = excluded.last_attempt_at`,
      )
      .run(
        cursor.teamId,
        cursor.handle,
        cursor.readThrough,
        cursor.deliveredThrough,
        cursor.lastError,
        cursor.lastAttemptAt,
      );
  }
}

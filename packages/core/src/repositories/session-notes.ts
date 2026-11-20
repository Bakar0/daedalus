import type { Database } from "bun:sqlite";

/**
 * Lines Daedalus adds once to the next message it brings a session: what
 * changed under a running agent, such as commands it was taught that no
 * longer exist.
 */
export class SessionNoteRepository {
  constructor(private readonly database: Database) {}

  add(sessionId: string, body: string, at: string): void {
    this.database
      .query(
        "INSERT INTO session_notes (session_id, body, created_at) VALUES (?, ?, ?)",
      )
      .run(sessionId, body, at);
  }

  /** A session's notes, oldest first, deleted as they are read. */
  take(sessionId: string): string[] {
    return this.database
      .query<{ id: number; body: string }, [string]>(
        "DELETE FROM session_notes WHERE session_id = ? RETURNING id, body",
      )
      .all(sessionId)
      .sort((a, b) => a.id - b.id)
      .map((row) => row.body);
  }

  /** Puts notes back when the delivery that carried them failed. */
  restore(sessionId: string, bodies: readonly string[], at: string): void {
    for (const body of bodies) this.add(sessionId, body, at);
  }
}

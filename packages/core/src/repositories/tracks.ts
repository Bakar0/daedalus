import type { Database } from "bun:sqlite";
import type { SessionTrack, TrackNote, TrackNoteKind } from "../domain";

interface SessionTrackRow {
  tracker_session_id: string;
  tracked_session_id: string;
  created_at: string;
}

interface TrackNoteRow {
  id: number;
  recipient_session_id: string;
  peer_session_id: string | null;
  kind: TrackNoteKind;
  body: string;
  created_at: string;
  delivered_at: string | null;
  last_error: string | null;
  attempted_at: string | null;
}

const trackFromRow = (row: SessionTrackRow): SessionTrack => ({
  trackerSessionId: row.tracker_session_id,
  trackedSessionId: row.tracked_session_id,
  createdAt: row.created_at,
});

const noteFromRow = (row: TrackNoteRow): TrackNote => ({
  id: row.id,
  recipientSessionId: row.recipient_session_id,
  peerSessionId: row.peer_session_id,
  kind: row.kind,
  body: row.body,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
  lastError: row.last_error,
  attemptedAt: row.attempted_at,
});

/** Which sessions track which (044), and the notes between them. */
export class TrackRepository {
  constructor(private readonly database: Database) {}

  /** Every track, oldest first. */
  list(): SessionTrack[] {
    return this.database
      .query<SessionTrackRow, []>(
        "SELECT * FROM session_tracks ORDER BY created_at, tracked_session_id",
      )
      .all()
      .map(trackFromRow);
  }

  /** What one session tracks, oldest first. */
  trackedBy(trackerSessionId: string): SessionTrack[] {
    return this.database
      .query<SessionTrackRow, [string]>(
        `SELECT * FROM session_tracks WHERE tracker_session_id = ?
         ORDER BY created_at, tracked_session_id`,
      )
      .all(trackerSessionId)
      .map(trackFromRow);
  }

  /** The sessions tracking one session. */
  trackersOf(trackedSessionId: string): SessionTrack[] {
    return this.database
      .query<SessionTrackRow, [string]>(
        "SELECT * FROM session_tracks WHERE tracked_session_id = ? ORDER BY created_at",
      )
      .all(trackedSessionId)
      .map(trackFromRow);
  }

  find(tracker: string, tracked: string): SessionTrack | undefined {
    const row = this.database
      .query<SessionTrackRow, [string, string]>(
        `SELECT * FROM session_tracks
         WHERE tracker_session_id = ? AND tracked_session_id = ?`,
      )
      .get(tracker, tracked);
    return row ? trackFromRow(row) : undefined;
  }

  /** Adds a track; true when it is new. */
  add(tracker: string, tracked: string, createdAt: string): boolean {
    return (
      this.database
        .query(
          `INSERT OR IGNORE INTO session_tracks
           (tracker_session_id, tracked_session_id, created_at) VALUES (?, ?, ?)`,
        )
        .run(tracker, tracked, createdAt).changes > 0
    );
  }

  /** Removes a track and the reports about it not delivered yet. */
  remove(tracker: string, tracked: string): boolean {
    this.database
      .query(
        `DELETE FROM track_notes WHERE recipient_session_id = ?
         AND peer_session_id = ? AND kind != 'message' AND delivered_at IS NULL`,
      )
      .run(tracker, tracked);
    return (
      this.database
        .query(
          `DELETE FROM session_tracks
           WHERE tracker_session_id = ? AND tracked_session_id = ?`,
        )
        .run(tracker, tracked).changes > 0
    );
  }

  addNote(
    note: Pick<
      TrackNote,
      "recipientSessionId" | "peerSessionId" | "kind" | "body" | "createdAt"
    >,
  ): TrackNote {
    const row = this.database
      .query<TrackNoteRow, (string | null)[]>(
        `INSERT INTO track_notes
         (recipient_session_id, peer_session_id, kind, body, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        note.recipientSessionId,
        note.peerSessionId,
        note.kind,
        note.body,
        note.createdAt,
      );
    if (!row) throw new Error("The note was not saved");
    return noteFromRow(row);
  }

  /** What has not reached a session yet, oldest first. */
  pending(recipientSessionId: string): TrackNote[] {
    return this.database
      .query<TrackNoteRow, [string]>(
        `SELECT * FROM track_notes
         WHERE recipient_session_id = ? AND delivered_at IS NULL ORDER BY id`,
      )
      .all(recipientSessionId)
      .map(noteFromRow);
  }

  /** Sessions with something waiting that is not only a waiting note. */
  recipientsWithPending(): string[] {
    return this.database
      .query<{ recipient_session_id: string }, []>(
        `SELECT DISTINCT recipient_session_id FROM track_notes
         WHERE delivered_at IS NULL AND kind != 'waiting'`,
      )
      .all()
      .map((row) => row.recipient_session_id);
  }

  /** When a session was last given notes, which the report rate runs from. */
  lastDelivered(recipientSessionId: string): string | null {
    return (
      this.database
        .query<{ at: string | null }, [string]>(
          `SELECT MAX(delivered_at) AS at FROM track_notes
           WHERE recipient_session_id = ?`,
        )
        .get(recipientSessionId)?.at ?? null
    );
  }

  /** The newest failed attempt for a session, if its last one failed. */
  lastAttempt(
    recipientSessionId: string,
  ): { at: string; error: string | null } | undefined {
    const row = this.database
      .query<{ attempted_at: string; last_error: string | null }, [string]>(
        `SELECT attempted_at, last_error FROM track_notes
         WHERE recipient_session_id = ? AND attempted_at IS NOT NULL
         ORDER BY attempted_at DESC, id DESC LIMIT 1`,
      )
      .get(recipientSessionId);
    return row ? { at: row.attempted_at, error: row.last_error } : undefined;
  }

  markDelivered(ids: readonly number[], at: string): void {
    const mark = this.database.query(
      `UPDATE track_notes SET delivered_at = ?, attempted_at = ?, last_error = NULL
       WHERE id = ?`,
    );
    for (const id of ids) mark.run(at, at, id);
  }

  markFailed(ids: readonly number[], at: string, error: string): void {
    const mark = this.database.query(
      `UPDATE track_notes SET delivered_at = NULL, attempted_at = ?, last_error = ?
       WHERE id = ?`,
    );
    for (const id of ids) mark.run(at, error, id);
  }

  /**
   * A rebirth hands the predecessor's tracks, both ways, and its undelivered
   * notes to the successor.
   */
  moveToSession(from: string, to: string): void {
    this.database
      .query(
        `INSERT OR IGNORE INTO session_tracks
         (tracker_session_id, tracked_session_id, created_at)
         SELECT CASE WHEN tracker_session_id = ?1 THEN ?2 ELSE tracker_session_id END,
                CASE WHEN tracked_session_id = ?1 THEN ?2 ELSE tracked_session_id END,
                created_at
         FROM session_tracks
         WHERE (tracker_session_id = ?1 OR tracked_session_id = ?1)
           AND tracker_session_id != tracked_session_id`,
      )
      .run(from, to);
    this.database
      .query(
        "DELETE FROM session_tracks WHERE tracker_session_id = ?1 OR tracked_session_id = ?1",
      )
      .run(from);
    this.database
      .query(
        "DELETE FROM session_tracks WHERE tracker_session_id = tracked_session_id",
      )
      .run();
    this.database
      .query(
        `UPDATE track_notes SET recipient_session_id = ?2
         WHERE recipient_session_id = ?1 AND delivered_at IS NULL`,
      )
      .run(from, to);
    this.database
      .query(
        "UPDATE track_notes SET peer_session_id = ?2 WHERE peer_session_id = ?1",
      )
      .run(from, to);
  }
}

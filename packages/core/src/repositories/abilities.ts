import type { Database } from "bun:sqlite";
import type { AbilityId, SessionAbility } from "../domain";

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
   * Hands a session's abilities to its successor. A rebirth is started by
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

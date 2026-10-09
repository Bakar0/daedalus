import type { Database } from "bun:sqlite";
import type { Secret } from "../domain";

interface SecretRow {
  workspace_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
}

const secretFromRow = (row: SecretRow): Secret => ({
  workspaceId: row.workspace_id,
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * The names of the secrets, global (`workspaceId` null) and per workspace.
 * The values are Keychain items, never rows. Shares the one connection
 * `SqliteRepositories` opens.
 */
export class SecretRepository {
  constructor(private readonly database: Database) {}

  /** One scope's secrets: a workspace's, or the global ones for null. */
  list(workspaceId: string | null): Secret[] {
    return this.database
      .query<SecretRow, [string | null]>(
        "SELECT * FROM secrets WHERE workspace_id IS ? ORDER BY name",
      )
      .all(workspaceId)
      .map(secretFromRow);
  }

  find(workspaceId: string | null, name: string): Secret | undefined {
    const row = this.database
      .query<SecretRow, [string | null, string]>(
        "SELECT * FROM secrets WHERE workspace_id IS ? AND name = ?",
      )
      .get(workspaceId, name);
    return row ? secretFromRow(row) : undefined;
  }

  /** Adds the name, or moves `updated_at` when it is already there. */
  save(workspaceId: string | null, name: string, at: string): Secret {
    const existing = this.find(workspaceId, name);
    if (existing) {
      this.database
        .query(
          "UPDATE secrets SET updated_at = ? WHERE workspace_id IS ? AND name = ?",
        )
        .run(at, workspaceId, name);
      return { ...existing, updatedAt: at };
    }
    this.database
      .query(
        "INSERT INTO secrets (workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(workspaceId, name, at, at);
    return { workspaceId, name, createdAt: at, updatedAt: at };
  }

  delete(workspaceId: string | null, name: string): boolean {
    return (
      this.database
        .query("DELETE FROM secrets WHERE workspace_id IS ? AND name = ?")
        .run(workspaceId, name).changes > 0
    );
  }
}

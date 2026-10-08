import type { Database } from "bun:sqlite";
import type { WorkspaceSecret } from "../domain";

interface WorkspaceSecretRow {
  workspace_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

const secretFromRow = (row: WorkspaceSecretRow): WorkspaceSecret => ({
  workspaceId: row.workspace_id,
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * The names of each workspace's secrets. The values are Keychain items, never
 * rows. Shares the one connection `SqliteRepositories` opens.
 */
export class SecretRepository {
  constructor(private readonly database: Database) {}

  list(workspaceId: string): WorkspaceSecret[] {
    return this.database
      .query<WorkspaceSecretRow, [string]>(
        "SELECT * FROM workspace_secrets WHERE workspace_id = ? ORDER BY name",
      )
      .all(workspaceId)
      .map(secretFromRow);
  }

  /** Adds the name, or moves `updated_at` when it is already there. */
  save(workspaceId: string, name: string, at: string): WorkspaceSecret {
    const row = this.database
      .query<WorkspaceSecretRow, [string, string, string, string]>(
        `INSERT INTO workspace_secrets (workspace_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_id, name) DO UPDATE SET updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get(workspaceId, name, at, at);
    if (!row) throw new Error("The secret was not stored");
    return secretFromRow(row);
  }

  delete(workspaceId: string, name: string): boolean {
    return (
      this.database
        .query(
          "DELETE FROM workspace_secrets WHERE workspace_id = ? AND name = ?",
        )
        .run(workspaceId, name).changes > 0
    );
  }
}

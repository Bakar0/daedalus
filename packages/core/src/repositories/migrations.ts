import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function runMigrations(
  databasePath: string,
  migrationsDirectory: string,
): Promise<void> {
  const database = new Database(databasePath, { create: true });
  try {
    database.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
    );
    database.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const applied = new Set(
      database
        .query<{ version: string }, []>("SELECT version FROM schema_migrations")
        .all()
        .map((row) => row.version),
    );
    const files = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const apply = database.transaction((version: string, sql: string) => {
      database.exec(sql);
      database
        .query(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        )
        .run(version, new Date().toISOString());
    });
    for (const file of files) {
      if (!applied.has(file))
        apply(file, await Bun.file(join(migrationsDirectory, file)).text());
    }
  } finally {
    database.close();
  }
}

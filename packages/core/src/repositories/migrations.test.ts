import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { runMigrations } from "./migrations";

const cleanup: string[] = [];
afterEach(async () =>
  Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ),
);

describe("runMigrations", () => {
  test("applies ordered migrations exactly once", async () => {
    const home = await mkdtemp(join(tmpdir(), "daedalus-migrations-"));
    cleanup.push(home);
    const migrations = join(home, "migrations");
    await mkdir(migrations);
    await Bun.write(
      join(migrations, "001_test.sql"),
      "CREATE TABLE sample (id TEXT PRIMARY KEY);",
    );
    const databasePath = join(home, "state.db");
    await runMigrations(databasePath, migrations);
    await runMigrations(databasePath, migrations);
    const database = new Database(databasePath);
    expect(
      database.query("SELECT version FROM schema_migrations").all(),
    ).toHaveLength(1);
    database.close();
  });
});

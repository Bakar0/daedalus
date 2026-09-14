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

  test("backfills names for existing task and terminal sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "daedalus-session-names-"));
    cleanup.push(home);
    const migrations = join(home, "migrations");
    const source = join(import.meta.dir, "../../../../migrations");
    await mkdir(migrations);
    for (const file of ["001_initial.sql", "002_session_kind.sql"])
      await Bun.write(join(migrations, file), Bun.file(join(source, file)));
    const databasePath = join(home, "state.db");
    await runMigrations(databasePath, migrations);
    const database = new Database(databasePath);
    database.exec(`
      INSERT INTO workspaces VALUES ('w1', 'demo', 'Demo', '/tmp/demo', 'now', 'now', NULL);
      INSERT INTO tasks VALUES ('t1', 'w1', 'Build UI', '', 'todo', 'normal', 'now', 'now', NULL);
      INSERT INTO agent_sessions VALUES ('a1', 'w1', 't1', 'codex', 'tmux-a1', 'codex', '[]', '/tmp/demo', 'running', NULL, 'now', NULL, 'agent');
      INSERT INTO agent_sessions VALUES ('a2', 'w1', NULL, 'custom', 'tmux-a2', 'zsh', '[]', '/tmp/demo', 'running', NULL, 'now', NULL, 'terminal');
    `);
    database.close();
    await Bun.write(
      join(migrations, "003_session_name.sql"),
      Bun.file(join(source, "003_session_name.sql")),
    );
    await runMigrations(databasePath, migrations);
    const migrated = new Database(databasePath);
    expect(
      migrated
        .query<{ name: string }, []>(
          "SELECT name FROM agent_sessions ORDER BY id",
        )
        .all(),
    ).toEqual([{ name: "Build UI" }, { name: "Terminal" }]);
    migrated.close();

    await Bun.write(
      join(migrations, "004_archives.sql"),
      Bun.file(join(source, "004_archives.sql")),
    );
    await runMigrations(databasePath, migrations);
    const archived = new Database(databasePath);
    expect(
      archived
        .query<{ archived_at: string | null; resume_count: number }, []>(
          "SELECT archived_at, resume_count FROM agent_sessions ORDER BY id",
        )
        .all(),
    ).toEqual([
      { archived_at: null, resume_count: 0 },
      { archived_at: null, resume_count: 0 },
    ]);
    archived.close();

    await Bun.write(
      join(migrations, "005_integrated_terminals.sql"),
      Bun.file(join(source, "005_integrated_terminals.sql")),
    );
    await runMigrations(databasePath, migrations);
    const integrated = new Database(databasePath);
    expect(
      integrated
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'integrated_terminals'",
        )
        .get(),
    ).toEqual({ name: "integrated_terminals" });
    integrated.close();

    await Bun.write(
      join(migrations, "006_workspace_content.sql"),
      Bun.file(join(source, "006_workspace_content.sql")),
    );
    await runMigrations(databasePath, migrations);
    const workspaceContent = new Database(databasePath);
    expect(
      workspaceContent
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('workspace_repositories', 'session_worktrees') ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "session_worktrees" },
      { name: "workspace_repositories" },
    ]);
    workspaceContent.close();

    await Bun.write(
      join(migrations, "007_repository_library.sql"),
      Bun.file(join(source, "007_repository_library.sql")),
    );
    await runMigrations(databasePath, migrations);
    const repositoryLibrary = new Database(databasePath);
    expect(
      repositoryLibrary
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repository_library'",
        )
        .get(),
    ).toEqual({ name: "repository_library" });
    expect(
      repositoryLibrary
        .query<{ name: string }, []>(
          "SELECT name FROM pragma_table_info('workspace_repositories') WHERE name IN ('library_repository_id', 'reference_path', 'base_branch', 'base_commit', 'fetched_at') ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "base_branch" },
      { name: "base_commit" },
      { name: "fetched_at" },
      { name: "library_repository_id" },
      { name: "reference_path" },
    ]);
    repositoryLibrary.close();
  });
});

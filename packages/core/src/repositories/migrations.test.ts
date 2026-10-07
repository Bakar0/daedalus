import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
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

    await Bun.write(
      join(migrations, "008_readable_task_ids.sql"),
      Bun.file(join(source, "008_readable_task_ids.sql")),
    );
    await runMigrations(databasePath, migrations);
    const readableTaskIds = new Database(databasePath);
    expect(
      readableTaskIds
        .query<{ task_id_prefix: string; next_task_number: number }, []>(
          "SELECT task_id_prefix, next_task_number FROM workspaces WHERE id = 'w1'",
        )
        .get(),
    ).toEqual({ task_id_prefix: "demo", next_task_number: 1 });
    readableTaskIds.close();

    await Bun.write(
      join(migrations, "009_task_numbers.sql"),
      Bun.file(join(source, "009_task_numbers.sql")),
    );
    await runMigrations(databasePath, migrations);
    const taskNumbers = new Database(databasePath);
    expect(
      taskNumbers
        .query<{ number: number }, []>(
          "SELECT number FROM tasks WHERE id = 't1'",
        )
        .get(),
    ).toEqual({ number: 1 });
    expect(
      taskNumbers
        .query<{ next_task_number: number }, []>(
          "SELECT next_task_number FROM workspaces WHERE id = 'w1'",
        )
        .get(),
    ).toEqual({ next_task_number: 2 });
    taskNumbers.close();
  });

  test("backfills manual order newest first for existing rows", async () => {
    const home = await mkdtemp(join(tmpdir(), "daedalus-manual-order-"));
    cleanup.push(home);
    const migrations = join(home, "migrations");
    const source = join(import.meta.dir, "../../../../migrations");
    await mkdir(migrations);
    // Everything up to, but not including, the migration under test — so the
    // rows below are exactly what an existing install would be carrying.
    const earlier = (await readdir(source))
      .filter((file) => file.endsWith(".sql") && !file.startsWith("011_"))
      .sort();
    for (const file of earlier)
      await Bun.write(join(migrations, file), Bun.file(join(source, file)));
    const databasePath = join(home, "state.db");
    await runMigrations(databasePath, migrations);

    const database = new Database(databasePath);
    database.exec(`
      INSERT INTO workspaces (id, slug, name, path, created_at, updated_at, task_id_prefix)
      VALUES ('w-old', 'old', 'Old', '/tmp/old', '2026-01-01T00:00:00.000Z', 'now', 'old'),
             ('w-new', 'new', 'New', '/tmp/new', '2026-03-01T00:00:00.000Z', 'now', 'new');
      INSERT INTO agent_sessions (id, workspace_id, task_id, name, provider, kind, tmux_session, command, args, working_directory, status, started_at)
      VALUES ('s-old', 'w-old', NULL, 'Older', 'claude', 'agent', 'tmux-old', 'claude', '[]', '/tmp/old', 'running', '2026-02-01T00:00:00.000Z'),
             ('s-new', 'w-old', NULL, 'Newer', 'claude', 'agent', 'tmux-new', 'claude', '[]', '/tmp/old', 'running', '2026-02-02T00:00:00.000Z'),
             ('s-other', 'w-new', NULL, 'Elsewhere', 'claude', 'agent', 'tmux-other', 'claude', '[]', '/tmp/new', 'running', '2026-02-03T00:00:00.000Z');
    `);
    database.close();

    await Bun.write(
      join(migrations, "011_manual_order.sql"),
      Bun.file(join(source, "011_manual_order.sql")),
    );
    await runMigrations(databasePath, migrations);

    const ordered = new Database(databasePath);
    // The newest workspace leads, which inverts how the list used to read.
    expect(
      ordered
        .query<{ id: string }, []>(
          "SELECT id FROM workspaces ORDER BY position, id",
        )
        .all(),
    ).toEqual([{ id: "w-new" }, { id: "w-old" }]);
    expect(
      ordered
        .query<{ id: string }, []>(
          "SELECT id FROM agent_sessions WHERE workspace_id = 'w-old' ORDER BY position, id",
        )
        .all(),
    ).toEqual([{ id: "s-new" }, { id: "s-old" }]);
    // Session order is per workspace, so the only session in the other
    // workspace is first there rather than third overall.
    expect(
      ordered
        .query<{ position: number }, []>(
          "SELECT position FROM agent_sessions WHERE id = 's-other'",
        )
        .get(),
    ).toEqual({ position: 1 });
    ordered.close();
  });
  test("a foreign-keys-off migration rolls back when it breaks a key", async () => {
    const home = await mkdtemp(join(tmpdir(), "daedalus-fk-off-"));
    cleanup.push(home);
    const migrations = join(home, "migrations");
    await mkdir(migrations);
    await Bun.write(
      join(migrations, "001_parent.sql"),
      "CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (parent_id TEXT REFERENCES parent(id));",
    );
    await Bun.write(
      join(migrations, "002_broken.sql"),
      "-- daedalus:foreign-keys-off\nINSERT INTO child VALUES ('missing');",
    );
    const databasePath = join(home, "state.db");
    await expect(runMigrations(databasePath, migrations)).rejects.toThrow(
      "002_broken.sql broke foreign keys in child",
    );
    const database = new Database(databasePath);
    expect(
      database.query("SELECT version FROM schema_migrations").all(),
    ).toEqual([{ version: "001_parent.sql" }]);
    expect(database.query("SELECT * FROM child").all()).toEqual([]);
    database.close();
  });

  test("teams keep every routine, run and report through the abilities rebuild", async () => {
    const home = await mkdtemp(join(tmpdir(), "daedalus-teams-"));
    cleanup.push(home);
    const migrations = join(home, "migrations");
    const source = join(import.meta.dir, "../../../../migrations");
    await mkdir(migrations);
    const earlier = (await readdir(source))
      .filter((file) => file.endsWith(".sql") && file < "020_")
      .sort();
    for (const file of earlier)
      await Bun.write(join(migrations, file), Bun.file(join(source, file)));
    const databasePath = join(home, "state.db");
    await runMigrations(databasePath, migrations);

    const database = new Database(databasePath);
    database.exec(`
      INSERT INTO workspaces (id, slug, name, path, created_at, updated_at, task_id_prefix)
      VALUES ('w1', 'demo', 'Demo', '/tmp/demo', 'now', 'now', 'demo');
      INSERT INTO tasks (id, workspace_id, title, description, status, priority, created_at, updated_at, number)
      VALUES ('t1', 'w1', 'Fix', '', 'todo', 'normal', 'now', 'now', 1);
      INSERT INTO agent_sessions (id, workspace_id, task_id, name, provider, kind, tmux_session, command, args, working_directory, status, started_at)
      VALUES ('s1', 'w1', NULL, 'Watcher', 'claude', 'agent', 'tmux-s1', 'claude', '[]', '/tmp/demo', 'running', 'now');
      INSERT INTO session_abilities (id, session_id, ability, config, granted_at)
      VALUES ('ab1', 's1', 'routines', '{"purpose":"watch CI"}', 'now');
      INSERT INTO routines (id, ability_id, name, schedule, timeout_ms, output, body, created_at, updated_at)
      VALUES ('r1', 'ab1', 'ci', '{"kind":"every","everyMs":60000,"text":"every 1m"}', 60000, 'task', 'check CI', 'now', 'now');
      INSERT INTO routine_runs (ability_id, routine, status, queued_at)
      VALUES ('ab1', 'ci', 'done', 'now');
      INSERT INTO routine_reports (id, ability_id, routine, report_key, title, task_id, state, opened_at, last_seen_at)
      VALUES ('rep1', 'ab1', 'ci', 'build-1', 'Build broke', 't1', 'open', 'now', 'now');
    `);
    database.close();

    await Bun.write(
      join(migrations, "020_teams.sql"),
      Bun.file(join(source, "020_teams.sql")),
    );
    await runMigrations(databasePath, migrations);

    const migrated = new Database(databasePath);
    expect(
      migrated
        .query("SELECT id, session_id, ability, config FROM session_abilities")
        .all(),
    ).toEqual([
      {
        id: "ab1",
        session_id: "s1",
        ability: "routines",
        config: '{"purpose":"watch CI"}',
      },
    ]);
    expect(migrated.query("SELECT id FROM routines").all()).toEqual([
      { id: "r1" },
    ]);
    expect(migrated.query("SELECT routine FROM routine_runs").all()).toEqual([
      { routine: "ci" },
    ]);
    expect(
      migrated.query("SELECT id, task_id FROM routine_reports").all(),
    ).toEqual([{ id: "rep1", task_id: "t1" }]);
    migrated.exec("PRAGMA foreign_keys = ON");
    migrated.exec(`
      INSERT INTO session_abilities (id, session_id, ability, granted_at)
      VALUES ('ab2', 's1', 'orchestration', 'now');
      UPDATE agent_sessions SET team_id = 'ab2', team_handle = 'worker' WHERE id = 's1';
      INSERT INTO team_messages (team_id, author, body, tags, created_at)
      VALUES ('ab2', 'user', 'hello', '["lead"]', 'now');
    `);
    // The children still point at the rebuilt table: deleting the session
    // cascades through it into routines and the team chat.
    migrated.exec("DELETE FROM agent_sessions WHERE id = 's1'");
    for (const table of [
      "session_abilities",
      "routines",
      "routine_runs",
      "routine_reports",
      "team_messages",
    ])
      expect(
        migrated
          .query<{ count: number }, []>(
            `SELECT count(*) AS count FROM ${table}`,
          )
          .get(),
      ).toEqual({ count: 0 });
    migrated.close();
  });
});

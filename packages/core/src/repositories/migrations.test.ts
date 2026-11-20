import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
  runMigrations,
  sqlStatements,
  withoutExistingColumns,
} from "./migrations";

const cleanup: string[] = [];
afterEach(async () =>
  Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ),
);

describe("sqlStatements", () => {
  test("ends a statement only at a semicolon outside strings, comments and trigger bodies", () => {
    expect(
      sqlStatements(`
        -- a comment; not a statement
        CREATE TABLE t (x TEXT DEFAULT 'a;b', "odd;name" INTEGER);
        /* block; comment */
        CREATE TRIGGER tr AFTER INSERT ON t BEGIN
          UPDATE t SET x = CASE WHEN new.x = 'y' THEN 'z' END;
          DELETE FROM t WHERE x = 'it''s;';
        END;
        INSERT INTO t (x) VALUES ('done');
        -- trailing comment
      `).map((statement) => statement.replace(/\s+/g, " ")),
    ).toEqual([
      `-- a comment; not a statement CREATE TABLE t (x TEXT DEFAULT 'a;b', "odd;name" INTEGER);`,
      "/* block; comment */ CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET x = CASE WHEN new.x = 'y' THEN 'z' END; DELETE FROM t WHERE x = 'it''s;'; END;",
      "INSERT INTO t (x) VALUES ('done');",
    ]);
  });
});

describe("runMigrations", () => {
  test("skips a column an unshipped build already added, and adds the rest", async () => {
    const home = await mkdtemp(join(tmpdir(), "daedalus-migrations-"));
    cleanup.push(home);
    const migrations = join(home, "migrations");
    await mkdir(migrations);
    await Bun.write(
      join(migrations, "001_base.sql"),
      "CREATE TABLE workspaces (id TEXT PRIMARY KEY);",
    );
    // What a local branch build applied under a name main never had.
    await Bun.write(
      join(migrations, "002_branch_only.sql"),
      "ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'workspace'\n  CHECK (kind IN ('workspace', 'home'));",
    );
    const databasePath = join(home, "state.db");
    await runMigrations(databasePath, migrations);
    await rm(join(migrations, "002_branch_only.sql"));
    await Bun.write(
      join(migrations, "003_home.sql"),
      [
        "-- ALTER TABLE workspaces ADD COLUMN commented TEXT;",
        "ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'workspace'",
        "  CHECK (kind IN ('workspace', 'home'));",
        "ALTER TABLE workspaces ADD COLUMN resolved_at TEXT;",
        "CREATE TABLE thread_suggestions (id INTEGER PRIMARY KEY);",
      ].join("\n"),
    );
    await runMigrations(databasePath, migrations);
    const database = new Database(databasePath);
    const columns = database
      .query<{ name: string }, []>("PRAGMA table_info(workspaces)")
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(["id", "kind", "resolved_at"]);
    expect(
      database.query("SELECT version FROM schema_migrations").all(),
    ).toHaveLength(3);
    database.close();
    expect(
      withoutExistingColumns(
        "ALTER TABLE a ADD b TEXT;\nALTER TABLE a ADD COLUMN c TEXT;",
        (_table, column) => column === "b",
      ),
    ).toBe(
      "-- skipped, the column already exists: a.b\nALTER TABLE a ADD COLUMN c TEXT;",
    );
  });

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
  test("a statement that fails after the first rolls the whole migration back", async () => {
    const home = await mkdtemp(join(tmpdir(), "daedalus-migrations-"));
    cleanup.push(home);
    const migrations = join(home, "migrations");
    await mkdir(migrations);
    await Bun.write(
      join(migrations, "001_table.sql"),
      "CREATE TABLE items (x INTEGER CHECK (x > 0));",
    );
    await Bun.write(
      join(migrations, "002_rows.sql"),
      "INSERT INTO items VALUES (1);\nINSERT INTO items VALUES (-1);\nDROP TABLE items;",
    );
    const databasePath = join(home, "state.db");
    await expect(runMigrations(databasePath, migrations)).rejects.toThrow(
      "CHECK constraint failed",
    );
    const database = new Database(databasePath);
    expect(database.query("SELECT x FROM items").all()).toEqual([]);
    expect(
      database.query("SELECT version FROM schema_migrations").all(),
    ).toEqual([{ version: "001_table.sql" }]);
    database.close();
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

  test("team chat and asks move to conversations with their ids, history and cursors", async () => {
    const home = await mkdtemp(join(tmpdir(), "daedalus-conversations-"));
    cleanup.push(home);
    const migrations = join(home, "migrations");
    const source = join(import.meta.dir, "../../../../migrations");
    await mkdir(migrations);
    for (const file of (await readdir(source))
      .filter((file) => file.endsWith(".sql") && file < "052_")
      .sort())
      await Bun.write(join(migrations, file), Bun.file(join(source, file)));
    const databasePath = join(home, "state.db");
    await runMigrations(databasePath, migrations);

    const database = new Database(databasePath);
    database.exec(`
      INSERT INTO workspaces (id, slug, name, path, created_at, updated_at, task_id_prefix)
      VALUES ('w1', 'demo', 'Demo', '/tmp/demo', 't0', 't0', 'demo');
      INSERT INTO agent_sessions (id, workspace_id, name, provider, kind, tmux_session, command, args, working_directory, status, started_at)
      VALUES ('s1', 'w1', 'Lead', 'claude', 'agent', 'tmux-s1', 'claude', '[]', '/tmp/demo', 'running', 't0'),
             ('s2', 'w1', 'Old', 'claude', 'agent', 'tmux-s2', 'claude', '[]', '/tmp/demo', 'exited', 't0');
      UPDATE agent_sessions SET archived_at = 't1' WHERE id = 's2';
      INSERT INTO session_abilities (id, session_id, ability, config, granted_at)
      VALUES ('team1', 's1', 'orchestration', '{}', 't0');
      INSERT INTO team_messages (id, team_id, author, body, tags, created_at, kind)
      VALUES (5, 'team1', 'lead', '@api start', '["api"]', 't1', 'message'),
             (9, 'team1', 'api', 'done', '[]', 't2', 'handback');
      INSERT INTO team_cursors (team_id, handle, read_through, tagged_read_through, delivered_through, delivered_at)
      VALUES ('team1', 'api', 5, 5, 5, 't1');
      INSERT INTO asks (id, workspace_id, session_id, title, context, why, options, state, answer, note, closed_reason, created_at, updated_at, closed_at, notice_delivered_at, notified_at, bumped_at, kind)
      VALUES
        (3, 'w1', 's1', 'Retries?', 'ids here', 'blocks deploy', '["3","5"]', 'answered', '5', 'and log it', NULL, 't1', 't3', 't3', NULL, 't1', NULL, 'question'),
        (4, 'w1', 's1', 'Which bucket?', NULL, NULL, '[]', 'open', NULL, NULL, NULL, 't1', 't2', NULL, NULL, NULL, 't2', 'question'),
        (6, 'w1', 's1', 'Merge?', NULL, NULL, '[]', 'answered', NULL, 'yes', 'Answered in its session', 't1', 't2', 't2', NULL, 't1', NULL, 'question'),
        (7, 'w1', 's1', 'A line in main', NULL, NULL, '[]', 'open', NULL, NULL, NULL, 't1', 't1', NULL, NULL, 't1', NULL, 'fork');
    `);
    database.close();

    await Bun.write(
      join(migrations, "052_conversations.sql"),
      Bun.file(join(source, "052_conversations.sql")),
    );
    await runMigrations(databasePath, migrations);

    const migrated = new Database(databasePath);
    const rows = (sql: string) => migrated.query(sql).all();
    expect(
      rows(
        "SELECT m.id, m.author, m.kind, m.body, m.tags FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.team_id = 'team1' ORDER BY m.id",
      ),
    ).toEqual([
      {
        id: 5,
        author: "lead",
        kind: "message",
        body: "@api start",
        tags: '["api"]',
      },
      { id: 9, author: "api", kind: "handback", body: "done", tags: "[]" },
    ]);
    expect(
      rows(
        "SELECT k.participant, k.read_through, k.tagged_read_through, k.delivered_through, k.delivered_at FROM cursors k JOIN conversations c ON c.id = k.conversation_id WHERE c.team_id = 'team1'",
      ),
    ).toEqual([
      {
        participant: "api",
        read_through: 5,
        tagged_read_through: 5,
        delivered_through: 5,
        delivered_at: "t1",
      },
    ]);
    const thread = (number: number) =>
      migrated
        .query<{ author: string; kind: string; body: string }, []>(
          `SELECT m.author, m.kind, m.body, m.details, m.options, m.picked FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.number = ${number} ORDER BY m.id`,
        )
        .all();
    expect(thread(3)).toEqual([
      {
        author: "agent",
        kind: "message",
        body: "Retries?\n\nblocks deploy",
        details: "ids here",
        options: '["3","5"]',
        picked: null,
      },
      {
        author: "user",
        kind: "message",
        body: "5\nand log it",
        details: null,
        options: "[]",
        picked: 1,
      },
      {
        author: "user",
        kind: "notice",
        body: "resolved",
        details: null,
        options: "[]",
        picked: null,
      },
    ]);
    expect(
      thread(4).map((message) => [message.author, message.kind, message.body]),
    ).toEqual([
      ["agent", "message", "Which bucket?"],
      ["agent", "notice", "blocked"],
    ]);
    expect(
      thread(6).map((message) => [message.author, message.kind, message.body]),
    ).toEqual([
      ["agent", "message", "Merge?"],
      ["agent", "notice", "resolved: answered in main (yes)"],
    ]);
    expect(thread(7)).toEqual([]);
    expect(
      rows(
        "SELECT number, resolved_by, blocked_at, title FROM conversations WHERE kind = 'thread' ORDER BY number",
      ),
    ).toEqual([
      { number: 3, resolved_by: "user", blocked_at: null, title: "Retries?" },
      {
        number: 4,
        resolved_by: null,
        blocked_at: "t2",
        title: "Which bucket?",
      },
      { number: 6, resolved_by: "agent", blocked_at: null, title: "Merge?" },
      {
        number: 7,
        resolved_by: null,
        blocked_at: null,
        title: "A line in main",
      },
    ]);
    // #3's answer was not told to its owner yet; #4 was never notified to the user.
    const pending = (participant: string, author: string) =>
      rows(
        `SELECT c.number FROM conversations c LEFT JOIN cursors k ON k.conversation_id = c.id AND k.participant = '${participant}' WHERE c.kind = 'thread' AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.author = '${author}' AND m.id > coalesce(k.delivered_through, 0)) ORDER BY c.number`,
      );
    expect(pending("agent", "user")).toEqual([{ number: 3 }]);
    expect(pending("user", "agent")).toEqual([{ number: 4 }]);
    expect(
      rows(
        "SELECT rowid FROM messages_search WHERE messages_search MATCH 'buck'",
      ),
    ).toHaveLength(1);
    expect(rows("SELECT session_id FROM session_notes")).toEqual([
      { session_id: "s1" },
    ]);
    expect(
      rows(
        "SELECT name FROM sqlite_master WHERE name IN ('asks', 'team_messages', 'team_cursors')",
      ),
    ).toEqual([]);
    migrated.close();
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

  test("ability routines move to their session's workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "daedalus-routines-move-"));
    cleanup.push(home);
    const migrations = join(home, "migrations");
    const source = join(import.meta.dir, "../../../../migrations");
    await mkdir(migrations);
    const earlier = (await readdir(source))
      .filter((file) => file.endsWith(".sql") && file < "037_")
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
      VALUES ('t1', 'w1', 'Build broke', '', 'todo', 'normal', 'now', 'now', 1);
      INSERT INTO agent_sessions (id, workspace_id, task_id, name, provider, kind, tmux_session, command, args, working_directory, status, started_at)
      VALUES ('s1', 'w1', NULL, 'Watcher', 'claude', 'agent', 'tmux-s1', 'claude', '[]', '/tmp/demo', 'running', 'now');
      INSERT INTO session_abilities (id, session_id, ability, paused, config, granted_at)
      VALUES ('ab1', 's1', 'routines', 0, '{"purpose":"watch CI"}', 'now');
      INSERT INTO routines (id, ability_id, name, schedule, model, timeout_ms, output, enabled, body, is_template, next_run_at, created_at, updated_at)
      VALUES
        ('r1', 'ab1', 'ci', '{"kind":"every","everyMs":60000,"text":"every 1m"}', 'haiku', 60000, 'task', 1, 'Builds since {{last_run}}.', 0, '2026-11-01T06:00:00.000Z', 'now', 'now'),
        ('r2', 'ab1', 'draft', '{"kind":"every","everyMs":60000,"text":"every 1m"}', NULL, 60000, 'task', 1, 'template', 1, NULL, 'now', 'now');
      INSERT INTO routine_reports (id, ability_id, routine, report_key, title, task_id, state, opened_at, last_seen_at)
      VALUES ('rep1', 'ab1', 'ci', 'build-1', 'Build broke', 't1', 'open', 'now', 'now');
    `);
    database.close();

    await Bun.write(
      join(migrations, "037_routines_move_to_workspaces.sql"),
      Bun.file(join(source, "037_routines_move_to_workspaces.sql")),
    );
    await runMigrations(databasePath, migrations);

    const migrated = new Database(databasePath);
    expect(
      migrated
        .query(
          "SELECT name, workspace_id, schedule, prompt, model, enabled, next_run_at FROM workspace_routines",
        )
        .all(),
    ).toEqual([
      {
        name: "ci",
        workspace_id: "w1",
        schedule: "every 1m",
        prompt:
          "Purpose: watch CI\n\nBuilds since <when the previous run ended, ISO 8601>.",
        model: "haiku",
        enabled: 1,
        next_run_at: "2026-11-01T06:00:00.000Z",
      },
    ]);
    expect(
      migrated
        .query(
          "SELECT name FROM sqlite_master WHERE name IN ('routines', 'routine_runs', 'routine_reports')",
        )
        .all(),
    ).toEqual([]);
    expect(migrated.query("SELECT * FROM session_abilities").all()).toEqual([]);
    expect(migrated.query("SELECT id FROM tasks").all()).toEqual([
      { id: "t1" },
    ]);
    migrated.close();
  });
});

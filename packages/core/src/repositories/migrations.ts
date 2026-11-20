import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * A migration that starts with this line runs with foreign keys off. SQLite's
 * table rebuild (create, copy, drop, rename) needs that: with foreign keys on,
 * dropping the old table cascades into every child table. The runner checks
 * the keys after the migration and rolls it back if any is broken.
 */
export const FOREIGN_KEYS_OFF_MARKER = "-- daedalus:foreign-keys-off";

/**
 * `ALTER TABLE t ADD [COLUMN] c ...;` starting a line, up to the statement's
 * end. A commented-out line starts with `--` and never matches.
 */
const ADD_COLUMN =
  /^[ \t]*ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+(?:COLUMN\s+)?["`]?(\w+)["`]?[^;]*;?/gim;

/**
 * The migration without the columns the database already has. A build that
 * never shipped (a local or branch build) can have added a column under
 * another migration's name; adding it again would stop the app at start
 * with "duplicate column name".
 */
export function withoutExistingColumns(
  sql: string,
  hasColumn: (table: string, column: string) => boolean,
): string {
  return sql.replace(ADD_COLUMN, (statement, table: string, column: string) =>
    hasColumn(table, column)
      ? `-- skipped, the column already exists: ${table}.${column}`
      : statement,
  );
}

/**
 * A script's statements, each with its `;`. A `;` inside a string, a quoted
 * name, a comment, or a trigger's `BEGIN ... END` body does not end one.
 * Text that is only comments and space is not a statement.
 */
export function sqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let code = "";
  let depth = 0;
  let index = 0;
  const finish = (end: number) => {
    if (code.trim()) statements.push(sql.slice(start, end).trim());
    start = end;
    code = "";
    depth = 0;
  };
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    const close = { "'": "'", '"': '"', "`": "`", "[": "]" }[char];
    if (close) {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === close && sql[end + 1] === close && close !== "]")
          end += 2;
        else if (sql[end] === close) break;
        else end += 1;
      }
      code += " x ";
      index = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(index))![0];
      const upper = word.toUpperCase();
      if (/^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(code + word)) {
        if (upper === "BEGIN" || upper === "CASE") depth += 1;
        else if (upper === "END") depth -= 1;
      }
      code += word;
      index += word.length;
      continue;
    }
    code += char;
    index += 1;
    if (char === ";" && depth <= 0) finish(index);
  }
  finish(sql.length);
  return statements;
}

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
    const hasColumn = (table: string, column: string) =>
      database
        .query<{ name: string }, []>(
          `PRAGMA table_info("${table.replace(/"/g, '""')}")`,
        )
        .all()
        .some((row) => row.name.toLowerCase() === column.toLowerCase());
    const apply = database.transaction(
      (version: string, sql: string, checkForeignKeys: boolean) => {
        // One statement at a time: given several, Bun's `exec` and `run`
        // skip one that fails after the first without throwing, which would
        // commit half a migration.
        for (const statement of sqlStatements(
          withoutExistingColumns(sql, hasColumn),
        ))
          database.run(statement);
        if (checkForeignKeys) {
          const broken = database
            .query<{ table: string }, []>("PRAGMA foreign_key_check")
            .all();
          if (broken.length > 0)
            throw new Error(
              `Migration ${version} broke foreign keys in ${[...new Set(broken.map((row) => row.table))].join(", ")}`,
            );
        }
        database
          .query(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
          )
          .run(version, new Date().toISOString());
      },
    );
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await Bun.file(join(migrationsDirectory, file)).text();
      const foreignKeysOff = sql.startsWith(FOREIGN_KEYS_OFF_MARKER);
      // The pragma is a no-op inside a transaction, so it is set around it.
      if (foreignKeysOff) database.exec("PRAGMA foreign_keys = OFF");
      try {
        apply(file, sql, foreignKeysOff);
      } finally {
        if (foreignKeysOff) database.exec("PRAGMA foreign_keys = ON");
      }
    }
  } finally {
    database.close();
  }
}

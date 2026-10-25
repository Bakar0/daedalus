import { Database } from "bun:sqlite";

/**
 * The gateway's SQLite database: users, token hashes and workspaces. Tokens
 * are never stored, only their SHA-256, so a copy of the database does not
 * let anyone sign in. Every workspace query takes the user id, so a lookup
 * cannot reach another user's row by accident.
 */

export interface UserRow {
  id: string;
  email: string;
}

/** A user as the admin page lists them. */
export interface AdminUserRow extends UserRow {
  createdAt: string;
  /** The admin's override of the workspace limit; null for the default. */
  maxWorkspaces: number | null;
}

/** One admin action, as the admin page's audit panel shows it. */
export interface AuditEntry {
  at: string;
  subject: string;
  session: string;
  address: string;
  action: string;
  target: string;
  result: string;
  detail: string;
}

/** Audit rows kept; older ones are pruned on insert. */
const AUDIT_KEEP = 1000;

export type TokenOwner =
  | { kind: "user"; userId: string }
  | { kind: "runner"; userId: string; workspaceId: string };

export interface WorkspaceRow {
  userId: string;
  workspaceId: string;
  name: string;
  macId: string;
  macKey: string;
  cpu: string | null;
  memory: string | null;
  runnerKey: string | null;
  /** Whether the user asked it to sleep; the pod is gone while it does. */
  sleeping: boolean;
  /** When it last went to sleep; null while awake. */
  sleptAt: string | null;
  /** When the Mac and the pod last exchanged a frame, or it was woken. */
  lastActiveAt: string | null;
  createdAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'runner')),
  user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mac_id TEXT NOT NULL,
  mac_key TEXT NOT NULL,
  cpu TEXT,
  memory TEXT,
  runner_key TEXT,
  sleeping INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  subject TEXT NOT NULL,
  session TEXT NOT NULL,
  address TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  result TEXT NOT NULL,
  detail TEXT NOT NULL
);
`;

interface WorkspaceRecord {
  user_id: string;
  workspace_id: string;
  name: string;
  mac_id: string;
  mac_key: string;
  cpu: string | null;
  memory: string | null;
  runner_key: string | null;
  sleeping: number;
  slept_at: string | null;
  last_active_at: string | null;
  created_at: string;
}

const toWorkspace = (row: WorkspaceRecord): WorkspaceRow => ({
  userId: row.user_id,
  workspaceId: row.workspace_id,
  name: row.name,
  macId: row.mac_id,
  macKey: row.mac_key,
  cpu: row.cpu,
  memory: row.memory,
  runnerKey: row.runner_key,
  sleeping: row.sleeping === 1,
  sleptAt: row.slept_at,
  lastActiveAt: row.last_active_at,
  createdAt: row.created_at,
});

export const sha256 = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** 32 random bytes, base64url. */
export const randomToken = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** A user id: 12 lowercase letters and digits (the contract allows 20). */
export function randomUserId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export class Store {
  readonly #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.run("PRAGMA journal_mode = WAL");
    this.#db.run("PRAGMA foreign_keys = ON");
    this.#db.run(SCHEMA);
    this.#addCollectionColumns();
    this.#addAdminColumns();
  }

  /** The columns the admin page reads, added to a database from before it. */
  #addAdminColumns(): void {
    const columns = (table: string) =>
      new Set(
        this.#db
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => column.name),
      );
    this.#db.transaction(() => {
      if (!columns("workspaces").has("last_active_at"))
        this.#db.run("ALTER TABLE workspaces ADD COLUMN last_active_at TEXT");
      if (!columns("users").has("max_workspaces"))
        this.#db.run("ALTER TABLE users ADD COLUMN max_workspaces INTEGER");
    })();
  }

  /**
   * The columns collection reads, added to a database from before it. A
   * workspace already asleep then starts its clock now, not at once.
   */
  #addCollectionColumns(): void {
    const columns = new Set(
      this.#db
        .query<{ name: string }, []>("PRAGMA table_info(workspaces)")
        .all()
        .map((column) => column.name),
    );
    this.#db.transaction(() => {
      if (!columns.has("slept_at")) {
        this.#db.run("ALTER TABLE workspaces ADD COLUMN slept_at TEXT");
        this.#db
          .query("UPDATE workspaces SET slept_at = ? WHERE sleeping = 1")
          .run(new Date().toISOString());
      }
      // `disposable` (a retired rule) stays in stores that have it, unused.
    })();
  }

  close(): void {
    this.#db.close();
  }

  /** The user with this email, made on first sign-in. */
  userForEmail(email: string): UserRow {
    const found = this.#db
      .query<UserRow, [string]>("SELECT id, email FROM users WHERE email = ?")
      .get(email);
    if (found) return found;
    const user = { id: randomUserId(), email };
    this.#db
      .query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .run(user.id, user.email, new Date().toISOString());
    return user;
  }

  /** Every user, for the admin page. */
  allUsers(): AdminUserRow[] {
    return this.#db
      .query<
        {
          id: string;
          email: string;
          created_at: string;
          max_workspaces: number | null;
        },
        []
      >(
        "SELECT id, email, created_at, max_workspaces FROM users ORDER BY email",
      )
      .all()
      .map((row) => ({
        id: row.id,
        email: row.email,
        createdAt: row.created_at,
        maxWorkspaces: row.max_workspaces,
      }));
  }

  /** The user's own workspace limit, or null for the configured default. */
  maxWorkspaces(userId: string): number | null {
    return (
      this.#db
        .query<{ max_workspaces: number | null }, [string]>(
          "SELECT max_workspaces FROM users WHERE id = ?",
        )
        .get(userId)?.max_workspaces ?? null
    );
  }

  /** Sets or (with null) clears the user's limit. False for no such user. */
  setMaxWorkspaces(userId: string, max: number | null): boolean {
    return (
      this.#db
        .query("UPDATE users SET max_workspaces = ? WHERE id = ?")
        .run(max, userId).changes > 0
    );
  }

  /** Records when the workspace was last in use. */
  touch(userId: string, workspaceId: string, at = new Date()): void {
    this.#db
      .query(
        "UPDATE workspaces SET last_active_at = ? WHERE user_id = ? AND workspace_id = ?",
      )
      .run(at.toISOString(), userId, workspaceId);
  }

  /** Adds an audit entry and drops all but the newest AUDIT_KEEP. */
  audit(entry: AuditEntry): void {
    this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO admin_audit (at, subject, session, address, action, target, result, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.at,
          entry.subject,
          entry.session,
          entry.address,
          entry.action,
          entry.target,
          entry.result,
          entry.detail,
        );
      this.#db
        .query(
          "DELETE FROM admin_audit WHERE id <= (SELECT MAX(id) FROM admin_audit) - ?",
        )
        .run(AUDIT_KEEP);
    })();
  }

  /** The newest audit entries, newest first. */
  auditLog(limit: number): AuditEntry[] {
    return this.#db
      .query<AuditEntry, [number]>(
        `SELECT at, subject, session, address, action, target, result, detail
         FROM admin_audit ORDER BY id DESC LIMIT ?`,
      )
      .all(limit);
  }

  user(id: string): UserRow | null {
    return this.#db
      .query<UserRow, [string]>("SELECT id, email FROM users WHERE id = ?")
      .get(id);
  }

  /** Makes a token for the user and returns it; only its hash is kept. */
  issueUserToken(userId: string): string {
    const token = randomToken();
    this.#db
      .query(
        "INSERT INTO tokens (hash, kind, user_id, created_at) VALUES (?, 'user', ?, ?)",
      )
      .run(sha256(token), userId, new Date().toISOString());
    return token;
  }

  tokenOwner(token: string): TokenOwner | null {
    const row = this.#db
      .query<
        { kind: string; user_id: string; workspace_id: string | null },
        [string]
      >("SELECT kind, user_id, workspace_id FROM tokens WHERE hash = ?")
      .get(sha256(token));
    if (!row) return null;
    if (row.kind === "user") return { kind: "user", userId: row.user_id };
    if (row.kind === "runner" && row.workspace_id)
      return {
        kind: "runner",
        userId: row.user_id,
        workspaceId: row.workspace_id,
      };
    return null;
  }

  /**
   * Adds a workspace and its runner token's hash. False when the user has
   * one with this id already.
   */
  insertWorkspace(
    workspace: Omit<
      WorkspaceRow,
      "runnerKey" | "sleeping" | "sleptAt" | "lastActiveAt"
    >,
    runnerToken: string,
  ): boolean {
    return this.#db.transaction(() => {
      const inserted = this.#db
        .query(
          `INSERT OR IGNORE INTO workspaces
             (user_id, workspace_id, name, mac_id, mac_key, cpu, memory, created_at, last_active_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workspace.userId,
          workspace.workspaceId,
          workspace.name,
          workspace.macId,
          workspace.macKey,
          workspace.cpu,
          workspace.memory,
          workspace.createdAt,
          workspace.createdAt,
        );
      if (inserted.changes === 0) return false;
      this.#db
        .query(
          `INSERT INTO tokens (hash, kind, user_id, workspace_id, created_at)
           VALUES (?, 'runner', ?, ?, ?)`,
        )
        .run(
          sha256(runnerToken),
          workspace.userId,
          workspace.workspaceId,
          workspace.createdAt,
        );
      return true;
    })();
  }

  workspace(userId: string, workspaceId: string): WorkspaceRow | null {
    const row = this.#db
      .query<WorkspaceRecord, [string, string]>(
        "SELECT * FROM workspaces WHERE user_id = ? AND workspace_id = ?",
      )
      .get(userId, workspaceId);
    return row ? toWorkspace(row) : null;
  }

  workspaces(userId: string): WorkspaceRow[] {
    return this.#db
      .query<WorkspaceRecord, [string]>(
        "SELECT * FROM workspaces WHERE user_id = ? ORDER BY created_at, workspace_id",
      )
      .all(userId)
      .map(toWorkspace);
  }

  /** Every user's workspaces, for collection. */
  allWorkspaces(): WorkspaceRow[] {
    return this.#db
      .query<WorkspaceRecord, []>(
        "SELECT * FROM workspaces ORDER BY user_id, created_at, workspace_id",
      )
      .all()
      .map(toWorkspace);
  }

  /** Asleep from `at`, or awake. */
  setSleeping(
    userId: string,
    workspaceId: string,
    sleeping: boolean,
    at = new Date(),
  ): void {
    this.#db
      .query(
        sleeping
          ? "UPDATE workspaces SET sleeping = 1, slept_at = ? WHERE user_id = ? AND workspace_id = ?"
          : "UPDATE workspaces SET sleeping = 0, slept_at = NULL WHERE ? IS NOT NULL AND user_id = ? AND workspace_id = ?",
      )
      .run(at.toISOString(), userId, workspaceId);
  }

  /**
   * Pins the runner's key on first connect. Returns whether `key` is the
   * pinned key afterwards: false when a different key was pinned before.
   */
  pinRunnerKey(userId: string, workspaceId: string, key: string): boolean {
    this.#db
      .query(
        `UPDATE workspaces SET runner_key = ?
         WHERE user_id = ? AND workspace_id = ? AND runner_key IS NULL`,
      )
      .run(key, userId, workspaceId);
    return this.workspace(userId, workspaceId)?.runnerKey === key;
  }

  /**
   * Gives the workspace a new runner token, so the one an earlier pod held
   * stops working. Called on every wake.
   */
  replaceRunnerToken(userId: string, workspaceId: string, token: string) {
    this.#db.transaction(() => {
      this.revokeRunnerToken(userId, workspaceId);
      this.#db
        .query(
          `INSERT INTO tokens (hash, kind, user_id, workspace_id, created_at)
           VALUES (?, 'runner', ?, ?, ?)`,
        )
        .run(sha256(token), userId, workspaceId, new Date().toISOString());
    })();
  }

  /** Ends the workspace's runner token, as on sleep. */
  revokeRunnerToken(userId: string, workspaceId: string): void {
    this.#db
      .query(
        "DELETE FROM tokens WHERE kind = 'runner' AND user_id = ? AND workspace_id = ?",
      )
      .run(userId, workspaceId);
  }

  /** Removes the workspace and its runner token. */
  deleteWorkspace(userId: string, workspaceId: string): void {
    this.#db.transaction(() => {
      this.#db
        .query(
          "DELETE FROM tokens WHERE kind = 'runner' AND user_id = ? AND workspace_id = ?",
        )
        .run(userId, workspaceId);
      this.#db
        .query("DELETE FROM workspaces WHERE user_id = ? AND workspace_id = ?")
        .run(userId, workspaceId);
    })();
  }
}

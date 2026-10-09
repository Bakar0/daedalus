import {
  deleteKeychainPassword,
  readKeychainPassword,
  writeKeychainPassword,
} from "@daedalus/platform";
import type { Secret } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories/sqlite";
import type { WorkspaceService } from "./workspaces";

/** The Keychain service every secret is filed under. */
export const SECRET_SERVICE = "Daedalus secret";

/** What a secret's name may be: an environment variable name. */
const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Names a secret may not take, because Daedalus or the provider already sets
 * them in a session and a secret would silently replace them.
 */
const RESERVED_NAMES = new Set([
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "USER",
  "TMPDIR",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
]);

export function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name))
    throw new DaedalusError(
      "VALIDATION",
      `'${name}' is not a secret name; use capital letters, digits and underscores, like GH_TOKEN`,
    );
  if (RESERVED_NAMES.has(name) || name.startsWith("DAEDALUS_"))
    throw new DaedalusError(
      "VALIDATION",
      `'${name}' is reserved; Daedalus or the provider sets it in every session`,
    );
}

export interface SecretKeychain {
  write: (service: string, account: string, secret: string) => Promise<void>;
  read: (service: string, account: string) => Promise<string | undefined>;
  remove: (service: string, account: string) => Promise<void>;
}

/** A secret as a workspace sees it. */
export interface VisibleSecret extends Secret {
  /** A global secret the workspace has one of the same name for. */
  overridden: boolean;
}

/**
 * Secrets: values an agent's tools need, like API keys, that the user stores
 * once instead of pasting into a prompt. A secret is global or a workspace's
 * own, and a workspace's wins over a global one of the same name. This is a
 * convenience, not a boundary: any process the user runs can read them.
 *
 * Each value is a login Keychain item; SQLite keeps only the names. The value
 * is stored hex-encoded, because `security` prints a password that is not
 * printable text as hex and plain text as itself, and a reader could not tell
 * the two apart.
 *
 * A scope is a workspace reference, or null for the global secrets.
 */
export class SecretService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaces: WorkspaceService,
    /** Separates two Daedalus homes that both have a workspace of one id. */
    private readonly home: string,
    /** The login Keychain; replaceable so tests never touch the real one. */
    private readonly keychain: SecretKeychain = {
      write: writeKeychainPassword,
      read: readKeychainPassword,
      remove: deleteKeychainPassword,
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** One scope's own secrets. */
  async list(scope: string | null): Promise<Secret[]> {
    return this.repositories.secrets.list(await this.workspaceId(scope));
  }

  /**
   * What a command in this workspace can use: its own secrets, then the
   * global ones, each marked when the workspace has its own of that name.
   * With null, only the global ones.
   */
  async visible(scope: string | null): Promise<VisibleSecret[]> {
    const workspaceId = await this.workspaceId(scope);
    const own = workspaceId ? this.repositories.secrets.list(workspaceId) : [];
    const names = new Set(own.map((secret) => secret.name));
    return [
      ...own.map((secret) => ({ ...secret, overridden: false })),
      ...this.repositories.secrets
        .list(null)
        .map((secret) => ({ ...secret, overridden: names.has(secret.name) })),
    ];
  }

  /** Adds a secret or replaces its value. */
  async set(
    scope: string | null,
    name: string,
    value: string,
  ): Promise<Secret> {
    assertSecretName(name);
    if (!value)
      throw new DaedalusError("VALIDATION", "A secret's value cannot be empty");
    const workspaceId = await this.workspaceId(scope);
    try {
      await this.keychain.write(
        SECRET_SERVICE,
        this.account(workspaceId, name),
        Buffer.from(value, "utf8").toString("hex"),
      );
    } catch (error) {
      throw new DaedalusError(
        "INTERNAL",
        `The Keychain did not take the secret: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.repositories.secrets.save(
      workspaceId,
      name,
      this.now().toISOString(),
    );
  }

  async remove(scope: string | null, name: string): Promise<void> {
    const workspaceId = await this.workspaceId(scope);
    if (!this.repositories.secrets.find(workspaceId, name))
      throw new DaedalusError(
        "NOT_FOUND",
        `There is no ${await this.scopeLabel(workspaceId)} secret '${name}'`,
      );
    await this.keychain.remove(SECRET_SERVICE, this.account(workspaceId, name));
    this.repositories.secrets.delete(workspaceId, name);
  }

  /** One secret's value, for the user to see in the app. */
  async reveal(scope: string | null, name: string): Promise<string> {
    const workspaceId = await this.workspaceId(scope);
    const value = this.repositories.secrets.find(workspaceId, name)
      ? await this.read(workspaceId, name)
      : undefined;
    if (value === undefined)
      throw new DaedalusError(
        "NOT_FOUND",
        `There is no ${await this.scopeLabel(workspaceId)} secret '${name}'`,
      );
    return value;
  }

  /**
   * The values of the named secrets, for a command's environment: the
   * workspace's own first, else the global one. With null, only global ones.
   * Every name is checked before any is returned, so a command never starts
   * with only some of what it asked for.
   */
  async values(
    scope: string | null,
    names: readonly string[],
  ): Promise<Record<string, string>> {
    const workspaceId = await this.workspaceId(scope);
    const missing: string[] = [];
    const values: Record<string, string> = {};
    for (const name of names) {
      const owner =
        workspaceId && this.repositories.secrets.find(workspaceId, name)
          ? workspaceId
          : this.repositories.secrets.find(null, name)
            ? null
            : undefined;
      // The row is there but the item is not: someone deleted it in
      // Keychain Access. Treated as missing, so the user sets it again.
      const value =
        owner === undefined ? undefined : await this.read(owner, name);
      if (value === undefined) missing.push(name);
      else values[name] = value;
    }
    if (missing.length) {
      const where = workspaceId
        ? `for ${await this.scopeLabel(workspaceId)} or globally`
        : "globally";
      throw new DaedalusError(
        "NOT_FOUND",
        `${missing.length === 1 ? "Secret" : "Secrets"} ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set ${where}. Ask the user to add ${missing.length === 1 ? "it" : "them"} in the app's Secrets (or with 'daedal secret set').`,
      );
    }
    return values;
  }

  /** Deletes every Keychain item of a workspace that is being removed. */
  async forgetWorkspace(workspaceId: string): Promise<void> {
    for (const secret of this.repositories.secrets.list(workspaceId))
      await this.keychain.remove(
        SECRET_SERVICE,
        this.account(workspaceId, secret.name),
      );
  }

  private async read(
    workspaceId: string | null,
    name: string,
  ): Promise<string | undefined> {
    const stored = await this.keychain.read(
      SECRET_SERVICE,
      this.account(workspaceId, name),
    );
    if (stored === undefined || !/^(?:[0-9a-f]{2})+$/.test(stored))
      return undefined;
    return Buffer.from(stored, "hex").toString("utf8");
  }

  private async workspaceId(scope: string | null): Promise<string | null> {
    return scope === null ? null : (await this.workspaces.get(scope)).id;
  }

  private async scopeLabel(workspaceId: string | null): Promise<string> {
    if (workspaceId === null) return "global";
    return `workspace '${(await this.workspaces.get(workspaceId)).slug}'`;
  }

  /**
   * The Keychain account: `<home>/<NAME>` for a global secret and
   * `<home>#<workspace id>/<NAME>` for a workspace's, which no workspace id
   * can make collide with a global one.
   */
  private account(workspaceId: string | null, name: string): string {
    return workspaceId === null
      ? `${this.home}/${name}`
      : `${this.home}#${workspaceId}/${name}`;
  }
}

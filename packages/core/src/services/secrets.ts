import {
  deleteKeychainPassword,
  readKeychainPassword,
  writeKeychainPassword,
} from "@daedalus/platform";
import type { WorkspaceSecret } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories/sqlite";
import type { WorkspaceService } from "./workspaces";

/** The Keychain service every workspace secret is filed under. */
export const SECRET_SERVICE = "Daedalus workspace secret";

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

/**
 * A workspace's secrets: values an agent's tools need, like API keys, that
 * the user stores once instead of pasting into a prompt. This is a
 * convenience, not a boundary: any process the user runs can read them.
 *
 * Each value is a login Keychain item; SQLite keeps only the names. The value
 * is stored hex-encoded, because `security` prints a password that is not
 * printable text as hex and plain text as itself, and a reader could not tell
 * the two apart.
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

  async list(workspaceReference: string): Promise<WorkspaceSecret[]> {
    const workspace = await this.workspaces.get(workspaceReference);
    return this.repositories.secrets.list(workspace.id);
  }

  /** Adds a secret or replaces its value. */
  async set(
    workspaceReference: string,
    name: string,
    value: string,
  ): Promise<WorkspaceSecret> {
    assertSecretName(name);
    if (!value)
      throw new DaedalusError("VALIDATION", "A secret's value cannot be empty");
    const workspace = await this.workspaces.get(workspaceReference);
    try {
      await this.keychain.write(
        SECRET_SERVICE,
        this.account(workspace.id, name),
        Buffer.from(value, "utf8").toString("hex"),
      );
    } catch (error) {
      throw new DaedalusError(
        "INTERNAL",
        `The Keychain did not take the secret: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.repositories.secrets.save(
      workspace.id,
      name,
      this.now().toISOString(),
    );
  }

  async remove(workspaceReference: string, name: string): Promise<void> {
    const workspace = await this.workspaces.get(workspaceReference);
    if (
      !this.repositories.secrets
        .list(workspace.id)
        .some((secret) => secret.name === name)
    )
      throw new DaedalusError(
        "NOT_FOUND",
        `Workspace '${workspace.slug}' has no secret '${name}'`,
      );
    await this.keychain.remove(
      SECRET_SERVICE,
      this.account(workspace.id, name),
    );
    this.repositories.secrets.delete(workspace.id, name);
  }

  /**
   * The values of the named secrets, for a command's environment. Every name
   * is checked before any is returned, so a command never starts with only
   * some of what it asked for.
   */
  async values(
    workspaceReference: string,
    names: readonly string[],
  ): Promise<Record<string, string>> {
    const workspace = await this.workspaces.get(workspaceReference);
    const known = new Set(
      this.repositories.secrets.list(workspace.id).map((secret) => secret.name),
    );
    const missing = names.filter((name) => !known.has(name));
    const values: Record<string, string> = {};
    for (const name of names) {
      if (!known.has(name)) continue;
      const stored = await this.keychain.read(
        SECRET_SERVICE,
        this.account(workspace.id, name),
      );
      // The row is there but the item is not: someone deleted it in
      // Keychain Access. Treated as missing, so the user sets it again.
      if (stored === undefined || !/^(?:[0-9a-f]{2})+$/.test(stored))
        missing.push(name);
      else values[name] = Buffer.from(stored, "hex").toString("utf8");
    }
    if (missing.length)
      throw new DaedalusError(
        "NOT_FOUND",
        `${missing.length === 1 ? "Secret" : "Secrets"} ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set for workspace '${workspace.slug}'. Ask the user to add ${missing.length === 1 ? "it" : "them"} in the workspace's settings (or with 'daedal secret set').`,
      );
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

  private account(workspaceId: string, name: string): string {
    return `${this.home}#${workspaceId}/${name}`;
  }
}

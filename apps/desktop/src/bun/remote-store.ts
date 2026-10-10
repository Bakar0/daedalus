import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "@daedalus/platform";
import {
  createIdentity,
  type DeviceIdentity,
  sodiumReady,
} from "@daedalus/remote-protocol";

export interface PairedPhone {
  id: string;
  publicKey: string;
  name: string;
  pairedAt: string;
}

/** What only this Mac may know: in the Keychain where there is one. */
export interface DeviceSecrets {
  secretKey: string;
  /** Proves this Mac to the relay until an account claims it. */
  relaySecret: string;
  /** Given by the relay when a phone claims this Mac for its account. */
  relayToken?: string;
}

/** Where the secrets live. Without one, they stay in device.json. */
export interface SecretVault {
  read(): Promise<DeviceSecrets | undefined>;
  write(secrets: DeviceSecrets): Promise<void>;
}

/**
 * The login Keychain, through `/usr/bin/security`. The value goes in on
 * standard input (`security -i`), never in arguments another process could
 * list. Each Daedalus home has its own item, so the dev and stable apps do
 * not share a device.
 *
 * This keeps the key and token out of the file, and so out of backups,
 * dotfile syncs and a `cat` of the home folder. It does not stop a process
 * running as the user: the item's access list trusts `security` itself.
 */
export class KeychainVault implements SecretVault {
  static readonly service = "dev.daedalus.remote";
  readonly #account: string;

  constructor(home: string) {
    this.#account = createHash("sha256")
      .update(home)
      .digest("hex")
      .slice(0, 32);
  }

  async read(): Promise<DeviceSecrets | undefined> {
    const result = await runCommand(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        KeychainVault.service,
        "-a",
        this.#account,
        "-w",
      ],
      { timeoutMs: 10_000 },
    );
    // 44: no such item.
    if (result.exitCode === 44) return undefined;
    if (result.exitCode !== 0)
      throw new Error(`Keychain read failed (${result.exitCode})`);
    return JSON.parse(
      Buffer.from(result.stdout.trim(), "base64url").toString("utf8"),
    ) as DeviceSecrets;
  }

  async write(secrets: DeviceSecrets): Promise<void> {
    const value = Buffer.from(JSON.stringify(secrets)).toString("base64url");
    const result = await runCommand("/usr/bin/security", ["-i"], {
      stdin: `add-generic-password -U -s "${KeychainVault.service}" -a "${this.#account}" -l "Daedalus phone access" -w "${value}"\n`,
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0 || result.stderr.trim())
      throw new Error(
        `Keychain write failed: ${result.stderr.trim() || result.exitCode}`,
      );
  }
}

/** The vault this platform has, or none: tests and other systems use the file. */
export function defaultVault(home: string): SecretVault | undefined {
  return process.platform === "darwin" &&
    process.env.DAEDALUS_REMOTE_VAULT !== "file"
    ? new KeychainVault(home)
    : undefined;
}

interface RemoteFile {
  identity: { id: string; publicKey: string; secretKey?: string };
  phones: PairedPhone[];
  /** Only while the secrets are kept in this file (no vault). */
  relaySecret?: string;
  relayToken?: string;
  /** The account that claimed this Mac, as the relay reports it. */
  account?: string;
}

/**
 * Keeps `<home>/remote` out of Time Machine. tmutil takes seconds, so the
 * app does not wait for it; the exclusion sticks to the folder.
 */
export function excludeFromBackups(home: string): void {
  if (process.platform !== "darwin") return;
  void runCommand("/usr/bin/tmutil", [
    "addexclusion",
    join(home, "remote"),
  ]).catch(() => undefined);
}

const newSecret = () => randomBytes(32).toString("base64url");

/**
 * Writes `path` whole or not at all: a temporary file created 0600, synced,
 * then renamed over the old one. A crash leaves the old file, and the secret
 * is never readable by other users, not even for a moment.
 */
async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

/**
 * The Mac's device key, its relay credentials and its paired phones. The
 * key and credentials go to the Keychain; `<home>/remote/device.json` keeps
 * the rest, readable only by the user (see `excludeFromBackups`).
 */
export class RemoteStore {
  private constructor(
    private readonly path: string,
    private data: RemoteFile,
    private secrets: DeviceSecrets,
    private readonly vault: SecretVault | null,
  ) {}

  static async open(
    home: string,
    /** `null` keeps the secrets in the file (tests). */
    vault: SecretVault | null = defaultVault(home) ?? null,
    log?: (event: string, fields: Record<string, unknown>) => void,
  ): Promise<RemoteStore> {
    await sodiumReady();
    const directory = join(home, "remote");
    const path = join(directory, "device.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const file = Bun.file(path);
    if (!(await file.exists())) return RemoteStore.#fresh(path, vault);
    let data: RemoteFile;
    try {
      data = (await file.json()) as RemoteFile;
    } catch {
      // Not JSON: a write from before writes were atomic was cut short.
      log?.("remote_store_unreadable", {});
      await rename(path, `${path}.broken`);
      return RemoteStore.#fresh(path, vault);
    }
    const inFile =
      data.identity.secretKey !== undefined
        ? {
            secretKey: data.identity.secretKey,
            relaySecret: data.relaySecret ?? newSecret(),
            ...(data.relayToken ? { relayToken: data.relayToken } : {}),
          }
        : undefined;
    let secrets = inFile;
    if (vault) {
      const kept = await vault.read().catch((error: unknown) => {
        log?.("remote_vault_failed", { message: String(error) });
        return undefined;
      });
      secrets = kept ?? inFile;
    }
    if (!secrets) {
      // The key is gone (a restored file without its Keychain item): this
      // is a new device that has to be paired again.
      log?.("remote_store_key_missing", {});
      return RemoteStore.#fresh(path, vault);
    }
    const store = new RemoteStore(path, data, secrets, vault);
    // Moves secrets out of a file written before there was a vault.
    if (inFile && vault) await store.save();
    return store;
  }

  static async #fresh(
    path: string,
    vault: SecretVault | null,
  ): Promise<RemoteStore> {
    const { secretKey, ...identity } = createIdentity();
    const store = new RemoteStore(
      path,
      { identity, phones: [] },
      { secretKey, relaySecret: newSecret() },
      vault,
    );
    await store.save();
    return store;
  }

  get identity(): DeviceIdentity {
    return {
      id: this.data.identity.id,
      publicKey: this.data.identity.publicKey,
      secretKey: this.secrets.secretKey,
    };
  }

  get phones(): readonly PairedPhone[] {
    return this.data.phones;
  }

  get relayToken(): string | undefined {
    return this.secrets.relayToken;
  }

  /** What the Mac shows the relay: its token once claimed, else its secret. */
  get relayCredential(): string {
    return this.secrets.relayToken ?? this.secrets.relaySecret;
  }

  get account(): string | undefined {
    return this.data.account;
  }

  /** Updates memory at once, so a reconnect right after sees the token. */
  setRelayToken(token: string): Promise<void> {
    this.secrets = { ...this.secrets, relayToken: token };
    return this.save();
  }

  async setAccount(email: string): Promise<void> {
    if (this.data.account === email) return;
    this.data.account = email;
    await this.save();
  }

  /**
   * Starts over as a new device that can be paired again. The old file is
   * kept as `device.json.removed`.
   */
  async reset(): Promise<void> {
    await rename(this.path, `${this.path}.removed`).catch(() => undefined);
    const { secretKey, ...identity } = createIdentity();
    this.data = { identity, phones: [] };
    this.secrets = { secretKey, relaySecret: newSecret() };
    await this.save();
  }

  phone(id: string): PairedPhone | undefined {
    return this.data.phones.find((phone) => phone.id === id);
  }

  async addPhone(phone: PairedPhone): Promise<void> {
    this.data.phones = [
      ...this.data.phones.filter((existing) => existing.id !== phone.id),
      phone,
    ];
    await this.save();
  }

  async removePhone(id: string): Promise<void> {
    this.data.phones = this.data.phones.filter((phone) => phone.id !== id);
    await this.save();
  }

  private async save(): Promise<void> {
    const { secretKey: _key, ...identity } = this.data.identity;
    let file: RemoteFile = { ...this.data, identity };
    delete file.relaySecret;
    delete file.relayToken;
    const vaulted = await this.vault
      ?.write(this.secrets)
      .then(() => true)
      .catch(() => false);
    if (!vaulted)
      file = {
        ...file,
        identity: { ...identity, secretKey: this.secrets.secretKey },
        relaySecret: this.secrets.relaySecret,
        ...(this.secrets.relayToken
          ? { relayToken: this.secrets.relayToken }
          : {}),
      };
    await writeAtomic(this.path, JSON.stringify(file, null, 2));
  }
}

/** One thing a phone did, as the Mac's user can review it later. */
export interface AuditEntry {
  at: string;
  phoneId: string;
  phone: string;
  /** A request's method, or `terminal.open` / `terminal.close`. */
  action: string;
  /** The ids it touched: workspace, task, session. Never text. */
  target?: string;
  ok: boolean;
  /** The error code of a failed request. */
  code?: string;
  /** For a terminal: bytes typed and bytes shown. */
  bytesIn?: number;
  bytesOut?: number;
}

const AUDIT_MAX_BYTES = 1024 * 1024;

/**
 * `<home>/remote/audit.log`: one JSON line per phone request and terminal,
 * never message text or keystrokes. Past 1 MB it moves to `audit.log.1`,
 * so two files at most are kept.
 */
export class RemoteAudit {
  readonly #path: string;
  #writing: Promise<void> = Promise.resolve();

  constructor(home: string) {
    this.#path = join(home, "remote", "audit.log");
  }

  record(entry: Omit<AuditEntry, "at">): void {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
    this.#writing = this.#writing
      .then(async () => {
        const file = Bun.file(this.#path);
        if ((await file.exists()) && file.size > AUDIT_MAX_BYTES)
          await rename(this.#path, `${this.#path}.1`);
        const handle = await open(this.#path, "a", 0o600);
        try {
          await handle.appendFile(line);
        } finally {
          await handle.close();
        }
      })
      .catch(() => undefined);
  }

  /** The latest entries, newest first. */
  async recent(limit = 50): Promise<AuditEntry[]> {
    await this.#writing;
    const file = Bun.file(this.#path);
    if (!(await file.exists())) return [];
    return (await file.text())
      .trim()
      .split("\n")
      .slice(-limit)
      .reverse()
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AuditEntry];
        } catch {
          return [];
        }
      });
  }
}

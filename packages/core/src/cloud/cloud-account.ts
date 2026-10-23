import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  deleteKeychainPassword,
  readKeychainPassword,
  writeFileAtomic,
  writeKeychainPassword,
} from "@daedalus/platform";
import type { GatewayUser } from "@daedalus/remote-protocol";
import { DaedalusError } from "../errors";

/**
 * This Mac's sign-in to a cloud gateway, and the runner keys it has pinned.
 *
 * The file `<home>/cloud/account.json` holds the gateway address, the user
 * and the pins; the token goes in the login Keychain, as the phone's relay
 * token does. Without a Keychain (tests, `DAEDALUS_REMOTE_VAULT=file`, other
 * systems) it stays in the file, which is 0600.
 */

interface AccountFile {
  gatewayUrl: string;
  user: GatewayUser;
  /** Only while there is no Keychain. */
  token?: string;
  /** Workspace id to its runner's static key, as first seen. */
  pins: Record<string, string>;
  /** Workspace id to when the gateway first said it was gone (ISO time). */
  missing?: Record<string, string>;
}

export interface CloudSignIn {
  gatewayUrl: string;
  user: GatewayUser;
  token: string;
}

const SERVICE = "dev.daedalus.cloud";

export interface TokenVault {
  read(): Promise<string | undefined>;
  write(token: string): Promise<void>;
  remove(): Promise<void>;
}

export function keychainTokenVault(home: string): TokenVault {
  const account = createHash("sha256").update(home).digest("hex").slice(0, 32);
  return {
    read: () => readKeychainPassword(SERVICE, account),
    write: (token) => writeKeychainPassword(SERVICE, account, token),
    remove: () => deleteKeychainPassword(SERVICE, account),
  };
}

/** The Keychain where there is one, as for the phone's device secrets. */
export function defaultTokenVault(home: string): TokenVault | undefined {
  return process.platform === "darwin" &&
    process.env.DAEDALUS_REMOTE_VAULT !== "file"
    ? keychainTokenVault(home)
    : undefined;
}

const writeAtomic = (path: string, text: string): Promise<void> =>
  writeFileAtomic(path, text, { mode: 0o600, sync: true });

export class CloudAccount {
  readonly #path: string;

  constructor(
    home: string,
    private readonly vault: TokenVault | undefined = defaultTokenVault(home),
  ) {
    this.#path = join(home, "cloud", "account.json");
  }

  async #read(): Promise<AccountFile | undefined> {
    const file = Bun.file(this.#path);
    if (!(await file.exists())) return undefined;
    try {
      return (await file.json()) as AccountFile;
    } catch {
      return undefined;
    }
  }

  async #write(data: AccountFile): Promise<void> {
    await mkdir(join(this.#path, ".."), { recursive: true, mode: 0o700 });
    await writeAtomic(this.#path, `${JSON.stringify(data, null, 2)}\n`);
  }

  /** The sign-in, or undefined when this Mac has none. */
  async signIn(): Promise<CloudSignIn | undefined> {
    const data = await this.#read();
    if (!data) return undefined;
    const token = this.vault ? await this.vault.read() : data.token;
    if (!token) return undefined;
    return { gatewayUrl: data.gatewayUrl, user: data.user, token };
  }

  async requireSignIn(): Promise<CloudSignIn> {
    const signIn = await this.signIn();
    if (!signIn)
      throw new DaedalusError(
        "DEPENDENCY",
        "This Mac is not signed in to a cloud gateway; sign in in Settings › Cloud or run 'daedal cloud login'",
      );
    return signIn;
  }

  /** Saves a sign-in. A different gateway or user starts with no pins. */
  async save(signIn: CloudSignIn): Promise<void> {
    const old = await this.#read();
    const same =
      old?.gatewayUrl === signIn.gatewayUrl && old.user.id === signIn.user.id;
    if (this.vault) await this.vault.write(signIn.token);
    await this.#write({
      gatewayUrl: signIn.gatewayUrl,
      user: signIn.user,
      ...(this.vault ? {} : { token: signIn.token }),
      pins: same ? old.pins : {},
    });
  }

  /**
   * Removes the sign-in. A token the Keychain would not remove is an error,
   * and the account file stays, so the Mac does not read as signed out while
   * the token is still stored.
   */
  async forget(): Promise<void> {
    try {
      await this.vault?.remove();
    } catch (error) {
      throw new DaedalusError(
        "DEPENDENCY",
        `The cloud token could not be removed from the Keychain: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await rm(this.#path, { force: true });
  }

  /** The runner key pinned for a workspace, if one was seen. */
  async pinned(workspaceId: string): Promise<string | undefined> {
    return (await this.#read())?.pins[workspaceId];
  }

  /**
   * Pins a workspace's runner key the first time it is seen. A different key
   * later is refused: the gateway introduces a runner once, and a second key
   * means something other than that runner is answering.
   */
  async pin(workspaceId: string, runnerKey: string): Promise<void> {
    const data = await this.#read();
    if (!data)
      throw new DaedalusError("DEPENDENCY", "This Mac is not signed in");
    const known = data.pins[workspaceId];
    if (known === runnerKey) return;
    if (known)
      throw new DaedalusError(
        "CONFLICT",
        "The workspace's runner presented a different key from the one this Mac pinned",
      );
    await this.#write({
      ...data,
      pins: { ...data.pins, [workspaceId]: runnerKey },
    });
  }

  /**
   * When the gateway first said a linked workspace was gone: `now` the
   * first time, kept until `found` clears it.
   */
  async missingSince(workspaceId: string, now: number): Promise<number> {
    const data = await this.#read();
    if (!data) return now;
    const since = Date.parse(data.missing?.[workspaceId] ?? "");
    if (Number.isFinite(since)) return since;
    await this.#write({
      ...data,
      missing: {
        ...data.missing,
        [workspaceId]: new Date(now).toISOString(),
      },
    });
    return now;
  }

  /** Forgets that a workspace was missing: it answered again, or is gone. */
  async found(workspaceId: string): Promise<void> {
    const data = await this.#read();
    if (!data?.missing || !(workspaceId in data.missing)) return;
    const { [workspaceId]: _back, ...missing } = data.missing;
    await this.#write({ ...data, missing });
  }

  /** Drops a pin, when the workspace is deleted. */
  async unpin(workspaceId: string): Promise<void> {
    const data = await this.#read();
    if (!data || !(workspaceId in data.pins)) return;
    const { [workspaceId]: _gone, ...pins } = data.pins;
    await this.#write({ ...data, pins });
  }
}

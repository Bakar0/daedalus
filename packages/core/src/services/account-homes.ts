import { join } from "node:path";
import type {
  AccountProfile,
  AccountProvider,
  DaedalusConfig,
} from "../config";
import { DaedalusError } from "../errors";

/** What a session or a command names to mean the provider's own account. */
export const DEFAULT_ACCOUNT = "default";

export const providerLabel = (provider: string): string =>
  provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : provider;

/** Where a profile's configuration folder lives. Never moves once created. */
export const accountDirectory = (
  config: DaedalusConfig,
  account: Pick<AccountProfile, "id" | "provider">,
): string => join(config.home, "accounts", account.provider, account.id);

/**
 * The profile a reference names, or undefined for the default account.
 *
 * A reference is an id or a display name, matched without regard to case, so
 * `--account Personal` and `--account personal-3f2a` both work. Null,
 * undefined and `default` all mean the default account.
 */
export function findAccount(
  config: DaedalusConfig,
  provider: AccountProvider,
  reference: string | null | undefined,
): AccountProfile | undefined {
  const wanted = reference?.trim();
  if (!wanted || wanted.toLowerCase() === DEFAULT_ACCOUNT) return undefined;
  const lower = wanted.toLowerCase();
  const own = config.accounts.filter((entry) => entry.provider === provider);
  const found =
    own.find((entry) => entry.id === wanted) ??
    own.find((entry) => entry.name.toLowerCase() === lower);
  if (found) return found;
  throw new DaedalusError(
    "NOT_FOUND",
    `No ${providerLabel(provider)} account named '${wanted}'`,
    { provider, account: wanted },
  );
}

/** A stored account id, or undefined for the default account. */
const profileId = (accountId: string | null | undefined): string | undefined =>
  accountId && accountId !== DEFAULT_ACCOUNT ? accountId : undefined;

/**
 * The configuration as seen by one account: the same settings with the
 * provider's folders swapped for the profile's.
 *
 * Everything that reads a provider folder — hooks, skills, the instructions
 * block, session lookup and telemetry — takes a `DaedalusConfig`, so handing
 * it this copy is what makes it work per account without each one knowing
 * accounts exist. The default account is the configuration itself.
 *
 * Takes an id as stored on a session, not a name the user typed, and does
 * not require the profile to still exist: a session whose account was removed
 * still has to be looked up, archived and listed.
 */
export function accountConfig(
  config: DaedalusConfig,
  provider: string,
  accountId: string | null | undefined,
): DaedalusConfig {
  const id = profileId(accountId);
  if (!id || (provider !== "claude" && provider !== "codex")) return config;
  const directory = accountDirectory(config, { id, provider });
  return provider === "claude"
    ? {
        ...config,
        claudeHome: directory,
        claudeProjectsDirectory: join(directory, "projects"),
      }
    : {
        ...config,
        codexHome: directory,
        codexSessionsDirectory: join(directory, "sessions"),
      };
}

/**
 * The variables that point a provider's CLI at one account.
 *
 * The default account sets nothing, which is the only way to reach it: Claude
 * names its Keychain login after the folder whenever `CLAUDE_CONFIG_DIR` is
 * set, even to `~/.claude`, so naming the default folder would look signed
 * out.
 *
 * A profile sets the folder variable and the one that would otherwise move
 * part of it elsewhere. Claude's Keychain name follows
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` when that is set, and Codex's databases
 * follow `CODEX_SQLITE_HOME`; an inherited value of either would put two
 * accounts' logins or threads in one place.
 */
export function accountEnvironment(
  config: DaedalusConfig,
  provider: string,
  accountId: string | null | undefined,
): Record<string, string> {
  const id = profileId(accountId);
  if (!id || (provider !== "claude" && provider !== "codex")) return {};
  const directory = accountDirectory(config, { id, provider });
  return provider === "claude"
    ? {
        CLAUDE_CONFIG_DIR: directory,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: directory,
      }
    : { CODEX_HOME: directory, CODEX_SQLITE_HOME: directory };
}

/** The profile a stored id names, if it still exists. */
export const accountProfile = (
  config: DaedalusConfig,
  provider: string,
  accountId: string | null | undefined,
): AccountProfile | undefined => {
  const id = profileId(accountId);
  return id
    ? config.accounts.find(
        (entry) => entry.id === id && entry.provider === provider,
      )
    : undefined;
};

/** What a session's account is called, for messages. */
export const accountName = (
  config: DaedalusConfig,
  provider: string,
  accountId: string | null | undefined,
): string =>
  profileId(accountId)
    ? (accountProfile(config, provider, accountId)?.name ?? accountId!)
    : "Default";

import { homedir } from "node:os";
import { rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensureDirectory } from "@daedalus/platform";

/**
 * Whether Daedalus puts a freshly spawned session into the provider's own
 * "only ask about what looks unsafe" mode, or leaves the provider's stored
 * configuration to decide.
 */
export type AgentPermissionMode = "auto" | "inherit";

export interface AgentDefinition {
  executable: string;
  args: string[];
  /** Defaults to `auto`. */
  permissionMode?: AgentPermissionMode;
}

/**
 * How much of a Daedalus-shipped capability is installed.
 *
 * `on-demand` puts the skill where the providers look, so the user can call it
 * by name. `always` additionally installs the style and instruction artifacts,
 * which is what makes a writing style apply to every response rather than to
 * the turns somebody remembers to ask for it.
 */
export type ManagedSkillMode = "on-demand" | "always";

export interface ManagedSkillSetting {
  enabled: boolean;
  /** Ignored by a capability that has no `always` form. */
  mode?: ManagedSkillMode;
  /**
   * Present only for a skill the user installed. A built-in capability has no
   * source, which is how the two are told apart in one map.
   */
  source?: { kind: "path" | "git"; ref: string; subpath?: string };
}

/**
 * Whether a skill Daedalus does not own reaches the agent at all.
 *
 * Claude Code's `skillOverrides` accepts four states, and only these two are
 * the user's to set. `name-only` is a token-budget trick that does not
 * describe anything the user wants. `user-invocable-only` is the same decision
 * as `disable-model-invocation` in the skill's own frontmatter, which is the
 * author's call and is already reported on the row, so offering it here too
 * would ask the user to overrule a choice whose reason they cannot see.
 */
export type SkillVisibility = "on" | "off";

/** The providers an account profile can belong to. */
export type AccountProvider = "claude" | "codex";

/**
 * A second (or third) account for one provider: a configuration folder of
 * its own under `DAEDALUS_HOME`, which the provider's CLI is pointed at with
 * its own environment variable. The default account is not one of these. It
 * is whatever the provider uses with nothing set, so it needs no entry.
 *
 * Holds no credentials. The provider keeps its own login: Claude in the
 * Keychain under a name derived from the folder path, Codex in the folder.
 */
export interface AccountProfile {
  /**
   * The folder name, fixed at creation. Claude keys its Keychain login on the
   * folder path, so renaming the folder would sign the account out; the
   * display name is free to change because it is stored only here.
   */
  id: string;
  provider: AccountProvider;
  name: string;
  createdAt: string;
  /**
   * How it authenticates. `login` (the default) signs in through the
   * provider's own login; `api-key` is a Claude account whose key Daedalus
   * keeps in the login Keychain and Claude reads through `apiKeyHelper`.
   */
  kind?: "login" | "api-key";
  /**
   * Which of Claude's logins Sign in runs for a `login` account: its
   * subscription (the default), SSO, or the Anthropic Console. Chosen when
   * the account is added, so signing in again is one click.
   */
  login?: ClaudeLogin;
}

/** Claude's three logins. */
export type ClaudeLogin = "subscription" | "sso" | "console";

const CLAUDE_LOGINS: readonly string[] = ["subscription", "sso", "console"];

export interface DaedalusConfig {
  home: string;
  workspaceRoot: string;
  databasePath: string;
  logsDirectory: string;
  repositoryRoot: string;
  codexSessionsDirectory: string;
  claudeProjectsDirectory: string;
  /**
   * The provider configuration directories skills are installed into and
   * discovered from.
   *
   * `claudeHome` and `codexHome` follow the providers' own environment
   * variables. The other two have no published variable, so Daedalus defines
   * its own overrides for tests and for unusual installs.
   */
  claudeHome: string;
  codexHome: string;
  /** `~/.agents`, the shared skills directory Codex and Cursor both read. */
  agentsHome: string;
  cursorHome: string;
  workspaceInstructionFilesEnabled: boolean;
  /**
   * Whether app startup brings `lost` agent sessions and integrated terminals
   * back by resuming their native conversations. A Mac reboot kills the
   * Daedalus tmux server and nothing else, so without this a restart costs a
   * board of red cards and a manual archive/restore per session. Resuming
   * leaves each agent idle at its prompt with its history loaded; nothing is
   * re-prompted, so no work restarts on its own.
   */
  autoRestoreSessionsEnabled: boolean;
  /**
   * Whether Daedalus records trust for each session folder it creates in the
   * provider's own configuration before the provider starts, so Codex and
   * Claude open straight at their prompt. Off, the provider asks the user in
   * the session's terminal, the same as for a folder they opened themselves.
   */
  trustSessionFoldersEnabled: boolean;
  /**
   * Suppresses toasts and desktop notifications without touching activity
   * tracking, so the board stays live while the interruptions stop.
   */
  focusMode: boolean;
  agents: Record<string, AgentDefinition>;
  /**
   * Per-capability state for the skills Daedalus ships. Absent means the
   * capability's own default, so a fresh install needs no config file.
   */
  managedSkills: Record<string, ManagedSkillSetting>;
  /**
   * Requested visibility for skills Daedalus does not own, keyed by skill
   * name. Applied through each provider's own switch rather than by moving
   * the user's files.
   */
  skillOverrides: Record<string, SkillVisibility>;
  /**
   * The keys Daedalus last wrote into the user's own Claude settings file.
   *
   * JSON has no comment to fence a block with, so the only way to know which
   * entries in that file are Daedalus's is to have written down which ones it
   * put there. Without this, removing an override would mean either leaving
   * every one behind or deleting entries the user set themselves.
   */
  claudeOverridesWritten: string[];
  /**
   * The output style Daedalus last selected in the user's Claude settings.
   *
   * Same reason as the override list: it is how Daedalus tells its own
   * selection from one the user made, so it never takes away a style it did
   * not choose.
   */
  claudeOutputStyleWritten?: string;
  /** Account profiles beyond each provider's default. */
  accounts: AccountProfile[];
  /** Which login Sign in runs for each provider's default account. */
  defaultLogins: { claude?: ClaudeLogin };
}

type StoredConfig = Partial<
  Pick<
    DaedalusConfig,
    | "workspaceRoot"
    | "workspaceInstructionFilesEnabled"
    | "autoRestoreSessionsEnabled"
    | "trustSessionFoldersEnabled"
    | "focusMode"
    | "agents"
  >
> & {
  managedSkills?: Record<string, ManagedSkillSetting>;
  skillOverrides?: Record<string, SkillVisibility>;
  claudeOverridesWritten?: string[];
  claudeOutputStyleWritten?: string;
  accounts?: AccountProfile[];
  defaultLogins?: { claude?: unknown };
};

function expandHome(path: string): string {
  return path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : path;
}

// A non-stable build must not share the stable app's home. They are separate
// applications with one SQLite database between them, and the loser of that
// race corrupts or locks the other.
//
// The suffix is applied to whatever home was resolved, including one that came
// from `DAEDALUS_HOME`, rather than only to the default. Daedalus exports
// `DAEDALUS_HOME` into every agent session it starts, so an agent that builds a
// dev app and opens it passes the *stable* home straight into it — the one
// arrangement this is meant to prevent, arriving by inheritance rather than by
// anyone choosing it. Re-suffixing is idempotent, so pointing `DAEDALUS_HOME`
// at an already-channelled home still names that same home.
export function channelHome(channel: string | undefined, home: string): string {
  if (!channel || channel === "stable") return home;
  const suffix = `-${channel}`;
  return home.endsWith(suffix) ? home : `${home}${suffix}`;
}

export const STABLE_APP_IDENTIFIER = "dev.daedalus.app";

/**
 * Which channel owns this home: `stable`, or the suffix of a channelled one.
 * Anything a channel writes outside its own home has to be named with this, or
 * two installed builds end up fighting over one record.
 */
export function channelName(home: string): string {
  return (
    /[/\\]\.daedalus-([a-z0-9]+)$/i.exec(home)?.[1]?.toLowerCase() ?? "stable"
  );
}

/**
 * The inverse of `channelHome`: which app owns this home. macOS keys Launch
 * Services and notification attribution off the identifier, so raising "the
 * app" from a dev home has to raise the *dev* app — otherwise a dev build's
 * notification opens the stable one, which is exactly the two-apps-as-one
 * confusion the channels exist to prevent.
 */
export function channelIdentifier(home: string): string {
  const match = /[/\\]\.daedalus-([a-z0-9]+)$/i.exec(home);
  return match
    ? `${STABLE_APP_IDENTIFIER}.${match[1]!.toLowerCase()}`
    : STABLE_APP_IDENTIFIER;
}

export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DaedalusConfig> {
  const home = resolve(
    expandHome(env.DAEDALUS_HOME || join(homedir(), ".daedalus")),
  );
  const configPath = join(home, "config.json");
  const file = Bun.file(configPath);
  const stored = (await file.exists())
    ? ((await file.json()) as StoredConfig)
    : {};
  const workspaceRoot = resolve(
    expandHome(stored.workspaceRoot || join(home, "workspaces")),
  );
  const logsDirectory = join(home, "logs");
  const repositoryRoot = join(home, "repos");
  const claudeHome = resolve(
    expandHome(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")),
  );
  const codexHome = resolve(
    expandHome(env.CODEX_HOME || join(homedir(), ".codex")),
  );
  await Promise.all([
    ensureDirectory(home),
    ensureDirectory(workspaceRoot),
    ensureDirectory(logsDirectory),
    ensureDirectory(repositoryRoot),
  ]);
  return {
    home,
    workspaceRoot,
    databasePath: join(home, "state.db"),
    logsDirectory,
    repositoryRoot,
    codexSessionsDirectory: join(codexHome, "sessions"),
    claudeProjectsDirectory: join(claudeHome, "projects"),
    claudeHome,
    codexHome,
    agentsHome: resolve(
      expandHome(env.DAEDALUS_AGENTS_HOME || join(homedir(), ".agents")),
    ),
    cursorHome: resolve(
      expandHome(env.DAEDALUS_CURSOR_HOME || join(homedir(), ".cursor")),
    ),
    workspaceInstructionFilesEnabled:
      stored.workspaceInstructionFilesEnabled !== false,
    autoRestoreSessionsEnabled: stored.autoRestoreSessionsEnabled !== false,
    trustSessionFoldersEnabled: stored.trustSessionFoldersEnabled !== false,
    focusMode: stored.focusMode === true,
    agents: stored.agents || {
      codex: { executable: "codex", args: [] },
      claude: { executable: "claude", args: [] },
    },
    managedSkills: stored.managedSkills || {},
    skillOverrides: stored.skillOverrides || {},
    claudeOverridesWritten: stored.claudeOverridesWritten || [],
    ...(stored.claudeOutputStyleWritten
      ? { claudeOutputStyleWritten: stored.claudeOutputStyleWritten }
      : {}),
    accounts: storedAccounts(stored.accounts),
    defaultLogins:
      typeof stored.defaultLogins?.claude === "string" &&
      CLAUDE_LOGINS.includes(stored.defaultLogins.claude)
        ? { claude: stored.defaultLogins.claude as ClaudeLogin }
        : {},
  };
}

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The stored profiles that are well formed. An entry with a bad id would name
 * a folder outside `accounts/`, and one with an unknown provider has no
 * variable to point at it, so both are dropped rather than trusted.
 */
function storedAccounts(value: unknown): AccountProfile[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is AccountProfile =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.id === "string" &&
      ACCOUNT_ID.test(entry.id) &&
      (entry.provider === "claude" || entry.provider === "codex") &&
      typeof entry.name === "string" &&
      typeof entry.createdAt === "string" &&
      (entry.kind === undefined ||
        entry.kind === "login" ||
        (entry.kind === "api-key" && entry.provider === "claude")) &&
      (entry.login === undefined ||
        (entry.provider === "claude" && CLAUDE_LOGINS.includes(entry.login))),
  );
}

export const isAccountId = (value: string): boolean => ACCOUNT_ID.test(value);

/**
 * Merges a patch into the stored settings and republishes it atomically, so a
 * crash mid-write can never leave a truncated config behind.
 */
async function saveSetting(
  config: DaedalusConfig,
  patch: Record<string, unknown>,
): Promise<void> {
  const configPath = join(config.home, "config.json");
  const file = Bun.file(configPath);
  const stored = (await file.exists())
    ? ((await file.json()) as Record<string, unknown>)
    : {};
  const temporaryPath = join(config.home, `config.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ ...stored, ...patch }, null, 2)}\n`,
      { flag: "wx" },
    );
    await rename(temporaryPath, configPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function saveWorkspaceInstructionFilesEnabled(
  config: DaedalusConfig,
  enabled: boolean,
): Promise<void> {
  await saveSetting(config, { workspaceInstructionFilesEnabled: enabled });
  config.workspaceInstructionFilesEnabled = enabled;
}

export async function saveAutoRestoreSessionsEnabled(
  config: DaedalusConfig,
  enabled: boolean,
): Promise<void> {
  await saveSetting(config, { autoRestoreSessionsEnabled: enabled });
  config.autoRestoreSessionsEnabled = enabled;
}

export async function saveTrustSessionFoldersEnabled(
  config: DaedalusConfig,
  enabled: boolean,
): Promise<void> {
  await saveSetting(config, { trustSessionFoldersEnabled: enabled });
  config.trustSessionFoldersEnabled = enabled;
}

export async function saveFocusMode(
  config: DaedalusConfig,
  enabled: boolean,
): Promise<void> {
  await saveSetting(config, { focusMode: enabled });
  config.focusMode = enabled;
}

/**
 * Stores one capability's state, leaving every other capability's entry alone.
 *
 * The whole map is rewritten rather than patched key by key because
 * `saveSetting` merges at the top level only, so passing a partial map here
 * would drop the capabilities it left out.
 */
export async function saveManagedSkillSetting(
  config: DaedalusConfig,
  id: string,
  setting: ManagedSkillSetting,
): Promise<void> {
  const managedSkills = { ...config.managedSkills, [id]: setting };
  await saveSetting(config, { managedSkills });
  config.managedSkills = managedSkills;
}

/** Stores one discovered skill's requested visibility, leaving the rest alone. */
export async function saveSkillOverride(
  config: DaedalusConfig,
  name: string,
  visibility: SkillVisibility | undefined,
): Promise<void> {
  const skillOverrides = { ...config.skillOverrides };
  if (visibility === undefined || visibility === "on")
    delete skillOverrides[name];
  else skillOverrides[name] = visibility;
  await saveSetting(config, { skillOverrides });
  config.skillOverrides = skillOverrides;
}

/** Records which override keys now belong to Daedalus in Claude's settings. */
export async function saveClaudeOverridesWritten(
  config: DaedalusConfig,
  names: string[],
): Promise<void> {
  await saveSetting(config, { claudeOverridesWritten: names });
  config.claudeOverridesWritten = names;
}

/** Stores the whole list of account profiles. */
export async function saveAccounts(
  config: DaedalusConfig,
  accounts: AccountProfile[],
): Promise<void> {
  await saveSetting(config, { accounts });
  config.accounts = accounts;
}

/** Stores which login the default Claude account signs in with. */
export async function saveDefaultLogin(
  config: DaedalusConfig,
  login: ClaudeLogin,
): Promise<void> {
  const defaultLogins = { ...config.defaultLogins, claude: login };
  await saveSetting(config, { defaultLogins });
  config.defaultLogins = defaultLogins;
}

/** Records which output style, if any, is Daedalus's in Claude's settings. */
export async function saveClaudeOutputStyleWritten(
  config: DaedalusConfig,
  style: string | undefined,
): Promise<void> {
  await saveSetting(config, { claudeOutputStyleWritten: style ?? null });
  if (style === undefined) delete config.claudeOutputStyleWritten;
  else config.claudeOutputStyleWritten = style;
}

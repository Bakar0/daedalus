import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ensureDirectory, writeFileAtomic } from "@daedalus/platform";

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
   * keeps in the login Keychain and Claude reads through `apiKeyHelper`;
   * `bedrock` is a Claude account that calls Amazon Bedrock with an AWS
   * profile's credentials, usually an IAM Identity Center (SSO) login.
   */
  kind?: AccountKind;
  /**
   * Which of Claude's logins Sign in runs for a `login` account: its
   * subscription (the default), SSO, or the Anthropic Console. Chosen when
   * the account is added, so signing in again is one click.
   */
  login?: ClaudeLogin;
  /** A `bedrock` account's AWS profile and the region Bedrock is called in. */
  aws?: AwsTarget;
}

export type AccountKind = "login" | "api-key" | "bedrock";

/**
 * Where a Bedrock account sends its requests. Both values end up in a
 * command Claude runs through a shell (`awsAuthRefresh`), so they are kept to
 * the characters AWS itself allows in them.
 */
export interface AwsTarget {
  profile: string;
  region: string;
}

const AWS_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._+@-]{0,63}$/;
const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

export const isAwsTarget = (value: unknown): value is AwsTarget =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as AwsTarget).profile === "string" &&
  AWS_PROFILE.test((value as AwsTarget).profile) &&
  typeof (value as AwsTarget).region === "string" &&
  AWS_REGION.test((value as AwsTarget).region);

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
   * The context percent, 10 to 100, at which sessions are asked for a
   * rebirth when neither their workspace nor they set one; null is off.
   */
  autoRebirthPercent: number | null;
  /**
   * Suppresses toasts and desktop notifications without touching activity
   * tracking, so the board stays live while the interruptions stop.
   */
  focusMode: boolean;
  /**
   * Whether a paired phone may operate this Mac through the relay. Off until
   * the user turns it on; the Mac then connects out to `remoteRelay`.
   */
  remoteEnabled: boolean;
  remoteRelay: string;
  /** Hold off idle sleep while phone access is on, so phones can reach it. */
  remoteKeepAwake: boolean;
  /** What phones call this Mac; empty means the computer's own name. */
  remoteMacName: string;
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
  /**
   * The AWS CLI Bedrock accounts check and sign in with. Found on `PATH`
   * when not set.
   */
  awsExecutable?: string;
}

type StoredConfig = Partial<
  Pick<
    DaedalusConfig,
    | "workspaceRoot"
    | "workspaceInstructionFilesEnabled"
    | "autoRestoreSessionsEnabled"
    | "trustSessionFoldersEnabled"
    | "autoRebirthPercent"
    | "focusMode"
    | "remoteEnabled"
    | "remoteRelay"
    | "remoteKeepAwake"
    | "remoteMacName"
    | "agents"
  >
> & {
  managedSkills?: Record<string, ManagedSkillSetting>;
  skillOverrides?: Record<string, SkillVisibility>;
  claudeOverridesWritten?: string[];
  claudeOutputStyleWritten?: string;
  accounts?: AccountProfile[];
  defaultLogins?: { claude?: unknown };
  awsExecutable?: unknown;
};

/** The Daedalus relay phones reach this Mac through (see `apps/relay`). */
export const DEFAULT_REMOTE_RELAY =
  "wss://daedalus-relay.daedalus-relay.workers.dev";

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
    autoRebirthPercent:
      typeof stored.autoRebirthPercent === "number" &&
      Number.isInteger(stored.autoRebirthPercent) &&
      stored.autoRebirthPercent >= 10 &&
      stored.autoRebirthPercent <= 100
        ? stored.autoRebirthPercent
        : null,
    focusMode: stored.focusMode === true,
    remoteEnabled: stored.remoteEnabled === true,
    remoteKeepAwake: stored.remoteKeepAwake === true,
    remoteMacName:
      typeof stored.remoteMacName === "string" ? stored.remoteMacName : "",
    remoteRelay:
      env.DAEDALUS_REMOTE_RELAY || stored.remoteRelay || DEFAULT_REMOTE_RELAY,
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
    ...(typeof stored.awsExecutable === "string" && stored.awsExecutable
      ? { awsExecutable: stored.awsExecutable }
      : {}),
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
        (entry.kind === "api-key" && entry.provider === "claude") ||
        (entry.kind === "bedrock" &&
          entry.provider === "claude" &&
          isAwsTarget(entry.aws))) &&
      (entry.login === undefined ||
        (entry.provider === "claude" && CLAUDE_LOGINS.includes(entry.login))),
  );
}

export const isAccountId = (value: string): boolean => ACCOUNT_ID.test(value);

/** The settings `updateSettings` may change; each is a field of the config. */
export type SettingsPatch = Partial<
  Pick<
    DaedalusConfig,
    | "workspaceInstructionFilesEnabled"
    | "autoRestoreSessionsEnabled"
    | "trustSessionFoldersEnabled"
    | "autoRebirthPercent"
    | "focusMode"
    | "remoteEnabled"
    | "remoteKeepAwake"
    | "remoteMacName"
    | "managedSkills"
    | "skillOverrides"
    | "claudeOverridesWritten"
    | "claudeOutputStyleWritten"
    | "accounts"
    | "defaultLogins"
  >
>;

/** The write in flight for each home, so saves run one after another. */
const settingsQueues = new Map<string, Promise<unknown>>();

/**
 * Changes the stored settings and the live config together. `mutate` receives
 * the config as the previous save left it and returns the fields to change;
 * a field returned as `undefined` is removed. Saves for one home run one at a
 * time, so two callers that each add a key both keep theirs. The file is
 * merged at the top level and replaced atomically, so a crash mid-write can
 * never leave a truncated config behind. The live config changes only after
 * the file was written.
 */
export function updateSettings(
  config: DaedalusConfig,
  mutate: (config: Readonly<DaedalusConfig>) => SettingsPatch,
): Promise<void> {
  const previous = settingsQueues.get(config.home) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      const patch = mutate(config);
      const configPath = join(config.home, "config.json");
      const file = Bun.file(configPath);
      const stored = (await file.exists())
        ? ((await file.json()) as Record<string, unknown>)
        : {};
      const written = Object.fromEntries(
        Object.entries(patch).map(([key, value]) => [key, value ?? null]),
      );
      await writeFileAtomic(
        configPath,
        `${JSON.stringify({ ...stored, ...written }, null, 2)}\n`,
      );
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined)
          delete (config as unknown as Record<string, unknown>)[key];
        else (config as unknown as Record<string, unknown>)[key] = value;
      }
    });
  settingsQueues.set(config.home, run);
  void run
    .catch(() => undefined)
    .finally(() => {
      if (settingsQueues.get(config.home) === run)
        settingsQueues.delete(config.home);
    });
  return run;
}

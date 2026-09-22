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
}

type StoredConfig = Partial<
  Pick<
    DaedalusConfig,
    | "workspaceRoot"
    | "workspaceInstructionFilesEnabled"
    | "autoRestoreSessionsEnabled"
    | "focusMode"
    | "agents"
  >
> & {
  managedSkills?: Record<string, ManagedSkillSetting>;
  skillOverrides?: Record<string, SkillVisibility>;
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
    focusMode: stored.focusMode === true,
    agents: stored.agents || {
      codex: { executable: "codex", args: [] },
      claude: { executable: "claude", args: [] },
    },
    managedSkills: stored.managedSkills || {},
    skillOverrides: stored.skillOverrides || {},
  };
}

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

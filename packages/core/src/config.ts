import { homedir } from "node:os";
import { rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensureDirectory } from "@daedalus/platform";

export interface AgentDefinition {
  executable: string;
  args: string[];
}

export interface DaedalusConfig {
  home: string;
  workspaceRoot: string;
  databasePath: string;
  logsDirectory: string;
  repositoryRoot: string;
  codexSessionsDirectory: string;
  claudeProjectsDirectory: string;
  workspaceInstructionFilesEnabled: boolean;
  /**
   * Suppresses toasts and desktop notifications without touching activity
   * tracking, so the board stays live while the interruptions stop.
   */
  focusMode: boolean;
  agents: Record<string, AgentDefinition>;
}

type StoredConfig = Partial<
  Pick<
    DaedalusConfig,
    | "workspaceRoot"
    | "workspaceInstructionFilesEnabled"
    | "focusMode"
    | "agents"
  >
>;

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
    codexSessionsDirectory: join(
      resolve(expandHome(env.CODEX_HOME || join(homedir(), ".codex"))),
      "sessions",
    ),
    claudeProjectsDirectory: join(
      resolve(expandHome(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"))),
      "projects",
    ),
    workspaceInstructionFilesEnabled:
      stored.workspaceInstructionFilesEnabled !== false,
    focusMode: stored.focusMode === true,
    agents: stored.agents || {
      codex: { executable: "codex", args: [] },
      claude: { executable: "claude", args: [] },
    },
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

export async function saveFocusMode(
  config: DaedalusConfig,
  enabled: boolean,
): Promise<void> {
  await saveSetting(config, { focusMode: enabled });
  config.focusMode = enabled;
}

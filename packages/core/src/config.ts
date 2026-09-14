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
  claudeProjectsDirectory: string;
  workspaceInstructionFilesEnabled: boolean;
  agents: Record<string, AgentDefinition>;
}

function expandHome(path: string): string {
  return path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : path;
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
    ? ((await file.json()) as Partial<
        Pick<
          DaedalusConfig,
          "workspaceRoot" | "workspaceInstructionFilesEnabled" | "agents"
        >
      >)
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
    claudeProjectsDirectory: join(
      resolve(expandHome(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"))),
      "projects",
    ),
    workspaceInstructionFilesEnabled:
      stored.workspaceInstructionFilesEnabled !== false,
    agents: stored.agents || {
      codex: { executable: "codex", args: [] },
      claude: { executable: "claude", args: [] },
    },
  };
}

export async function saveWorkspaceInstructionFilesEnabled(
  config: DaedalusConfig,
  enabled: boolean,
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
      `${JSON.stringify(
        { ...stored, workspaceInstructionFilesEnabled: enabled },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    await rename(temporaryPath, configPath);
    config.workspaceInstructionFilesEnabled = enabled;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

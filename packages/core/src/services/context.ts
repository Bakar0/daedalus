import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  CommandTmuxClient,
  findExecutable,
  runCommand,
  TMUX_EXECUTABLE_FALLBACKS,
  type TmuxClient,
} from "@daedalus/platform";
import { loadConfig, type DaedalusConfig } from "../config";
import { JsonLogger } from "../logging";
import { runMigrations } from "../repositories/migrations";
import { SqliteRepositories } from "../repositories/sqlite";
import { AgentService } from "./agents";
import { IntegratedTerminalService } from "./integrated-terminals";
import { TaskService } from "./tasks";
import { WorkspaceService } from "./workspaces";
import { WorkspaceContentService } from "./workspace-content";

export interface ApplicationContext {
  config: DaedalusConfig;
  logger: JsonLogger;
  repositories: SqliteRepositories;
  workspaces: WorkspaceService;
  workspaceContent: WorkspaceContentService;
  tasks: TaskService;
  agents: AgentService;
  terminals: IntegratedTerminalService;
  tmux: TmuxClient;
  close(): void;
}

export interface ApplicationContextOptions {
  migrationsDirectory?: string;
  env?: NodeJS.ProcessEnv;
  tmux?: TmuxClient;
  reconcile?: boolean;
}

export async function createApplicationContext(
  input: string | ApplicationContextOptions = {},
): Promise<ApplicationContext> {
  const options: ApplicationContextOptions =
    typeof input === "string" ? { migrationsDirectory: input } : input;
  const migrationsDirectory =
    options.migrationsDirectory ??
    resolve(import.meta.dir, "../../../../migrations");
  const config = await loadConfig(options.env);
  await runMigrations(config.databasePath, migrationsDirectory);
  const repositories = new SqliteRepositories(config.databasePath);
  const socketSuffix = createHash("sha256")
    .update(config.home)
    .digest("hex")
    .slice(0, 12);
  const tmux =
    options.tmux ??
    new CommandTmuxClient(
      `daedalus-${socketSuffix}`,
      findExecutable("tmux", TMUX_EXECUTABLE_FALLBACKS) ?? "tmux",
      runCommand,
      config.home,
    );
  let agents!: AgentService;
  const workspaces = new WorkspaceService(
    repositories,
    config.workspaceRoot,
    (workspaceId) => agents.hasLiveWorkspaceAgents(workspaceId),
    (workspaceId) => agents.archiveWorkspaceSessions(workspaceId),
    () => config.workspaceInstructionFilesEnabled,
  );
  const tasks = new TaskService(repositories, workspaces, (taskId) =>
    agents.hasLiveTaskAgents(taskId),
  );
  const workspaceContent = new WorkspaceContentService(
    repositories,
    workspaces,
    config,
  );
  agents = new AgentService(
    repositories,
    workspaces,
    workspaceContent,
    tasks,
    tmux,
    config,
  );
  const terminals = new IntegratedTerminalService(
    repositories,
    workspaces,
    tmux,
    config,
  );
  if (options.reconcile !== false)
    await Promise.all([agents.reconcile(), terminals.reconcile()]);
  return {
    config,
    logger: new JsonLogger(config.logsDirectory),
    repositories,
    workspaces,
    workspaceContent,
    tasks,
    agents,
    terminals,
    tmux,
    close: () => repositories.close(),
  };
}

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { CommandTmuxClient, type TmuxClient } from "@daedalus/platform";
import { loadConfig, type DaedalusConfig } from "../config";
import { JsonLogger } from "../logging";
import { runMigrations } from "../repositories/migrations";
import { SqliteRepositories } from "../repositories/sqlite";
import { AgentService } from "./agents";
import { TaskService } from "./tasks";
import { WorkspaceService } from "./workspaces";

export interface ApplicationContext {
  config: DaedalusConfig;
  logger: JsonLogger;
  repositories: SqliteRepositories;
  workspaces: WorkspaceService;
  tasks: TaskService;
  agents: AgentService;
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
    options.tmux ?? new CommandTmuxClient(`daedalus-${socketSuffix}`);
  let agents!: AgentService;
  const workspaces = new WorkspaceService(
    repositories,
    config.workspaceRoot,
    (workspaceId) => agents.hasLiveWorkspaceAgents(workspaceId),
  );
  const tasks = new TaskService(repositories, workspaces, (taskId) =>
    agents.hasLiveTaskAgents(taskId),
  );
  agents = new AgentService(repositories, workspaces, tasks, tmux, config);
  if (options.reconcile !== false) await agents.reconcile();
  return {
    config,
    logger: new JsonLogger(config.logsDirectory),
    repositories,
    workspaces,
    tasks,
    agents,
    close: () => repositories.close(),
  };
}

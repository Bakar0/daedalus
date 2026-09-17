import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  CommandTmuxClient,
  findExecutable,
  runCommand,
  TMUX_EXECUTABLE_FALLBACKS,
  type NativeNotification,
  type NativeNotifierResult,
  type TmuxClient,
} from "@daedalus/platform";
import { channelIdentifier, loadConfig, type DaedalusConfig } from "../config";
import { JsonLogger } from "../logging";
import { runMigrations } from "../repositories/migrations";
import { SqliteRepositories } from "../repositories/sqlite";
import { ActivityService } from "./activity";
import { AgentService } from "./agents";
import { IntegratedTerminalService } from "./integrated-terminals";
import { NotificationService } from "./notifications";
import { PresenceService } from "./presence";
import { TaskService } from "./tasks";
import { TelemetryService } from "./telemetry";
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
  telemetry: TelemetryService;
  presence: PresenceService;
  notifications: NotificationService;
  activity: ActivityService;
  tmux: TmuxClient;
  close(): void;
}

export interface ApplicationContextOptions {
  migrationsDirectory?: string;
  env?: NodeJS.ProcessEnv;
  tmux?: TmuxClient;
  reconcile?: boolean;
  /**
   * Set by the desktop host, which is the only adapter with a window to draw a
   * toast in. Everywhere else a toast has to wait in the queue.
   */
  canDrawToasts?: () => boolean;
  /** Injected so tests never reach the real Notification Center. */
  sendNativeNotification?: (
    notification: NativeNotification,
  ) => Promise<NativeNotifierResult>;
  /**
   * The host app's own notifier. Correctly attributed to Daedalus and needs
   * nothing installed, so it outranks AppleScript when the app is the caller.
   */
  showNotificationInApp?: (notification: NativeNotification) => void;
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
  let activity!: ActivityService;
  const workspaces = new WorkspaceService(
    repositories,
    config.workspaceRoot,
    (workspaceId) => agents.hasLiveWorkspaceAgents(workspaceId),
    (workspaceId) => agents.archiveWorkspaceSessions(workspaceId),
    config.home,
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
    (sessionId) => activity.forget(sessionId),
  );
  const terminals = new IntegratedTerminalService(
    repositories,
    workspaces,
    tmux,
    config,
  );
  const telemetry = new TelemetryService(repositories, config);
  const presence = new PresenceService(config);
  const notifications = new NotificationService(repositories, presence, {
    ...(options.sendNativeNotification
      ? { sendNative: options.sendNativeNotification }
      : {}),
    ...(options.canDrawToasts ? { canDrawToasts: options.canDrawToasts } : {}),
    cliExecutable: join(config.home, "bin", "daedal"),
    bundleId: channelIdentifier(config.home),
    ...(options.showNotificationInApp
      ? { showInApp: options.showNotificationInApp }
      : {}),
  });
  activity = new ActivityService(repositories, notifications);
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
    telemetry,
    presence,
    notifications,
    activity,
    tmux,
    close: () => repositories.close(),
  };
}

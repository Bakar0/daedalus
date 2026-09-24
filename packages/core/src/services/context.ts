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
import { EventBus } from "../events";
import { JsonLogger } from "../logging";
import { runMigrations } from "../repositories/migrations";
import { SqliteRepositories } from "../repositories/sqlite";
import { ActivityService } from "./activity";
import { SkillService } from "./skills";
import { AgentService } from "./agents";
import { IntegratedTerminalService } from "./integrated-terminals";
import { NotificationService } from "./notifications";
import { PresenceService } from "./presence";
import { ShutdownService } from "./shutdown";
import { TaskHistoryService } from "./task-history";
import { TaskService } from "./tasks";
import { TelemetryService } from "./telemetry";
import { WorkspaceService } from "./workspaces";
import { WorkspaceContentService } from "./workspace-content";
import { WorkspaceWatchService } from "./workspace-watch";

export interface ApplicationContext {
  config: DaedalusConfig;
  logger: JsonLogger;
  /** Domain events an adapter forwards to its own surface. */
  events: EventBus;
  repositories: SqliteRepositories;
  workspaces: WorkspaceService;
  workspaceContent: WorkspaceContentService;
  /**
   * Live filesystem changes for whichever workspaces an adapter says are
   * open. Publishes on `events`; nothing polls it.
   */
  workspaceWatch: WorkspaceWatchService;
  tasks: TaskService;
  /** Read-only: a task's timeline and cost, assembled on demand. */
  taskHistory: TaskHistoryService;
  agents: AgentService;
  terminals: IntegratedTerminalService;
  telemetry: TelemetryService;
  presence: PresenceService;
  notifications: NotificationService;
  activity: ActivityService;
  skills: SkillService;
  /** Ends everything at once. Nothing else in the app reaches for it. */
  shutdown: ShutdownService;
  tmux: TmuxClient;
  close(): void;
}

export interface ApplicationContextOptions {
  migrationsDirectory?: string;
  env?: NodeJS.ProcessEnv;
  tmux?: TmuxClient;
  reconcile?: boolean;
  /** Notified when a background repository preparation settles. */
  onRepositoriesChanged?: () => void;
  /**
   * Set by the desktop host, which is the only adapter with a window to draw a
   * toast in. Everywhere else a toast has to wait in the queue.
   */
  canDrawToasts?: () => boolean;
  /** Injected so staleness decay is testable without waiting ten minutes. */
  now?: () => Date;
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
      options.env ?? process.env,
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
    () => options.onRepositoriesChanged?.(),
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
  const events = new EventBus();
  const logger = new JsonLogger(config.logsDirectory);
  const workspaceWatch = new WorkspaceWatchService(
    workspaces,
    events,
    (workspaceId, error) =>
      void logger.write("error", "workspace_watch_failed", {
        workspaceId,
        message: error.message,
      }),
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
  activity = new ActivityService(repositories, notifications, {
    home: config.home,
    ...(options.now ? { now: options.now } : {}),
  });
  if (options.reconcile !== false) {
    // A clone only lives as long as the process running it, so anything still
    // marked as preparing belongs to a run that is over.
    workspaceContent.reconcilePreparations();
    await Promise.all([agents.reconcile(), terminals.reconcile()]);
    // Reconcile has just settled which sessions are still live, so the replay
    // knows which records to restore and which to discard. Decay runs after,
    // on the restored rows rather than on stale ones.
    await activity.restore();
    await activity.decay();
  }
  return {
    config,
    logger,
    events,
    repositories,
    workspaces,
    workspaceContent,
    workspaceWatch,
    tasks,
    taskHistory: new TaskHistoryService(repositories, workspaces, telemetry),
    agents,
    terminals,
    telemetry,
    presence,
    notifications,
    activity,
    skills: new SkillService(config),
    shutdown: new ShutdownService(repositories, agents, terminals, tmux),
    tmux,
    // Watchers are kernel resources held outside the database, so they are
    // released here rather than left to the process exiting.
    close: () => {
      workspaceWatch.close();
      repositories.close();
    },
  };
}

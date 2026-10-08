import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  CommandTmuxClient,
  findTmuxExecutable,
  runCommand,
  type NativeNotification,
  type NativeNotifierResult,
  type TmuxClient,
} from "@daedalus/platform";
import { channelIdentifier, loadConfig, type DaedalusConfig } from "../config";
import type { AgentSession } from "../domain";
import { EventBus } from "../events";
import { JsonLogger } from "../logging";
import { runMigrations } from "../repositories/migrations";
import { SqliteRepositories } from "../repositories/sqlite";
import { ActivityService } from "./activity";
import { AbilityService } from "./abilities";
import { findAccount } from "./account-homes";
import { AccountService } from "./accounts";
import { DeliveryGate } from "./delivery";
import { RoutineDelivery } from "./routine-delivery";
import { RoutineReportService } from "./routine-reports";
import { RoutineService } from "./routines";
import { SecretService } from "./secrets";
import { SkillService } from "./skills";
import { AgentService } from "./agents";
import { IntegratedTerminalService } from "./integrated-terminals";
import { NotificationService } from "./notifications";
import { PresenceService } from "./presence";
import { ShutdownService } from "./shutdown";
import { TaskHistoryService } from "./task-history";
import { forgetSessionFolders } from "./folder-trust";
import { TaskService } from "./tasks";
import { ProviderTeamTransport, type TeamTransport } from "./team-transport";
import { TeamService } from "./teams";
import { TelemetryService } from "./telemetry";
import { WorkspaceService } from "./workspaces";
import { WorkspaceContentService } from "./workspace-content";
import {
  WORKSPACE_FILES_CHANGED,
  WorkspaceWatchService,
  type WorkspaceFilesChanged,
} from "./workspace-watch";

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
  accounts: AccountService;
  /** Workspace secrets: names in SQLite, values in the login Keychain. */
  secrets: SecretService;
  abilities: AbilityService;
  routines: RoutineService;
  routineReports: RoutineReportService;
  /** Teams: a lead, its members, and their chat. */
  teams: TeamService;
  /** The routine clock; only the desktop host ticks it. */
  routineDelivery: RoutineDelivery;
  /** Keystrokes per session, and the rule for typing into a session. */
  deliveryGate: DeliveryGate;
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
  /** Injected so tests never write to a real session's inbox. */
  teamTransport?: TeamTransport;
  /** Injected so tests stand in for a Claude session's inbox waiter. */
  sessionInbox?: (session: AgentSession, line: string) => Promise<boolean>;
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
      findTmuxExecutable(options.env ?? process.env) ?? "tmux",
      runCommand,
      config.home,
      options.env ?? process.env,
    );
  let agents!: AgentService;
  let teams: TeamService | undefined;
  const endedNoted = new Map<string, number>();
  let activity!: ActivityService;
  const abilities = new AbilityService(repositories, config, options.now);
  const workspaces = new WorkspaceService(
    repositories,
    config.workspaceRoot,
    (workspaceId) => agents.hasLiveWorkspaceAgents(workspaceId),
    (workspaceId) => agents.archiveWorkspaceSessions(workspaceId),
    config.home,
    () => config.workspaceInstructionFilesEnabled,
    async (workspaceId) => {
      // Every session folder lives under the workspace folder, so this drops
      // their provider trust records with it.
      const path = repositories.findWorkspace(workspaceId)?.path;
      if (path) await forgetSessionFolders(config, path);
      await workspaceContent.discardWorkspaceCheckouts(workspaceId);
    },
    (provider, reference) =>
      findAccount(config, provider, reference)?.id ?? null,
    (workspaceId) => secrets.forgetWorkspace(workspaceId),
  );
  const secrets = new SecretService(repositories, workspaces, config.home);
  const tasks = new TaskService(repositories, workspaces, (taskId) =>
    agents.hasLiveTaskAgents(taskId),
  );
  const workspaceContent = new WorkspaceContentService(
    repositories,
    workspaces,
    config,
    () => options.onRepositoriesChanged?.(),
    (folder) => terminals.closeInside(folder),
  );
  agents = new AgentService(
    repositories,
    workspaces,
    workspaceContent,
    tasks,
    tmux,
    config,
    abilities,
    (sessionId) => {
      activity.forget(sessionId);
      // Archiving a running session stops it first, which ends it twice.
      const last = endedNoted.get(sessionId) ?? 0;
      if (Date.now() - last < 10_000) return;
      endedNoted.set(sessionId, Date.now());
      void teams?.noteMemberStatus(sessionId, "stopped running.");
    },
    (sessionId, reason) =>
      activity.raise({ sessionId, reason }).catch(() => undefined),
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
  // File changes the watcher sees tell the git status pass which trees to
  // measure, so it can leave every other tree alone.
  events.subscribe((event) => {
    if (event.type !== WORKSPACE_FILES_CHANGED) return;
    const { workspaceId, changes, overflow } =
      event.payload as WorkspaceFilesChanged;
    workspaceContent.noteFilesChanged(workspaceId, changes, overflow);
  });
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
  const routines = new RoutineService(
    repositories,
    async (sessionId, reason) => {
      await activity.raise({ sessionId, reason });
    },
    options.now,
  );
  abilities.onRevoke("routines", (ability) =>
    routines.skipUndelivered(ability, "Skipped: the ability was revoked"),
  );
  teams = new TeamService(
    repositories,
    abilities,
    agents,
    options.teamTransport ??
      new ProviderTeamTransport(config, (session) =>
        agents.codexExecutable(session),
      ),
    options.now,
    activity,
  );
  const routineReports = new RoutineReportService(
    repositories,
    notifications,
    options.now,
  );
  const deliveryGate = new DeliveryGate(options.now);
  const routineDelivery = new RoutineDelivery(
    repositories,
    abilities,
    agents,
    routines,
    routineReports,
    deliveryGate,
    options.now,
    options.sessionInbox,
  );
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
    accounts: new AccountService(config, repositories, undefined, (id) =>
      agents.archive(id, true),
    ),
    secrets,
    abilities,
    routines,
    routineReports,
    teams: teams!,
    routineDelivery,
    deliveryGate,
    shutdown: new ShutdownService(repositories, agents, terminals, tmux),
    tmux,
    // Watchers are kernel resources held outside the database, so they are
    // released here rather than left to the process exiting.
    close: () => {
      workspaceWatch.close();
      workspaceContent.close();
      repositories.close();
    },
  };
}

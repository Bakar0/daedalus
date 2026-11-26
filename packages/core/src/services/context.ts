import { readMainMessages } from "./main-messages";
import { createHash } from "node:crypto";
import type { PartialReadModelSource } from "./read-model";
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
import { DaedalusError } from "../errors";
import { EventBus } from "../events";
import { JsonLogger } from "../logging";
import { runMigrations } from "../repositories/migrations";
import { SqliteRepositories } from "../repositories/sqlite";
import { ActivityService } from "./activity";
import { sweepProviderActivity } from "./activity-detect";
import { AbilityService } from "./abilities";
import { RoutineService, type RoutineSpawner } from "./routines";
import { findAccount } from "./account-homes";
import { AccountService } from "./accounts";
import { DeliveryGate } from "./delivery";
import { AbilityNoteDelivery } from "./ability-notes";
import { SessionChannel } from "./session-channel";
import { SecretService } from "./secrets";
import {
  customInstructionsPath,
  SkillService,
  workflowsEnabled,
} from "./skills";
import { InstructionService } from "./instruction-files";
import { KeybindingService, keybindingsPath } from "./keybindings";
import { AgentService } from "./agents";
import { IntegratedTerminalService } from "./integrated-terminals";
import { NotificationService } from "./notifications";
import { AppUpdateService } from "./app-updates";
import { PresenceService } from "./presence";
import { ShutdownService } from "./shutdown";
import { claudeSyncSeeder } from "../cloud/claude-sync-seeder";
import { CloudService, type CloudServiceOptions } from "../cloud/cloud-service";
import { CLOUD_LAUNCH_SECRETS } from "./cloud-launch";
import { WorkspaceMoves } from "./workspace-move";
import { CloudWorktrees } from "./cloud-worktrees";
import { isPodAccess, PodMoveSide } from "./move-side";
import { MAX_EXPLORER_BYTES } from "./pod-files";
import { CloudSessions } from "../cloud/cloud-sessions";
import { GatewayInstaller } from "../cloud/gateway-install";
import { SessionArchive } from "./session-archive";
import { LocalSessionHost } from "./session-host";
import { SessionHosts } from "./session-hosts";
import { TaskHistoryService } from "./task-history";
import { forgetSessionFolders } from "./folder-trust";
import { TaskService } from "./tasks";
import {
  HostTeamTransport,
  ProviderTeamTransport,
  type TeamTransport,
} from "./team-transport";
import { TeamService } from "./teams";
import { ChannelService } from "./channels";
import { TelemetryService } from "./telemetry";
import { WorkspaceService } from "./workspaces";
import { WorkflowService } from "./workflows";
import { FactoryService } from "./factory";
import { convertOldWork } from "./job-convert";
import { createJobPorts, JobIntakeService } from "./job-intake";
import { JobService } from "./jobs";
import { PlanService } from "./plans";
import { SearchService } from "./search";
import { HomeService } from "./home";
import { OpenThreadsTransport, ThreadService } from "./threads";
import {
  instructionFileOptions,
  WorkspaceContentService,
} from "./workspace-content";
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
  appUpdates: AppUpdateService;
  notifications: NotificationService;
  activity: ActivityService;
  skills: SkillService;
  accounts: AccountService;
  /** Workspace secrets: names in SQLite, values in the login Keychain. */
  secrets: SecretService;
  abilities: AbilityService;
  /** Teams: a lead, its members, and their chat. */
  teams: TeamService;
  channels: ChannelService;
  /** Workflow runs: which workflow each piece of work follows, and where. */
  workflows: WorkflowService;
  /** The job engine: every piece of work as a tree of jobs over one log. */
  jobs: JobService;
  /** Workflows and plans as jobs under the job a session is on. */
  jobIntake: JobIntakeService;
  /** Plans: `plans/*.plan.md` in a workspace or at Home, and their owners. */
  plans: PlanService;
  /** The ⌘K palette's file list and content search. */
  search: SearchService;
  /** Home: the hidden Home workspace row. */
  home: HomeService;
  /** A lead marking a team member done. */
  /** Activity: questions for the user that sessions ask once. */
  threads: ThreadService;
  factory: FactoryService;
  /** The user's custom instructions, as the Custom instructions tab edits them. */
  instructions: InstructionService;
  /** The person's own keys, `keybindings.json` in the home. */
  keybindings: KeybindingService;
  /** Types grant and revoke notes in; only the desktop host ticks it. */
  abilityNotes: AbilityNoteDelivery;
  /** Routines on their own page, each run a headless session; ticked by the desktop host. */
  routines: RoutineService;
  /** How Daedalus hands a line to a running session it did not get from the user. */
  sessionChannel: SessionChannel;
  /** Keystrokes per session, and the rule for typing into a session. */
  deliveryGate: DeliveryGate;
  /** Ends everything at once. Nothing else in the app reaches for it. */
  shutdown: ShutdownService;
  tmux: TmuxClient;
  /** Where sessions run: this Mac, and any connected cloud hosts. */
  hosts: SessionHosts;
  /** Cloud workspaces: the gateway sign-in and the link to their runners. */
  cloud: CloudService;
  /** Moving whole workspaces between this Mac and their cloud copy. */
  workspaceMoves: WorkspaceMoves;
  /** Waking a cloud workspace and resuming the sessions its sleep ended. */
  cloudSessions: CloudSessions;
  /** Archiving and deleting where the cloud is involved. */
  archive: SessionArchive;
  /** Installing the gateway onto a Kubernetes cluster, from Settings > Cloud. */
  gatewayInstall: GatewayInstaller;
  close(): void;
}

export interface ApplicationContextOptions {
  migrationsDirectory?: string;
  env?: NodeJS.ProcessEnv;
  tmux?: TmuxClient;
  reconcile?: boolean;
  /**
   * Notified when a background repository preparation settles, or a measured
   * git status or pull request changes. `parts` names the read-model parts
   * that moved when only those did; without it anything may have.
   */
  onRepositoriesChanged?: (parts?: PartialReadModelSource[]) => void;
  /**
   * Set by the desktop host, which is the only adapter with a window to draw a
   * toast in. Everywhere else a toast has to wait in the queue.
   */
  canDrawToasts?: () => boolean;
  /** Injected so tests never write to a real session's inbox. */
  teamTransport?: TeamTransport;
  /** Starts routine runs; tests pass a fake provider. */
  routineSpawner?: RoutineSpawner;
  /** Injected so tests stand in for a Claude session's inbox pipe. */
  sessionInbox?: (session: AgentSession, line: string) => Promise<boolean>;
  /** Injected so staleness decay is testable without waiting ten minutes. */
  now?: () => Date;
  /** Injected so tests reach a fake gateway, with no Keychain. */
  cloud?: Pick<
    CloudServiceOptions,
    | "fetch"
    | "account"
    | "identity"
    | "connect"
    | "awsConfig"
    | "apiKey"
    | "log"
    | "now"
    | "runnerWaitMs"
  >;
  /**
   * The chart and kind scripts the gateway install uses, and a checkout to
   * build images from. The desktop host passes the copies in its bundle.
   */
  gatewayInstall?: {
    chartDirectory?: string;
    kindDirectory?: string;
    sourceRoot?: string;
  };
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
  // What was recorded before the job engine becomes jobs, once.
  const conversion = await convertOldWork(
    repositories,
    config.databasePath,
    options.now,
  );
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
  const hosts = new SessionHosts(new LocalSessionHost(tmux));
  let agents!: AgentService;
  let teams: TeamService | undefined;
  let channels: ChannelService | undefined;
  const endedNoted = new Map<string, number>();
  let activity!: ActivityService;
  const abilities = new AbilityService(repositories, config, options.now);
  const workspaces = new WorkspaceService(
    repositories,
    config.workspaceRoot,
    (workspaceId) => agents.hasLiveWorkspaceAgents(workspaceId),
    (workspaceId) => agents.archiveWorkspaceSessions(workspaceId),
    config.home,
    () => instructionFileOptions(config),
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
    (parts) => options.onRepositoriesChanged?.(parts),
    (folder) => terminals.closeInside(folder),
  );
  // The workflows switch also adds or removes step 8 of every workspace's
  // instruction files.
  const skills = new SkillService(config, async (id) => {
    if (id === "daedalus-workflows")
      await workspaceContent.syncInstructionFiles();
  });
  const accounts = new AccountService(config, repositories, undefined, (id) =>
    agents.archive(id, true),
  );
  const deliveryGate = new DeliveryGate(options.now);
  const sessionChannel = new SessionChannel(
    config,
    hosts,
    deliveryGate,
    options.now,
    options.sessionInbox,
  );
  agents = new AgentService(
    repositories,
    workspaces,
    workspaceContent,
    tasks,
    hosts,
    tmux,
    config,
    abilities,
    accounts,
    sessionChannel,
    (sessionId) => {
      activity.forget(sessionId);
      // An archived session's threads resolve; one that only stopped keeps them.
      threads.closeForSession(sessionId);
      // Archiving a running session stops it first, which ends it twice.
      const last = endedNoted.get(sessionId) ?? 0;
      if (Date.now() - last < 10_000) return;
      endedNoted.set(sessionId, Date.now());
      void channels?.noteMemberStatus(sessionId, "stopped running.");
    },
    (sessionId, reason) =>
      activity.raise({ sessionId, reason }).catch(() => undefined),
    // Read off the screen, so it is a pane reading, and only fills a gap:
    // anything a hook already said about the session stands.
    (sessionId) =>
      activity
        .record({
          sessionId,
          activity: "idle",
          source: "pane",
          ifActivity: ["unknown"],
        })
        .catch(() => undefined),
  );
  agents.onCloudSecrets((workspaceId) =>
    secrets.values(workspaceId, CLOUD_LAUNCH_SECRETS),
  );
  const terminals = new IntegratedTerminalService(
    repositories,
    workspaces,
    hosts.local,
    config,
  );
  const logger = new JsonLogger(config.logsDirectory);
  if (conversion.ran)
    void logger
      .write(
        conversion.error ? "error" : "info",
        conversion.error
          ? "The records from before the job engine did not convert. They are as they were, and nothing reads them until they do."
          : "Converted the records from before the job engine",
        { ...conversion },
      )
      .catch(() => undefined);
  const cloudLog =
    options.cloud?.log ??
    ((event: string, fields?: Record<string, unknown>) =>
      void logger.write("info", event, fields));
  const cloud = new CloudService({
    config,
    repositories,
    workspaces,
    hosts,
    ...options.cloud,
    log: cloudLog,
  });
  agents.onCloudLaunch((session) => cloud.prepareLaunch(session));
  agents.onCloudHost((workspaceId) => cloud.prepareForSession(workspaceId));
  // The user's skills, commands, plugins and remote MCP servers.
  cloud.addLaunchSeeder(claudeSyncSeeder({ config, log: cloudLog }));
  agents.onCloudReady((session, launch) => cloud.autoSignIn(session, launch));
  const events = new EventBus();
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
    sweep: () =>
      sweepProviderActivity({ config, repositories, activity, tmux }),
  });
  const rawTransport = new HostTeamTransport(
    options.teamTransport ??
      new ProviderTeamTransport(config, (session) =>
        agents.codexExecutable(session),
      ),
    sessionChannel,
    (sessionId) => activity.get(sessionId),
  );
  let plans!: PlanService;
  // Every message Daedalus brings a session ends with its open threads.
  const threads = new ThreadService(
    repositories,
    () => plans,
    agents,
    () => teamTransport,
    options.now,
    (session) => readMainMessages(config, session),
  );
  const teamTransport = new OpenThreadsTransport(
    rawTransport,
    (sessionId) => threads.openLine(sessionId),
    repositories.sessionNotes,
  );
  agents.onSessionRunning((session) => threads.flushSession(session.id));
  teams = new TeamService(
    repositories,
    abilities,
    agents,
    () => channels!,
    options.now,
  );
  channels = new ChannelService(
    repositories,
    teams,
    agents,
    teamTransport,
    options.now,
    activity,
  );
  const home = new HomeService(repositories, workspaces, {
    archive: (id) => agents.archive(id),
  });
  const abilityNotes = new AbilityNoteDelivery(
    repositories,
    abilities,
    sessionChannel,
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
    // Home has no agent; a session an older build left there is put away.
    await home.retireMainAgent();
  }
  workspaceContent.useCloudWorktrees(
    new CloudWorktrees({ config, repositories, workspaces, hosts }),
  );
  // The explorer browses an awake pod only; opening a session wakes it.
  workspaceContent.usePod(async (workspace) => {
    const host = await cloud.awakeHost(workspace.id);
    if (!isPodAccess(host))
      throw new DaedalusError(
        "CONFLICT",
        "The cloud workspace is asleep; open a session to wake it",
      );
    return new PodMoveSide(host, MAX_EXPLORER_BYTES);
  });
  const workspaceMoves = new WorkspaceMoves({
    config,
    repositories,
    workspaces,
    agents,
    hosts,
    cloud,
    terminals,
    activity: async (sessionId) =>
      (await activity.binding(sessionId))?.activity ??
      activity.get(sessionId)?.activity,
  });
  cloud.keepWhile((workspaceId) => workspaceMoves.moving(workspaceId));
  const repositoryRoot = resolve(import.meta.dir, "../../../..");
  const gatewayInstall = new GatewayInstaller({
    home: config.home,
    chartDirectory:
      options.gatewayInstall?.chartDirectory ??
      join(repositoryRoot, "deploy/helm/daedalus"),
    kindDirectory:
      options.gatewayInstall?.kindDirectory ??
      join(repositoryRoot, "deploy/kind"),
    ...(options.gatewayInstall?.sourceRoot
      ? { sourceRoot: options.gatewayInstall.sourceRoot }
      : {}),
    signIn: (gatewayUrl, email) => cloud.signIn(gatewayUrl, email),
    signedInGateway: async () =>
      (await cloud.account.signIn())?.gatewayUrl ?? null,
    log: (message, fields) => cloudLog(message, fields),
  });

  const workflows = new WorkflowService(config.home, options.now);
  const jobs = new JobService(
    repositories,
    createJobPorts({
      spawn: async (input) => {
        const workspace = await workspaces.getActive(input.workspace);
        return agents.spawn({
          ...input,
          provider: workspace.defaultProvider ?? "claude",
          forJob: true,
        });
      },
      send: (sessionId, text) => agents.send(sessionId, text),
      raise: (sessionId, reason) => activity.raise({ sessionId, reason }),
      clear: (sessionId) => activity.clear(sessionId),
      session: (sessionId) => repositories.findAgent(sessionId),
      archive: (sessionId) => agents.archive(sessionId),
      places: async (workspaceId) => ({
        path: (await workspaces.getActive(workspaceId)).path,
        repositories: repositories
          .listWorkspaceRepositories(workspaceId)
          .map((repository) => repository.canonicalPath),
      }),
      plans: {
        find: (scope, reference) => plans.find(scope, reference),
        read: (file) => plans.read(file),
        setState: (file, task, state, owner) =>
          plans.setState(file, task, state, owner),
      },
      now: () => options.now?.() ?? new Date(),
    }),
  );
  agents.onContinued = (from, to) => jobs.moveSession(from, to);
  agents.onSpawned = async (session, input) => {
    const message = input.message?.trim();
    if (input.forJob || !message || session.kind !== "agent") return;
    // Work a session hands to another is part of the job it is on.
    // A team member's work is part of its lead's, whoever typed the command.
    const from =
      input.spawnedBy ??
      (session.teamId
        ? teams?.list().find((team) => team.id === session.teamId)?.lead.id
        : undefined);
    const above = from ? jobs.current(from)?.job : undefined;
    const parent =
      above &&
      repositories.findAgent(from ?? "")?.workspaceId === session.workspaceId
        ? above.id
        : null;
    const name =
      session.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "work";
    const draft = { title: session.name, instructions: message };
    await jobs
      .open(session.workspaceId, session.id, { ...draft, name }, parent)
      .catch(() =>
        // The name is taken beside it.
        jobs.open(
          session.workspaceId,
          session.id,
          { ...draft, name: `${name}-${session.id.slice(0, 6)}` },
          parent,
        ),
      );
  };
  const jobIntake = new JobIntakeService({
    jobs,
    catalog: () => workflows.catalog(),
    plans: {
      read: (file) => plans.read(file),
      pinTask: (file, task) => plans.pinTask(file, task),
    },
    session: (sessionId) => repositories.findAgent(sessionId),
    sessions: (workspace) => agents.list({ workspace }),
    leads: () => new Set(teams?.list().map((team) => team.lead.id) ?? []),
    enabled: () => workflowsEnabled(config),
  });

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
    appUpdates: new AppUpdateService(config),
    notifications,
    activity,
    skills,
    accounts,
    secrets,
    abilities,
    teams: teams!,
    channels: channels!,
    instructions: new InstructionService(customInstructionsPath(config.home)),
    keybindings: new KeybindingService(keybindingsPath(config.home)),
    workflows,
    jobs,
    jobIntake,
    plans: (plans = new PlanService({
      workspaceRoot: config.workspaceRoot,
      workspace: (reference) => workspaces.getActive(reference),
      workspaces: () => workspaces.list(),
      sessions: (workspace) => agents.list({ workspace }),
      leads: () => teams?.list().map((team) => team.lead.id) ?? [],
      activity: (sessionId) => activity.get(sessionId)?.activity,
      needsAttention: (sessionId) => Boolean(activity.attentionFor(sessionId)),
      send: (sessionId, text, from) =>
        agents.send(sessionId, text, from ? { from } : {}),
    })),
    factory: new FactoryService({
      jobs: (workspaceId) => jobs.page(workspaceId),
      sessions: (workspace) =>
        agents.list({ workspace, includeArchived: true }),
      activity: (sessionId) => activity.get(sessionId)?.activity,
      needsAttention: (sessionId) => Boolean(activity.attentionFor(sessionId)),
      threadTasks: (planPath) =>
        threads
          .onPlan(planPath)
          .flatMap((thread) => (thread.taskKey ? [thread.taskKey] : [])),
    }),
    search: new SearchService(),
    home,
    threads,
    abilityNotes,
    routines: new RoutineService(
      repositories,
      config,
      {
        continueConversation: (input) => agents.continueConversation(input),
        spawn: (input) => agents.spawn(input),
        restore: (id) => agents.restore(id),
      },
      options.routineSpawner,
      options.now,
      (request) => notifications.notify(request),
    ),
    sessionChannel,
    deliveryGate,
    shutdown: new ShutdownService(repositories, agents, terminals, tmux),
    tmux,
    hosts,
    cloud,
    cloudSessions: new CloudSessions({ repositories, agents, cloud }),
    workspaceMoves,
    gatewayInstall,
    archive: new SessionArchive({
      repositories,
      agents,
      workspaces,
      workspaceMoves,
      cloud,
    }),
    // Watchers are kernel resources held outside the database, so they are
    // released here rather than left to the process exiting.
    close: () => {
      gatewayInstall.close();
      cloud.close();
      workspaceWatch.close();
      workspaceContent.close();
      repositories.close();
    },
  };
}

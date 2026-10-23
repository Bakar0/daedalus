import { stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import packageJson from "../../../../package.json";
import { readPasteboardFiles, writePasteboardFiles } from "@daedalus/platform";
import {
  accountDirectory,
  autoRebirthPercent,
  channelName,
  cloudHostWorkspace,
  cloudMcpChoices,
  setCloudMcpServer,
  DaedalusError,
  INSTALL_COMMANDS,
  normalizeError,
  ReadModel,
  updateSettings,
  type AccountProfile,
  type AgentActivityState,
  type AgentSession,
  type ApplicationContext,
  type CloudOverview,
  type IntegratedTerminal,
  type PendingNotification,
  type PresenceState,
  type RepositoryLibraryEntry,
  type Routine,
  type RoutineRun,
  type RoutinesStatus,
  type SessionAbility,
  type Team,
  type TeamMessage,
  USER_HANDLE,
  type SessionAttention,
  type Task,
  type VisibleSecret,
  type Workspace,
  type WorkspaceContent,
  type WorkspaceRepository,
} from "@daedalus/core";
import type {
  AccountDto,
  AgentActivityDto,
  AppUpdateDto,
  QuitChoice,
  AgentSessionDto,
  CloudMcpServersDto,
  CloudStateDto,
  DesktopRpcSchema,
  DesktopSnapshotDto,
  DesktopWindowRole,
  IntegratedTerminalDto,
  PresenceStateDto,
  RepositoryLibraryDto,
  RoutineDto,
  RoutineRunDto,
  RoutinesDetailDto,
  RoutinesStatusDto,
  SessionAbilityDto,
  TeamDetailDto,
  TeamDto,
  TeamMessageDto,
  RpcResult,
  SessionAttentionDto,
  TaskDto,
  ToastDto,
  WorkspaceContentDto,
  WorkspaceDto,
  WorkspaceRepositoryDto,
  SecretDto,
} from "@daedalus/protocol";

import type { DesktopRemoteHost } from "./remote";

/**
 * The host's side of the quit dialog. It lives in `index.ts` because only the
 * host can end the process; the RPC layer just carries the two answers back.
 */
export interface DesktopQuitHost {
  dialogShown(): void;
  decide(choice: QuitChoice): Promise<void>;
}

/** The host's `UpdateController`, as far as the window can reach it. */
export interface DesktopUpdateHost {
  current(): AppUpdateDto | null;
  check(): Promise<AppUpdateDto | null>;
  install(): Promise<AppUpdateDto | null>;
  dismiss(version?: string): Promise<AppUpdateDto | null>;
}

const NO_UPDATES: DesktopUpdateHost = {
  current: () => null,
  check: async () => null,
  install: async () => null,
  dismiss: async () => null,
};

type Requests = DesktopRpcSchema["bun"]["requests"];
export type DesktopRequestHandlers = {
  [Name in keyof Requests]: (
    params: Requests[Name]["params"],
  ) => Promise<Requests[Name]["response"]> | Requests[Name]["response"];
};

const success = <T>(data: T): RpcResult<T> => ({ ok: true, data });

async function result<T>(
  operation: () => T | Promise<T>,
): Promise<RpcResult<T>> {
  try {
    return success(await operation());
  } catch (error) {
    const normalized = normalizeError(error);
    return {
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
      },
    };
  }
}

// DTO conversion is explicit so persistence/domain objects never leak implicitly.
const workspaceDto = (
  workspace: Workspace,
  available = true,
): WorkspaceDto => ({ ...workspace, available });
const taskDto = (task: Task): TaskDto => ({ ...task });
const agentDto = (agent: AgentSession): AgentSessionDto => ({
  ...agent,
  args: [...agent.args],
});
/** Name and host only: a server's URL can hold a key. */
const mcpDto = (
  choices: Awaited<ReturnType<typeof cloudMcpChoices>>,
): CloudMcpServersDto => ({
  servers: choices.servers.map((server) => ({
    name: server.name,
    host: server.host,
    on: server.on,
  })),
  leftOut: choices.leftOut.map((one) => ({
    name: one.name,
    reason: one.reason,
  })),
});

/** Field by field, so nothing else the host knows can come along. */
const cloudStateDto = (overview: CloudOverview): CloudStateDto => ({
  signedIn: overview.connection !== "signed-out",
  gatewayUrl: overview.gatewayUrl,
  email: overview.email,
  connection: overview.connection,
  error: overview.error,
  workspaces: overview.workspaces.map((workspace) => ({
    workspaceId: workspace.workspaceId,
    cloudId: workspace.cloudId,
    status: workspace.status,
    runnerOnline: workspace.runnerOnline,
    reason: workspace.reason,
    createdAt: workspace.createdAt,
  })),
});
const accountDto = (
  context: ApplicationContext,
  profile: AccountProfile,
): AccountDto => ({
  provider: profile.provider,
  account: profile.id,
  name: profile.name,
  directory: accountDirectory(context.config, profile),
  createdAt: profile.createdAt,
  kind: profile.kind ?? "login",
  ...(profile.provider === "claude" && (profile.kind ?? "login") === "login"
    ? { login: profile.login ?? "subscription" }
    : {}),
  ...(profile.aws ? { aws: { ...profile.aws } } : {}),
});
const integratedTerminalDto = (
  terminal: IntegratedTerminal,
): IntegratedTerminalDto => ({
  id: terminal.id,
  name: terminal.name,
  tmuxSession: terminal.tmuxSession,
  workingDirectory: terminal.workingDirectory,
  status: terminal.status,
  startedAt: terminal.startedAt,
  endedAt: terminal.endedAt,
  revivedAt: terminal.revivedAt,
});
const workspaceRepositoryDto = (
  repository: WorkspaceRepository,
): WorkspaceRepositoryDto => ({ ...repository });
const repositoryLibraryDto = (
  repository: RepositoryLibraryEntry,
): RepositoryLibraryDto => ({
  id: repository.id,
  name: repository.name,
  remoteUrl: repository.remoteUrl,
  defaultBranch: repository.defaultBranch,
  lastFetchedAt: repository.lastFetchedAt,
});
const agentActivityDto = (state: AgentActivityState): AgentActivityDto => ({
  ...state,
});
const sessionAttentionDto = (
  attention: SessionAttention,
): SessionAttentionDto => ({
  ...attention,
  reasons: attention.reasons.map((reason) => ({ ...reason })),
});
const toastDto = (notification: PendingNotification): ToastDto => ({
  id: notification.id,
  sessionId: notification.sessionId,
  workspaceId: notification.workspaceId,
  level: notification.level,
  title: notification.title,
  body: notification.body,
  createdAt: notification.createdAt,
});
const presenceDto = (
  presence: PresenceState,
  focusMode: boolean,
): PresenceStateDto => ({ ...presence, focusMode });
const workspaceContentDto = (
  content: WorkspaceContent,
): WorkspaceContentDto => ({
  ...content,
  files: content.files.map((item) => ({ ...item })),
  repositories: content.repositories.map(workspaceRepositoryDto),
  worktrees: content.worktrees.map((item) => ({ ...item })),
});

/** The read model's view, as the window and the phone receive it. */
export async function desktopSnapshot(
  readModel: ReadModel,
): Promise<DesktopSnapshotDto> {
  const view = await readModel.snapshot();
  const { config, accounts } = view.settings;
  return {
    workspaces: view.workspaces.map(({ workspace, available }) =>
      workspaceDto(workspace, available),
    ),
    tasks: view.tasks.map(({ task, references }) => ({
      ...taskDto(task),
      references: references.map((item) => ({ ...item })),
    })),
    agents: view.agents.map(agentDto),
    terminals: view.terminals.map(integratedTerminalDto),
    repositories: view.repositories.map(repositoryLibraryDto),
    ...view.telemetry,
    sessionActivity: view.sessionActivity.map(agentActivityDto),
    worktrees: view.worktrees.map((worktree) => ({ ...worktree })),
    shipped: view.shipped.map((item) => ({ ...item })),
    attention: view.attention.map(sessionAttentionDto),
    toasts: view.toasts.map(toastDto),
    abilities: view.abilities.map(sessionAbilityDto),
    teams: view.teams.map(teamDto),
    largeFiles: view.largeFiles.map((file) => ({ ...file })),
    routines: view.routines.map(routinesStatusDto),
    routineReports: view.routineReports.map((report) => ({ ...report })),
    settings: {
      version: packageJson.version,
      channel: channelName(config.home),
      home: config.home,
      workspaceRoot: config.workspaceRoot,
      databasePath: config.databasePath,
      repositoryRoot: config.repositoryRoot,
      workspaceInstructionFilesEnabled: config.workspaceInstructionFilesEnabled,
      autoRestoreSessionsEnabled: config.autoRestoreSessionsEnabled,
      trustSessionFoldersEnabled: config.trustSessionFoldersEnabled,
      autoRebirthPercent: config.autoRebirthPercent,
      focusMode: config.focusMode,
      ...view.capabilities,
      accounts: accounts.map((item) => ({ ...item })),
    },
  };
}

const sessionAbilityDto = (ability: SessionAbility): SessionAbilityDto => ({
  id: ability.id,
  sessionId: ability.sessionId,
  ability: ability.ability,
  enabled: ability.enabled,
  paused: ability.paused,
  purpose: ability.config.purpose ?? null,
  noteWaiting: Boolean(ability.pendingNote),
  grantedAt: ability.grantedAt,
});

const teamDto = (team: Team): TeamDto => ({
  id: team.id,
  leadId: team.lead.id,
  name: team.name,
  goal: team.goal,
});

const teamMessageDto = (
  message: TeamMessage,
  cloud: string | undefined,
): TeamMessageDto => ({
  id: message.id,
  author: message.author,
  ...(cloud ? { cloud } : {}),
  body: message.body,
  tags: [...message.tags],
  createdAt: message.createdAt,
});

/** How many messages the Team panel shows. */
const TEAM_PANEL_MESSAGES = 100;

async function teamDetail(
  context: ApplicationContext,
  teamId: string,
): Promise<TeamDetailDto> {
  await context.teams.flush(teamId);
  const { team, members } = context.teams.status(teamId);
  const { messages } = context.teams.chat(teamId, USER_HANDLE, {
    all: true,
    limit: TEAM_PANEL_MESSAGES,
  });
  const cloud = context.teams.cloudMarks(team);
  return {
    team: teamDto(team),
    members: members.map((member) => ({
      handle: member.handle,
      role: member.role,
      sessionId: member.session.id,
      name: member.session.name,
      status: member.session.archivedAt ? "archived" : member.session.status,
      unread: member.unread,
      undelivered: member.undelivered,
      lastError: member.lastError,
    })),
    messages: messages.map((message) =>
      teamMessageDto(message, cloud(message.author)),
    ),
  };
}

const routinesStatusDto = (status: RoutinesStatus): RoutinesStatusDto => ({
  abilityId: status.ability.id,
  sessionId: status.ability.sessionId,
  paused: status.ability.paused,
  waiting: status.waiting.map((run) => ({
    runId: run.id,
    routine: run.routine,
    queuedAt: run.queuedAt,
  })),
  running: status.running,
  hold: status.hold ? { ...status.hold } : null,
  nextRun: status.nextRun ? { ...status.nextRun } : null,
  lastKeystrokeAt: status.lastKeystrokeAt,
  routines: status.routines,
  openReports: status.openReports,
  openUrgentReports: status.openUrgentReports,
  openReportTasks: status.openReportTasks,
});

const routineRunDto = (run: RoutineRun): RoutineRunDto => ({
  id: run.id,
  routine: run.routine,
  status: run.status,
  queuedAt: run.queuedAt,
  deliveredAt: run.deliveredAt,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  outcome: run.outcome,
  summary: run.summary,
  missedMs: run.missedMs,
});

const routineDto = (
  routine: Routine,
  lastRun: RoutineRun | null,
): RoutineDto => ({
  name: routine.name,
  prompt: routine.body,
  schedule: routine.schedule.text,
  until: routine.until,
  model: routine.model,
  timeoutMs: routine.timeoutMs,
  output: routine.output,
  enabled: routine.enabled,
  nextRunAt: routine.enabled ? routine.nextRunAt : null,
  lastRunAt: routine.lastRunAt,
  consecutiveFailures: routine.consecutiveFailures,
  lastRun: lastRun ? routineRunDto(lastRun) : null,
});

function routinesDetail(
  context: ApplicationContext,
  sessionId: string,
): RoutinesDetailDto {
  const ability = context.abilities.require(sessionId, "routines");
  const { routines, templates } = context.routines.list(ability);
  return {
    purpose: ability.config.purpose ?? null,
    routines: routines.map(({ routine, lastRun }) =>
      routineDto(routine, lastRun),
    ),
    templates: templates.map((template) => routineDto(template, null)),
    runs: context.routines.runs(ability, { limit: 100 }).map(routineRunDto),
  };
}

/**
 * The windows side of the host: which window a set of handlers serves, and
 * the two things the World window asks of the others.
 */
export interface DesktopWindowHost {
  role: DesktopWindowRole;
  openWorld(): void;
  focusSession(sessionId: string): void;
}

/** Where no host runs a connector, as in tests: phone access is off. */
const NO_REMOTE: DesktopRemoteHost = {
  state: () => ({
    enabled: false,
    keepAwake: false,
    status: "off",
    relay: "",
    macName: "",
    phones: [],
    connectedPhones: 0,
    signedIn: false,
  }),
  setEnabled: async () => {
    throw new DaedalusError(
      "DEPENDENCY",
      "Phone access is not available here.",
    );
  },
  pairingCode: async () => {
    throw new DaedalusError(
      "DEPENDENCY",
      "Phone access is not available here.",
    );
  },
  setKeepAwake: async () => {
    throw new DaedalusError(
      "DEPENDENCY",
      "Phone access is not available here.",
    );
  },
  setMacName: async () => {
    throw new DaedalusError(
      "DEPENDENCY",
      "Phone access is not available here.",
    );
  },
  removePhone: async () => NO_REMOTE.state(),
  confirmPairing: async () => NO_REMOTE.state(),
  signIn: async () => {
    throw new DaedalusError(
      "DEPENDENCY",
      "Phone access is not available here.",
    );
  },
  redeemInvite: async () => NO_REMOTE.state(),
  refreshAccount: async () => NO_REMOTE.state(),
  adminUnlock: async () => {
    throw new DaedalusError(
      "DEPENDENCY",
      "Phone access is not available here.",
    );
  },
  adminStatus: async () => ({ unlockedUntil: null }),
  adminLock: async () => undefined,
  adminKeys: async () => [],
  adminCreateKey: async () => {
    throw new DaedalusError(
      "DEPENDENCY",
      "Phone access is not available here.",
    );
  },
  adminDeleteKey: async () => undefined,
  adminRenameKey: async () => undefined,
  adminAccounts: async () => [],
  adminLog: async () => [],
  adminSetPlan: async () => undefined,
  leaveAccount: async () => NO_REMOTE.state(),
  startOver: async () => NO_REMOTE.state(),
  activity: async () => [],
};

const MAIN_WINDOW_ONLY: DesktopWindowHost = {
  role: "main",
  openWorld: () => {},
  focusSession: () => {},
};

/** A terminal copy past this is a runaway program, not a selection. */
const MAX_CLIPBOARD_TEXT = 1024 * 1024;

/**
 * What the host lends a set of handlers. Every part is optional: where no host
 * runs one, as in tests and for the phone, the handlers fall back to doing
 * nothing or refusing.
 */
export interface DesktopHost {
  /** Told after every mutation that succeeded, so the windows reload. */
  onMutation(): void;
  openExternal(url: string): boolean;
  /** Opens a file in its default app. */
  openPath(path: string): boolean;
  /** Selects a file in a Finder window. */
  revealPath(path: string): void;
  terminalEndpoint: string;
  quit: DesktopQuitHost;
  updates: DesktopUpdateHost;
  windows: DesktopWindowHost;
  clipboardWrite(text: string): boolean;
  remote: DesktopRemoteHost;
}

/** Files macOS runs, rather than shows, when they are opened. */
const RUNNABLE_EXTENSIONS = new Set([
  ".app",
  ".command",
  ".tool",
  ".terminal",
  ".workflow",
  ".pkg",
  ".mpkg",
  ".scpt",
  ".applescript",
  ".jar",
  ".fileloc",
  ".webloc",
  ".inetloc",
]);

export function createDesktopRequestHandlers(
  context: ApplicationContext,
  host: Partial<DesktopHost> = {},
): DesktopRequestHandlers {
  const {
    onMutation = () => {},
    openExternal = () => false,
    openPath = () => false,
    revealPath = () => {},
    terminalEndpoint = "",
    quit = { dialogShown: () => {}, decide: async () => {} },
    updates = NO_UPDATES,
    windows = MAIN_WINDOW_ONLY,
    clipboardWrite = () => false,
    remote = NO_REMOTE,
  } = host;
  const readModel = new ReadModel(context);
  const mutate = async <T>(operation: () => T | Promise<T>) => {
    const response = await result(operation);
    if (response.ok) onMutation();
    return response;
  };

  return {
    snapshot: () =>
      result(async () => ({
        ...(await desktopSnapshot(readModel)),
        cloudSignIns: context.cloud.signIns.list(),
        sessionMoves: context.moves.list(),
        cloudPreparing: context.cloud.preparing(),
      })),
    sessionUpdate: ({ sessionId, name, pinned, color, autoRebirthPercent }) =>
      mutate(async () => {
        if (name !== undefined) await context.agents.rename(sessionId, name);
        if (pinned !== undefined)
          await context.agents.setPinned(sessionId, pinned);
        if (color !== undefined)
          await context.agents.setColor(sessionId, color);
        if (autoRebirthPercent !== undefined)
          await context.agents.setAutoRebirth(sessionId, autoRebirthPercent);
        return agentDto(await context.agents.get(sessionId));
      }),
    sessionAbility: ({ sessionId, ability, granted }) =>
      mutate(() =>
        sessionAbilityDto(
          granted
            ? context.abilities.grant(sessionId, ability, { live: true })
            : context.abilities.revoke(sessionId, ability),
        ),
      ),
    routinesDetail: ({ sessionId }) =>
      result(() => routinesDetail(context, sessionId)),
    teamDetail: ({ teamId }) => result(() => teamDetail(context, teamId)),
    teamSay: ({ teamId, body }) =>
      mutate(async () => {
        const said = await context.teams.say({
          team: teamId,
          author: USER_HANDLE,
          body,
        });
        return {
          // The user's own post, never a cloud session's.
          message: teamMessageDto(said.message, undefined),
          warnings: said.warnings,
        };
      }),
    teamGoal: ({ teamId, goal }) =>
      mutate(() => teamDto(context.teams.setGoal(teamId, goal))),
    routinesControl: ({ sessionId, action }) =>
      mutate(() =>
        sessionAbilityDto(
          context.abilities.setPaused(
            sessionId,
            "routines",
            action === "pause",
          ),
        ),
      ),
    routinesPurpose: ({ sessionId, purpose }) =>
      mutate(() =>
        sessionAbilityDto(
          context.abilities.configure(
            sessionId,
            "routines",
            "purpose",
            purpose,
          ),
        ),
      ),
    routineSetEnabled: ({ sessionId, name, enabled }) =>
      mutate(() => {
        const routine = context.routines.setEnabled(
          context.abilities.require(sessionId, "routines"),
          name,
          enabled,
        );
        return { name: routine.name, enabled: routine.enabled };
      }),
    routineRunNow: ({ sessionId, name }) =>
      mutate(() => {
        const run = context.routineDelivery.runNow(
          context.abilities.require(sessionId, "routines"),
          name,
        );
        return {
          ...routineRunDto(run),
          ...(run.alreadyQueued ? { alreadyQueued: true } : {}),
        };
      }),
    routineReportVerdict: ({ id, verdict }) =>
      mutate(() => {
        const report = context.repositories.routines.findReport(id);
        const ability = report
          ? context.repositories.abilities.find(report.abilityId)
          : undefined;
        if (!ability)
          throw new DaedalusError("NOT_FOUND", `Report '${id}' was not found`);
        return { ...context.routineReports.verdict(ability, id, verdict) };
      }),
    windowRole: () => result(() => ({ role: windows.role })),
    worldWindowOpen: () =>
      result(() => {
        windows.openWorld();
        return { opened: true };
      }),
    sessionFocus: ({ sessionId }) =>
      result(() => {
        windows.focusSession(sessionId);
        return { focused: true };
      }),
    terminalEndpoint: () => result(() => ({ endpoint: terminalEndpoint })),
    openExternal: ({ url }) =>
      result(() => {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
          throw new DaedalusError(
            "VALIDATION",
            "Only HTTP and HTTPS links can be opened",
          );
        return { opened: openExternal(parsed.href) };
      }),
    openPath: ({ path }) =>
      result(async () => {
        if (!isAbsolute(path))
          throw new DaedalusError("VALIDATION", "The path must be absolute");
        const info = await stat(path).catch(() => undefined);
        if (!info?.isFile())
          throw new DaedalusError("NOT_FOUND", `No file at ${path}`);
        // Opening a program runs it, and a path in a terminal is whatever an
        // agent or a command printed. Those are shown in Finder instead.
        if (
          info.mode & 0o111 ||
          RUNNABLE_EXTENSIONS.has(extname(path).toLowerCase())
        ) {
          revealPath(path);
          return { opened: true };
        }
        return { opened: openPath(path) };
      }),
    clipboardFilesRead: () =>
      result(async () => ({ paths: await readPasteboardFiles() })),
    clipboardFilesWrite: ({ paths }) =>
      result(async () => {
        if (paths.some((path) => !isAbsolute(path)))
          throw new DaedalusError(
            "VALIDATION",
            "Pasteboard paths must be absolute",
          );
        await writePasteboardFiles(paths);
        return { written: paths.length };
      }),
    clipboardWrite: ({ text }) =>
      result(() => {
        if (text.length > MAX_CLIPBOARD_TEXT)
          throw new DaedalusError("VALIDATION", "That copy is too large");
        return { written: clipboardWrite(text) };
      }),
    workspaceCreate: (params) =>
      mutate(async () => workspaceDto(await context.workspaces.create(params))),
    workspaceGet: (params) =>
      result(async () =>
        workspaceDto(await context.workspaces.get(params.reference)),
      ),
    workspaceUpdate: ({ reference, ...changes }) =>
      mutate(async () =>
        workspaceDto(await context.workspaces.update(reference, changes)),
      ),
    workspaceRemove: ({ reference, deleteFiles, force }) =>
      mutate(async () => {
        const removed = await context.archive.removeWorkspace(reference, {
          deleteFiles,
          force,
        });
        return {
          workspace: workspaceDto(removed.workspace),
          filesDeleted: removed.filesDeleted,
        };
      }),
    workspaceReorder: ({ references }) =>
      mutate(async () =>
        (await context.workspaces.reorder(references)).map((workspace) =>
          workspaceDto(workspace),
        ),
      ),
    workspaceArchive: ({ reference, approved, withoutCloudChanges }) =>
      mutate(async () => {
        const archived = await context.archive.archiveWorkspace({
          reference,
          ...(approved ? { approved } : {}),
          ...(withoutCloudChanges ? { withoutCloudChanges } : {}),
        });
        return archived.status === "archived"
          ? {
              status: "archived" as const,
              workspace: workspaceDto(archived.workspace),
            }
          : archived;
      }),
    workspaceRestore: ({ reference }) =>
      mutate(async () =>
        workspaceDto(await context.workspaces.restore(reference)),
      ),
    workspaceDelete: ({ reference }) =>
      mutate(async () =>
        workspaceDto(await context.archive.deleteWorkspace(reference)),
      ),
    workspaceContentGet: ({ workspace }) =>
      result(async () =>
        workspaceContentDto(await context.workspaceContent.get(workspace)),
      ),
    workspaceDirectoryList: ({ workspace, path }) =>
      result(async () =>
        (await context.workspaceContent.listDirectory(workspace, path)).map(
          (item) => ({ ...item }),
        ),
      ),
    workspaceFileRead: ({ workspace, path }) =>
      result(async () => ({
        ...(await context.workspaceContent.readFile(workspace, path)),
      })),
    workspaceImageRead: ({ workspace, path }) =>
      result(async () => ({
        ...(await context.workspaceContent.readImage(workspace, path)),
      })),
    workspaceFileWrite: (params) =>
      mutate(async () => ({
        ...(await context.workspaceContent.writeFile(params)),
      })),
    workspaceFileImport: (params) =>
      mutate(async () => ({
        ...(await context.workspaceContent.importFile(params)),
      })),
    workspaceEntryCreate: (params) =>
      mutate(async () => ({
        ...(await context.workspaceContent.createEntry(params)),
      })),
    workspaceEntryRename: (params) =>
      mutate(async () => ({
        ...(await context.workspaceContent.renameEntry(params)),
      })),
    workspaceEntryMove: (params) =>
      mutate(async () => ({
        ...(await context.workspaceContent.moveEntry(params)),
      })),
    workspaceEntryRemove: (params) =>
      mutate(async () => ({
        ...(await context.workspaceContent.removeEntry(params)),
      })),
    workspaceEntryRestore: (params) =>
      mutate(async () => ({
        ...(await context.workspaceContent.restoreEntry(params)),
      })),
    workspaceChanges: ({ workspace }) =>
      result(async () =>
        (await context.workspaceContent.worktreeChanges(workspace)).map(
          (tree) => ({
            ...tree,
            files: tree.files.map((file) => ({ ...file })),
          }),
        ),
      ),
    workspaceChangeOriginal: (params) =>
      result(() => context.workspaceContent.changeOriginal(params)),
    workspaceCommits: (params) =>
      result(async () =>
        (await context.workspaceContent.worktreeCommits(params)).map(
          (commit) => ({ ...commit }),
        ),
      ),
    workspaceCommitFiles: (params) =>
      result(async () =>
        (await context.workspaceContent.commitFiles(params)).map((file) => ({
          ...file,
        })),
      ),
    fileLinkResolve: (params) =>
      result(async () => {
        const target = await context.workspaceContent.resolveFileLink(params);
        return target ? { ...target } : null;
      }),
    workspaceEntriesCopy: (params) =>
      mutate(async () =>
        (await context.workspaceContent.copyEntries(params)).map((entry) => ({
          ...entry,
        })),
      ),
    // Deliberately not a `mutate`: nothing about the snapshot changes, and
    // announcing would make every view switch redraw the whole window.
    workspaceWatchSet: ({ workspaces }) =>
      result(async () => ({
        watching: await context.workspaceWatch.watchOnly(workspaces),
      })),
    workspaceInstructionFilesSet: ({ enabled }) =>
      mutate(async () => {
        await context.workspaceContent.setInstructionFilesEnabled(enabled);
        return { enabled };
      }),
    cloudState: () =>
      result(async () => cloudStateDto(await context.cloud.overview())),
    cloudSignIn: ({ gatewayUrl, email }) =>
      mutate(async () => {
        await context.cloud.signIn(gatewayUrl.trim(), email.trim());
        return cloudStateDto(await context.cloud.overview());
      }),
    cloudMcpServers: () =>
      result(async () => mcpDto(await cloudMcpChoices(context.config))),
    cloudMcpServerSet: ({ name, on }) =>
      mutate(async () => {
        await setCloudMcpServer(context.config, name, on === true);
        return mcpDto(await cloudMcpChoices(context.config));
      }),
    cloudSignOut: () =>
      mutate(async () => {
        await context.cloud.logout();
        return cloudStateDto(await context.cloud.overview());
      }),
    cloudWorkspaceCreate: ({ workspace }) =>
      mutate(async () => {
        await context.cloud.create(workspace);
        return cloudStateDto(await context.cloud.overview());
      }),
    cloudWorkspaceSleep: ({ workspace }) =>
      mutate(async () => {
        await context.cloud.sleep(await context.cloud.linkedCloudId(workspace));
        return cloudStateDto(await context.cloud.overview());
      }),
    cloudWorkspaceWake: ({ workspace }) =>
      mutate(async () => {
        await context.cloudSessions.wakeWorkspace(workspace);
        return cloudStateDto(await context.cloud.overview());
      }),
    cloudWorkspaceDelete: ({ workspace, force }) =>
      mutate(async () => {
        if (force !== true)
          throw new DaedalusError(
            "VALIDATION",
            "Deleting a cloud workspace removes its pod and its volume; confirm it",
          );
        await context.cloud.delete(
          await context.cloud.linkedCloudId(workspace),
        );
        return cloudStateDto(await context.cloud.overview());
      }),
    cloudSessionWake: ({ sessionId }) =>
      mutate(async () => agentDto(await context.cloudSessions.wake(sessionId))),
    agentMove: ({ sessionId, to, approved }) =>
      mutate(async () => {
        const moved = await context.moves.move({
          sessionId,
          to,
          ...(approved ? { approved } : {}),
        });
        return moved.status === "moved"
          ? {
              status: "moved" as const,
              session: agentDto(moved.session),
              ...(moved.notice ? { notice: moved.notice } : {}),
            }
          : moved;
      }),
    agentMoveCancel: ({ sessionId }) =>
      result(() => {
        context.moves.cancel(sessionId);
        return null;
      }),
    agentMoveDismiss: ({ sessionId }) =>
      result(() => {
        context.moves.dismiss(sessionId);
        return null;
      }),
    cloudSignInOpen: ({ requestId }) =>
      result(async () => {
        const page = await context.cloud.openSignIn(requestId);
        if (!openExternal(page.url))
          throw new DaedalusError(
            "DEPENDENCY",
            "The browser did not open; ask for the sign-in page again in the session",
          );
        return { host: page.host, paste: page.paste };
      }),
    cloudSignInDismiss: ({ requestId, sessionId }) =>
      result(() => {
        context.cloud.signIns.dismiss({
          ...(requestId ? { requestId } : {}),
          ...(sessionId ? { sessionId } : {}),
        });
        return null;
      }),
    remoteGet: () => result(() => remote.state()),
    remoteSetEnabled: ({ enabled }) => mutate(() => remote.setEnabled(enabled)),
    remoteSetKeepAwake: ({ enabled }) =>
      mutate(() => remote.setKeepAwake(enabled)),
    remoteSetMacName: ({ name }) => mutate(() => remote.setMacName(name)),
    remotePairingCode: () => result(() => remote.pairingCode()),
    remotePhoneRemove: ({ id }) => mutate(() => remote.removePhone(id)),
    remoteConfirmPairing: ({ allow }) =>
      mutate(() => remote.confirmPairing(allow)),
    remoteSignIn: () => result(() => remote.signIn()),
    remoteRedeemInvite: ({ code }) => mutate(() => remote.redeemInvite(code)),
    remoteRefreshAccount: () => mutate(() => remote.refreshAccount()),
    remoteAdminUnlock: () => result(() => remote.adminUnlock()),
    remoteAdminStatus: () => result(() => remote.adminStatus()),
    remoteAdminLock: () =>
      result(async () => {
        await remote.adminLock();
        return null;
      }),
    remoteAdminKeys: () => result(() => remote.adminKeys()),
    remoteAdminCreateKey: (input) => result(() => remote.adminCreateKey(input)),
    remoteAdminDeleteKey: ({ code }) =>
      result(async () => {
        await remote.adminDeleteKey(code);
        return null;
      }),
    remoteAdminRenameKey: ({ code, name }) =>
      result(async () => {
        await remote.adminRenameKey(code, name);
        return null;
      }),
    remoteAdminAccounts: () => result(() => remote.adminAccounts()),
    remoteAdminLog: () => result(() => remote.adminLog()),
    remoteAdminSetPlan: (input) =>
      result(async () => {
        await remote.adminSetPlan(input);
        return null;
      }),
    remoteLeaveAccount: () => mutate(() => remote.leaveAccount()),
    remoteStartOver: () => mutate(() => remote.startOver()),
    remoteActivity: () => result(() => remote.activity()),
    autoRestoreSessionsSet: ({ enabled }) =>
      mutate(async () => {
        await updateSettings(context.config, () => ({
          autoRestoreSessionsEnabled: enabled,
        }));
        return { enabled };
      }),
    trustSessionFoldersSet: ({ enabled }) =>
      mutate(async () => {
        await updateSettings(context.config, () => ({
          trustSessionFoldersEnabled: enabled,
        }));
        return { enabled };
      }),
    autoRebirthSet: ({ percent }) =>
      mutate(async () => {
        if (percent !== null) autoRebirthPercent(percent);
        await updateSettings(context.config, () => ({
          autoRebirthPercent: percent,
        }));
        return { percent };
      }),
    focusModeSet: ({ enabled }) =>
      mutate(async () => ({
        enabled: await context.presence.setFocusMode(enabled),
      })),
    // Reading is a plain result. Everything that writes goes through `mutate`,
    // because a skill toggle changes what every future session sees and the
    // rest of the app should redraw around it.
    skillList: () => result(() => context.skills.list()),
    skillSet: ({ id, enabled, mode }) =>
      mutate(() => context.skills.setEnabled(id, enabled, mode)),
    skillVisibilitySet: ({ name, visibility }) =>
      mutate(() => context.skills.setVisibility(name, visibility)),
    skillRemove: ({ name }) =>
      mutate(() => context.skills.removeInstalled(name)),
    skillRead: ({ path }) => result(() => context.skills.readSkill(path)),
    skillDoctor: () =>
      result(async () => ({ findings: await context.skills.doctor() })),
    // Neither of these is a data change, and the second one is usually the
    // last thing this process does.
    quitDialogShown: () =>
      result(() => {
        quit.dialogShown();
        return { acknowledged: true as const };
      }),
    quitDecision: ({ choice }) =>
      result(async () => {
        await quit.decide(choice);
        return { accepted: true as const };
      }),
    appUpdateGet: () => result(() => updates.current()),
    appUpdateCheck: () => result(() => updates.check()),
    appUpdateInstall: () => result(() => updates.install()),
    appUpdateDismiss: ({ version }) => result(() => updates.dismiss(version)),
    // Presence is a heartbeat, not a data change: announcing it would make the
    // window refresh itself every time the user moved.
    presencePublish: (report) =>
      result(async () =>
        presenceDto(
          await context.presence.publish(report),
          context.config.focusMode,
        ),
      ),
    attentionRaise: ({ sessionId, reason }) =>
      mutate(async () => {
        const outcome = await context.activity.raise({ sessionId, reason });
        return outcome.attention
          ? sessionAttentionDto(outcome.attention)
          : null;
      }),
    attentionClear: ({ sessionId }) =>
      mutate(() => context.activity.clear(sessionId)),
    toastsAcknowledge: ({ ids }) =>
      mutate(() => {
        context.notifications.acknowledge(ids);
        return { acknowledged: ids.length };
      }),
    workspaceRepositoryAttach: (params) =>
      mutate(async () =>
        workspaceRepositoryDto(
          await context.workspaceContent.attachRepository(params),
        ),
      ),
    workspaceRepositoryFetch: ({ id }) =>
      mutate(async () =>
        workspaceRepositoryDto(
          await context.workspaceContent.fetchRepository(id),
        ),
      ),
    workspaceRepositoriesFetch: (params) =>
      mutate(() => context.workspaceContent.fetchRepositories(params)),
    sessionWorktreeRemove: (params) =>
      mutate(async () => ({
        ...(await context.workspaceContent.removeSessionWorktree(params)),
      })),
    // Opening a folder changes nothing Daedalus stores, so it announces
    // nothing either.
    sessionWorktreeOpen: (params) =>
      result(() => context.workspaceContent.openSessionWorktree(params)),
    sessionWorktreePush: (params) =>
      mutate(async () => {
        const pushed =
          await context.workspaceContent.pushSessionWorktree(params);
        return {
          worktree: { ...pushed.worktree },
          alreadyUpToDate: pushed.alreadyUpToDate,
        };
      }),
    repositoryAddAndAttachStart: (params) =>
      mutate(async () =>
        workspaceRepositoryDto(
          await context.workspaceContent.beginAddAndAttachRepository(params),
        ),
      ),
    repositoryAddAndAttach: (params) =>
      mutate(async () =>
        workspaceRepositoryDto(
          await context.workspaceContent.addAndAttachRepository(params),
        ),
      ),
    workspaceRepositorySync: ({ id }) =>
      mutate(async () =>
        workspaceRepositoryDto(
          await context.workspaceContent.syncRepository(id),
        ),
      ),
    repositoryLibraryAdd: (params) =>
      mutate(async () =>
        repositoryLibraryDto(
          await context.workspaceContent.addRepositoryToLibrary(params),
        ),
      ),
    repositoryDiscovery: () =>
      result(() => context.workspaceContent.discoverGitHubRepositories()),
    workspaceRepositoryDetach: ({ id }) =>
      mutate(async () =>
        workspaceRepositoryDto(
          await context.workspaceContent.detachRepository(id),
        ),
      ),
    workspaceJournalAppend: (params) =>
      mutate(async () => {
        await context.workspaceContent.appendJournal(params);
        return workspaceContentDto(
          await context.workspaceContent.get(params.workspace),
        );
      }),
    taskCreate: (params) =>
      mutate(async () => taskDto(await context.tasks.create(params))),
    taskGet: ({ id }) => result(() => taskDto(context.tasks.get(id))),
    taskUpdate: ({ id, ...changes }) =>
      mutate(() => taskDto(context.tasks.update(id, changes))),
    taskSetStatus: ({ id, status }) =>
      mutate(() => taskDto(context.tasks.setStatus(id, status))),
    taskTimeline: ({ id }) =>
      result(async () => {
        const report = await context.taskHistory.report(id);
        return {
          taskId: id,
          events: report.events.map((event) => ({ ...event })),
          cost: { ...report.cost, models: [...report.cost.models] },
        };
      }),
    taskRemove: ({ id, force }) =>
      mutate(async () => taskDto(await context.tasks.remove(id, force))),
    agentGet: ({ id }) =>
      result(async () => agentDto(await context.agents.get(id))),
    agentModels: ({ provider, account }) =>
      result(() => context.agents.models(provider, account)),
    accountStatus: (filter) =>
      result(async () =>
        (await context.accounts.status(filter)).map((status) => ({
          ...status,
          ...(status.state === "missing"
            ? {
                install: INSTALL_COMMANDS[status.provider].map((item) => ({
                  ...item,
                })),
              }
            : {}),
        })),
      ),
    accountAdd: ({ provider, name, kind, login, aws }) =>
      mutate(async () =>
        accountDto(
          context,
          await context.accounts.add(provider, name, kind, login, aws),
        ),
      ),
    accountSetAws: ({ provider, account, aws }) =>
      mutate(async () =>
        accountDto(
          context,
          await context.accounts.setAws(provider, account, aws),
        ),
      ),
    accountSetLogin: ({ provider, account, login }) =>
      mutate(() => context.accounts.setLogin(provider, account, login)),
    secretList: ({ workspaceId }) =>
      result(async () =>
        (await context.secrets.visible(workspaceId)).map(secretDto),
      ),
    secretSet: ({ workspaceId, name, value }) =>
      mutate(async () =>
        secretDto({
          ...(await context.secrets.set(workspaceId, name, value)),
          overridden: false,
        }),
      ),
    secretRemove: ({ workspaceId, name }) =>
      mutate(async () => {
        await context.secrets.remove(workspaceId, name);
        return { name };
      }),
    secretReveal: ({ workspaceId, name }) =>
      result(async () => ({
        value: await context.secrets.reveal(workspaceId, name),
      })),
    accountSetApiKey: ({ provider, account, key }) =>
      mutate(async () =>
        accountDto(
          context,
          await context.accounts.setApiKey(provider, account, key),
        ),
      ),
    accountRename: ({ provider, account, name }) =>
      mutate(async () =>
        accountDto(
          context,
          await context.accounts.rename(provider, account, name),
        ),
      ),
    accountRemove: ({ provider, account, archiveSessions }) =>
      mutate(async () =>
        accountDto(
          context,
          await context.accounts.remove(provider, account, { archiveSessions }),
        ),
      ),
    accountSignIn: ({ provider, account, variant }) =>
      mutate(async () =>
        integratedTerminalDto(
          await context.accounts.openSignIn(
            context.terminals,
            provider,
            account,
            variant,
          ),
        ),
      ),
    accountSignOut: ({ provider, account }) =>
      mutate(() => context.accounts.signOut(provider, account)),
    agentSpawn: ({ teamId, cloud, ...params }) =>
      mutate(async () => {
        // The first cloud session makes the workspace's cloud copy; a
        // sleeping one is woken. The window shows how far it got.
        const host = cloud
          ? await context.cloud.prepareForSession(
              teamId
                ? context.teams.get(teamId).lead.workspaceId
                : params.workspace,
            )
          : undefined;
        return agentDto(
          teamId
            ? (
                await context.teams.spawnMember({
                  team: teamId,
                  addedBy: "user",
                  ...(host ? { host } : {}),
                  instructions: params.message ?? "",
                  ...(params.name ? { name: params.name } : {}),
                  ...(params.taskId ? { taskId: params.taskId } : {}),
                  ...(params.provider ? { provider: params.provider } : {}),
                  ...(params.model ? { model: params.model } : {}),
                  ...(params.account !== undefined
                    ? { account: params.account }
                    : {}),
                })
              ).session
            : await context.agents.spawn({
                ...params,
                ...(host ? { host } : {}),
              }),
        );
      }),
    agentSend: ({ id, text }) =>
      mutate(async () => agentDto(await context.agents.send(id, text))),
    agentStop: ({ id, force }) =>
      mutate(async () => agentDto(await context.agents.stop(id, force))),
    agentRemove: ({ id }) =>
      mutate(async () => agentDto(await context.agents.remove(id))),
    agentDelete: ({ id }) =>
      mutate(async () => agentDto(await context.agents.deletePermanently(id))),
    agentReorder: ({ workspace, sessionIds }) =>
      mutate(async () =>
        (await context.agents.reorder(workspace, sessionIds)).map(agentDto),
      ),
    agentArchive: ({ id, force, approved, withoutCloudChanges }) =>
      mutate(async () => {
        const archived = await context.archive.archiveSession({
          sessionId: id,
          ...(force !== undefined ? { force } : {}),
          ...(approved ? { approved } : {}),
          ...(withoutCloudChanges ? { withoutCloudChanges } : {}),
        });
        return archived.status === "archived"
          ? { status: "archived" as const, session: agentDto(archived.session) }
          : archived;
      }),
    agentRestore: ({ id }) =>
      mutate(async () => agentDto(await context.agents.restore(id))),
    agentRevive: ({ id }) =>
      mutate(async () => agentDto(await context.agents.reviveLost(id))),
    agentRequestRebirth: ({ id }) =>
      mutate(async () => agentDto(await context.agents.requestRebirth(id))),
    agentContinue: ({ id }) =>
      mutate(async () =>
        agentDto((await context.agents.continueSession({ id })).session),
      ),
    terminalCreate: (params) =>
      mutate(async () =>
        integratedTerminalDto(await context.terminals.create(params)),
      ),
    terminalClose: ({ id }) =>
      mutate(async () =>
        integratedTerminalDto(await context.terminals.close(id)),
      ),
  };
}

function secretDto(secret: VisibleSecret): SecretDto {
  return {
    name: secret.name,
    workspaceId: secret.workspaceId,
    overridden: secret.overridden,
    updatedAt: secret.updatedAt,
  };
}

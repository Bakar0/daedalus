import { isAbsolute } from "node:path";
import packageJson from "../../../../package.json";
import { readPasteboardFiles, writePasteboardFiles } from "@daedalus/platform";
import {
  accountDirectory,
  channelName,
  DaedalusError,
  INSTALL_COMMANDS,
  normalizeError,
  saveAutoRestoreSessionsEnabled,
  saveTrustSessionFoldersEnabled,
  type AccountProfile,
  type AgentActivityState,
  type AgentSession,
  type ApplicationContext,
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
  ...(profile.provider === "claude" && profile.kind !== "api-key"
    ? { login: profile.login ?? "subscription" }
    : {}),
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

export async function desktopSnapshot(
  context: ApplicationContext,
): Promise<DesktopSnapshotDto> {
  const [workspaces, tasks, agents, terminals, capabilities, telemetry] =
    await Promise.all([
      context.workspaces.listWithHealth(),
      context.tasks.list({}),
      context.agents.list({ includeArchived: true }),
      context.terminals.list(),
      context.agents.capabilities(),
      context.telemetry.read(),
    ]);
  const references = context.tasks.references(tasks);
  return {
    workspaces: workspaces.map(({ workspace, available }) =>
      workspaceDto(workspace, available),
    ),
    tasks: tasks.map((task) => ({
      ...taskDto(task),
      references: (references.get(task.id) ?? []).map((item) => ({
        ...item,
      })),
    })),
    agents: agents.map(agentDto),
    terminals: terminals.map(integratedTerminalDto),
    repositories: context.workspaceContent
      .listRepositoryLibrary()
      .map(repositoryLibraryDto),
    ...telemetry,
    sessionActivity: context.activity.list().map(agentActivityDto),
    worktrees: context.workspaceContent
      .listWorktrees()
      .map((worktree) => ({ ...worktree })),
    shipped: context.workspaceContent
      .listShippedPullRequests()
      .map((item) => ({ ...item })),
    attention: context.activity.listAttention().map(sessionAttentionDto),
    toasts: context.notifications.pending("toast").map(toastDto),
    abilities: context.repositories.abilities.list().map(sessionAbilityDto),
    teams: context.teams.list().map(teamDto),
    routines: context.abilities
      .holders("routines")
      .map((ability) =>
        routinesStatusDto(context.routineDelivery.status(ability)),
      ),
    routineReports: context.repositories.routines
      .listReportsWithTasks()
      .map((report) => ({ ...report })),
    settings: {
      version: packageJson.version,
      channel: channelName(context.config.home),
      home: context.config.home,
      workspaceRoot: context.config.workspaceRoot,
      databasePath: context.config.databasePath,
      repositoryRoot: context.config.repositoryRoot,
      workspaceInstructionFilesEnabled:
        context.config.workspaceInstructionFilesEnabled,
      autoRestoreSessionsEnabled: context.config.autoRestoreSessionsEnabled,
      trustSessionFoldersEnabled: context.config.trustSessionFoldersEnabled,
      focusMode: context.config.focusMode,
      ...capabilities,
      accounts: context.accounts.list().map((item) => ({ ...item })),
    },
  };
}

export function desktopDataFingerprint(context: ApplicationContext): string {
  return JSON.stringify({
    workspaces: context.repositories.listWorkspaces(),
    tasks: context.repositories.listTasks({}),
    agents: context.repositories.listAgents(),
    terminals: context.repositories.listIntegratedTerminals(),
    workspaceRepositories: context.repositories.listWorkspaceRepositories(),
    sessionWorktrees: context.repositories.listSessionWorktrees(),
    repositoryLibrary: context.repositories.listRepositoryLibrary(),
    // Activity and attention are the point of the indicators: a session that
    // starts waiting on the user has to reach the window on the next tick,
    // exactly like a session that starts or stops.
    activity: context.repositories.listAgentActivity(),
    attention: context.repositories.listSessionAttention(),
    notifications: context.repositories.listPendingNotifications(),
    // A run starting or ending, or a hold changing, changes what the
    // session's bar says, so it reloads too.
    abilities: context.repositories.abilities.list().map((ability) => ({
      ability,
      ...(ability.enabled && ability.ability === "routines"
        ? {
            status: fingerprintStatus(context.routineDelivery.status(ability)),
            routines: context.repositories.routines.list(ability.id),
            reports: context.repositories.routines.listReports(ability.id, {
              states: ["open", "resolved"],
            }),
          }
        : {}),
    })),
  });
}

/**
 * A routines status as the fingerprint sees it. Every keystroke moves the
 * quiet time, so the times are rounded to ten seconds: a reload per tick
 * while the user types would resend the whole snapshot for nothing.
 */
const fingerprintStatus = (status: RoutinesStatus) => ({
  ...status,
  lastKeystrokeAt: null,
  hold: status.hold
    ? {
        ...status.hold,
        until: status.hold.until
          ? Math.floor(Date.parse(status.hold.until) / 10_000)
          : undefined,
      }
    : null,
});

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

const teamMessageDto = (message: TeamMessage): TeamMessageDto => ({
  id: message.id,
  author: message.author,
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
    messages: messages.map(teamMessageDto),
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
    status: "off",
    relay: "",
    macName: "",
    phones: [],
  }),
  setEnabled: async () => {
    throw new DaedalusError(
      "DEPENDENCY",
      "Phone access is not available here.",
    );
  },
  pairingCode: () => {
    throw new DaedalusError(
      "DEPENDENCY",
      "Phone access is not available here.",
    );
  },
  removePhone: async () => NO_REMOTE.state(),
};

const MAIN_WINDOW_ONLY: DesktopWindowHost = {
  role: "main",
  openWorld: () => {},
  focusSession: () => {},
};

/** A terminal copy past this is a runaway program, not a selection. */
const MAX_CLIPBOARD_TEXT = 1024 * 1024;

export function createDesktopRequestHandlers(
  context: ApplicationContext,
  onMutation: () => void = () => {},
  openExternal: (url: string) => boolean = () => false,
  terminalEndpoint = "",
  quit: DesktopQuitHost = { dialogShown: () => {}, decide: async () => {} },
  updates: DesktopUpdateHost = NO_UPDATES,
  windows: DesktopWindowHost = MAIN_WINDOW_ONLY,
  clipboardWrite: (text: string) => boolean = () => false,
  remote: DesktopRemoteHost = NO_REMOTE,
): DesktopRequestHandlers {
  const mutate = async <T>(operation: () => T | Promise<T>) => {
    const response = await result(operation);
    if (response.ok) onMutation();
    return response;
  };

  return {
    snapshot: () => result(() => desktopSnapshot(context)),
    sessionUpdate: ({ sessionId, name, pinned, color }) =>
      mutate(async () => {
        if (name !== undefined) await context.agents.rename(sessionId, name);
        if (pinned !== undefined)
          await context.agents.setPinned(sessionId, pinned);
        if (color !== undefined)
          await context.agents.setColor(sessionId, color);
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
          message: teamMessageDto(said.message),
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
        const removed = await context.workspaces.remove(reference, {
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
    workspaceArchive: ({ reference }) =>
      mutate(async () =>
        workspaceDto(await context.workspaces.archive(reference)),
      ),
    workspaceRestore: ({ reference }) =>
      mutate(async () =>
        workspaceDto(await context.workspaces.restore(reference)),
      ),
    workspaceDelete: ({ reference }) =>
      mutate(async () =>
        workspaceDto(await context.workspaces.deletePermanently(reference)),
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
    workspaceFileWrite: (params) =>
      mutate(async () => ({
        ...(await context.workspaceContent.writeFile(params)),
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
    remoteGet: () => result(() => remote.state()),
    remoteSetEnabled: ({ enabled }) => mutate(() => remote.setEnabled(enabled)),
    remotePairingCode: () => result(() => remote.pairingCode()),
    remotePhoneRemove: ({ id }) => mutate(() => remote.removePhone(id)),
    autoRestoreSessionsSet: ({ enabled }) =>
      mutate(async () => {
        await saveAutoRestoreSessionsEnabled(context.config, enabled);
        return { enabled };
      }),
    trustSessionFoldersSet: ({ enabled }) =>
      mutate(async () => {
        await saveTrustSessionFoldersEnabled(context.config, enabled);
        return { enabled };
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
    accountAdd: ({ provider, name, kind, login }) =>
      mutate(async () =>
        accountDto(
          context,
          await context.accounts.add(provider, name, kind, login),
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
    agentSpawn: ({ teamId, ...params }) =>
      mutate(async () =>
        agentDto(
          teamId
            ? (
                await context.teams.spawnMember({
                  team: teamId,
                  addedBy: "user",
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
            : await context.agents.spawn(params),
        ),
      ),
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
    agentArchive: ({ id, force }) =>
      mutate(async () => agentDto(await context.agents.archive(id, force))),
    agentRestore: ({ id }) =>
      mutate(async () => agentDto(await context.agents.restore(id))),
    agentRevive: ({ id }) =>
      mutate(async () => agentDto(await context.agents.reviveLost(id))),
    agentRequestHandoff: ({ id }) =>
      mutate(async () => agentDto(await context.agents.requestHandoff(id))),
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

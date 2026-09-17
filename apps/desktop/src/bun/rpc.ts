import packageJson from "../../../../package.json";
import {
  channelName,
  DaedalusError,
  normalizeError,
  type AgentActivityState,
  type AgentSession,
  type ApplicationContext,
  type IntegratedTerminal,
  type PendingNotification,
  type PresenceState,
  type RepositoryLibraryEntry,
  type SessionAttention,
  type Task,
  type Workspace,
  type WorkspaceContent,
  type WorkspaceRepository,
} from "@daedalus/core";
import type {
  AgentActivityDto,
  AgentSessionDto,
  DesktopRpcSchema,
  DesktopSnapshotDto,
  IntegratedTerminalDto,
  PresenceStateDto,
  RepositoryLibraryDto,
  RpcResult,
  SessionAttentionDto,
  TaskDto,
  ToastDto,
  WorkspaceContentDto,
  WorkspaceDto,
  WorkspaceRepositoryDto,
} from "@daedalus/protocol";

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
  return {
    workspaces: workspaces.map(({ workspace, available }) =>
      workspaceDto(workspace, available),
    ),
    tasks: tasks.map(taskDto),
    agents: agents.map(agentDto),
    terminals: terminals.map(integratedTerminalDto),
    repositories: context.workspaceContent
      .listRepositoryLibrary()
      .map(repositoryLibraryDto),
    ...telemetry,
    sessionActivity: context.activity.list().map(agentActivityDto),
    attention: context.activity.listAttention().map(sessionAttentionDto),
    toasts: context.notifications.pending("toast").map(toastDto),
    settings: {
      version: packageJson.version,
      channel: channelName(context.config.home),
      home: context.config.home,
      workspaceRoot: context.config.workspaceRoot,
      databasePath: context.config.databasePath,
      repositoryRoot: context.config.repositoryRoot,
      workspaceInstructionFilesEnabled:
        context.config.workspaceInstructionFilesEnabled,
      focusMode: context.config.focusMode,
      ...capabilities,
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
  });
}

export function createDesktopRequestHandlers(
  context: ApplicationContext,
  onMutation: () => void = () => {},
  openExternal: (url: string) => boolean = () => false,
  terminalEndpoint = "",
): DesktopRequestHandlers {
  const mutate = async <T>(operation: () => T | Promise<T>) => {
    const response = await result(operation);
    if (response.ok) onMutation();
    return response;
  };

  return {
    snapshot: () => result(() => desktopSnapshot(context)),
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
    workspaceInstructionFilesSet: ({ enabled }) =>
      mutate(async () => {
        await context.workspaceContent.setInstructionFilesEnabled(enabled);
        return { enabled };
      }),
    focusModeSet: ({ enabled }) =>
      mutate(async () => ({
        enabled: await context.presence.setFocusMode(enabled),
      })),
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
      mutate(() =>
        workspaceRepositoryDto(context.workspaceContent.detachRepository(id)),
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
    taskRemove: ({ id, force }) =>
      mutate(async () => taskDto(await context.tasks.remove(id, force))),
    agentGet: ({ id }) =>
      result(async () => agentDto(await context.agents.get(id))),
    agentModels: ({ provider }) =>
      result(() => context.agents.models(provider)),
    agentSpawn: (params) =>
      mutate(async () => agentDto(await context.agents.spawn(params))),
    agentSend: ({ id, text }) =>
      mutate(async () => agentDto(await context.agents.send(id, text))),
    agentStop: ({ id, force }) =>
      mutate(async () => agentDto(await context.agents.stop(id, force))),
    agentRemove: ({ id }) =>
      mutate(async () => agentDto(await context.agents.remove(id))),
    agentReorder: ({ workspace, sessionIds }) =>
      mutate(async () =>
        (await context.agents.reorder(workspace, sessionIds)).map(agentDto),
      ),
    agentArchive: ({ id, force }) =>
      mutate(async () => agentDto(await context.agents.archive(id, force))),
    agentRestore: ({ id }) =>
      mutate(async () => agentDto(await context.agents.restore(id))),
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

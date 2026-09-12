import {
  normalizeError,
  type ApplicationContext,
  type AgentSession,
  type Task,
  type Workspace,
} from "@daedalus/core";
import type {
  AgentSessionDto,
  DesktopRpcSchema,
  DesktopSnapshotDto,
  RpcResult,
  TaskDto,
  WorkspaceDto,
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

export async function desktopSnapshot(
  context: ApplicationContext,
): Promise<DesktopSnapshotDto> {
  const [workspaces, tasks, agents, capabilities] = await Promise.all([
    context.workspaces.listWithHealth(),
    context.tasks.list({}),
    context.agents.list({}),
    context.agents.capabilities(),
  ]);
  return {
    workspaces: workspaces.map(({ workspace, available }) =>
      workspaceDto(workspace, available),
    ),
    tasks: tasks.map(taskDto),
    agents: agents.map(agentDto),
    settings: {
      home: context.config.home,
      workspaceRoot: context.config.workspaceRoot,
      databasePath: context.config.databasePath,
      ...capabilities,
    },
  };
}

export function desktopDataFingerprint(context: ApplicationContext): string {
  return JSON.stringify({
    workspaces: context.repositories.listWorkspaces(),
    tasks: context.repositories.listTasks({}),
    agents: context.repositories.listAgents(),
  });
}

export function createDesktopRequestHandlers(
  context: ApplicationContext,
  onMutation: () => void = () => {},
): DesktopRequestHandlers {
  const mutate = async <T>(operation: () => T | Promise<T>) => {
    const response = await result(operation);
    if (response.ok) onMutation();
    return response;
  };

  return {
    snapshot: () => result(() => desktopSnapshot(context)),
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
    agentSpawn: (params) =>
      mutate(async () => agentDto(await context.agents.spawn(params))),
    agentSend: ({ id, text }) =>
      mutate(async () => agentDto(await context.agents.send(id, text))),
    agentStop: ({ id, force }) =>
      mutate(async () => agentDto(await context.agents.stop(id, force))),
    agentRemove: ({ id }) =>
      mutate(async () => agentDto(await context.agents.remove(id))),
  };
}

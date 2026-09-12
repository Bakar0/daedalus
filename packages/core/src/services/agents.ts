import type { TmuxClient } from "@daedalus/platform";
import type { DaedalusConfig } from "../config";
import type { AgentSession } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import { buildTaskPrompt, resolveProvider } from "./providers";
import type { TaskService } from "./tasks";
import type { WorkspaceService } from "./workspaces";

export class AgentService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaces: WorkspaceService,
    private readonly tasks: TaskService,
    private readonly tmux: TmuxClient,
    private readonly config: DaedalusConfig,
  ) {}

  async spawn(input: {
    workspace: string;
    taskId?: string;
    provider?: string;
    command?: string;
  }): Promise<AgentSession> {
    const workspace = await this.workspaces.get(input.workspace);
    const task = input.taskId ? this.tasks.get(input.taskId) : undefined;
    if (task && task.workspaceId !== workspace.id)
      throw new DaedalusError(
        "VALIDATION",
        "Task does not belong to the selected workspace",
      );
    if (!(await this.tmux.probe()))
      throw new DaedalusError("DEPENDENCY", "tmux is not available on PATH");
    const provider = resolveProvider(this.config, input);
    const availability = await provider.adapter.probe();
    if (!availability.available)
      throw new DaedalusError(
        "DEPENDENCY",
        `Agent executable '${availability.executable}' is not available on PATH`,
      );
    const launch = await provider.adapter.buildLaunch({
      taskId: task?.id,
      prompt: task ? buildTaskPrompt(task.title, task.description) : undefined,
    });
    const id = crypto.randomUUID();
    const session: AgentSession = {
      id,
      workspaceId: workspace.id,
      taskId: task?.id ?? null,
      provider: provider.name,
      tmuxSession: `daedalus_${id.replaceAll("-", "")}`,
      command: launch.executable,
      args: launch.args,
      workingDirectory: workspace.path,
      status: "starting",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.repositories.createAgent(session);
    try {
      await this.tmux.createSession({
        session: session.tmuxSession,
        cwd: workspace.path,
        executable: launch.executable,
        args: launch.args,
        env: launch.env,
      });
      const running = { ...session, status: "running" as const };
      this.repositories.updateAgent(running);
      return running;
    } catch (error) {
      this.repositories.updateAgent({
        ...session,
        status: "exited",
        endedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  async reconcile(): Promise<void> {
    if (!(await this.tmux.probe())) return;
    const live = new Set(await this.tmux.listSessions());
    const now = new Date().toISOString();
    this.repositories.transaction(() => {
      for (const agent of this.repositories.listAgents()) {
        if (
          (agent.status === "starting" || agent.status === "running") &&
          !live.has(agent.tmuxSession)
        ) {
          this.repositories.updateAgent({
            ...agent,
            status: "lost",
            endedAt: now,
          });
        } else if (agent.status === "starting" && live.has(agent.tmuxSession)) {
          this.repositories.updateAgent({ ...agent, status: "running" });
        }
      }
    });
  }

  async list(filters: {
    workspace?: string;
    running?: boolean;
  }): Promise<AgentSession[]> {
    await this.reconcile();
    const workspaceId = filters.workspace
      ? (await this.workspaces.get(filters.workspace)).id
      : undefined;
    return this.repositories.listAgents({
      workspaceId,
      status: filters.running ? "running" : undefined,
    });
  }

  async get(id: string): Promise<AgentSession> {
    await this.reconcile();
    const agent = this.repositories.findAgent(id);
    if (!agent)
      throw new DaedalusError(
        "NOT_FOUND",
        `Agent session '${id}' was not found`,
      );
    return agent;
  }

  async attach(id: string): Promise<number> {
    const agent = await this.requireRunning(id);
    return this.tmux.attach(agent.tmuxSession);
  }

  async send(id: string, text: string): Promise<AgentSession> {
    if (!text)
      throw new DaedalusError(
        "VALIDATION",
        "Agent input text must not be empty",
      );
    const agent = await this.requireRunning(id);
    await this.tmux.send(agent.tmuxSession, text);
    return agent;
  }

  async stop(id: string, force = false): Promise<AgentSession> {
    const agent = await this.requireRunning(id);
    await this.tmux.stop(agent.tmuxSession, force);
    const stopped: AgentSession = {
      ...agent,
      status: "exited",
      endedAt: new Date().toISOString(),
    };
    this.repositories.updateAgent(stopped);
    return stopped;
  }

  async remove(id: string): Promise<AgentSession> {
    const agent = await this.get(id);
    if (agent.status === "running" || agent.status === "starting")
      throw new DaedalusError(
        "CONFLICT",
        "Running agent sessions must be stopped before removal",
      );
    this.repositories.deleteAgent(id);
    return agent;
  }

  async hasLiveWorkspaceAgents(workspaceId: string): Promise<boolean> {
    await this.reconcile();
    return this.repositories
      .listAgents({ workspaceId })
      .some(
        (agent) => agent.status === "running" || agent.status === "starting",
      );
  }

  async hasLiveTaskAgents(taskId: string): Promise<boolean> {
    await this.reconcile();
    return this.repositories
      .listAgents()
      .some(
        (agent) =>
          agent.taskId === taskId &&
          (agent.status === "running" || agent.status === "starting"),
      );
  }

  private async requireRunning(id: string): Promise<AgentSession> {
    const agent = await this.get(id);
    if (agent.status !== "running")
      throw new DaedalusError(
        "CONFLICT",
        `Agent session '${id}' is not running`,
      );
    return agent;
  }
}

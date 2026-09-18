import { isAbsolute } from "node:path";
import {
  findExecutable,
  isPathInside,
  pathExists,
  type TmuxClient,
} from "@daedalus/platform";
import type { DaedalusConfig } from "../config";
import type { IntegratedTerminal } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { WorkspaceService } from "./workspaces";

async function resolveWorkingDirectory(
  requested: string | undefined,
  workspacePath: string | undefined,
  home: string,
): Promise<string> {
  const fallback = workspacePath ?? home;
  if (!requested) return fallback;
  if (!workspacePath)
    throw new DaedalusError(
      "VALIDATION",
      "A working directory needs the workspace it belongs to",
    );
  if (!isAbsolute(requested) || !isPathInside(workspacePath, requested))
    throw new DaedalusError(
      "VALIDATION",
      "A terminal can only be opened inside its workspace",
    );
  if (!(await pathExists(requested)))
    throw new DaedalusError("NOT_FOUND", `'${requested}' no longer exists`);
  return requested;
}

export class IntegratedTerminalService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaces: WorkspaceService,
    private readonly tmux: TmuxClient,
    private readonly config: DaedalusConfig,
  ) {}

  async list(): Promise<IntegratedTerminal[]> {
    await this.reconcile();
    return this.repositories.listIntegratedTerminals();
  }

  async get(id: string): Promise<IntegratedTerminal> {
    await this.reconcile();
    const terminal = this.repositories.findIntegratedTerminal(id);
    if (!terminal)
      throw new DaedalusError(
        "NOT_FOUND",
        `Integrated terminal '${id}' was not found`,
      );
    return terminal;
  }

  async create(input: {
    workspace?: string;
    name?: string;
    /**
     * Where the shell starts. Constrained to the workspace it belongs to, so
     * "open in terminal" on a repository or a working tree cannot be turned
     * into a shell anywhere on the machine.
     */
    workingDirectory?: string;
  }): Promise<IntegratedTerminal> {
    if (!(await this.tmux.probe()))
      throw new DaedalusError("DEPENDENCY", "tmux is not available on PATH");
    const workspace = input.workspace
      ? await this.workspaces.getActive(input.workspace)
      : undefined;
    const shell =
      findExecutable(process.env.SHELL ?? "") ??
      findExecutable("/bin/zsh") ??
      findExecutable("/bin/bash") ??
      findExecutable("/bin/sh");
    if (!shell)
      throw new DaedalusError("DEPENDENCY", "No interactive shell was found");
    const requestedName = input.name?.trim();
    if (requestedName && requestedName.length > 120)
      throw new DaedalusError(
        "VALIDATION",
        "Terminal name must contain at most 120 characters",
      );
    const baseName = requestedName || workspace?.name || "Terminal";
    const name = this.uniqueName(baseName);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const terminal: IntegratedTerminal = {
      id,
      name,
      tmuxSession: `daedalus_terminal_${id.replaceAll("-", "")}`,
      command: shell,
      args: ["-l"],
      workingDirectory: await resolveWorkingDirectory(
        input.workingDirectory,
        workspace?.path,
        this.config.home,
      ),
      status: "starting",
      exitCode: null,
      startedAt: now,
      endedAt: null,
    };
    this.repositories.createIntegratedTerminal(terminal);
    try {
      await this.tmux.createSession({
        session: terminal.tmuxSession,
        cwd: terminal.workingDirectory,
        executable: terminal.command,
        args: terminal.args,
      });
      const running = { ...terminal, status: "running" as const };
      this.repositories.updateIntegratedTerminal(running);
      return running;
    } catch (error) {
      if (await this.tmux.hasSession(terminal.tmuxSession))
        await this.tmux.stop(terminal.tmuxSession, true).catch(() => undefined);
      this.repositories.deleteIntegratedTerminal(terminal.id);
      throw error;
    }
  }

  async close(id: string): Promise<IntegratedTerminal> {
    const terminal = await this.get(id);
    if (terminal.status === "running" || terminal.status === "starting")
      await this.tmux.stop(terminal.tmuxSession, true);
    this.repositories.deleteIntegratedTerminal(id);
    return {
      ...terminal,
      status: "exited",
      endedAt: terminal.endedAt ?? new Date().toISOString(),
    };
  }

  async reconcile(): Promise<void> {
    if (!(await this.tmux.probe())) return;
    const live = new Set(await this.tmux.listSessions());
    const now = new Date().toISOString();
    for (const terminal of this.repositories.listIntegratedTerminals()) {
      if (
        (terminal.status === "running" || terminal.status === "starting") &&
        !live.has(terminal.tmuxSession)
      )
        this.repositories.updateIntegratedTerminal({
          ...terminal,
          status: "lost",
          endedAt: now,
        });
      else if (terminal.status === "starting" && live.has(terminal.tmuxSession))
        this.repositories.updateIntegratedTerminal({
          ...terminal,
          status: "running",
        });
    }
  }

  private uniqueName(baseName: string): string {
    const names = new Set(
      this.repositories.listIntegratedTerminals().map((item) => item.name),
    );
    if (!names.has(baseName)) return baseName;
    let suffix = 2;
    while (names.has(`${baseName} ${suffix}`)) suffix++;
    return `${baseName} ${suffix}`;
  }
}

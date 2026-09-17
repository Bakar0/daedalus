import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  findExecutable,
  runCommand,
  type TmuxClient,
} from "@daedalus/platform";
import type { DaedalusConfig } from "../config";
import type { AgentSession } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import {
  buildAgentPrompt,
  claudeDaedalusSettingsArgs,
  codexDaedalusHookConfigArgs,
  CODEX_DAEDALUS_TUI_ARGS,
  discoverProviderModels,
  modelArgument,
  resolveAgentExecutable,
  resolveProvider,
} from "./providers";
import type { TaskService } from "./tasks";
import type { WorkspaceService } from "./workspaces";
import type { WorkspaceContentService } from "./workspace-content";

const UUID_FILE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;
const CODEX_ROLLOUT_FILE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;
const CODEX_WRITER_LOCK =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.lock$/i;
const UUID_VALUE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_RECOVERY_WINDOW_MS = 60_000;
const SESSION_RECOVERY_UNIQUENESS_MS = 2_000;
const PROVIDER_STARTUP_TIMEOUT_MS = 30_000;
const PROVIDER_STARTUP_POLL_MS = 150;
// Upper bound on synthetic Enter presses per startup prompt. Daedalus answers
// the trust prompts for directories it created itself; it must never keep
// typing into a session the user has taken over.
const MAX_PROMPT_CONFIRMATIONS = 3;

export function isMissingCodexConversationError(message: string): boolean {
  return /(?:^|\b)No active session found matching\s+['"][^'"]+['"]\.?/i.test(
    message,
  );
}

function claudeProjectKey(workingDirectory: string): string {
  return workingDirectory.replace(/[^a-zA-Z0-9]/g, "-");
}

export async function recoverClaudeSessionId(input: {
  projectsDirectory: string;
  workingDirectory: string;
  startedAt: string;
  claimedIds?: Iterable<string>;
}): Promise<string | undefined> {
  const startedAt = Date.parse(input.startedAt);
  if (!Number.isFinite(startedAt)) return undefined;
  const claimedIds = new Set(input.claimedIds ?? []);
  const directory = join(
    input.projectsDirectory,
    claudeProjectKey(input.workingDirectory),
  );
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates: Array<{ id: string; distance: number }> = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const match = UUID_FILE.exec(entry.name);
      const id = match?.[1];
      if (!id || claimedIds.has(id)) return;
      try {
        const initialTranscript = await Bun.file(join(directory, entry.name))
          .slice(0, 128 * 1024)
          .text();
        if (!initialTranscript.includes(`"sessionId":"${id}"`)) return;
        if (
          initialTranscript.includes('"cwd":') &&
          !initialTranscript.includes(
            `"cwd":${JSON.stringify(input.workingDirectory)}`,
          )
        )
          return;
        const timestamp = /"timestamp":"([^"]+)"/.exec(initialTranscript)?.[1];
        if (!timestamp) return;
        const distance = Math.abs(Date.parse(timestamp) - startedAt);
        if (Number.isFinite(distance) && distance <= SESSION_RECOVERY_WINDOW_MS)
          candidates.push({ id, distance });
      } catch {
        // A partial or concurrently-written transcript is not a safe match.
      }
    }),
  );
  candidates.sort((left, right) => left.distance - right.distance);
  const closest = candidates[0];
  if (!closest) return undefined;
  const runnerUp = candidates[1];
  if (
    runnerUp &&
    runnerUp.distance - closest.distance < SESSION_RECOVERY_UNIQUENESS_MS
  )
    return undefined;
  return closest.id;
}

export async function recoverCodexSessionId(input: {
  sessionsDirectory: string;
  workingDirectory: string;
  startedAt: string;
  claimedIds?: Iterable<string>;
  /**
   * How far from `startedAt` a rollout may be and still be this session's.
   *
   * The default minute is the right bound for archive and resume, where
   * claiming the wrong conversation is destructive. Activity detection passes
   * a wider one, because a session that sat on a startup prompt only writes
   * its rollout when the user answers — and by then the narrow window has
   * closed, leaving the locator null forever. Widening it is safe there
   * precisely because `cwd` must still match exactly, and a Daedalus session's
   * working directory is a per-session path nothing else owns.
   */
  windowMs?: number;
}): Promise<string | undefined> {
  const window = input.windowMs ?? SESSION_RECOVERY_WINDOW_MS;
  const startedAt = Date.parse(input.startedAt);
  if (!Number.isFinite(startedAt)) return undefined;
  const claimedIds = new Set(input.claimedIds ?? []);
  const dateDirectories = new Set<string>();
  for (const offset of [-1, 0, 1]) {
    const [year, month, day] = new Date(
      startedAt + offset * 24 * 60 * 60 * 1_000,
    )
      .toISOString()
      .slice(0, 10)
      .split("-");
    dateDirectories.add(join(input.sessionsDirectory, year!, month!, day!));
  }
  const candidatesById = new Map<string, number>();
  const addCandidate = (id: string, distance: number) => {
    const previous = candidatesById.get(id);
    if (previous === undefined || distance < previous)
      candidatesById.set(id, distance);
  };
  await Promise.all(
    [...dateDirectories].map(async (directory) => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      await Promise.all(
        entries.map(async (entry) => {
          if (!entry.isFile()) return;
          const id = CODEX_ROLLOUT_FILE.exec(entry.name)?.[1];
          if (!id || claimedIds.has(id)) return;
          try {
            const initialTranscript = await Bun.file(
              join(directory, entry.name),
            )
              .slice(0, 128 * 1024)
              .text();
            for (const line of initialTranscript.split("\n").slice(0, 20)) {
              if (!line) continue;
              const record = JSON.parse(line) as {
                type?: string;
                payload?: { id?: string; cwd?: string; timestamp?: string };
              };
              if (record.type !== "session_meta" || record.payload?.id !== id)
                continue;
              if (record.payload.cwd !== input.workingDirectory) return;
              const timestamp = Date.parse(record.payload.timestamp ?? "");
              const distance = Math.abs(timestamp - startedAt);
              if (Number.isFinite(distance) && distance <= window)
                addCandidate(id, distance);
              return;
            }
          } catch {
            // A partial or concurrently-written rollout is not a safe match.
          }
        }),
      );
    }),
  );
  const locksDirectory = join(
    dirname(input.sessionsDirectory),
    "thread-writer-locks",
  );
  try {
    const entries = await readdir(locksDirectory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) return;
        const id = CODEX_WRITER_LOCK.exec(entry.name)?.[1];
        if (!id || claimedIds.has(id)) return;
        try {
          const metadata = await stat(join(locksDirectory, entry.name));
          const timestamp = metadata.birthtimeMs || metadata.mtimeMs;
          const distance = Math.abs(timestamp - startedAt);
          if (
            Number.isFinite(distance) &&
            distance <= SESSION_RECOVERY_WINDOW_MS
          )
            addCandidate(id, distance);
        } catch {
          // The owning Codex process may remove its lock while it exits.
        }
      }),
    );
  } catch {
    // Older Codex releases do not have a writer-lock directory.
  }
  const candidates = [...candidatesById].map(([id, distance]) => ({
    id,
    distance,
  }));
  candidates.sort((left, right) => left.distance - right.distance);
  const closest = candidates[0];
  if (!closest) return undefined;
  const runnerUp = candidates[1];
  if (
    runnerUp &&
    runnerUp.distance - closest.distance < SESSION_RECOVERY_UNIQUENESS_MS
  )
    return undefined;
  return closest.id;
}

export async function hasPersistedCodexSession(input: {
  sessionsDirectory: string;
  id: string;
  startedAt: string;
}): Promise<boolean> {
  // Legacy Codex sessions may be addressed by their user-visible name.
  if (!UUID_VALUE.test(input.id)) return true;
  const codexHome = dirname(input.sessionsDirectory);
  try {
    const entries = await readdir(codexHome, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/^state_\d+\.sqlite$/.test(entry.name)) continue;
      let database: Database | undefined;
      try {
        database = new Database(join(codexHome, entry.name), {
          readonly: true,
        });
        const found = database
          .query<{ found: number }, [string]>(
            "SELECT 1 AS found FROM threads WHERE id = ? LIMIT 1",
          )
          .get(input.id);
        if (found) return true;
      } catch {
        // Fall through to rollout files for older or incompatible schemas.
      } finally {
        database?.close();
      }
    }
  } catch {
    // The Codex home may predate the SQLite state store.
  }

  const startedAt = Date.parse(input.startedAt);
  if (Number.isFinite(startedAt)) {
    for (const offset of [-1, 0, 1]) {
      const [year, month, day] = new Date(
        startedAt + offset * 24 * 60 * 60 * 1_000,
      )
        .toISOString()
        .slice(0, 10)
        .split("-");
      try {
        const entries = await readdir(
          join(input.sessionsDirectory, year!, month!, day!),
        );
        if (entries.some((entry) => entry.endsWith(`${input.id}.jsonl`)))
          return true;
      } catch {
        // Missing date directories are expected.
      }
    }
  }
  try {
    const entries = await readdir(join(codexHome, "archived_sessions"));
    return entries.some((entry) => entry.endsWith(`${input.id}.jsonl`));
  } catch {
    return false;
  }
}

export class AgentService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaces: WorkspaceService,
    private readonly workspaceContent: WorkspaceContentService,
    private readonly tasks: TaskService,
    private readonly tmux: TmuxClient,
    private readonly config: DaedalusConfig,
    /**
     * Called when a session stops being live. An attention badge on a session
     * that is over is the purest form of a badge outliving its cause.
     */
    private readonly onSessionEnded: (sessionId: string) => void = () => {},
  ) {}

  private agentEnvironment(
    session: AgentSession,
    environment: Record<string, string> = {},
  ): Record<string, string> {
    const task = session.taskId
      ? this.repositories.findTask(session.taskId)
      : undefined;
    const path = [
      join(this.config.home, "bin"),
      environment.PATH,
      process.env.PATH,
    ]
      .filter(Boolean)
      .join(":");
    return {
      ...environment,
      PATH: path,
      DAEDALUS_HOME: this.config.home,
      DAEDALUS_SESSION_ID: session.id,
      DAEDALUS_WORKSPACE_ID: session.workspaceId,
      ...(task
        ? {
            DAEDALUS_TASK_ID: task.id,
            DAEDALUS_TASK_NUMBER: String(task.number),
          }
        : {}),
    };
  }

  private async confirmOwnedWorkspaceTrust(
    provider: string,
    tmuxSession: string,
  ): Promise<void> {
    if (provider !== "codex" && provider !== "claude") return;
    const deadline = Date.now() + PROVIDER_STARTUP_TIMEOUT_MS;
    const promptAttempts = new Map<
      string,
      {
        navigationCount: number;
        navigatedAt: number;
        confirmCount: number;
        confirmedAt?: number;
      }
    >();
    let lastScreen = "";

    const confirmDefaultPrompt = async (key: string) => {
      const previous = promptAttempts.get(key);
      // Answered prompts stay in the scrollback, so the capture keeps matching
      // them long after the provider moved on. Without a hard cap Daedalus
      // would keep pressing Enter into the session the user is now typing in.
      if (previous && previous.confirmCount >= MAX_PROMPT_CONFIRMATIONS) return;
      if (previous?.confirmedAt && Date.now() - previous.confirmedAt < 1_000)
        return;
      if (!previous) await Bun.sleep(500);
      await this.tmux.sendKeys(tmuxSession, ["Enter"]);
      promptAttempts.set(key, {
        navigationCount: 0,
        navigatedAt: previous?.navigatedAt ?? 0,
        confirmCount: (previous?.confirmCount ?? 0) + 1,
        confirmedAt: Date.now(),
      });
    };

    const confirmClaudePrompt = async (
      key: string,
      screen: string,
      affirmativeLabel: string,
    ) => {
      const previous = promptAttempts.get(key);
      const escapedLabel = affirmativeLabel.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      if (new RegExp(`❯\\s*${escapedLabel}`).test(screen)) {
        if (previous && previous.confirmCount >= MAX_PROMPT_CONFIRMATIONS)
          return;
        if (previous?.confirmedAt && Date.now() - previous.confirmedAt < 1_000)
          return;
        await this.tmux.sendKeys(tmuxSession, ["Enter"]);
        promptAttempts.set(key, {
          navigationCount: previous?.navigationCount ?? 0,
          navigatedAt: previous?.navigatedAt ?? 0,
          confirmCount: (previous?.confirmCount ?? 0) + 1,
          confirmedAt: Date.now(),
        });
        return;
      }
      if (
        previous &&
        (previous.navigationCount >= 3 ||
          Date.now() - previous.navigatedAt < 1_000)
      )
        return;
      if (!previous) await Bun.sleep(500);
      await this.tmux.sendKeys(tmuxSession, ["Down"]);
      promptAttempts.set(key, {
        navigationCount: (previous?.navigationCount ?? 0) + 1,
        navigatedAt: Date.now(),
        confirmCount: previous?.confirmCount ?? 0,
      });
    };

    while (Date.now() < deadline) {
      if (!(await this.tmux.hasSession(tmuxSession)))
        throw new DaedalusError(
          "INTERNAL",
          `${provider} exited before finishing startup`,
          {
            startupOutput: lastScreen.replace(/\s+/g, " ").trim().slice(-600),
          },
        );
      const screen = await this.tmux.capture(tmuxSession);
      lastScreen = screen;

      // Readiness is checked first: the answered prompt stays in the
      // scrollback, so matching it ahead of the ready marker would keep
      // driving keys into a session that already belongs to the user.
      if (
        (provider === "codex" && screen.includes("Ask Codex to do anything")) ||
        (provider === "claude" && screen.includes("shift+tab to cycle"))
      ) {
        return;
      } else if (provider === "codex" && screen.includes("Hooks need review")) {
        // Daedalus injects Codex's activity hooks, and Codex gates them behind
        // a one-time review because a trusted hook runs outside the sandbox.
        // That is the user's decision, not Daedalus's, so the prompt is left
        // standing and startup is treated as finished: the session is live and
        // usable either way, and until it is answered Codex activity simply
        // runs on the rollout tier. Answering it here would be Daedalus
        // clicking through a security control on the user's behalf.
        return;
      } else if (
        provider === "codex" &&
        screen.includes("Do you trust the contents of this directory?")
      ) {
        await confirmDefaultPrompt("codex-workspace");
      } else if (
        provider === "claude" &&
        screen.includes("Yes, I trust this folder")
      ) {
        await confirmClaudePrompt(
          "claude-workspace",
          screen,
          "Yes, I trust this folder",
        );
      } else if (
        provider === "claude" &&
        screen.includes("Allow external CLAUDE.md file imports?")
      ) {
        await confirmClaudePrompt(
          "claude-instructions",
          screen,
          "Yes, allow external imports",
        );
      }

      await Bun.sleep(PROVIDER_STARTUP_POLL_MS);
    }

    if (!(await this.tmux.hasSession(tmuxSession)))
      throw new Error(`${provider} exited before finishing startup`);
    throw new Error(`${provider} did not become ready within 30 seconds`);
  }

  async capabilities(): Promise<{
    tmuxAvailable: boolean;
    tmuxVersion?: string;
    providers: Array<{
      name: string;
      executable: string;
      available: boolean;
    }>;
  }> {
    const tmuxVersion = await this.tmux.probe();
    return {
      tmuxAvailable: Boolean(tmuxVersion),
      tmuxVersion,
      providers: Object.entries(this.config.agents)
        .map(([name, definition]) => {
          const executable = resolveAgentExecutable(
            name,
            definition.executable,
          );
          return {
            name,
            executable: executable ?? definition.executable,
            available: Boolean(executable),
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async models(provider: "codex" | "claude") {
    return discoverProviderModels(this.config, provider);
  }

  async spawn(input: {
    workspace: string;
    taskId?: string;
    name?: string;
    provider?: string;
    model?: string;
    message?: string;
    command?: string;
    terminal?: boolean;
  }): Promise<AgentSession> {
    const workspace = await this.workspaces.getActive(input.workspace);
    const task = input.taskId ? this.tasks.get(input.taskId) : undefined;
    const requestedName = input.name?.trim();
    if (requestedName && requestedName.length > 240)
      throw new DaedalusError(
        "VALIDATION",
        "Session name must contain at most 240 characters",
      );
    if (task && task.workspaceId !== workspace.id)
      throw new DaedalusError(
        "VALIDATION",
        "Task does not belong to the selected workspace",
      );
    if (!(await this.tmux.probe()))
      throw new DaedalusError("DEPENDENCY", "tmux is not available on PATH");
    if (input.terminal && (input.provider || input.command))
      throw new DaedalusError(
        "VALIDATION",
        "A terminal session cannot also select an agent provider",
      );
    const shell = input.terminal
      ? (findExecutable(process.env.SHELL ?? "") ??
        findExecutable("/bin/zsh") ??
        findExecutable("/bin/bash") ??
        findExecutable("/bin/sh"))
      : undefined;
    if (input.terminal && !shell)
      throw new DaedalusError("DEPENDENCY", "No interactive shell was found");
    const provider = input.terminal
      ? undefined
      : resolveProvider(this.config, input);
    if (provider) {
      const availability = await provider.adapter.probe();
      if (!availability.available)
        throw new DaedalusError(
          "DEPENDENCY",
          `Agent executable '${availability.executable}' is not available on PATH`,
        );
    }
    const id = crypto.randomUUID();
    const defaultName = input.terminal
      ? "Terminal"
      : `${provider!.name.slice(0, 1).toUpperCase()}${provider!.name.slice(1)} session`;
    const name = requestedName || task?.title || defaultName;
    const prepared = !input.terminal
      ? await this.workspaceContent.prepareSession({
          workspace,
          task,
          sessionId: id,
        })
      : { workingDirectory: workspace.path, worktrees: [], references: [] };
    const launchPrompt = buildAgentPrompt({
      taskNumber: task?.number,
      message: input.message,
    });
    const launch = input.terminal
      ? { executable: shell!, args: ["-l"], env: {} }
      : await provider!.adapter.buildLaunch({
          taskId: task?.id,
          sessionId: id,
          sessionName: name,
          prompt: launchPrompt,
          model: input.model,
          additionalDirectories: prepared.references.map(
            (repository) =>
              repository.referencePath ?? repository.canonicalPath,
          ),
        });
    const session: AgentSession = {
      id,
      workspaceId: workspace.id,
      taskId: task?.id ?? null,
      name,
      provider: provider?.name ?? "custom",
      kind: input.terminal ? "terminal" : "agent",
      tmuxSession: `daedalus_${id.replaceAll("-", "")}`,
      command: launch.executable,
      args: launch.args,
      workingDirectory: prepared.workingDirectory,
      status: "starting",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      providerSessionId: launch.providerSessionId ?? null,
      archivedAt: null,
      resumeCount: 0,
    };
    this.repositories.createAgent(session);
    try {
      await this.tmux.createSession({
        session: session.tmuxSession,
        cwd: session.workingDirectory,
        executable: launch.executable,
        args: launch.args,
        env: input.terminal
          ? launch.env
          : this.agentEnvironment(session, launch.env),
      });
      if (!input.terminal)
        await this.confirmOwnedWorkspaceTrust(
          provider!.name,
          session.tmuxSession,
        );
      let runningSession = session;
      if (provider?.name === "codex") {
        const recoveredId = await recoverCodexSessionId({
          sessionsDirectory: this.config.codexSessionsDirectory,
          workingDirectory: session.workingDirectory,
          startedAt: session.startedAt,
          claimedIds: this.repositories
            .listAgents()
            .flatMap((item) =>
              item.providerSessionId ? [item.providerSessionId] : [],
            ),
        });
        if (recoveredId)
          runningSession = {
            ...runningSession,
            providerSessionId: recoveredId,
          };
      }
      const running = { ...runningSession, status: "running" as const };
      this.repositories.updateAgent(running);
      return running;
    } catch (error) {
      if (await this.tmux.hasSession(session.tmuxSession))
        await this.tmux.stop(session.tmuxSession, true).catch(() => undefined);
      this.repositories.updateAgent({
        ...session,
        status: "exited",
        endedAt: new Date().toISOString(),
      });
      throw new DaedalusError(
        error instanceof DaedalusError ? error.code : "INTERNAL",
        error instanceof Error ? error.message : String(error),
        {
          ...(error instanceof DaedalusError ? error.details : undefined),
          sessionId: session.id,
        },
      );
    }
  }

  async reconcile(): Promise<void> {
    if (!(await this.tmux.probe())) return;
    const live = new Set(await this.tmux.listSessions());
    const now = new Date().toISOString();
    const lost: string[] = [];
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
          lost.push(agent.id);
        } else if (agent.status === "starting" && live.has(agent.tmuxSession)) {
          this.repositories.updateAgent({ ...agent, status: "running" });
        }
      }
    });
    for (const sessionId of lost) this.onSessionEnded(sessionId);
  }

  async list(filters: {
    workspace?: string;
    running?: boolean;
    archived?: boolean;
    includeArchived?: boolean;
  }): Promise<AgentSession[]> {
    await this.reconcile();
    const workspaceId = filters.workspace
      ? (await this.workspaces.get(filters.workspace)).id
      : undefined;
    const sessions = this.repositories.listAgents({
      workspaceId,
      status: filters.running ? "running" : undefined,
    });
    if (filters.includeArchived) return sessions;
    return sessions.filter((session) =>
      filters.archived ? Boolean(session.archivedAt) : !session.archivedAt,
    );
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
    const agent = await this.get(id);
    // A session that never finished starting is still a live tmux session, so
    // stopping it must work exactly like stopping a running one.
    if (agent.status !== "running" && agent.status !== "starting")
      throw new DaedalusError(
        "CONFLICT",
        `Agent session '${id}' is not running`,
      );
    await this.tmux.stop(agent.tmuxSession, force);
    const stopped: AgentSession = {
      ...agent,
      status: "exited",
      endedAt: new Date().toISOString(),
    };
    this.repositories.updateAgent(stopped);
    this.onSessionEnded(id);
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

  async archive(id: string, force = false): Promise<AgentSession> {
    let agent = await this.get(id);
    if (agent.archivedAt) return agent;
    // Archivability is settled before anything is stopped, so a session that
    // cannot be archived safely keeps running instead of being destroyed.
    agent = await this.prepareArchivable(agent);
    if (agent.status === "running" || agent.status === "starting")
      agent = await this.stop(id, force);
    const hasNativeCodexConversation =
      agent.provider === "codex" && agent.providerSessionId
        ? await hasPersistedCodexSession({
            sessionsDirectory: this.config.codexSessionsDirectory,
            id: agent.providerSessionId,
            startedAt: agent.startedAt,
          })
        : false;
    if (
      agent.provider === "codex" &&
      agent.providerSessionId &&
      hasNativeCodexConversation
    ) {
      const result = await runCommand(
        agent.command,
        ["archive", agent.providerSessionId],
        { cwd: agent.workingDirectory },
      );
      const errorMessage = result.stderr.trim() || result.stdout.trim();
      if (
        result.exitCode !== 0 &&
        !isMissingCodexConversationError(errorMessage)
      )
        throw new DaedalusError(
          "CONFLICT",
          errorMessage || "Codex could not archive the conversation",
        );
    }
    const archived = { ...agent, archivedAt: new Date().toISOString() };
    this.repositories.updateAgent(archived);
    this.onSessionEnded(id);
    return archived;
  }

  async restore(id: string): Promise<AgentSession> {
    const agent = await this.get(id);
    if (!agent.archivedAt)
      throw new DaedalusError("CONFLICT", "Session is not archived");
    const workspace = await this.workspaces.get(agent.workspaceId);
    if (workspace.archivedAt)
      throw new DaedalusError(
        "CONFLICT",
        "Restore the workspace before restoring its sessions",
      );
    if (!(await this.tmux.probe()))
      throw new DaedalusError("DEPENDENCY", "tmux is not available on PATH");

    let executable = agent.command;
    let args = agent.args;
    let providerSessionId = agent.providerSessionId;
    if (agent.kind === "agent") {
      const nativeSessionId = agent.providerSessionId;
      if (!nativeSessionId && agent.provider !== "codex")
        throw new DaedalusError(
          "CONFLICT",
          "This session predates native resume support and cannot be resumed safely",
        );
      const definition = this.config.agents[agent.provider];
      if (!definition)
        throw new DaedalusError(
          "DEPENDENCY",
          `Agent configuration '${agent.provider}' is unavailable`,
        );
      executable =
        resolveAgentExecutable(agent.provider, definition.executable) ??
        definition.executable;
      const additionalDirectories = this.repositories
        .listWorkspaceRepositories(workspace.id)
        .flatMap((repository) => [
          "--add-dir",
          repository.referencePath ?? repository.canonicalPath,
        ]);
      const selectedModel = modelArgument(agent.args);
      const modelArgs = selectedModel ? ["--model", selectedModel] : [];
      if (agent.provider === "codex") {
        const hasNativeConversation = nativeSessionId
          ? await hasPersistedCodexSession({
              sessionsDirectory: this.config.codexSessionsDirectory,
              id: nativeSessionId,
              startedAt: agent.startedAt,
            })
          : false;
        if (hasNativeConversation && nativeSessionId) {
          const unarchive = await runCommand(
            executable,
            ["unarchive", nativeSessionId],
            { cwd: agent.workingDirectory },
          );
          const unarchiveError =
            unarchive.stderr.trim() || unarchive.stdout.trim();
          if (unarchive.exitCode !== 0)
            throw new DaedalusError(
              "CONFLICT",
              unarchiveError || "Codex could not restore the conversation",
            );
          args = [
            ...definition.args,
            ...CODEX_DAEDALUS_TUI_ARGS,
            ...(await codexDaedalusHookConfigArgs(this.config, executable)),
            ...modelArgs,
            ...additionalDirectories,
            "resume",
            nativeSessionId,
          ];
        } else {
          // Codex allocates a thread UUID before the first user event but does
          // not persist an empty conversation. Restoring such an archived
          // session correctly starts a new empty native session.
          args = [
            ...definition.args,
            ...CODEX_DAEDALUS_TUI_ARGS,
            ...(await codexDaedalusHookConfigArgs(this.config, executable)),
            ...modelArgs,
            ...additionalDirectories,
          ];
          providerSessionId = null;
        }
      } else if (agent.provider === "claude") {
        if (!nativeSessionId)
          throw new DaedalusError(
            "CONFLICT",
            "This session predates native resume support and cannot be resumed safely",
          );
        args = [
          ...(await claudeDaedalusSettingsArgs(this.config, definition.args)),
          ...modelArgs,
          ...additionalDirectories,
          "--resume",
          nativeSessionId,
        ];
      } else {
        throw new DaedalusError(
          "CONFLICT",
          "Custom sessions do not define a native resume capability",
        );
      }
    }

    const restoring: AgentSession = {
      ...agent,
      command: executable,
      args,
      providerSessionId,
      status: "starting",
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
    };
    try {
      await this.tmux.createSession({
        session: restoring.tmuxSession,
        cwd: agent.workingDirectory,
        executable,
        args,
        env:
          agent.kind === "agent" ? this.agentEnvironment(restoring) : undefined,
      });
      if (agent.kind === "agent")
        await this.confirmOwnedWorkspaceTrust(
          agent.provider,
          restoring.tmuxSession,
        );
      let restored: AgentSession = {
        ...restoring,
        status: "running",
        archivedAt: null,
        resumeCount: agent.resumeCount + 1,
      };
      if (agent.provider === "codex" && !restored.providerSessionId) {
        const recoveredId = await recoverCodexSessionId({
          sessionsDirectory: this.config.codexSessionsDirectory,
          workingDirectory: restored.workingDirectory,
          startedAt: restored.startedAt,
          claimedIds: this.repositories
            .listAgents()
            .flatMap((session) =>
              session.providerSessionId ? [session.providerSessionId] : [],
            ),
        });
        if (recoveredId)
          restored = { ...restored, providerSessionId: recoveredId };
      }
      this.repositories.updateAgent(restored);
      return restored;
    } catch (error) {
      if (agent.provider === "codex" && agent.providerSessionId)
        await runCommand(executable, ["archive", agent.providerSessionId], {
          cwd: workspace.path,
        }).catch(() => undefined);
      throw error;
    }
  }

  async archiveWorkspaceSessions(workspaceId: string): Promise<void> {
    const sessions = this.repositories
      .listAgents({ workspaceId })
      .filter((session) => !session.archivedAt);
    for (const session of sessions) await this.prepareArchivable(session);
    for (const session of sessions)
      if (!session.archivedAt) await this.archive(session.id);
  }

  private async prepareArchivable(agent: AgentSession): Promise<AgentSession> {
    if (agent.kind === "terminal") return agent;
    if (agent.provider === "custom")
      throw new DaedalusError(
        "CONFLICT",
        "Custom agent sessions cannot be archived because no native resume capability is configured",
      );
    if (agent.providerSessionId) return agent;
    if (agent.provider === "codex") {
      const recoveredId = await recoverCodexSessionId({
        sessionsDirectory: this.config.codexSessionsDirectory,
        workingDirectory: agent.workingDirectory,
        startedAt: agent.startedAt,
        claimedIds: this.repositories
          .listAgents()
          .flatMap((session) =>
            session.providerSessionId ? [session.providerSessionId] : [],
          ),
      });
      if (recoveredId) {
        const recovered = { ...agent, providerSessionId: recoveredId };
        this.repositories.updateAgent(recovered);
        return recovered;
      }
      // Codex allocates a thread UUID before the first user event but never
      // persists an empty conversation, and a session that failed during
      // startup has nothing to persist either. `restore` already covers this
      // by starting a fresh native session, so archiving loses nothing.
      return agent;
    }
    if (agent.provider === "claude") {
      const recoveredId = await recoverClaudeSessionId({
        projectsDirectory: this.config.claudeProjectsDirectory,
        workingDirectory: agent.workingDirectory,
        startedAt: agent.startedAt,
        claimedIds: this.repositories
          .listAgents()
          .flatMap((session) =>
            session.providerSessionId ? [session.providerSessionId] : [],
          ),
      });
      if (recoveredId) {
        const recovered = { ...agent, providerSessionId: recoveredId };
        this.repositories.updateAgent(recovered);
        return recovered;
      }
    }
    throw new DaedalusError(
      "CONFLICT",
      "This existing session has no uniquely matching native conversation and cannot be archived safely",
    );
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

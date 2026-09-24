import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  findExecutable,
  pathExists,
  runCommand,
  type TmuxClient,
} from "@daedalus/platform";
import type { DaedalusConfig } from "../config";
import type { AgentSession, Workspace } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import {
  buildAgentPrompt,
  buildHandoffRequest,
  catalogOffersModel,
  CLAUDE_DEFAULT_MODEL,
  claudeDaedalusSettingsArgs,
  ensureCodexHooks,
  CODEX_DAEDALUS_TUI_ARGS,
  discoverProviderModels,
  HANDOFF_FILE,
  modelArgument,
  type ProviderModelCatalog,
  resolveAgentExecutable,
  resolveProvider,
  sessionLaunchModel,
} from "./providers";
import { applyManualOrder } from "./ordering";
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
// How many sessions a revive sweep brings back at once. Every relaunch is a
// provider CLI re-reading a transcript and possibly sitting on a startup trust
// prompt that Daedalus answers with up to MAX_PROMPT_CONFIRMATIONS synthetic
// Enters, so ten sessions starting together at login is ten of those racing
// each other for the machine. Two at a time is still far faster than the
// manual archive/restore it replaces.
const REVIVE_CONCURRENCY = 2;
const REVIVE_LOCK_FILE = "revive.lock";
// A sweep that crashed between taking the lock and releasing it must not
// disable revival for ever, and no single sweep runs for anything like this
// long — each session is bounded by the 30s provider startup timeout.
const REVIVE_LOCK_STALE_MS = 10 * 60_000;
// How much of a failed startup's last screen is kept in `lostReason`. Enough
// for the provider's own sentence — "No conversation found with session ID" is
// the whole answer — without pasting a terminal onto a session card.
const LOST_REASON_OUTPUT_LIMIT = 200;
// How long a provider's model catalog is trusted before a spawn asks for it
// again. Discovery is a provider subprocess, about a second for Claude, and
// the catalog only changes when the account or the provider build does.
const MODEL_CATALOG_TTL_MS = 10 * 60_000;

/**
 * What to put on the card when a revive failed. A provider that refused to
 * start said why on its own last screen, and "claude exited before finishing
 * startup" without that sentence is a symptom where the cause was available.
 */
export function reviveFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const output =
    error instanceof DaedalusError &&
    typeof error.details?.startupOutput === "string"
      ? error.details.startupOutput.trim()
      : "";
  if (!output) return message;
  return `${message}: ${output.slice(0, LOST_REASON_OUTPUT_LIMIT)}`;
}

/**
 * Why a sweep produced nothing, when it produced nothing on purpose.
 *
 * `sweep_in_progress` is the case the lock exists for: the app starting while
 * a `daedal agent revive --all` is already running would otherwise create a
 * second tmux session under the same name for the same conversation.
 */
export type ReviveHalt = "disabled" | "tmux_unavailable" | "sweep_in_progress";

export interface ReviveSweepResult {
  revived: AgentSession[];
  /** Sessions left `lost`, each with the reason now stored on its row. */
  skipped: Array<{ sessionId: string; name: string; reason: string }>;
  /** Set only when the sweep declined to run at all. */
  halted?: ReviveHalt;
}

/**
 * A cross-process mutex for the revive sweep, held as a file under
 * `DAEDALUS_HOME` because the racing parties are separate processes — the
 * desktop app starting and a CLI sweep — with only the home between them.
 */
async function acquireReviveLock(
  home: string,
): Promise<(() => Promise<void>) | undefined> {
  const path = join(home, REVIVE_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, `${process.pid}\n`, { flag: "wx" });
      return async () => {
        await rm(path, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      const age = await stat(path)
        .then((metadata) => Date.now() - metadata.mtimeMs)
        .catch(() => 0);
      if (age < REVIVE_LOCK_STALE_MS) return undefined;
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
  return undefined;
}

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
     * Called when a session is *over* — stopped, archived, removed. An
     * attention badge on a session that is over is the purest form of a badge
     * outliving its cause.
     *
     * Deliberately not called when a session merely goes `lost`. Lost is not
     * over: the tmux server died under a still-open conversation, and the
     * revive sweep puts the agent back at the very point it was blocked at.
     * Clearing the badge there would wipe every reason the user had to look,
     * at exactly the moment a reboot gave them a whole board of them.
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

  private readonly modelCatalogs = new Map<
    "codex" | "claude",
    { fetchedAt: number; catalog: ProviderModelCatalog }
  >();

  async models(provider: "codex" | "claude"): Promise<ProviderModelCatalog> {
    const catalog = await discoverProviderModels(this.config, provider);
    this.modelCatalogs.set(provider, { fetchedAt: Date.now(), catalog });
    return catalog;
  }

  /**
   * The provider's catalog for checking a default against, reusing the one
   * the app loaded for its picker when it is recent enough. A catalog that
   * cannot be read at all resolves to undefined: an unverifiable default is
   * not a stale one.
   */
  private async knownModels(
    provider: "codex" | "claude",
  ): Promise<ProviderModelCatalog | undefined> {
    const cached = this.modelCatalogs.get(provider);
    if (cached && Date.now() - cached.fetchedAt < MODEL_CATALOG_TTL_MS)
      return cached.catalog;
    try {
      return await this.models(provider);
    } catch {
      return undefined;
    }
  }

  /**
   * The `--model` a new session starts with.
   *
   * An explicit choice wins. Otherwise the workspace's default model applies
   * when this is the provider it was set for, and nothing is passed for any
   * other provider, which then uses its own default. The workspace default
   * exists because a provider's own default drifts: Claude writes the last
   * `/model` choice from any session into the user's settings, so "default"
   * there means "whatever the previous session ended on".
   *
   * A stored default outlives the catalog it was picked from, so it is
   * checked against the live catalog before launch and refused, with the way
   * to fix it, rather than starting a session whose every turn would fail.
   * An explicit model is never checked: the user typed it, and the catalog
   * lists aliases, not every id the provider accepts.
   */
  private async launchModel(
    workspace: Workspace,
    provider: "claude" | "codex" | "custom",
    requested: string | undefined,
  ): Promise<string | undefined> {
    const explicit = requested?.trim();
    if (explicit) return explicit;
    const defaultModel = workspace.defaultModel;
    if (
      defaultModel &&
      provider !== "custom" &&
      workspace.defaultProvider === provider
    ) {
      const catalog = await this.knownModels(provider);
      if (catalog && !catalogOffersModel(catalog, defaultModel))
        throw new DaedalusError(
          "VALIDATION",
          `Workspace default model '${defaultModel}' is not offered by ${provider === "claude" ? "Claude" : "Codex"} any more. Choose another with 'daedal workspace update ${workspace.slug} --default-model <model>|none' or pass --model.`,
          { workspaceId: workspace.id, provider, defaultModel },
        );
      return defaultModel;
    }
    // Claude with nothing chosen is asked for its recommended model by name
    // rather than launched with no `--model`, which would hand it the last
    // `/model` pick from its settings file. A model in the Daedalus agent
    // arguments is already in the launch and has to stay the last one.
    if (
      provider === "claude" &&
      !modelArgument(this.config.agents.claude?.args ?? [])
    )
      return CLAUDE_DEFAULT_MODEL;
    return undefined;
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
    /**
     * Launch the session to write the task's brief rather than to do the task.
     * It is still linked to the task, so the board shows it, but it does not
     * count as starting the work and leaves the status alone.
     */
    draftBrief?: boolean;
    /**
     * Internal to `continueSession`: run in this session's working directory,
     * take over its worktrees, and launch with the continuation prompt.
     */
    continueFrom?: AgentSession;
    handoff?: boolean;
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
    // Resolved before anything is prepared on disk, so a default the
    // provider no longer offers refuses here and leaves no worktree behind.
    const model = provider
      ? await this.launchModel(workspace, provider.name, input.model)
      : undefined;
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
          workingDirectory: input.continueFrom?.workingDirectory,
        })
      : { workingDirectory: workspace.path, worktrees: [], references: [] };
    if (input.draftBrief && !task)
      throw new DaedalusError(
        "VALIDATION",
        "Drafting a brief needs the task it is for",
      );
    const launchPrompt = buildAgentPrompt({
      taskNumber: task?.number,
      message: input.message,
      mode: input.continueFrom
        ? "continue"
        : input.draftBrief
          ? "draft-brief"
          : "execute",
      handoff: input.handoff,
    });
    const launch = input.terminal
      ? { executable: shell!, args: ["-l"], env: {} }
      : await provider!.adapter.buildLaunch({
          taskId: task?.id,
          sessionId: id,
          sessionName: name,
          prompt: launchPrompt,
          model,
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
      lostReason: null,
      handoffRequestedAt: null,
      resumeOnStart: false,
      // Top of its workspace's list, leaving any manual order below it intact.
      position: this.repositories.nextAgentPosition(workspace.id),
    };
    this.repositories.createAgent(session);
    // Moved before the provider starts, so the new agent never sees a
    // worktree directory that no row claims and tries to create it again.
    if (input.continueFrom)
      this.repositories.reassignSessionWorktrees(
        input.continueFrom.id,
        session.id,
      );
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
      if (task && !input.terminal && !input.draftBrief && !input.continueFrom)
        this.markTaskStarted(workspace, task.id);
      return running;
    } catch (error) {
      if (input.continueFrom)
        this.repositories.reassignSessionWorktrees(
          session.id,
          input.continueFrom.id,
        );
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

  /**
   * The one-click half of a handoff: asks a running agent to write a note for
   * its successor and then run `daedal agent continue` itself.
   */
  async requestHandoff(id: string): Promise<AgentSession> {
    const agent = await this.requireContinuable(id);
    await this.send(agent.id, buildHandoffRequest(agent.workingDirectory));
    const requested = {
      ...agent,
      handoffRequestedAt: new Date().toISOString(),
    };
    this.repositories.updateAgent(requested);
    return requested;
  }

  /**
   * Asks every running session whose context has passed its workspace's
   * threshold to hand off. Once per session: a request already made stands
   * until the successor archives it, so the agent is not nagged every tick
   * while it writes the note.
   */
  async sweepAutoHandoffs(
    telemetry: ReadonlyArray<{
      sessionId: string;
      context?: { usedPercent?: number };
    }>,
  ): Promise<AgentSession[]> {
    const thresholds = new Map(
      this.repositories
        .listWorkspaces()
        .filter((workspace) => workspace.autoHandoffPercent !== null)
        .map((workspace) => [workspace.id, workspace.autoHandoffPercent!]),
    );
    if (thresholds.size === 0) return [];
    const usage = new Map(
      telemetry.map((item) => [item.sessionId, item.context?.usedPercent]),
    );
    const requested: AgentSession[] = [];
    for (const agent of this.repositories.listAgents()) {
      const threshold = thresholds.get(agent.workspaceId);
      const percent = usage.get(agent.id);
      if (
        threshold === undefined ||
        percent === undefined ||
        percent < threshold ||
        agent.kind !== "agent" ||
        agent.status !== "running" ||
        agent.archivedAt ||
        agent.handoffRequestedAt ||
        (agent.provider !== "claude" && agent.provider !== "codex")
      )
        continue;
      try {
        requested.push(await this.requestHandoff(agent.id));
      } catch {
        // A session that vanished between the list and the send is the
        // reconcile pass's business, not this one's.
      }
    }
    return requested;
  }

  /**
   * Moves a session's work to a fresh one with an empty context: same task,
   * same working directory, same worktrees. The handoff note, when there is
   * one, is written to `HANDOFF.md` there and the successor is told to read
   * it. The predecessor is archived, which keeps its conversation restorable.
   *
   * `archive: "later"` leaves that to the caller. An agent that runs this on
   * itself cannot be archived from inside the same process: stopping its tmux
   * session interrupts the command that is doing the stopping.
   */
  async continueSession(input: {
    id: string;
    handoff?: string;
    provider?: "codex" | "claude";
    model?: string;
    message?: string;
    archive?: "now" | "later";
  }): Promise<{
    session: AgentSession;
    predecessor: AgentSession;
    archiveError?: string;
  }> {
    const predecessor = await this.requireContinuable(input.id);
    const provider =
      input.provider ??
      (predecessor.provider === "codex" || predecessor.provider === "claude"
        ? predecessor.provider
        : undefined);
    if (!provider)
      throw new DaedalusError(
        "VALIDATION",
        "A custom session has no provider to continue with; pass --provider",
      );
    // Marked whether the request came from Daedalus or the agent decided on
    // its own, so the app can follow this session to its successor either way.
    if (!predecessor.handoffRequestedAt)
      this.repositories.updateAgent({
        ...predecessor,
        handoffRequestedAt: new Date().toISOString(),
      });
    const handoff = input.handoff?.trim();
    if (handoff)
      await writeFile(
        join(predecessor.workingDirectory, HANDOFF_FILE),
        `${handoff}\n`,
        "utf8",
      );
    const session = await this.spawn({
      workspace: predecessor.workspaceId,
      taskId: predecessor.taskId ?? undefined,
      name: predecessor.name,
      provider,
      // A different provider would not understand the old one's model name.
      model:
        input.model ??
        (provider === predecessor.provider
          ? sessionLaunchModel(predecessor.args)
          : undefined),
      message: input.message,
      continueFrom: predecessor,
      handoff: Boolean(handoff),
    });
    if (input.archive === "later") return { session, predecessor };
    try {
      return {
        session,
        predecessor: await this.archive(predecessor.id),
      };
    } catch (error) {
      // The successor is already running and holds the worktrees, so a
      // predecessor that will not archive is reported, not rolled back.
      return {
        session,
        predecessor: await this.get(predecessor.id),
        archiveError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async requireContinuable(id: string): Promise<AgentSession> {
    const agent = await this.get(id);
    if (agent.kind !== "agent")
      throw new DaedalusError(
        "CONFLICT",
        "Only agent sessions can hand their work to a new session",
      );
    if (agent.archivedAt)
      throw new DaedalusError(
        "CONFLICT",
        "An archived session cannot hand off its work; restore it first",
      );
    if (!(await pathExists(agent.workingDirectory)))
      throw new DaedalusError(
        "CONFLICT",
        `Working directory ${agent.workingDirectory} no longer exists`,
      );
    return agent;
  }

  /**
   * Settles which rows are still backed by a live tmux session.
   *
   * Observation only: it never starts anything. It runs on nearly every CLI
   * command and on the desktop poll, so a sweep triggered from here would mean
   * `daedal agent list` resurrecting agents. Revival is an explicit call —
   * `reviveLostSessions`.
   */
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
          // Activity and attention are deliberately left alone: see
          // `onSessionEnded`. `lostReason` is cleared so it always describes
          // this disappearance rather than the last one.
          this.repositories.updateAgent({
            ...agent,
            status: "lost",
            endedAt: now,
            lostReason: null,
            handoffRequestedAt: null,
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

  /**
   * Puts the named sessions in the order given, within one workspace. Naming a
   * subset rearranges only that subset, so a drag in a filtered list leaves
   * the hidden sessions where they are.
   */
  async reorder(
    workspaceReference: string,
    sessionIds: string[],
  ): Promise<AgentSession[]> {
    const workspace = await this.workspaces.get(workspaceReference);
    const current = this.repositories.listAgents({
      workspaceId: workspace.id,
    });
    // Scoped to the workspace on purpose: a session id from somewhere else is
    // not a session this list can place, and silently ignoring it would leave
    // the caller believing an order that never happened.
    this.repositories.reorderAgents(
      workspace.id,
      applyManualOrder(
        current.map((item) => item.id),
        sessionIds,
        "Agent session",
      ),
    );
    return this.repositories.listAgents({ workspaceId: workspace.id });
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
    // Working trees used to outlive every session that ever held one, which is
    // what made a repository permanently undetachable. Only trees that
    // provably hold nothing are cleared; anything with uncommitted or unpushed
    // work is left exactly where it is.
    await this.workspaceContent.releaseSessionWorktrees(id);
    this.onSessionEnded(id);
    return archived;
  }

  async restore(id: string): Promise<AgentSession> {
    const agent = await this.get(id);
    if (!agent.archivedAt)
      throw new DaedalusError("CONFLICT", "Session is not archived");
    return this.relaunch({ ...agent, resumeOnStart: false });
  }

  /**
   * Brings back what "Quit and stop sessions" put away, which is what makes
   * that a pause rather than a farewell.
   *
   * Separate from `reviveLostSessions` because the two recover different
   * things: revival is for sessions the OS killed and left `lost`, this is for
   * ones Daedalus archived on purpose and promised to return. A session the
   * user archived by hand has no flag and is deliberately left alone.
   *
   * Per-session try/catch throughout, and the flag is cleared either way: a
   * session that cannot come back must cost nothing but its own card, and must
   * not be retried on every launch from now on.
   */
  async resumeMarkedSessions(): Promise<{
    resumed: AgentSession[];
    skipped: { sessionId: string; name: string; reason: string }[];
  }> {
    const result: {
      resumed: AgentSession[];
      skipped: { sessionId: string; name: string; reason: string }[];
    } = { resumed: [], skipped: [] };
    const marked = this.repositories
      .listAgents()
      .filter((agent) => agent.resumeOnStart && agent.archivedAt);
    if (!marked.length) return result;
    if (!(await this.tmux.probe())) return result;
    for (const agent of marked) {
      try {
        result.resumed.push(await this.restore(agent.id));
      } catch (error) {
        this.repositories.updateAgent({ ...agent, resumeOnStart: false });
        result.skipped.push({
          sessionId: agent.id,
          name: agent.name,
          reason: reviveFailureReason(error),
        });
      }
    }
    return result;
  }

  /**
   * Brings one vanished session back with its conversation resumed, leaving it
   * idle at its prompt. Nothing is sent to the agent: a resume loads history
   * and waits, which is the whole reason this is safe to do unattended.
   *
   * Not archive-then-restore. That would run `codex archive` immediately
   * followed by `codex unarchive` on a conversation nobody asked to archive,
   * for no gain but two extra ways to fail.
   */
  async reviveLost(id: string): Promise<AgentSession> {
    return this.reviveLostSession(await this.get(id));
  }

  private async reviveLostSession(agent: AgentSession): Promise<AgentSession> {
    if (agent.archivedAt)
      throw new DaedalusError(
        "CONFLICT",
        "Archived sessions come back through restore, not revive",
      );
    if (agent.status !== "lost")
      throw new DaedalusError(
        "CONFLICT",
        `Agent session '${agent.id}' is not lost`,
      );
    try {
      // Named before `prepareArchivable` gets to it, because its refusal is
      // worded for archiving and this reason is read off a session card.
      if (agent.kind === "agent" && agent.provider === "custom")
        throw new DaedalusError(
          "CONFLICT",
          "Custom sessions do not define a native resume capability",
        );
      if (!(await pathExists(agent.workingDirectory)))
        throw new DaedalusError(
          "CONFLICT",
          `Working directory ${agent.workingDirectory} no longer exists`,
        );
      // Really "make this resumable": it rescues a `providerSessionId` that
      // was never recorded from the provider's own transcript directory.
      return await this.relaunch(await this.prepareArchivable(agent));
    } catch (error) {
      const current = this.repositories.findAgent(agent.id);
      // A session whose revive failed stays lost and says why, rather than
      // being one more indistinguishable red dot on a board full of them.
      if (current && current.status === "lost")
        this.repositories.updateAgent({
          ...current,
          lostReason: reviveFailureReason(error),
        });
      throw error;
    }
  }

  /**
   * Starts a fresh tmux runtime for a session that already exists, resuming
   * its native conversation. Shared by `restore` (archived, deliberately) and
   * `reviveLost` (vanished with the tmux server), which differ in how the
   * session stopped being live, not in how it comes back.
   */
  private async relaunch(agent: AgentSession): Promise<AgentSession> {
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
          // Only a conversation Daedalus archived needs unarchiving. A session
          // that merely lost its tmux server never left Codex's active list,
          // and `codex unarchive` on one fails with wording that has nothing
          // to do with the single message `isMissingCodexConversationError`
          // forgives — which would abort a revive that was about to work.
          if (agent.archivedAt) {
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
          }
          args = [
            ...definition.args,
            ...CODEX_DAEDALUS_TUI_ARGS,
            ...(await ensureCodexHooks(this.config, executable)),
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
            ...(await ensureCodexHooks(this.config, executable)),
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
      lostReason: null,
      handoffRequestedAt: null,
    };
    // Last thing before the launch, because the window between the sweep's own
    // check and this one is where a racing CLI would put a second runtime on
    // the same tmux name for the same conversation.
    if (await this.tmux.hasSession(agent.tmuxSession))
      throw new DaedalusError(
        "CONFLICT",
        `tmux session '${agent.tmuxSession}' is already live`,
      );
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
      // A launch that got as far as tmux but not as far as a ready provider
      // leaves a live session behind a row that says otherwise. Nothing
      // reconciles that direction, so it is cleaned up here.
      if (await this.tmux.hasSession(restoring.tmuxSession))
        await this.tmux
          .stop(restoring.tmuxSession, true)
          .catch(() => undefined);
      // Only put back what was taken out. A revived session's conversation was
      // never archived, so archiving it on a failed relaunch would hide a
      // conversation the user never asked to put away.
      if (
        agent.archivedAt &&
        agent.provider === "codex" &&
        agent.providerSessionId
      )
        await runCommand(executable, ["archive", agent.providerSessionId], {
          cwd: workspace.path,
        }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Brings every `lost`, non-archived session back, which is what a Mac reboot
   * leaves behind: tmux sessions survive quitting the app but not a restart of
   * the machine, so `reconcile` finds a whole board of them at once.
   *
   * Serialized and throttled rather than fired in parallel, guarded by a
   * cross-process lock, and per-session try/catch throughout: one session that
   * cannot come back must cost nothing but its own card.
   */
  async reviveLostSessions(
    options: {
      workspaceId?: string;
      /**
       * A startup sweep obeys the user's setting. An explicit
       * `daedal agent revive` is the user asking, and does not.
       */
      automatic?: boolean;
    } = {},
  ): Promise<ReviveSweepResult> {
    const result: ReviveSweepResult = { revived: [], skipped: [] };
    if (options.automatic && !this.config.autoRestoreSessionsEnabled)
      return { ...result, halted: "disabled" };
    // Without tmux there is nothing to put a session back into, and the whole
    // sweep would be one identical failure per card.
    if (!(await this.tmux.probe()))
      return { ...result, halted: "tmux_unavailable" };
    const release = await acquireReviveLock(this.config.home);
    if (!release) return { ...result, halted: "sweep_in_progress" };
    try {
      await this.reconcile();
      const queue = this.repositories
        .listAgents(
          options.workspaceId ? { workspaceId: options.workspaceId } : {},
        )
        .filter((agent) => agent.status === "lost" && !agent.archivedAt);
      const workers = Array.from({ length: REVIVE_CONCURRENCY }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const current = this.repositories.findAgent(next.id);
          if (!current || current.status !== "lost" || current.archivedAt)
            continue;
          if (await this.tmux.hasSession(current.tmuxSession)) {
            // Someone else won the race. Adopting the live session is right;
            // launching a second one under the same name is not.
            this.repositories.updateAgent({
              ...current,
              status: "running",
              endedAt: null,
              lostReason: null,
              handoffRequestedAt: null,
            });
            continue;
          }
          try {
            result.revived.push(await this.reviveLostSession(current));
          } catch (error) {
            result.skipped.push({
              sessionId: current.id,
              name: current.name,
              reason: reviveFailureReason(error),
            });
          }
        }
      });
      await Promise.all(workers);
    } finally {
      await release();
    }
    return result;
  }

  async archiveWorkspaceSessions(workspaceId: string): Promise<void> {
    const sessions = this.repositories
      .listAgents({ workspaceId })
      .filter((session) => !session.archivedAt);
    for (const session of sessions) await this.prepareArchivable(session);
    for (const session of sessions)
      if (!session.archivedAt) await this.archive(session.id);
  }

  /**
   * "Make this session resumable": rescues a `providerSessionId` that was
   * never recorded by matching the provider's own transcript directory against
   * the session's working directory and start time. Archiving needs it because
   * a locator is what makes an archive reversible; revival needs it for the
   * same reason, one machine reboot later.
   */
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
      "This existing session has no uniquely matching native conversation and cannot be resumed safely",
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

  /**
   * Starting a session on a task is the user deciding to begin it, whether
   * they clicked Start on the board or asked an agent to spawn one. That is
   * the one status change Daedalus makes on their behalf, and only forward:
   * `in_progress`, `done` and `cancelled` are left exactly as they are. The
   * agent's own lifecycle never reaches here.
   */
  private markTaskStarted(workspace: Workspace, taskId: string): void {
    if (!workspace.startSetsInProgress) return;
    const current = this.repositories.findTask(taskId);
    if (!current || (current.status !== "todo" && current.status !== "blocked"))
      return;
    this.tasks.setStatus(taskId, "in_progress");
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

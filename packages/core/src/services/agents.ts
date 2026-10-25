import { isCodexThread, podCodexRollout } from "./codex-move";
import type { SessionHost } from "./session-host";
import type { SessionHosts } from "./session-hosts";
import {
  asleepInCloud,
  cloudEnvironment,
  cloudHostId,
  CLOUD_SHELL,
  CLOUD_WORKING_DIRECTORY,
} from "./cloud-launch";
import { preparePodSession } from "./cloud-folder";
import {
  isPodAccess,
  POD_CLAUDE_PROJECTS,
  podWorkingDirectory,
} from "./move-side";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import {
  findExecutable,
  isPathInside,
  loginShellPath,
  pathExists,
  runCommand,
  type TmuxClient,
} from "@daedalus/platform";
import type { DaedalusConfig } from "../config";
import {
  accountModelKey,
  resolveAutoRebirth,
  SESSION_COLORS,
  type AgentActivityState,
  type AgentSession,
  type AutoRebirth,
  type SessionColor,
  type TeamMembership,
  type Workspace,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import {
  buildAgentPrompt,
  buildSkillInvocation,
  catalogOffersModel,
  CLAUDE_DEFAULT_MODEL,
  discoverProviderModels,
  REBIRTH_FILE,
  REBIRTH_SKILL,
  REFINEMENT_SKILL,
  rebirthSessionName,
  modelArgument,
  type ProviderModelCatalog,
  removeClaudeSettingsFiles,
  resolveAgentExecutable,
  resolveProvider,
  sessionLaunchModel,
} from "./providers";
import type { DeliveryResult, SessionChannel } from "./session-channel";
import { installedSkill, requireSkill } from "./installed-skills";
import { abilityDefinition, type AbilityService } from "./abilities";
import {
  accountConfig,
  accountEnvironment,
  accountProfile,
  DEFAULT_ACCOUNT,
  findAccount,
  providerLabel,
} from "./account-homes";
import type { AccountService } from "./accounts";
import { hasPersistedCodexSession } from "./codex-sessions";
import { forgetSessionFolders, trustSessionFolder } from "./folder-trust";
import { applyManualOrder } from "./ordering";
import type { TaskService } from "./tasks";
import { autoRebirthPercent, type WorkspaceService } from "./workspaces";
import type { WorkspaceContentService } from "./workspace-content";

const UUID_FILE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;
const CODEX_ROLLOUT_FILE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;
const CODEX_WRITER_LOCK =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.lock$/i;
// How long a rebirth request may go unanswered before it is made again, and
// how many times it is, each wait twice the last, before the user is told.
const REBIRTH_RETRY_MS = 15 * 60_000;
const REBIRTH_RETRIES = 3;
const SESSION_RECOVERY_WINDOW_MS = 60_000;
const SESSION_RECOVERY_UNIQUENESS_MS = 2_000;
const PROVIDER_STARTUP_TIMEOUT_MS = 30_000;
const PROVIDER_STARTUP_POLL_MS = 150;
// How long reconcile leaves a `starting` row with no tmux session alone. The
// row is written before tmux is asked for one, and on a loaded machine that
// launch takes seconds; a reconcile in the gap, or one holding a list taken
// before the launch, showed every new session as lost until it came up. The
// launcher marks its own failures `exited`, so this only waits out a launcher
// that died, and is well past its 30 second startup wait.
const STARTING_GRACE_MS = 2 * 60_000;
// How long a startup question must stay on screen before startup hands it to
// the user rather than treating it as a frame on the way to the prompt.
const STARTUP_QUESTION_SETTLE_MS = 2_000;
// How many sessions a revive sweep brings back at once. Every relaunch is a
// provider CLI re-reading a transcript, so ten sessions starting together at
// login is ten of those racing each other for the machine. Two at a time is still far faster than the
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
 * The directories a session is given beyond its working directory. Every
 * attached repository checked out under the workspace's `repos/` folder is
 * covered by that one folder: the session can still read all of them, and
 * the provider does not load each repository's own skills, commands and
 * agents into every session's startup context. With 76 repositories that
 * was about 6k tokens on every model call. A repository's skills still load
 * once the session works on files inside it.
 */
export function sessionDirectories(
  workspacePath: string,
  repositoryPaths: readonly string[],
): string[] {
  const reposFolder = join(workspacePath, "repos");
  const directories: string[] = [];
  for (const path of repositoryPaths) {
    const directory = isPathInside(reposFolder, path) ? reposFolder : path;
    if (!directories.includes(directory)) directories.push(directory);
  }
  return directories;
}

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
  // A rollout names its folder, so one in this session's folder outranks
  // writer locks, which name none: another Codex thread started in the same
  // seconds would otherwise make the match ambiguous.
  const rolloutCandidates = new Map<string, number>();
  const lockCandidates = new Map<string, number>();
  const addCandidate = (
    candidatesById: Map<string, number>,
    id: string,
    distance: number,
  ) => {
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
                addCandidate(rolloutCandidates, id, distance);
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
            addCandidate(lockCandidates, id, distance);
        } catch {
          // The owning Codex process may remove its lock while it exits.
        }
      }),
    );
  } catch {
    // Older Codex releases do not have a writer-lock directory.
  }
  const candidates = [
    ...(rolloutCandidates.size ? rolloutCandidates : lockCandidates),
  ].map(([id, distance]) => ({
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

/**
 * Claude's footer once it is ready for input. The relaxed modes print
 * "shift+tab to cycle"; the default mode prints
 * "manual mode on" instead, and older versions "? for shortcuts".
 */
export const claudeReady = (screen: string): boolean =>
  screen.includes("shift+tab to cycle") ||
  screen.includes("manual mode on") ||
  screen.includes("? for shortcuts");

/**
 * Screens on which the provider stopped to ask the user something before
 * reaching its prompt. Recognising one only hands it over sooner; a screen
 * this list misses is handed over when the startup timeout runs out.
 */
export const startupQuestion = (provider: string, screen: string): boolean =>
  provider === "codex"
    ? screen.includes("Trust this folder?") ||
      screen.includes("Do you trust the contents of this directory?") ||
      /enter (?:to )?continue/i.test(screen)
    : provider === "claude"
      ? screen.includes("Yes, I trust this folder") ||
        screen.includes("Allow external CLAUDE.md file imports?") ||
        (/Enter to confirm/.test(screen) && /Esc to cancel/.test(screen))
      : false;

const startupQuestionReason = (session: AgentSession): string =>
  `${providerLabel(session.provider)} is asking something before it starts. Answer it in the session's terminal.`;

/** Set by a session move; see `AgentService.resumeAfterMove`. */
interface RelaunchOptions {
  permissionMode?: string;
  /** The session has no conversation yet; see `ResumeInput.fresh`. */
  fresh?: boolean;
}

/** What a cloud launch adds for its account. */
export interface CloudLaunchExtras {
  env?: Record<string, string>;
  /** In place of the workspace's launch secrets, when set. */
  secrets?: Record<string, string>;
}

export class AgentService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaces: WorkspaceService,
    private readonly workspaceContent: WorkspaceContentService,
    private readonly tasks: TaskService,
    private readonly hosts: SessionHosts,
    /**
     * This Mac's tmux, for what only makes sense here: an interactive
     * `tmux attach` in the user's own terminal, and the version it reports.
     */
    private readonly tmux: TmuxClient,
    private readonly config: DaedalusConfig,
    private readonly abilities: AbilityService,
    private readonly accounts: AccountService,
    /** How Daedalus hands a rebirth request to a running session. */
    private readonly channel: SessionChannel,
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
    /**
     * Puts a reason on a session's Needs me badge: a question at startup, or
     * a rebirth that keeps not happening.
     */
    private readonly raiseAttention: (
      sessionId: string,
      reason: string,
    ) => unknown = () => undefined,
    /**
     * Called when a Claude or Codex session reached its prompt at startup.
     * Codex fires no hook until the first prompt, and a resumed session none
     * until it is used, so without this the card has no reading and shows the
     * lifecycle word "Running" for a session that is sitting idle.
     */
    private readonly onStartupReady: (sessionId: string) => unknown = () =>
      undefined,
  ) {}

  private teamLaunchLines: (member: TeamMembership) => string[] = () => [];

  /** What a team member is told at launch; set by the team service. */
  onTeamLaunch(lines: (member: TeamMembership) => string[]): void {
    this.teamLaunchLines = lines;
  }

  private sessionRunning: (session: AgentSession) => Promise<unknown> =
    async () => undefined;

  /**
   * Called once a spawn, restore or revive has the session running, such as
   * to send it team messages that waited while it was not. A resumed session
   * sits idle, so its own hooks may not fire again for a long time. Must not
   * throw.
   */
  onSessionRunning(run: (session: AgentSession) => Promise<unknown>): void {
    this.sessionRunning = run;
  }

  private cloudAsleep:
    ((sessionId: string) => Promise<AgentSession>) | undefined;

  /**
   * How a session lost to its cloud workspace's sleep is woken and resumed,
   * for a message to it: `CloudSessions`, which knows the cloud.
   */
  onCloudAsleep(wake: (sessionId: string) => Promise<AgentSession>): void {
    this.cloudAsleep = wake;
  }

  /**
   * A cloud session read as lost whose tmux session still lives in its pod,
   * because the sleep it was lost to did not happen: running again, as it
   * was. Undefined when it is not live there.
   */
  async reclaimLiveCloud(id: string): Promise<AgentSession | undefined> {
    const agent = await this.get(id);
    if (!agent.hostId || agent.status !== "lost" || agent.archivedAt)
      return undefined;
    const live = await this.hosts
      .get(agent.hostId)
      .isLive(agent.tmuxSession)
      .catch(() => false);
    if (!live) return undefined;
    const running: AgentSession = {
      ...agent,
      status: "running",
      endedAt: null,
      exitCode: null,
      lostReason: null,
    };
    this.repositories.updateAgent(running);
    await this.sessionRunning(running);
    return running;
  }

  /**
   * Wakes and resumes a session its cloud workspace's sleep ended, so a
   * message can reach it; anything else comes back as it is.
   */
  async wakeIfAsleep(agent: AgentSession): Promise<AgentSession> {
    return asleepInCloud(agent) && this.cloudAsleep
      ? this.cloudAsleep(agent.id)
      : agent;
  }

  /** Raises the badge for a session that stopped on a question at startup. */
  private askedAtStartup(session: AgentSession): void {
    void this.raiseAttention(session.id, startupQuestionReason(session));
  }

  private async readyAtStartup(session: AgentSession): Promise<void> {
    if (session.provider === "codex" || session.provider === "claude")
      await this.onStartupReady(session.id);
  }

  /**
   * Whether the session's only badge is the startup question. The provider
   * then exited before it ever reached its prompt (Codex quits after the
   * update its startup menu offers), so there is no conversation to revive
   * at that point and the question is gone with the process.
   */
  private endedAtStartupQuestion(agent: AgentSession): boolean {
    const reasons = this.repositories.findSessionAttention(agent.id)?.reasons;
    const asked = startupQuestionReason(agent);
    return (
      !!reasons &&
      reasons.length > 0 &&
      reasons.every((reason) => reason.text === asked)
    );
  }

  /** Records the provider's trust for the session folder, if allowed. */
  private async trustFolder(session: AgentSession): Promise<void> {
    if (!this.config.trustSessionFoldersEnabled) return;
    await trustSessionFolder(
      this.sessionConfig(session),
      session.provider,
      session.workingDirectory,
    );
  }

  /** The configuration with this session's account folders in place. */
  private sessionConfig(agent: AgentSession): DaedalusConfig {
    return accountConfig(this.config, agent.provider, agent.account);
  }

  private async agentEnvironment(
    session: AgentSession,
    environment: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const task = session.taskId
      ? this.repositories.findTask(session.taskId)
      : undefined;
    // An agent runs what the user's terminal would: Homebrew, nvm and the
    // rest come from the login shell, not from the app's Launch Services
    // PATH, which has none of them. The bundled `daedal` comes first.
    const path = [
      ...new Set(
        [
          join(this.config.home, "bin"),
          environment.PATH,
          (await loginShellPath()) ?? process.env.PATH,
        ]
          .filter(Boolean)
          .flatMap((value) => value!.split(":"))
          .filter(Boolean),
      ),
    ].join(":");
    return {
      ...environment,
      ...accountEnvironment(this.config, session.provider, session.account),
      PATH: path,
      DAEDALUS_HOME: this.config.home,
      DAEDALUS_SESSION_ID: session.id,
      DAEDALUS_SESSION_DIRECTORY: session.workingDirectory,
      DAEDALUS_WORKSPACE_ID: session.workspaceId,
      ...(task
        ? {
            DAEDALUS_TASK_ID: task.id,
            DAEDALUS_TASK_NUMBER: String(task.number),
          }
        : {}),
    };
  }

  /**
   * Waits for the provider to reach its prompt. Daedalus only reads the
   * screen here and never types into it: trust for the session folder was
   * recorded in the provider's configuration before launch (when the user
   * allows it). Anything the provider still asks at startup is the user's to
   * answer: a trust prompt with that setting off, an update offer, a terms
   * notice. Resolves `question` for those, which leaves the session
   * open at the screen and marks it as needing the user, rather than closing
   * it as a failed start.
   */
  private async waitForProviderReady(
    provider: string,
    tmuxSession: string,
    host: SessionHost = this.hosts.local,
  ): Promise<"ready" | "question"> {
    if (provider !== "codex" && provider !== "claude") return "ready";
    // When a recognised question was first seen, so a frame only passing
    // through on the way to the prompt is not mistaken for one.
    let questionSince: number | undefined;
    const deadline = Date.now() + PROVIDER_STARTUP_TIMEOUT_MS;
    let lastScreen = "";

    while (Date.now() < deadline) {
      if (!(await host.isLive(tmuxSession)))
        throw new DaedalusError(
          "INTERNAL",
          `${provider} exited before finishing startup`,
          {
            startupOutput: lastScreen.replace(/\s+/g, " ").trim().slice(-600),
          },
        );
      const screen = await host.capture(tmuxSession);
      lastScreen = screen;

      // Readiness is checked first: an answered prompt stays in the
      // scrollback beside the ready marker.
      if (
        (provider === "codex" && screen.includes("Ask Codex to do anything")) ||
        (provider === "claude" && claudeReady(screen))
      )
        return "ready";
      if (provider === "codex" && screen.includes("Hooks need review"))
        // Daedalus injects Codex's activity hooks, and Codex gates them behind
        // a one-time review because a trusted hook runs outside the sandbox.
        // The session is usable either way, and until the user answers it
        // activity runs on the rollout tier, so this one is not a question
        // that blocks startup.
        return "ready";
      if (
        provider === "codex" &&
        host !== this.hosts.local &&
        screen.includes("Sign in with ChatGPT")
      )
        // A cloud Codex signed out: the cloud service picks the method, and
        // the sign-in panel takes the user through the page.
        return "ready";
      if (startupQuestion(provider, screen)) {
        questionSince ??= Date.now();
        if (Date.now() - questionSince >= STARTUP_QUESTION_SETTLE_MS)
          return "question";
      } else questionSince = undefined;

      await Bun.sleep(PROVIDER_STARTUP_POLL_MS);
    }

    if (!(await host.isLive(tmuxSession)))
      throw new Error(`${provider} exited before finishing startup`);
    // Still running but not at its prompt: some screen this code does not
    // know, which a new provider release can add at any time. The user can
    // see and answer it; closing the session would take that away.
    return "question";
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

  // Keyed by provider and account: a plan decides which models an account
  // is offered, so one account's catalog says nothing about another's.
  private readonly modelCatalogs = new Map<
    string,
    { fetchedAt: number; catalog: ProviderModelCatalog }
  >();

  async models(
    provider: "codex" | "claude",
    account?: string | null,
  ): Promise<ProviderModelCatalog> {
    const id = account
      ? findAccount(this.config, provider, account)?.id
      : undefined;
    const catalog = await discoverProviderModels(
      accountConfig(this.config, provider, id),
      provider,
      accountEnvironment(this.config, provider, id),
    );
    this.modelCatalogs.set(`${provider}:${id ?? DEFAULT_ACCOUNT}`, {
      fetchedAt: Date.now(),
      catalog,
    });
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
    account: string | null,
  ): Promise<ProviderModelCatalog | undefined> {
    const cached = this.modelCatalogs.get(
      `${provider}:${account ?? DEFAULT_ACCOUNT}`,
    );
    if (cached && Date.now() - cached.fetchedAt < MODEL_CATALOG_TTL_MS)
      return cached.catalog;
    try {
      return await this.models(provider, account);
    } catch {
      return undefined;
    }
  }

  /**
   * The `--model` a new session starts with.
   *
   * An explicit choice wins. Otherwise the model the workspace remembers for
   * this provider account applies, and with none the provider uses its own
   * default. It is per account because accounts take different ids: a
   * Bedrock account's `us.anthropic.…` is refused by a Claude subscription,
   * and the reverse. The workspace default
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
    account: string | null,
  ): Promise<string | undefined> {
    const explicit = requested?.trim();
    if (explicit) return explicit;
    const defaultModel =
      provider === "custom"
        ? undefined
        : workspace.accountModels[accountModelKey(provider, account)];
    if (defaultModel && provider !== "custom") {
      const catalog = await this.knownModels(provider, account);
      if (catalog && !catalogOffersModel(catalog, defaultModel))
        throw new DaedalusError(
          "VALIDATION",
          `Workspace default model '${defaultModel}' is not offered by ${provider === "claude" ? "Claude" : "Codex"} any more on ${account ? "this" : "the default"} account. Pick another in Create session with "Remember for this workspace" on, use 'daedal workspace update ${workspace.slug} --default-model <model>|none' for the default account, or pass --model.`,
          { workspaceId: workspace.id, provider, account, defaultModel },
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

  private cloudSecrets: (
    workspaceId: string,
  ) => Promise<Record<string, string>> = async () => ({});

  private cloudLaunch: (session: AgentSession) => Promise<CloudLaunchExtras> =
    async () => ({});

  /**
   * Readies a cloud Claude session's pod before each launch: the files that
   * skip Claude's first-run screens, and what its account adds to the
   * launch. Set by the context, from the cloud service.
   */
  onCloudLaunch(
    prepare: (session: AgentSession) => Promise<CloudLaunchExtras>,
  ): void {
    this.cloudLaunch = prepare;
  }

  private cloudReady: (
    session: AgentSession,
    launch: { apiKey: boolean },
  ) => Promise<void> = async () => {};

  /**
   * Told when a cloud Claude session is up, after a spawn or a revive, so it
   * can be signed in. Not awaited: the session is running either way.
   */
  onCloudReady(
    ready: (
      session: AgentSession,
      launch: { apiKey: boolean },
    ) => Promise<void>,
  ): void {
    this.cloudReady = ready;
  }

  private cloudHost: (workspaceId: string) => Promise<string> = async () => {
    throw new DaedalusError("DEPENDENCY", "No cloud service is connected");
  };

  /**
   * Makes or wakes a workspace's cloud copy for a new session and returns
   * its host id. Set by the context, from the cloud service.
   */
  onCloudHost(prepare: (workspaceId: string) => Promise<string>): void {
    this.cloudHost = prepare;
  }

  /** Reads the secrets a cloud session is launched with; set by the context. */
  onCloudSecrets(
    read: (workspaceId: string) => Promise<Record<string, string>>,
  ): void {
    this.cloudSecrets = read;
  }

  /**
   * Spawns on the workspace's cloud host: Claude, Codex or a login shell,
   * each in its own folder of the pod. Hooks reach the Mac through the
   * pod's `daedal`, which the runner relays.
   */
  private async spawnCloud(
    input: Parameters<AgentService["spawn"]>[0] & { host: string },
  ): Promise<AgentSession> {
    const workspace = await this.workspaces.getActive(input.workspace);
    const cloudId = this.repositories.cloudWorkspaceId(workspace.id);
    if (!cloudId || input.host !== cloudHostId(cloudId))
      throw new DaedalusError(
        "VALIDATION",
        "A cloud session runs on its own workspace's cloud host",
      );
    if (input.command)
      throw new DaedalusError(
        "CONFLICT",
        "A custom command cannot run in the cloud; move the workspace home to this Mac to run it",
      );
    if (input.terminal && input.provider)
      throw new DaedalusError(
        "VALIDATION",
        "A terminal session cannot also select an agent provider",
      );
    const provider = input.terminal ? undefined : (input.provider ?? "claude");
    if (provider !== undefined && provider !== "claude" && provider !== "codex")
      throw new DaedalusError(
        "CONFLICT",
        "Only Claude and Codex run in the cloud; move the workspace home to this Mac to start it",
      );
    const agentProvider = provider ?? "claude";
    if (input.draftBrief && !input.taskId)
      throw new DaedalusError(
        "VALIDATION",
        "Drafting a brief needs the task it is for",
      );
    const predecessor = input.continueFrom;
    // A terminal has no account. An agent runs on the one asked for, else
    // the previous session's, else the workspace's default; what it brings
    // to the pod is the cloud service's.
    const workspaceDefault =
      agentProvider === "codex"
        ? workspace.defaultCodexAccount
        : workspace.defaultClaudeAccount;
    const requestedAccount = input.terminal
      ? undefined
      : (input.account ??
        predecessor?.account ??
        (accountProfile(this.config, agentProvider, workspaceDefault)
          ? workspaceDefault
          : undefined));
    // Throws for an account that is not there.
    const profile = findAccount(this.config, agentProvider, requestedAccount);
    const task = input.taskId ? this.tasks.get(input.taskId) : undefined;
    if (task && task.workspaceId !== workspace.id)
      throw new DaedalusError(
        "VALIDATION",
        "Task does not belong to the selected workspace",
      );
    const requestedName = input.name?.trim();
    if (requestedName && requestedName.length > 240)
      throw new DaedalusError(
        "VALIDATION",
        "Session name must contain at most 240 characters",
      );
    if (input.color !== undefined) sessionColor(input.color);
    const host = this.hosts.get(input.host);
    const unavailable = await host.probe();
    if (unavailable) throw new DaedalusError("DEPENDENCY", unavailable);
    // A successor holds what its predecessor held.
    const abilities = predecessor
      ? this.abilities
          .list(predecessor.id)
          .filter((row) => row.enabled)
          .map((row) => row.ability)
      : this.abilities.validate(
          {
            kind: input.terminal ? "terminal" : "agent",
            provider: agentProvider,
            hostId: host.id,
          },
          input.abilities ?? [],
        );
    const id = crypto.randomUUID();
    const name =
      requestedName ||
      task?.title ||
      (input.terminal ? "Terminal" : `${providerLabel(agentProvider)} session`);
    const team =
      predecessor?.teamId && predecessor.teamHandle
        ? { teamId: predecessor.teamId, handle: predecessor.teamHandle }
        : input.team;
    const prompt = buildAgentPrompt({
      taskNumber: task?.number,
      refinement:
        input.draftBrief && !predecessor
          ? await this.refinementInvocation(agentProvider)
          : undefined,
      message: [
        ...this.abilities.launchLines(abilities),
        ...(team ? this.teamLaunchLines(team) : []),
        input.message?.trim(),
      ]
        .filter(Boolean)
        .join("\n\n"),
      mode: predecessor
        ? "continue"
        : input.draftBrief
          ? "draft-brief"
          : "execute",
      note: input.note,
    });
    // Its own folder in the pod, as on this Mac; a successor works where
    // its predecessor did, and a terminal opens at the workspace root.
    const workingDirectory = predecessor
      ? predecessor.workingDirectory
      : input.terminal
        ? CLOUD_WORKING_DIRECTORY
        : await preparePodSession(host, {
            task,
            sessionId: id,
            provider: agentProvider,
            instructions: this.config.workspaceInstructionFilesEnabled,
          });
    const {
      executable,
      args,
      providerSessionId: launchedId,
    }: {
      executable: string;
      args: string[];
      providerSessionId?: string;
    } = input.terminal
      ? { executable: CLOUD_SHELL, args: ["-l"] }
      : await resolveProvider(this.config, {
          provider: agentProvider,
        }).adapter.buildLaunch({
          target: "cloud",
          sessionId: id,
          sessionName: name,
          model: input.model,
          prompt,
          acceptPeerMessages:
            Boolean(team) || abilities.includes("orchestration"),
        });
    const session: AgentSession = {
      id,
      workspaceId: workspace.id,
      taskId: task?.id ?? null,
      name,
      provider: input.terminal ? "custom" : agentProvider,
      kind: input.terminal ? "terminal" : "agent",
      tmuxSession: `daedalus_${id.replaceAll("-", "")}`,
      command: executable,
      args,
      workingDirectory,
      status: "starting",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      // Codex names its own thread, which its first hook reports.
      providerSessionId: input.terminal ? null : (launchedId ?? null),
      archivedAt: null,
      resumeCount: 0,
      lostReason: null,
      rebirthRequestedAt: null,
      resumeOnStart: false,
      position: this.repositories.nextAgentPosition(workspace.id),
      pinnedAt:
        predecessor?.pinnedAt ??
        (input.pinned ? new Date().toISOString() : null),
      color: predecessor?.color ?? input.color ?? null,
      autoRebirthPercent: predecessor?.autoRebirthPercent ?? null,
      account: profile?.id ?? null,
      teamId: team?.teamId ?? null,
      teamHandle: team?.handle ?? null,
      spawnedBy: input.spawnedBy ?? null,
      hostId: host.id,
    };
    // Before the session exists: an account that cannot run in the cloud
    // (a Bedrock profile without SSO) leaves nothing behind.
    const extras =
      session.kind === "agent" ? await this.cloudLaunch(session) : {};
    this.repositories.transaction(() => {
      this.repositories.createAgent(session);
      if (!predecessor)
        for (const ability of abilities)
          this.abilities.grant(session.id, ability, { live: false });
    });
    if (predecessor)
      this.repositories.reassignSessionWorktrees(predecessor.id, session.id);
    try {
      const launched = await this.startCloud(host, session, extras);
      const startup = input.terminal
        ? "ready"
        : await this.waitForProviderReady(
            agentProvider,
            session.tmuxSession,
            host,
          );
      const running = { ...session, status: "running" as const };
      this.repositories.updateAgent(running);
      if (task && !input.terminal) this.markTaskStarted(workspace, task.id);
      if (startup === "question") this.askedAtStartup(running);
      else if (!input.terminal) await this.readyAtStartup(running);
      await this.sessionRunning(running);
      if (!input.terminal)
        void this.cloudReady(running, launched).catch(() => {});
      return running;
    } catch (error) {
      if (await host.isLive(session.tmuxSession).catch(() => false))
        await host.stop(session.tmuxSession, true).catch(() => undefined);
      this.repositories.updateAgent({
        ...session,
        status: "exited",
        endedAt: new Date().toISOString(),
      });
      throw new DaedalusError(
        error instanceof DaedalusError ? error.code : "INTERNAL",
        error instanceof Error ? error.message : String(error),
        error instanceof DaedalusError ? error.details : undefined,
      );
    }
  }

  /** Starts a cloud session's process with its environment and secrets. */
  private async startCloud(
    host: SessionHost,
    session: AgentSession,
    extras: CloudLaunchExtras,
  ): Promise<{ apiKey: boolean }> {
    const task = session.taskId
      ? this.repositories.findTask(session.taskId)
      : undefined;
    const secrets: Record<string, string> | undefined =
      session.kind === "agent"
        ? (extras.secrets ??
          (await this.cloudSecrets(session.workspaceId).catch(() => ({}))))
        : undefined;
    await host.start({
      session: session.tmuxSession,
      cwd: session.workingDirectory,
      executable: session.command,
      args: session.args,
      env: {
        ...cloudEnvironment({
          sessionId: session.id,
          workspaceId: session.workspaceId,
          workingDirectory: session.workingDirectory,
          task,
        }),
        ...extras.env,
      },
      secrets,
    });
    // Claude with an API key needs no sign-in.
    return { apiKey: Boolean(secrets?.ANTHROPIC_API_KEY) };
  }

  /**
   * Starts a cloud session again with its conversation resumed, as `relaunch`
   * does on this Mac. A sleeping workspace's pod is gone, so waking it leaves
   * every session that was running there lost, with its conversation on the
   * workspace volume.
   */
  private async relaunchCloud(
    agent: AgentSession,
    options: RelaunchOptions = {},
  ): Promise<AgentSession> {
    const host = this.hosts.get(agent.hostId);
    const unavailable = await host.probe();
    if (unavailable) throw new DaedalusError("DEPENDENCY", unavailable);
    const codex = agent.kind === "agent" && agent.provider === "codex";
    // Codex names its thread at the first turn, so a Codex session without
    // one starts a new conversation, as it does on this Mac.
    if (agent.kind === "agent" && !codex && !agent.providerSessionId)
      throw new DaedalusError(
        "CONFLICT",
        "This session has no conversation to resume",
      );
    // A session that never had a turn has no conversation in the pod, and
    // `--resume` would end it at once, its tmux server with it.
    const fresh =
      options.fresh ||
      (agent.kind === "agent" &&
        isPodAccess(host) &&
        (codex
          ? !(await podCodexRollout(host, agent.providerSessionId))
          : (
              await host.run({
                cwd: ".",
                executable: "test",
                args: [
                  "-f",
                  `${POD_CLAUDE_PROJECTS}/${claudeProjectKey(podWorkingDirectory(agent.workingDirectory))}/${agent.providerSessionId}.jsonl`,
                ],
              })
            ).exitCode !== 0));
    // The executable too: a session that moved here from this Mac recorded
    // this Mac's path to its provider, which the pod does not have.
    const launch =
      agent.kind === "agent"
        ? await resolveProvider(this.config, {
            provider: codex ? "codex" : "claude",
          }).adapter.buildLaunch({
            target: "cloud",
            sessionId: agent.id,
            sessionName: agent.name,
            model: modelArgument(agent.args),
            acceptPeerMessages:
              Boolean(agent.teamId) ||
              Boolean(this.abilities.held(agent.id, "orchestration")),
            resume: {
              ...(agent.providerSessionId
                ? { nativeId: agent.providerSessionId }
                : {}),
              startedAt: agent.startedAt,
              archived: Boolean(agent.archivedAt),
              workingDirectory: agent.workingDirectory,
              env: {},
              ...(options.permissionMode
                ? { permissionMode: options.permissionMode }
                : {}),
              ...(fresh ? { fresh: true } : {}),
            },
          })
        : undefined;
    const restoring: AgentSession = {
      ...agent,
      command: launch?.executable ?? agent.command,
      args: launch?.args ?? agent.args,
      status: "starting",
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      lostReason: null,
      rebirthRequestedAt: null,
    };
    if (await host.isLive(agent.tmuxSession))
      throw new DaedalusError(
        "CONFLICT",
        `tmux session '${agent.tmuxSession}' is already live`,
      );
    try {
      const launched = await this.startCloud(
        host,
        restoring,
        restoring.kind === "agent" ? await this.cloudLaunch(restoring) : {},
      );
      const startup =
        agent.kind === "agent"
          ? await this.waitForProviderReady(
              codex ? "codex" : "claude",
              restoring.tmuxSession,
              host,
            )
          : "ready";
      const restored: AgentSession = {
        ...restoring,
        status: "running",
        archivedAt: null,
        resumeCount: agent.resumeCount + 1,
      };
      if (agent.archivedAt)
        this.repositories.abilities.setPausedForSession(agent.id, false);
      this.repositories.updateAgent(restored);
      if (startup === "question") this.askedAtStartup(restored);
      else if (agent.kind === "agent") await this.readyAtStartup(restored);
      await this.sessionRunning(restored);
      if (agent.kind === "agent")
        void this.cloudReady(restored, launched).catch(() => {});
      return restored;
    } catch (error) {
      if (await host.isLive(restoring.tmuxSession).catch(() => false))
        await host.stop(restoring.tmuxSession, true).catch(() => undefined);
      throw error;
    }
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
     * The account profile to run on, by id or name; `default` for the
     * provider's own. Omitted means the workspace's default for the provider.
     */
    account?: string | null;
    /**
     * Launch the session to write the task's brief rather than to do the task.
     * It is still linked to the task, so the board shows it, but it does not
     * count as starting the work and leaves the status alone.
     */
    draftBrief?: boolean;
    /** The session that started this one from inside itself, as a handoff does. */
    spawnedBy?: string;
    /**
     * Internal to `continueSession`: run in this session's working directory,
     * take over its worktrees, and launch with the continuation prompt.
     */
    continueFrom?: AgentSession;
    note?: boolean;
    /** Abilities the session holds from the start, such as `routines`. */
    abilities?: string[];
    color?: SessionColor;
    pinned?: boolean;
    /** The team it joins, and its handle there. A successor keeps both. */
    team?: TeamMembership;
  }): Promise<AgentSession> {
    const workspace = await this.workspaces.getActive(input.workspace);
    // A workspace in the cloud runs every session there.
    if (workspace.place === "cloud")
      return this.spawnCloud({
        ...input,
        host: await this.cloudHost(workspace.id),
      });
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
    // A misspelt ability or colour is the caller's to fix whatever is
    // installed, so it is refused before tmux or the agent is looked for.
    // Whether the session may hold the abilities is decided further down.
    for (const ability of input.abilities ?? []) abilityDefinition(ability);
    const color =
      input.color === undefined ? undefined : sessionColor(input.color);
    if ((await this.hosts.local.probe()) !== undefined)
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
    const chosen = input.terminal
      ? undefined
      : resolveProvider(this.config, input);
    if (input.terminal && input.account && input.account !== DEFAULT_ACCOUNT)
      throw new DaedalusError(
        "VALIDATION",
        "A terminal session has no account",
      );
    // Probed first: it is what finds a provider installed only on the login
    // shell's PATH, and the sign-in check needs to find it too.
    if (chosen) {
      const availability = await chosen.adapter.probe();
      if (!availability.available)
        throw new DaedalusError(
          "DEPENDENCY",
          `Agent executable '${availability.executable}' is not available on PATH`,
        );
    }
    const account = chosen
      ? await this.accounts.forLaunch(chosen.name, {
          requested: input.account,
          previous: input.continueFrom,
          workspace,
        })
      : null;
    // The launch reads the account's own folders: its Codex config for hooks
    // and instructions, its Claude folder for skills.
    const provider =
      chosen && account
        ? resolveProvider(
            accountConfig(this.config, chosen.name, account),
            input,
          )
        : chosen;
    // Checked before anything is prepared, so a session that cannot hold an
    // ability is refused without leaving a worktree behind. A successor
    // holds what its predecessor held.
    const abilities = input.continueFrom
      ? this.abilities
          .list(input.continueFrom.id)
          .filter((row) => row.enabled)
          .map((row) => row.ability)
      : this.abilities.validate(
          {
            kind: input.terminal ? "terminal" : "agent",
            provider: provider?.name ?? "custom",
          },
          input.abilities ?? [],
        );
    // Resolved before anything is prepared on disk, so a default the
    // provider no longer offers refuses here and leaves no worktree behind.
    const model = provider
      ? await this.launchModel(workspace, provider.name, input.model, account)
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
          provider: provider?.name,
          workingDirectory: input.continueFrom?.workingDirectory,
        })
      : { workingDirectory: workspace.path, worktrees: [], references: [] };
    if (input.draftBrief && !task)
      throw new DaedalusError(
        "VALIDATION",
        "Drafting a brief needs the task it is for",
      );
    const team =
      input.continueFrom?.teamId && input.continueFrom.teamHandle
        ? {
            teamId: input.continueFrom.teamId,
            handle: input.continueFrom.teamHandle,
          }
        : input.team;
    const launchPrompt = buildAgentPrompt({
      taskNumber: task?.number,
      refinement:
        input.draftBrief && !input.continueFrom
          ? await this.refinementInvocation(provider?.name)
          : undefined,
      message: [
        ...this.abilities.launchLines(abilities),
        ...(team ? this.teamLaunchLines(team) : []),
        input.message?.trim(),
      ]
        .filter(Boolean)
        .join("\n\n"),
      mode: input.continueFrom
        ? "continue"
        : input.draftBrief
          ? "draft-brief"
          : "execute",
      note: input.note,
    });
    const launch = input.terminal
      ? { executable: shell!, args: ["-l"], env: {} }
      : await provider!.adapter.buildLaunch({
          taskId: task?.id,
          sessionId: id,
          sessionName: name,
          prompt: launchPrompt,
          model,
          acceptPeerMessages:
            Boolean(team) || abilities.includes("orchestration"),
          workingDirectory: prepared.workingDirectory,
          additionalDirectories: sessionDirectories(
            workspace.path,
            prepared.references.map(
              (repository) =>
                repository.referencePath ?? repository.canonicalPath,
            ),
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
      rebirthRequestedAt: null,
      resumeOnStart: false,
      // Top of its workspace's list, leaving any manual order below it intact.
      position: this.repositories.nextAgentPosition(workspace.id),
      pinnedAt:
        input.continueFrom?.pinnedAt ??
        (input.pinned ? new Date().toISOString() : null),
      color: input.continueFrom?.color ?? color ?? null,
      autoRebirthPercent: input.continueFrom?.autoRebirthPercent ?? null,
      account,
      teamId: team?.teamId ?? null,
      teamHandle: team?.handle ?? null,
      spawnedBy: input.spawnedBy ?? null,
      hostId: null,
    };
    this.repositories.transaction(() => {
      this.repositories.createAgent(session);
      if (!input.continueFrom)
        for (const ability of abilities)
          this.abilities.grant(session.id, ability, { live: false });
    });
    // Moved before the provider starts, so the new agent never sees a
    // worktree directory that no row claims and tries to create it again.
    if (input.continueFrom)
      this.repositories.reassignSessionWorktrees(
        input.continueFrom.id,
        session.id,
      );
    try {
      if (!input.terminal) await this.trustFolder(session);
      await this.hosts.local.start({
        session: session.tmuxSession,
        cwd: session.workingDirectory,
        executable: launch.executable,
        args: launch.args,
        env: input.terminal
          ? launch.env
          : await this.agentEnvironment(session, launch.env),
      });
      const startup = input.terminal
        ? "ready"
        : await this.waitForProviderReady(provider!.name, session.tmuxSession);
      let runningSession = session;
      if (provider?.name === "codex") {
        const recoveredId = await recoverCodexSessionId({
          sessionsDirectory: this.sessionConfig(session).codexSessionsDirectory,
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
      if (startup === "question") this.askedAtStartup(running);
      else if (!input.terminal) await this.readyAtStartup(running);
      await this.sessionRunning(running);
      return running;
    } catch (error) {
      if (input.continueFrom)
        this.repositories.reassignSessionWorktrees(
          session.id,
          input.continueFrom.id,
        );
      if (await this.hosts.local.isLive(session.tmuxSession))
        await this.hosts.local
          .stop(session.tmuxSession, true)
          .catch(() => undefined);
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
   * The one-click half of a rebirth: asks a running agent to write a note for
   * its successor and then run `daedal agent continue` itself. A Claude
   * session with an inbox gets it in its mailbox, so it arrives even
   * mid-turn and never shows as something the user typed.
   */
  async requestRebirth(id: string): Promise<AgentSession> {
    const agent = await this.requireContinuable(id);
    const outcome = await this.channel.deliver(
      agent,
      () => this.rebirthLine(agent),
      { when: "now", skill: { id: REBIRTH_SKILL } },
    );
    if (outcome.kind === "held")
      throw new DaedalusError(
        "CONFLICT",
        outcome.held.reason === "stopped"
          ? `Agent session '${id}' is not running`
          : outcome.held.text,
      );
    return this.markRebirthRequested(agent);
  }

  /**
   * A rebirth request under the delivery rule, for the routines clock: it
   * goes in only while the session waits at its prompt, and an inbox keeps
   * it in the mailbox so it is never lost.
   */
  async requestRebirthAtPrompt(
    session: AgentSession,
    activity: AgentActivityState | undefined,
  ): Promise<DeliveryResult> {
    // The row as it stands once the gate passes, not the tick's snapshot.
    let current = session;
    const outcome = await this.channel.deliver(
      session,
      async () => {
        current = await this.requireContinuable(session.id);
        return this.rebirthLine(current);
      },
      {
        when: "at-prompt",
        activity,
        skill: { id: REBIRTH_SKILL },
        mustArrive: true,
      },
    );
    if (outcome.kind === "delivered") this.markRebirthRequested(current);
    return outcome;
  }

  /** The rebirth request an inbox takes; it needs the skill installed. */
  private async rebirthLine(agent: AgentSession): Promise<string> {
    const skill = await requireSkill(this.config, agent, REBIRTH_SKILL);
    return `Daedalus: continue your work in a fresh session now. Run the ${skill} skill.`;
  }

  private markRebirthRequested(agent: AgentSession): AgentSession {
    const requested = {
      ...agent,
      rebirthRequestedAt: new Date().toISOString(),
    };
    this.repositories.updateAgent(requested);
    return requested;
  }

  /**
   * How a Refine session starts the refinement skill, or nothing when
   * the provider has no skills or the user turned the skill off; the session
   * then drafts the brief without interviewing.
   */
  private async refinementInvocation(
    provider: string | undefined,
  ): Promise<string | undefined> {
    if (provider !== "claude" && provider !== "codex") return undefined;
    const skillName = await installedSkill(
      this.config,
      provider,
      REFINEMENT_SKILL,
    );
    return skillName ? buildSkillInvocation(provider, skillName) : undefined;
  }

  /**
   * The context percent that triggers this session's rebirth: its own, else
   * its workspace's, else the global default. Null when that comes to off.
   */
  autoRebirthThreshold(agent: AgentSession): number | null {
    return resolveAutoRebirth(
      agent.autoRebirthPercent,
      this.repositories.findWorkspace(agent.workspaceId)?.autoRebirthPercent ??
        null,
      this.config.autoRebirthPercent,
    );
  }

  /** Sets this session's own rebirth threshold; null takes its workspace's. */
  async setAutoRebirth(id: string, value: AutoRebirth): Promise<AgentSession> {
    const agent = await this.get(id);
    const checked = autoRebirthPercent(value);
    this.repositories.setAgentAutoRebirth(agent.id, checked);
    return { ...agent, autoRebirthPercent: checked };
  }

  /**
   * Asks every running session whose context has passed its threshold (see
   * `autoRebirthThreshold`) to be reborn. A request already made stands
   * until the successor archives it, so the agent is not nagged every tick
   * while it writes the note.
   *
   * A request can still go nowhere: the line was lost, or the agent ran
   * `daedal agent continue` and it failed. The session then sits at its
   * prompt with a full context and the mark set, and nothing would ever ask
   * again. So a request older than `REBIRTH_RETRY_MS` is made again, but only
   * while the session waits at its prompt; one that is working may be writing
   * its note, and one asking the user something is the user's. Each retry
   * waits twice as long as the one before. After `REBIRTH_RETRIES` of them
   * something keeps failing that asking again will not fix, so the session
   * goes on the user's Needs me badge instead.
   */
  async sweepAutoRebirths(
    telemetry: ReadonlyArray<{
      sessionId: string;
      context?: { usedPercent?: number };
    }>,
  ): Promise<AgentSession[]> {
    const workspaces = new Map(
      this.repositories
        .listWorkspaces()
        .map((workspace) => [workspace.id, workspace.autoRebirthPercent]),
    );
    const usage = new Map(
      telemetry.map((item) => [item.sessionId, item.context?.usedPercent]),
    );
    const requested: AgentSession[] = [];
    const now = Date.now();
    for (const agent of this.repositories.listAgents()) {
      const threshold = resolveAutoRebirth(
        agent.autoRebirthPercent,
        workspaces.get(agent.workspaceId) ?? null,
        this.config.autoRebirthPercent,
      );
      const percent = usage.get(agent.id);
      if (
        threshold === null ||
        percent === undefined ||
        percent < threshold ||
        agent.kind !== "agent" ||
        agent.status !== "running" ||
        agent.archivedAt ||
        (agent.provider !== "claude" && agent.provider !== "codex") ||
        // A session running routines drains its runs first, and is reborn
        // under the delivery rule; the routine clock decides.
        this.abilities.held(agent.id, "routines")?.paused === false
      )
        continue;
      if (!agent.rebirthRequestedAt) this.rebirthRetries.delete(agent.id);
      else {
        // Its successor is running; the predecessor only waits to be archived.
        if (this.continued.has(agent.id)) continue;
        const retries = this.rebirthRetries.get(agent.id) ?? 0;
        if (!this.rebirthUnanswered(agent, now, retries)) continue;
        if (retries >= REBIRTH_RETRIES) {
          if (this.rebirthGivenUp.has(agent.id)) continue;
          this.rebirthGivenUp.add(agent.id);
          await this.raiseAttention(
            agent.id,
            `Daedalus asked this session to continue in a fresh one ${retries + 1} times and it has not. Its context is ${Math.round(percent)}% full. Check its terminal.`,
          );
          continue;
        }
        this.rebirthRetries.set(agent.id, retries + 1);
      }
      try {
        requested.push(await this.requestRebirth(agent.id));
      } catch {
        // A session that vanished between the list and the send is the
        // reconcile pass's business, not this one's.
      }
    }
    return requested;
  }

  /**
   * The sweep's memory of the requests it repeated, by session. It lives in
   * the app, so a restart gives a stuck session a fresh set of tries.
   */
  private readonly rebirthRetries = new Map<string, number>();
  /** Sessions whose stuck rebirth is already on the user's badge. */
  private readonly rebirthGivenUp = new Set<string>();
  /** Predecessors whose successor started; they only wait to be archived. */
  private readonly continued = new Set<string>();

  /** A rebirth request that has had its time and left the agent idle. */
  private rebirthUnanswered(
    agent: AgentSession,
    now: number,
    retries: number,
  ): boolean {
    const requestedAt = Date.parse(agent.rebirthRequestedAt ?? "");
    if (!(now - requestedAt >= REBIRTH_RETRY_MS * 2 ** retries)) return false;
    const activity = this.repositories.findAgentActivity(agent.id)?.activity;
    return activity === "idle" || activity === "done" || activity === "error";
  }

  /**
   * Moves a session's work to a fresh one with an empty context: same task,
   * same working directory, same worktrees. The rebirth note, when there is
   * one, is written to `REBIRTH.md` there and the successor is told to read
   * it. The predecessor is archived, which keeps its conversation restorable.
   *
   * `archive: "later"` leaves that to the caller. An agent that runs this on
   * itself cannot be archived from inside the same process: stopping its tmux
   * session interrupts the command that is doing the stopping.
   */
  async continueSession(input: {
    id: string;
    note?: string;
    provider?: "codex" | "claude";
    model?: string;
    /** Another account for the successor; its predecessor's by default. */
    account?: string | null;
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
    // Stamped afresh, so the sweep's retry clock runs from this continue and
    // not from a request made long before it.
    const requestedBefore = predecessor.rebirthRequestedAt;
    this.repositories.updateAgent({
      ...predecessor,
      rebirthRequestedAt: new Date().toISOString(),
    });
    let session: AgentSession;
    try {
      const note = input.note?.trim();
      if (note && predecessor.hostId) {
        const pod = this.hosts.get(predecessor.hostId);
        if (!isPodAccess(pod))
          throw new DaedalusError(
            "DEPENDENCY",
            "The cloud workspace cannot take files from this Mac",
          );
        await pod.writeFiles([
          {
            path: posix.join(predecessor.workingDirectory, REBIRTH_FILE),
            contents: new TextEncoder().encode(`${note}\n`),
          },
        ]);
      } else if (note)
        await writeFile(
          join(predecessor.workingDirectory, REBIRTH_FILE),
          `${note}\n`,
          "utf8",
        );
      // A session holding routines keeps its name: it is one agent over time,
      // and the name is how its routines' tasks and notifications are signed.
      // A team's lead is numbered like any session; its team keeps one name.
      const holdsRoutines = Boolean(
        this.abilities.held(predecessor.id, "routines"),
      );
      session = await this.spawn({
        workspace: predecessor.workspaceId,
        taskId: predecessor.taskId ?? undefined,
        name: holdsRoutines
          ? predecessor.name
          : rebirthSessionName(predecessor.name),
        provider,
        // A different provider would not understand the old one's model name.
        model:
          input.model ??
          (provider === predecessor.provider
            ? sessionLaunchModel(predecessor.args)
            : undefined),
        ...(input.account !== undefined ? { account: input.account } : {}),
        message: input.message,
        continueFrom: predecessor,
        note: Boolean(note),
      });
    } catch (error) {
      // No successor, so the mark would claim a rebirth that is not
      // happening, and the delivery gate would hold every line for it. A
      // request Daedalus made keeps its own time, and the sweep asks again
      // once that has passed.
      this.repositories.updateAgent({
        ...(await this.get(predecessor.id)),
        rebirthRequestedAt: requestedBefore,
      });
      throw error;
    }
    // Until it is archived the predecessor sits at its prompt with the mark
    // set, which is what the sweep's retry looks for.
    this.continued.add(predecessor.id);
    // Abilities move with the work, so the routine clock follows the
    // successor, and archiving the predecessor below does not pause them. A
    // lead's team is its orchestration ability, so it moves too. A member's
    // handle now names the successor alone.
    this.repositories.transaction(() => {
      this.repositories.abilities.moveToSession(predecessor.id, session.id);
      if (predecessor.teamId)
        this.repositories.setAgentTeam(predecessor.id, null, null);
    });
    if (input.archive === "later")
      return { session, predecessor: await this.get(predecessor.id) };
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
        "An archived session cannot be reborn; restore it first",
      );
    // A cloud session's folder is in its pod, where its successor runs.
    if (!agent.hostId && !(await pathExists(agent.workingDirectory)))
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
  async reconcile(liveSessions?: ReadonlySet<string>): Promise<void> {
    // The host asks tmux once per tick and shares the answer with the
    // terminals; anyone else asks here. A tmux that did not answer settles
    // nothing; the next call asks again.
    const local =
      liveSessions ??
      ((await this.hosts.local.probe()) === undefined
        ? await this.hosts.local.listLive().then(
            (sessions) => new Set(sessions),
            () => undefined,
          )
        : undefined);
    // A cloud host is asked only once this process holds it, and one that
    // does not answer (its workspace asleep, the Mac offline) settles none of
    // its sessions.
    const cloud = new Map<string, ReadonlySet<string>>();
    // All at once: a slow or unreachable host must not hold up the others.
    await Promise.all(
      this.hosts.cloud().map(async (host) => {
        // The set is made inside the catch, so a host whose answer cannot be
        // read settles nothing rather than ending the whole pass.
        const live = await host
          .listLive()
          .then((names) => new Set(names))
          .catch(() => undefined);
        if (live) cloud.set(host.id, live);
      }),
    );
    if (!local && cloud.size === 0) return;
    const now = new Date().toISOString();
    const launching = (agent: AgentSession) =>
      agent.status === "starting" &&
      Date.parse(now) - Date.parse(agent.startedAt) < STARTING_GRACE_MS;
    const endedAtStartup: string[] = [];
    this.repositories.transaction(() => {
      for (const agent of this.repositories.listAgents()) {
        const live = agent.hostId ? cloud.get(agent.hostId) : local;
        if (!live) continue;
        if (
          (agent.status === "starting" || agent.status === "running") &&
          !live.has(agent.tmuxSession) &&
          !launching(agent)
        ) {
          // Activity and attention are deliberately left alone: see
          // `onSessionEnded`. The exception is a startup question whose
          // provider exited, which no revive brings back. `lostReason` is
          // otherwise cleared so it always describes this disappearance
          // rather than the last one.
          const atStartup = this.endedAtStartupQuestion(agent);
          if (atStartup) endedAtStartup.push(agent.id);
          this.repositories.updateAgent({
            ...agent,
            status: "lost",
            endedAt: now,
            lostReason: atStartup
              ? `${providerLabel(agent.provider)} exited before reaching its prompt. Restore the session to start it again.`
              : null,
            rebirthRequestedAt: null,
          });
        } else if (agent.status === "starting" && live.has(agent.tmuxSession)) {
          this.repositories.updateAgent({ ...agent, status: "running" });
        } else if (
          agent.status === "lost" &&
          !agent.archivedAt &&
          live.has(agent.tmuxSession)
        ) {
          // Its tmux session is running, so it was never lost, or something
          // brought it back. The revive sweep adopts such a session the same
          // way.
          this.repositories.updateAgent({
            ...agent,
            status: "running",
            endedAt: null,
            lostReason: null,
          });
        }
      }
    });
    for (const id of endedAtStartup) this.onSessionEnded(id);
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

  /** The host the session runs on. */
  sessionHost(agent: AgentSession): SessionHost {
    return this.hosts.get(agent.hostId);
  }

  /**
   * A session by id, or by name when exactly one live session has it. Names
   * are what people use; ids are what agents pass.
   */
  resolve(reference: string): AgentSession {
    const byId = this.repositories.findAgent(reference);
    if (byId) return byId;
    const matches = this.repositories
      .listAgents()
      .filter(
        (session) =>
          !session.archivedAt &&
          session.name.toLowerCase() === reference.trim().toLowerCase(),
      );
    if (matches.length === 1) return matches[0]!;
    throw new DaedalusError(
      matches.length ? "VALIDATION" : "NOT_FOUND",
      matches.length
        ? `More than one session is called '${reference}'; pass its id`
        : `Session '${reference}' was not found`,
    );
  }

  async attach(id: string): Promise<number> {
    const agent = await this.requireRunning(id);
    if (agent.hostId)
      throw new DaedalusError(
        "CONFLICT",
        "A cloud session has no local tmux to attach to; open it in the app",
      );
    return this.tmux.attach(agent.tmuxSession);
  }

  /**
   * What the session's pane shows right now, as text. `styled` keeps the
   * escape codes, which is how a dim placeholder in an input box is told
   * apart from text someone typed.
   */
  async screen(
    id: string,
    options: { styled?: boolean } = {},
  ): Promise<string> {
    const agent = await this.requireRunning(id);
    return this.sessionHost(agent).capture(agent.tmuxSession, options);
  }

  async send(id: string, text: string): Promise<AgentSession> {
    if (!text)
      throw new DaedalusError(
        "VALIDATION",
        "Agent input text must not be empty",
      );
    // A session asleep with its cloud workspace wakes for the message.
    await this.wakeIfAsleep(await this.get(id));
    const agent = await this.requireRunning(id);
    await this.sessionHost(agent).send(agent.tmuxSession, text);
    return agent;
  }

  /** Renames a session. Its tasks and notifications use the new name. */
  async rename(id: string, name: string): Promise<AgentSession> {
    const agent = await this.get(id);
    const trimmed = name.trim();
    if (!trimmed)
      throw new DaedalusError("VALIDATION", "A session name must not be empty");
    if (trimmed.length > 240)
      throw new DaedalusError(
        "VALIDATION",
        "Session name must contain at most 240 characters",
      );
    this.repositories.renameAgent(agent.id, trimmed);
    return { ...agent, name: trimmed };
  }

  /** Pins a session to the top of its workspace's list, or unpins it. */
  async setPinned(id: string, pinned: boolean): Promise<AgentSession> {
    const agent = await this.get(id);
    const pinnedAt = pinned
      ? (agent.pinnedAt ?? new Date().toISOString())
      : null;
    this.repositories.setAgentPinned(agent.id, pinnedAt);
    return { ...agent, pinnedAt };
  }

  /** Marks a session with a named or `#rrggbb` color, or clears it with null. */
  async setColor(id: string, color: string | null): Promise<AgentSession> {
    const agent = await this.get(id);
    const value = color === null ? null : sessionColor(color);
    this.repositories.transaction(() => {
      this.repositories.setAgentColor(agent.id, value);
      // A lead's members wear its color.
      const team = this.abilities.held(agent.id, "orchestration");
      if (team)
        for (const member of this.repositories.listTeamMembers(team.id))
          this.repositories.setAgentColor(member.id, value);
    });
    return { ...agent, color: value };
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
    await this.sessionHost(agent).stop(agent.tmuxSession, force);
    const stopped: AgentSession = {
      ...agent,
      status: "exited",
      endedAt: new Date().toISOString(),
    };
    this.repositories.updateAgent(stopped);
    this.onSessionEnded(id);
    return stopped;
  }

  /**
   * Stops a session that is moving to another host. Unlike `stop`, it has
   * not ended for its team or its activity: it comes back on the other side.
   */
  async stopForMove(id: string): Promise<AgentSession> {
    const agent = await this.get(id);
    if (agent.status !== "running" && agent.status !== "starting") return agent;
    await this.sessionHost(agent).stop(agent.tmuxSession);
    const stopped: AgentSession = {
      ...agent,
      status: "exited",
      endedAt: new Date().toISOString(),
    };
    this.repositories.updateAgent(stopped);
    return stopped;
  }

  /**
   * Starts a stopped session on the host and in the folder `agent` names,
   * resuming its conversation. A move calls it for the other side, and for
   * the side it left when the move fails.
   */
  async resumeAfterMove(
    agent: AgentSession,
    options: RelaunchOptions = {},
  ): Promise<AgentSession> {
    const before = await this.get(agent.id);
    const place = (session: AgentSession) => ({
      hostId: session.hostId ?? null,
      workingDirectory: session.workingDirectory,
    });
    // Recorded first, so everything the launch reads finds the session
    // where it now runs; put back if it does not start.
    this.repositories.setAgentPlace(agent.id, place(agent));
    try {
      return await this.relaunch({ ...agent, archivedAt: null }, options);
    } catch (error) {
      this.repositories.setAgentPlace(agent.id, place(before));
      throw error;
    }
  }

  /** Where Claude keeps this session's conversations on this Mac. */
  claudeProjectsDirectory(agent: AgentSession): string {
    return this.sessionConfig(agent).claudeProjectsDirectory;
  }

  /**
   * Records a cloud Codex session's thread from its hook, once: the session
   * resumes, comes home and takes team messages by it. A thread another
   * session has is not taken.
   */
  bindCloudCodexThread(sessionId: string, thread: string): void {
    const agent = this.repositories.findAgent(sessionId);
    if (
      !agent ||
      agent.kind !== "agent" ||
      agent.provider !== "codex" ||
      !agent.hostId ||
      agent.providerSessionId ||
      !isCodexThread(thread) ||
      this.repositories
        .listAgents()
        .some((other) => other.providerSessionId === thread)
    )
      return;
    this.repositories.updateAgent({ ...agent, providerSessionId: thread });
  }

  /** Where Codex keeps this session's conversations on this Mac. */
  codexSessionsDirectory(agent: AgentSession): string {
    return this.sessionConfig(agent).codexSessionsDirectory;
  }

  async remove(id: string): Promise<AgentSession> {
    const agent = await this.get(id);
    if (agent.status === "running" || agent.status === "starting")
      throw new DaedalusError(
        "CONFLICT",
        "Running agent sessions must be stopped before removal",
      );
    await removeClaudeSettingsFiles(this.config, id).catch(() => undefined);
    this.repositories.deleteAgent(id);
    return agent;
  }

  // The permanent counterpart of `archive`: only an archived session
  // qualifies, and its worktrees, branches and folder go with the row.
  async deletePermanently(id: string): Promise<AgentSession> {
    const agent = await this.get(id);
    if (!agent.archivedAt)
      throw new DaedalusError(
        "CONFLICT",
        "Only an archived session can be deleted; archive it first",
      );
    await this.workspaceContent.discardSessionFiles(agent);
    // Only a folder Daedalus made for the session goes with it. A session
    // that ran in the workspace folder itself leaves the workspace's trust
    // for the workspace's own deletion, and one whose folder a successor
    // still works in leaves it to that one.
    const workspace = await this.workspaces
      .get(agent.workspaceId)
      .catch(() => undefined);
    const folder = resolve(agent.workingDirectory);
    const shared = this.repositories
      .listAgents({ workspaceId: agent.workspaceId })
      .some(
        (other) =>
          other.id !== agent.id && resolve(other.workingDirectory) === folder,
      );
    if (
      workspace &&
      !agent.hostId &&
      folder !== resolve(workspace.path) &&
      !shared
    )
      await forgetSessionFolders(this.config, agent.workingDirectory);
    await removeClaudeSettingsFiles(this.config, id).catch(() => undefined);
    this.repositories.deleteAgent(id);
    return agent;
  }

  async archive(id: string, force = false): Promise<AgentSession> {
    let agent = await this.get(id);
    if (agent.archivedAt) return agent;
    // Archivability is settled before anything is stopped, so a session that
    // cannot be archived safely keeps running instead of being destroyed.
    agent = await this.prepareArchivable(agent);
    const hasNativeCodexConversation =
      agent.kind === "agent" &&
      agent.provider === "codex" &&
      agent.providerSessionId
        ? await hasPersistedCodexSession({
            sessionsDirectory: this.sessionConfig(agent).codexSessionsDirectory,
            id: agent.providerSessionId,
            startedAt: agent.startedAt,
          })
        : false;
    // The Codex that launched a session is not necessarily still installed:
    // the ChatGPT app has dropped its bundled copy before, which left every
    // older session pointing at a path that no longer exists. Archiving uses
    // the Codex that `restore` would use, and finds it before anything is
    // stopped.
    const codex = hasNativeCodexConversation
      ? this.codexExecutable(agent)
      : undefined;
    if (hasNativeCodexConversation && !codex)
      throw new DaedalusError(
        "DEPENDENCY",
        "Codex is not installed, so its conversation cannot be archived",
      );
    if (agent.status === "running" || agent.status === "starting")
      agent = await this.stop(id, force);
    if (codex && agent.providerSessionId) {
      const result = await runCommand(
        codex,
        ["archive", agent.providerSessionId],
        {
          cwd: agent.workingDirectory,
          env: accountEnvironment(this.config, "codex", agent.account),
        },
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
    this.repositories.transaction(() => {
      this.repositories.updateAgent(archived);
      // Archiving pauses what the session holds; its routines and their
      // tasks stay, and restoring the session resumes them.
      // A lead's team pauses with it: members keep their place, messages to
      // the lead wait, and restoring the lead brings the team back. Only
      // revoking orchestration ends a team.
      this.repositories.abilities.setPausedForSession(id, true);
    });
    // Working trees used to outlive every session that ever held one, which is
    // what made a repository permanently undetachable. Only trees that
    // provably hold nothing are cleared; anything with uncommitted or unpushed
    // work is left exactly where it is.
    await this.workspaceContent.releaseSessionWorktrees(id);
    this.onSessionEnded(id);
    return archived;
  }

  /** The Codex a restore would launch, else the one the session started with. */
  codexExecutable(agent: AgentSession): string | undefined {
    const configured = this.config.agents.codex?.executable;
    return (
      (configured ? resolveAgentExecutable("codex", configured) : undefined) ??
      resolveAgentExecutable("codex", agent.command)
    );
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
    if ((await this.hosts.local.probe()) !== undefined) return result;
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
      if (!agent.hostId && !(await pathExists(agent.workingDirectory)))
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
  private async relaunch(
    agent: AgentSession,
    options: RelaunchOptions = {},
  ): Promise<AgentSession> {
    const workspace = await this.workspaces.get(agent.workspaceId);
    if (workspace.archivedAt)
      throw new DaedalusError(
        "CONFLICT",
        "Restore the workspace before restoring its sessions",
      );
    if (agent.hostId) return this.relaunchCloud(agent, options);
    if ((await this.hosts.local.probe()) !== undefined)
      throw new DaedalusError("DEPENDENCY", "tmux is not available on PATH");

    let executable = agent.command;
    let args = agent.args;
    let providerSessionId = agent.providerSessionId;
    const scoped = this.sessionConfig(agent);
    const accountEnv = accountEnvironment(
      this.config,
      agent.provider,
      agent.account,
    );
    if (agent.kind === "agent" && agent.provider === "custom") {
      // Restoring one starts its command afresh, which the user asks for by
      // restoring it. Revival never gets here: an unattended relaunch of an
      // arbitrary command is not the same promise as resuming a conversation.
      if (!agent.archivedAt)
        throw new DaedalusError(
          "CONFLICT",
          "Custom sessions do not define a native resume capability",
        );
    } else if (agent.kind === "agent") {
      if (!this.config.agents[agent.provider])
        throw new DaedalusError(
          "DEPENDENCY",
          `Agent configuration '${agent.provider}' is unavailable`,
        );
      // Called for its refusals only: a resume keeps the session's own
      // account, which `previous` hands straight back.
      await this.accounts.forLaunch(agent.provider, {
        previous: agent,
        workspace,
      });
      const launch = await resolveProvider(scoped, {
        provider: agent.provider,
      }).adapter.buildLaunch({
        sessionId: agent.id,
        model: modelArgument(agent.args),
        acceptPeerMessages:
          Boolean(agent.teamId) ||
          Boolean(this.abilities.held(agent.id, "orchestration")),
        workingDirectory: agent.workingDirectory,
        additionalDirectories: sessionDirectories(
          workspace.path,
          this.repositories
            .listWorkspaceRepositories(workspace.id)
            .map(
              (repository) =>
                repository.referencePath ?? repository.canonicalPath,
            ),
        ),
        resume: {
          nativeId: agent.providerSessionId ?? undefined,
          startedAt: agent.startedAt,
          archived: Boolean(agent.archivedAt),
          workingDirectory: agent.workingDirectory,
          env: accountEnv,
          ...(options.permissionMode
            ? { permissionMode: options.permissionMode }
            : {}),
          ...(options.fresh ? { fresh: true } : {}),
        },
      });
      executable = launch.executable;
      args = launch.args;
      providerSessionId = launch.providerSessionId ?? null;
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
      rebirthRequestedAt: null,
    };
    // Last thing before the launch, because the window between the sweep's own
    // check and this one is where a racing CLI would put a second runtime on
    // the same tmux name for the same conversation.
    if (await this.hosts.local.isLive(agent.tmuxSession))
      throw new DaedalusError(
        "CONFLICT",
        `tmux session '${agent.tmuxSession}' is already live`,
      );
    try {
      if (agent.kind === "agent") await this.trustFolder(agent);
      await this.hosts.local.start({
        session: restoring.tmuxSession,
        cwd: agent.workingDirectory,
        executable,
        args,
        env:
          agent.kind === "agent"
            ? await this.agentEnvironment(restoring)
            : undefined,
      });
      const startup =
        agent.kind === "agent"
          ? await this.waitForProviderReady(
              agent.provider,
              restoring.tmuxSession,
            )
          : "ready";
      let restored: AgentSession = {
        ...restoring,
        status: "running",
        archivedAt: null,
        resumeCount: agent.resumeCount + 1,
      };
      // Back from the archive: what archiving paused runs again.
      if (agent.archivedAt)
        this.repositories.abilities.setPausedForSession(agent.id, false);
      if (agent.provider === "codex" && !restored.providerSessionId) {
        const recoveredId = await recoverCodexSessionId({
          sessionsDirectory: scoped.codexSessionsDirectory,
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
      if (startup === "question") this.askedAtStartup(restored);
      else if (agent.kind === "agent") await this.readyAtStartup(restored);
      await this.sessionRunning(restored);
      return restored;
    } catch (error) {
      // A launch that got as far as tmux but not as far as a ready provider
      // leaves a live session behind a row that says otherwise. Nothing
      // reconciles that direction, so it is cleaned up here.
      if (await this.hosts.local.isLive(restoring.tmuxSession))
        await this.hosts.local
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
          env: accountEnv,
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
      /**
       * Only this Mac's sessions, or only cloud ones. The app's start sweeps
       * this Mac's before anything else runs, and the cloud's once it holds
       * the link, where a runner that is not linked costs nothing.
       */
      where?: "mac" | "cloud";
    } = {},
  ): Promise<ReviveSweepResult> {
    const result: ReviveSweepResult = { revived: [], skipped: [] };
    if (options.automatic && !this.config.autoRestoreSessionsEnabled)
      return { ...result, halted: "disabled" };
    // Without tmux there is nothing to put a session back into, and the whole
    // sweep would be one identical failure per card.
    if ((await this.hosts.local.probe()) !== undefined)
      return { ...result, halted: "tmux_unavailable" };
    const release = await acquireReviveLock(this.config.home);
    if (!release) return { ...result, halted: "sweep_in_progress" };
    try {
      await this.reconcile();
      const queue = this.repositories
        .listAgents(
          options.workspaceId ? { workspaceId: options.workspaceId } : {},
        )
        .filter(
          (agent) =>
            agent.status === "lost" &&
            !agent.archivedAt &&
            (options.where === undefined ||
              (options.where === "cloud") === Boolean(agent.hostId)) &&
            // A cloud session comes back once this process holds its host.
            this.hosts.find(agent.hostId) !== undefined,
        );
      const workers = Array.from({ length: REVIVE_CONCURRENCY }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const current = this.repositories.findAgent(next.id);
          if (!current || current.status !== "lost" || current.archivedAt)
            continue;
          if (
            await this.sessionHost(current)
              .isLive(current.tmuxSession)
              .catch(() => false)
          ) {
            // Someone else won the race. Adopting the live session is right;
            // launching a second one under the same name is not.
            this.repositories.updateAgent({
              ...current,
              status: "running",
              endedAt: null,
              lostReason: null,
              rebirthRequestedAt: null,
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
   * A Codex session's thread id, found again and saved when spawn missed it,
   * because its rollout was not written yet. Team messages reach Codex only
   * through `codex queue <thread>`. The window is as wide as activity
   * detection's: the session's folder is its own, so anything written there
   * since it started is its conversation.
   */
  async recoverCodexThread(agent: AgentSession): Promise<AgentSession> {
    if (agent.provider !== "codex" || agent.providerSessionId) return agent;
    const recoveredId = await recoverCodexSessionId({
      sessionsDirectory: this.sessionConfig(agent).codexSessionsDirectory,
      workingDirectory: agent.workingDirectory,
      startedAt: agent.startedAt,
      claimedIds: this.repositories
        .listAgents()
        .flatMap((session) =>
          session.providerSessionId ? [session.providerSessionId] : [],
        ),
      windowMs: Math.max(
        SESSION_RECOVERY_WINDOW_MS,
        Date.now() - Date.parse(agent.startedAt) + SESSION_RECOVERY_WINDOW_MS,
      ),
    });
    if (!recoveredId) return agent;
    const recovered = { ...agent, providerSessionId: recoveredId };
    this.repositories.updateAgent(recovered);
    return recovered;
  }

  /**
   * "Make this session resumable": rescues a `providerSessionId` that was
   * never recorded by matching the provider's own transcript directory against
   * the session's working directory and start time. Archiving needs it because
   * a locator is what makes an archive reversible; revival needs it for the
   * same reason, one machine reboot later.
   */
  private async prepareArchivable(agent: AgentSession): Promise<AgentSession> {
    // A custom command has no conversation to find, so like a terminal it
    // archives as it is and `restore` starts the command again.
    if (agent.kind === "terminal" || agent.provider === "custom") return agent;
    if (agent.providerSessionId) return agent;
    if (agent.provider === "codex") {
      const recoveredId = await recoverCodexSessionId({
        sessionsDirectory: this.sessionConfig(agent).codexSessionsDirectory,
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
        projectsDirectory: this.sessionConfig(agent).claudeProjectsDirectory,
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

/**
 * A session color: a named one, or `#rrggbb` (kept in lower case). Anything
 * else is refused with the names there are.
 */
export function sessionColor(value: string): SessionColor {
  if ((SESSION_COLORS as readonly string[]).includes(value))
    return value as SessionColor;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase() as SessionColor;
  throw new DaedalusError(
    "VALIDATION",
    `Color must be one of: ${SESSION_COLORS.join(", ")}, or #rrggbb`,
  );
}

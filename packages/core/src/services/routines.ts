import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { loginShellPath } from "@daedalus/platform";
import type { DaedalusConfig } from "../config";
import type {
  AgentProviderName,
  AgentSession,
  Routine,
  RoutineRun,
  RoutineRunOutcome,
  RoutineTrigger,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import { accountEnvironment } from "./account-homes";
import { installedSkill } from "./installed-skills";
import type { NotificationRequest } from "./notifications";
import { buildSkillInvocation, resolveAgentExecutable } from "./providers";
import {
  describeSchedule,
  nextRunTime,
  parseSchedule,
  parseWhen,
  routineName,
} from "./routine-schedule";

/** Runs at once across every routine; the rest wait for a later tick. */
export const MAX_ROUTINE_RUNS = 2;
export const ROUTINE_RUN_TIMEOUT_MS = 30 * 60_000;
/** Runs shown per routine in the table. */
const RECENT_RUNS = 7;
/** Runs kept per routine; older ones, read and finished, are deleted. */
export const ROUTINE_RUNS_KEPT = 100;
/** How often the tick looks for runs past that. */
const PRUNE_EVERY_MS = 10 * 60_000;

export interface RoutineProcess {
  /** Resolves with the exit code once the process ends. */
  exited: Promise<number>;
  kill(): void;
  pid?: number;
}

/** True while a process with this pid exists; signal 0 only checks. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Starts the provider for one run, its output written to `logPath`. */
export type RoutineSpawner = (input: {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  logPath: string;
}) => RoutineProcess;

export const spawnRoutineProcess: RoutineSpawner = (input) => {
  const child = Bun.spawn([input.executable, ...input.args], {
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    stdin: "ignore",
    stdout: Bun.file(input.logPath),
    stderr: "ignore",
  });
  return { exited: child.exited, kill: () => child.kill(), pid: child.pid };
};

/** The session actions routines need, from the agent service. */
export interface RoutineSessions {
  /** Opens a run's conversation as an archived session, then restores it. */
  continueConversation(input: {
    workspaceId: string;
    provider: AgentProviderName;
    providerSessionId: string;
    workingDirectory: string;
    name: string;
    startedAt: string;
  }): Promise<AgentSession>;
  spawn(input: {
    workspace: string;
    name: string;
    provider: string;
    message: string;
  }): Promise<AgentSession>;
  restore(id: string): Promise<AgentSession>;
}

/** The skill the Routines agent starts with. */
export const ROUTINES_SKILL = "daedalus-routines";

const ROUTINES_AGENT_PROMPT =
  "You are the Routines agent. You write and keep the user's Daedalus routines in every workspace, and read their runs. Run `daedal routine list`. If a routine's recent runs failed or gave a weak result, read its runs and suggest one concrete change to its prompt or schedule. Then say in one line what you can do and wait for the user.";

export interface RoutineView {
  routine: Routine;
  workspaceName: string | null;
  scheduleText: string;
  recentRuns: RoutineRun[];
  /** Finished runs the user has not opened, of any age. */
  unseenRuns: number;
}

export interface RoutineTranscriptEntry {
  kind: "text" | "tool" | "result" | "error";
  text: string;
}

export interface RoutineAddInput {
  name?: string;
  /** Workspace id or slug; null runs across every workspace. */
  workspace: string | null;
  when: string;
  prompt: string;
  model?: string | null;
}

/**
 * Routines as their own page: a schedule and a prompt that run in a
 * workspace folder as a headless Claude session. The app's tick is the
 * clock, so nothing runs while it is closed; a slot missed meanwhile runs
 * once when it opens.
 */
export class RoutineService {
  private readonly live = new Map<number, RoutineProcess>();
  private prunedAt = 0;

  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly config: DaedalusConfig,
    private readonly sessions: RoutineSessions,
    private readonly spawn: RoutineSpawner = spawnRoutineProcess,
    private readonly now: () => Date = () => new Date(),
    /** Tells the user a run ended; the notification service routes it. */
    private readonly notify: (
      request: NotificationRequest,
    ) => Promise<unknown> = async () => undefined,
  ) {}

  /**
   * The Routines agent: one Claude session that writes and keeps routines in
   * every workspace. The first call starts it in `workspace`; later calls
   * return it, restoring it when it was archived.
   */
  async agent(workspace: string): Promise<AgentSession> {
    const id = this.repositories.routines.agentSessionId();
    const existing = id ? this.repositories.findAgent(id) : undefined;
    if (existing)
      return existing.archivedAt
        ? this.sessions.restore(existing.id)
        : existing;
    const skill = await installedSkill(this.config, "claude", ROUTINES_SKILL);
    const session = await this.sessions.spawn({
      workspace,
      name: "Routines",
      provider: "claude",
      message: [
        ...(skill ? [buildSkillInvocation("claude", skill)] : []),
        ROUTINES_AGENT_PROMPT,
      ].join("\n\n"),
    });
    this.repositories.routines.setAgentSession(session.id);
    return session;
  }

  list(): RoutineView[] {
    const unseen = this.repositories.routines.unseenCounts();
    return this.repositories.routines.list().map((routine) => ({
      routine,
      workspaceName: routine.workspaceId
        ? (this.repositories.findWorkspace(routine.workspaceId)?.name ?? null)
        : null,
      scheduleText: describeSchedule(routine.schedule),
      recentRuns: this.repositories.routines
        .listRuns({ routineId: routine.id, limit: RECENT_RUNS })
        .reverse(),
      unseenRuns: unseen.get(routine.id) ?? 0,
    }));
  }

  /** One routine as the table shows it. */
  view(idOrName: string): RoutineView {
    const id = this.get(idOrName).id;
    const found = this.list().find((item) => item.routine.id === id);
    if (!found)
      throw new DaedalusError("NOT_FOUND", `No routine '${idOrName}'`);
    return found;
  }

  /** Newest first; `beforeId` gives the page older than that run. */
  runs(limit: number, beforeId?: number): RoutineRun[] {
    return this.repositories.routines.listRuns({
      limit,
      ...(beforeId !== undefined ? { beforeId } : {}),
    });
  }

  /** Deletes runs past the newest `ROUTINE_RUNS_KEPT` of each routine. */
  async prune(): Promise<number> {
    const ids = this.repositories.routines.runsPastKeep(ROUTINE_RUNS_KEPT);
    if (!ids.length) return 0;
    this.repositories.routines.deleteRuns(ids);
    await this.removeLogs(ids);
    return ids.length;
  }

  private async removeLogs(ids: number[]): Promise<void> {
    await Promise.all(
      ids.map((id) => rm(this.logPath(id), { force: true }).catch(() => {})),
    );
  }

  get(idOrName: string): Routine {
    const routine = this.repositories.routines.find(idOrName);
    if (!routine)
      throw new DaedalusError("NOT_FOUND", `No routine '${idOrName}'`);
    return routine;
  }

  add(input: RoutineAddInput): Routine {
    const prompt = input.prompt.trim();
    if (!prompt)
      throw new DaedalusError("VALIDATION", "A routine needs a prompt");
    const schedule = parseWhen(input.when);
    const name = this.uniqueName(
      input.name?.trim() ? routineName(input.name) : nameFromPrompt(prompt),
    );
    const now = this.now();
    const routine: Routine = {
      id: crypto.randomUUID(),
      name,
      workspaceId: this.workspaceId(input.workspace),
      schedule,
      prompt,
      model: input.model?.trim() || null,
      enabled: true,
      nextRunAt: null,
      lastRunAt: null,
      runRequestedAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    routine.nextRunAt = this.nextAt(routine);
    this.repositories.routines.create(routine);
    return routine;
  }

  update(
    idOrName: string,
    change: {
      name?: string;
      workspace?: string | null;
      when?: string;
      prompt?: string;
      model?: string | null;
      enabled?: boolean;
    },
  ): Routine {
    const current = this.get(idOrName);
    const next: Routine = {
      ...current,
      updatedAt: this.now().toISOString(),
    };
    if (change.name !== undefined && routineName(change.name) !== current.name)
      next.name = this.uniqueName(routineName(change.name));
    if (change.workspace !== undefined)
      next.workspaceId = this.workspaceId(change.workspace);
    if (change.when !== undefined) next.schedule = parseWhen(change.when);
    if (change.prompt !== undefined) {
      if (!change.prompt.trim())
        throw new DaedalusError("VALIDATION", "A routine needs a prompt");
      next.prompt = change.prompt.trim();
    }
    if (change.model !== undefined) next.model = change.model?.trim() || null;
    if (change.enabled !== undefined) next.enabled = change.enabled;
    // A new schedule, or a routine coming back from a pause, counts from now:
    // a paused week is not a missed slot to catch up on.
    if (change.when !== undefined || (change.enabled && !current.enabled))
      next.nextRunAt = this.nextAt({ ...next, lastRunAt: null });
    this.repositories.routines.update(next);
    return next;
  }

  remove(idOrName: string): void {
    const routine = this.get(idOrName);
    for (const run of this.repositories.routines.runningRuns())
      if (run.routineId === routine.id) this.live.get(run.id)?.kill();
    const runs = this.repositories.routines
      .listRuns({ routineId: routine.id, limit: Number.MAX_SAFE_INTEGER })
      .map((run) => run.id);
    this.repositories.routines.delete(routine.id);
    void this.removeLogs(runs);
  }

  /** Starts a run now, whatever the schedule says. */
  async runNow(idOrName: string): Promise<RoutineRun> {
    const routine = this.get(idOrName);
    if (this.isRunning(routine.id))
      throw new DaedalusError("CONFLICT", `${routine.name} is already running`);
    if (this.runningCount() >= MAX_ROUTINE_RUNS)
      throw new DaedalusError(
        "CONFLICT",
        `${MAX_ROUTINE_RUNS} routines are running; try again when one ends`,
      );
    return this.start(routine, "manual");
  }

  /**
   * Asks the app for a run now. For a process other than the app, such as
   * the CLI, which cannot watch the run to its end; the next tick starts it.
   */
  requestRun(idOrName: string): Routine {
    const routine = this.get(idOrName);
    if (this.isRunning(routine.id))
      throw new DaedalusError("CONFLICT", `${routine.name} is already running`);
    const next = { ...routine, runRequestedAt: this.now().toISOString() };
    this.repositories.routines.update(next);
    return next;
  }

  /**
   * Called on the app's tick. Starts every routine that is due, up to the
   * limit of runs at once, and ends runs past their time limit.
   */
  async tick(): Promise<RoutineRun[]> {
    const now = this.now();
    for (const run of this.repositories.routines.runningRuns()) {
      const over =
        now.getTime() - Date.parse(run.startedAt) > ROUTINE_RUN_TIMEOUT_MS;
      const live = this.live.get(run.id);
      if (live) {
        if (over) {
          live.kill();
          this.finish(run, "failed", "Stopped after 30 minutes");
        }
        continue;
      }
      // Started by an app that has since quit. Its process may still be
      // going, as sessions do; watch it until it ends.
      if (run.pid && isAlive(run.pid)) {
        if (over) {
          process.kill(run.pid);
          this.finish(run, "failed", "Stopped after 30 minutes");
        }
        continue;
      }
      await this.settle(run.id, null);
    }
    if (now.getTime() - this.prunedAt >= PRUNE_EVERY_MS) {
      this.prunedAt = now.getTime();
      await this.prune();
    }
    const started: RoutineRun[] = [];
    for (const routine of this.repositories.routines.list()) {
      const due =
        routine.enabled &&
        routine.nextRunAt !== null &&
        Date.parse(routine.nextRunAt) <= now.getTime();
      if (routine.runRequestedAt && !this.isRunning(routine.id)) {
        if (this.runningCount() >= MAX_ROUTINE_RUNS) continue;
        // A request that lands on a due slot is that slot's run.
        started.push(await this.start(routine, due ? "schedule" : "manual"));
        continue;
      }
      if (!due) continue;
      if (this.isRunning(routine.id)) {
        this.skip(routine, "The previous run was still going");
        continue;
      }
      if (this.runningCount() >= MAX_ROUTINE_RUNS) continue;
      started.push(await this.start(routine, "schedule"));
    }
    return started;
  }

  async transcript(runId: number): Promise<RoutineTranscriptEntry[]> {
    this.requireRun(runId);
    const text = await readFile(this.logPath(runId), "utf8").catch(() => "");
    return parseTranscript(text);
  }

  /**
   * Opens the run's conversation as a session of its workspace. A run on all
   * workspaces has none, so it joins `fallbackWorkspace`, the one open.
   */
  async continueRun(
    runId: number,
    fallbackWorkspace?: string,
  ): Promise<AgentSession> {
    const run = this.requireRun(runId);
    if (run.continuedSessionId) {
      const existing = this.repositories.findAgent(run.continuedSessionId);
      if (existing && !existing.archivedAt) return existing;
    }
    if (run.status === "running")
      throw new DaedalusError("CONFLICT", "Wait for the run to finish first");
    if (!run.providerSessionId)
      throw new DaedalusError(
        "CONFLICT",
        "This run has no conversation to continue",
      );
    const routine = this.repositories.routines.find(run.routineId);
    const workspaceId =
      routine?.workspaceId ??
      (fallbackWorkspace ? this.workspaceId(fallbackWorkspace) : null);
    if (!workspaceId)
      throw new DaedalusError(
        "VALIDATION",
        "Open a workspace to continue a run across all workspaces in",
      );
    const session = await this.sessions.continueConversation({
      workspaceId,
      provider: "claude",
      providerSessionId: run.providerSessionId,
      workingDirectory: run.workingDirectory,
      name: `${routine?.name ?? "Routine"} run`,
      startedAt: run.startedAt,
    });
    this.repositories.routines.updateRun({
      ...run,
      continuedSessionId: session.id,
    });
    return session;
  }

  private async start(
    routine: Routine,
    trigger: RoutineTrigger,
  ): Promise<RoutineRun> {
    const now = this.now();
    // A workspace that is gone fails the run rather than running it in the
    // root, where it would reach every workspace.
    const workingDirectory = routine.workspaceId
      ? (this.repositories.findWorkspace(routine.workspaceId)?.path ?? "")
      : this.config.workspaceRoot;
    const previous = this.repositories.routines.listRuns({
      routineId: routine.id,
      limit: 1,
    })[0];
    // A scheduled run moves the clock on; Run now leaves the next slot as it
    // is. Either one answers a request for a run.
    if (trigger === "schedule")
      this.repositories.routines.update({
        ...routine,
        lastRunAt: now.toISOString(),
        nextRunAt: this.nextAt({ ...routine, lastRunAt: now.toISOString() }),
        runRequestedAt: null,
      });
    else if (routine.runRequestedAt)
      this.repositories.routines.update({
        ...routine,
        runRequestedAt: null,
      });
    const providerSessionId = crypto.randomUUID();
    const run = this.repositories.routines.createRun({
      routineId: routine.id,
      trigger,
      status: "running",
      providerSessionId,
      workingDirectory,
      startedAt: now.toISOString(),
      finishedAt: null,
      summary: null,
      outcome: null,
      continuedSessionId: null,
      seenAt: null,
      pid: null,
    });
    try {
      if (!workingDirectory) throw new Error("Its workspace no longer exists");
      const configured = this.config.agents.claude?.executable ?? "claude";
      if (!resolveAgentExecutable("claude", configured)) await loginShellPath();
      const executable = resolveAgentExecutable("claude", configured);
      if (!executable) throw new Error("Claude Code is not installed");
      await mkdir(this.logDirectory(), { recursive: true });
      const child = this.spawn({
        executable,
        args: [
          "-p",
          runPrompt(routine, previous, now),
          "--session-id",
          providerSessionId,
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "auto",
          "--permission-prompts",
          "none",
          "--append-system-prompt",
          ROUTINE_RUN_SYSTEM_PROMPT,
          ...(routine.model ? ["--model", routine.model] : []),
        ],
        cwd: workingDirectory,
        env: {
          ...accountEnvironment(this.config, "claude", null),
          DAEDALUS_ROUTINE: routine.name,
        },
        logPath: this.logPath(run.id),
      });
      this.live.set(run.id, child);
      this.repositories.routines.updateRun({ ...run, pid: child.pid ?? null });
      void child.exited
        .then((code) => {
          this.live.delete(run.id);
          return this.settle(run.id, code);
        })
        // The app may have closed the database while the run was going; the
        // next app's tick settles the run from its log instead.
        .catch(() => undefined);
    } catch (error) {
      this.finish(
        run,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    return this.repositories.routines.findRun(run.id) ?? run;
  }

  /**
   * Ends a run whose process is gone, from what its log says. `code` is null
   * when another app started it, so the exit code is not known.
   */
  private async settle(runId: number, code: number | null): Promise<void> {
    const current = this.repositories.routines.findRun(runId);
    if (!current || current.status !== "running") return;
    const entries = await this.transcript(runId).catch(() => []);
    const result = entries.findLast((entry) => entry.kind === "result");
    const error = entries.findLast((entry) => entry.kind === "error");
    if (result && (code === 0 || code === null)) {
      const { outcome, summary } = readOutcome(lastLine(result.text));
      this.finish(current, "done", summary, outcome);
    } else
      this.finish(
        current,
        "failed",
        error
          ? lastLine(error.text)
          : code === null
            ? "Ended without a result while Daedalus was closed"
            : `Claude exited with code ${code}`,
      );
  }

  private skip(routine: Routine, reason: string): void {
    const now = this.now().toISOString();
    this.repositories.routines.update({
      ...routine,
      lastRunAt: now,
      nextRunAt: this.nextAt({ ...routine, lastRunAt: now }),
    });
    this.repositories.routines.createRun({
      routineId: routine.id,
      trigger: "schedule",
      status: "skipped",
      providerSessionId: null,
      workingDirectory: "",
      startedAt: now,
      finishedAt: now,
      summary: reason,
      outcome: null,
      continuedSessionId: null,
      // Nothing ran, so there is nothing to read.
      seenAt: now,
      pid: null,
    });
  }

  private finish(
    run: RoutineRun,
    status: "done" | "failed",
    summary: string,
    outcome: RoutineRunOutcome | null = null,
  ): void {
    const now = this.now().toISOString();
    // A run that found nothing for a person is read already: it neither
    // counts toward the sidebar badge nor sends an alert.
    const quiet = outcome === "ok";
    this.repositories.routines.updateRun({
      ...run,
      status,
      summary,
      outcome,
      finishedAt: now,
      seenAt: quiet ? now : run.seenAt,
    });
    const routine = this.repositories.routines.find(run.routineId);
    if (!routine || quiet) return;
    void this.notify({
      workspaceId: routine.workspaceId,
      level: status === "failed" ? "error" : "info",
      title:
        status === "failed"
          ? `${routine.name} failed`
          : `${routine.name} needs attention`,
      subtitle: routine.workspaceId
        ? (this.repositories.findWorkspace(routine.workspaceId)?.name ??
          "Routines")
        : "All workspaces",
      body: summary || "No reply.",
    }).catch(() => undefined);
  }

  /** The user opened a finished run, so it no longer counts as unread. */
  markSeen(runId: number): void {
    const run = this.requireRun(runId);
    if (run.status === "running" || run.seenAt) return;
    this.repositories.routines.updateRun({
      ...run,
      seenAt: this.now().toISOString(),
    });
  }

  /** Clears the unread count without opening each run. */
  markAllSeen(): number {
    return this.repositories.routines.markAllSeen(this.now().toISOString());
  }

  private runningCount(): number {
    return this.repositories.routines.runningRuns().length;
  }

  private isRunning(routineId: string): boolean {
    return this.repositories.routines
      .runningRuns()
      .some((run) => run.routineId === routineId);
  }

  private requireRun(id: number): RoutineRun {
    const run = this.repositories.routines.findRun(id);
    if (!run) throw new DaedalusError("NOT_FOUND", `No routine run ${id}`);
    return run;
  }

  private nextAt(routine: Routine): string | null {
    return (
      nextRunTime(parseSchedule(routine.schedule), {
        now: this.now(),
        lastRunAt: routine.lastRunAt,
      })?.toISOString() ?? null
    );
  }

  private workspaceId(reference: string | null): string | null {
    if (reference === null) return null;
    const workspace =
      this.repositories.findWorkspace(reference) ??
      this.repositories
        .listWorkspaces()
        .find((item) => item.slug === reference);
    if (!workspace)
      throw new DaedalusError("NOT_FOUND", `No workspace '${reference}'`);
    return workspace.id;
  }

  private uniqueName(base: string): string {
    let name = base;
    for (let suffix = 2; this.repositories.routines.find(name); suffix++)
      name = `${base}-${suffix}`;
    return name;
  }

  private logDirectory(): string {
    return join(this.config.home, "routine-runs");
  }

  private logPath(runId: number): string {
    return join(this.logDirectory(), `${runId}.jsonl`);
  }
}

/** A name from the prompt's first words, such as `check-env-health`. */
export function nameFromPrompt(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  return routineName(words.join("-") || "routine");
}

/**
 * A run has no Daedalus session, so the workspace's instructions to start a
 * workflow, raise attention or post to a team would fail and take over the
 * run's first line. Continuing a run in a session brings those back.
 */
export const ROUTINE_RUN_SYSTEM_PROMPT =
  "This is a headless Daedalus routine run with no Daedalus session: DAEDALUS_SESSION_ID is unset. Skip every instruction that needs a session, such as starting or continuing a workflow, `daedal attention`, team messages and journal entries. Do not mention skipping them. Do only the routine's task.";

function runPrompt(
  routine: Routine,
  previous: RoutineRun | undefined,
  now: Date,
): string {
  const lines = [
    `This is a scheduled run of the routine "${routine.name}" (${describeSchedule(routine.schedule)}), started by Daedalus at ${now.toLocaleString("en-GB")}.`,
    "Nobody is watching live and nobody can answer a question or a permission prompt. Do the work, then end with a short reply whose first line starts with `OK:` when nothing needs a person, or `ATTENTION:` when something does, followed by the most important thing you found or did. Daedalus reads that word: an ATTENTION run is flagged to the user, an OK run is not, and a reply with neither counts as ATTENTION.",
  ];
  if (previous?.finishedAt && previous.summary)
    lines.push(
      `The previous run ended ${new Date(previous.finishedAt).toLocaleString("en-GB")} and said: ${previous.outcome ? `${previous.outcome.toUpperCase()}: ` : ""}${previous.summary}`,
    );
  return `${lines.join("\n")}\n\n${routine.prompt}`;
}

/**
 * Splits a done run's first line into its outcome and the summary after it.
 * The word may sit inside markdown, as in `**ATTENTION:** …`. A line with
 * neither word counts as attention, so a reply that forgot it is never
 * shown as all clear.
 */
export function readOutcome(line: string): {
  outcome: RoutineRunOutcome;
  summary: string;
} {
  const match = /^[\s*_`#>]*(OK|ATTENTION)\b[*_`]*\s*[:\-–—][*_`\s]*/i.exec(
    line,
  );
  if (!match) return { outcome: "attention", summary: line };
  return {
    outcome: match[1]!.toUpperCase() === "OK" ? "ok" : "attention",
    summary: line.slice(match[0].length).trim(),
  };
}

function lastLine(text: string): string {
  const first = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return (first ?? "").slice(0, 300);
}

type StreamEvent = {
  type?: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  message?: { content?: Array<Record<string, unknown>> | string };
};

function toolText(block: Record<string, unknown>): string {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const detail =
    input.command ??
    input.file_path ??
    input.pattern ??
    input.url ??
    input.description ??
    input.prompt ??
    "";
  return `${String(block.name)}${detail ? ` ${String(detail).split("\n")[0]!.slice(0, 200)}` : ""}`;
}

/** Reads a run's stream-json log into what the run view shows. */
export function parseTranscript(log: string): RoutineTranscriptEntry[] {
  const entries: RoutineTranscriptEntry[] = [];
  for (const line of log.split("\n")) {
    if (!line.trim()) continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim()
        )
          entries.push({ kind: "text", text: block.text.trim() });
        else if (block.type === "tool_use")
          entries.push({ kind: "tool", text: toolText(block) });
      }
    } else if (event.type === "result") {
      const text = (event.result ?? "").trim();
      // The result repeats the agent's last message.
      const last = entries.at(-1);
      if (last?.kind === "text" && last.text === text) entries.pop();
      entries.push({
        kind:
          event.is_error || event.subtype !== "success" ? "error" : "result",
        text: (event.result ?? event.subtype ?? "").trim(),
      });
    }
  }
  return entries;
}

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  RoutineReport,
  RoutineAgent,
  Routine,
  RoutineFileError,
  RoutineRun,
  RoutineRunOutcome,
  RoutineState,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import {
  fillPlaceholders,
  formatDuration,
  nextRunTime,
  parseRoutineFile,
  parseSchedule,
  parseUntil,
  renderRoutineFile,
  routineName,
  ROUTINES_DIRECTORY,
  routineAgentFolder,
  RoutineFolderReader,
  setFrontmatterField,
  TEMPLATES_DIRECTORY,
} from "./routine-files";
import type { WorkspaceService } from "./workspaces";

/** Failures in a row after which the agent's session gets a badge. */
export const FAILURE_BADGE_THRESHOLD = 3;
/** A run overdue by less than this was on time, as far as `{{missed}}` goes. */
const MISSED_GRACE_MS = 90_000;
/** A queued run nobody could deliver for this long is dropped. */
const UNDELIVERED_LIMIT_MS = 60 * 60_000;
const OUTCOMES: readonly RoutineRunOutcome[] = ["quiet", "notified", "task"];

export interface RoutineView {
  routine: Routine;
  state: RoutineState | null;
  /** The newest run of this routine, if it has one. */
  lastRun: RoutineRun | null;
}

export interface RoutineStart {
  run: RoutineRun;
  routine: Pick<Routine, "name" | "model" | "timeoutMs" | "output">;
  prompt: string;
  /** Every open report of the agent, so one cause is reported once. */
  openReports: RoutineReport[];
}

const localTime = (iso: string): string => {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

async function writeAtomically(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

/**
 * A routine agent's routines: the files that define them and the runs they make.
 * The files are the source of truth, so every change here is a file write
 * and the scheduler picks it up on its next read.
 */
export class RoutineService {
  private readonly reader = new RoutineFolderReader();

  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaces: WorkspaceService,
    /** Raises the agent's badge after repeated failures. */
    private readonly raiseAttention: (
      sessionId: string,
      reason: string,
    ) => Promise<void>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async directory(agent: RoutineAgent): Promise<string> {
    const workspace = await this.workspaces.get(agent.workspaceId);
    return join(
      routineAgentFolder(workspace.path, agent.slug),
      ROUTINES_DIRECTORY,
    );
  }

  async read(
    agent: RoutineAgent,
  ): Promise<{ routines: Routine[]; errors: RoutineFileError[] }> {
    return this.reader.read(await this.directory(agent));
  }

  async list(
    agent: RoutineAgent,
  ): Promise<{ routines: RoutineView[]; errors: RoutineFileError[] }> {
    const { routines, errors } = await this.read(agent);
    const states = new Map(
      this.repositories.routineAgents
        .listRoutineStates(agent.id)
        .map((state) => [state.name, state]),
    );
    const runs = this.repositories.routineAgents.listRoutineRuns(agent.id, {
      limit: 500,
    });
    return {
      routines: routines.map((routine) => ({
        routine,
        state: states.get(routine.name) ?? null,
        // Overlap skips are newer than the run they were skipped for, and
        // say nothing about it, so the row shows the run that is real.
        lastRun:
          runs.find(
            (run) => run.routine === routine.name && run.status !== "skipped",
          ) ?? null,
      })),
      errors,
    };
  }

  async get(agent: RoutineAgent, name: string): Promise<RoutineView> {
    const view = (await this.list(agent)).routines.find(
      (item) => item.routine.name === name,
    );
    if (!view)
      throw new DaedalusError("NOT_FOUND", `Routine '${name}' was not found`);
    return view;
  }

  /**
   * Adds a routine from a whole file, or from a template with vars filled in.
   * The file is validated before anything is written, so a bad schedule is
   * refused here rather than shown as a broken file later.
   */
  async add(
    agent: RoutineAgent,
    input:
      | { text: string; replace?: boolean }
      | {
          template: string;
          name?: string;
          vars?: Record<string, string>;
          until?: string;
          schedule?: string;
          enabled?: boolean;
        },
  ): Promise<Routine> {
    const directory = await this.directory(agent);
    let routine: Routine;
    if ("text" in input) {
      routine = parseRoutineFile(join(directory, "new.md"), input.text);
    } else {
      const templateName = routineName(input.template);
      const templatePath = join(
        directory,
        TEMPLATES_DIRECTORY,
        `${templateName}.md`,
      );
      let text: string;
      try {
        text = await readFile(templatePath, "utf8");
      } catch {
        throw new DaedalusError(
          "NOT_FOUND",
          `Template '${templateName}' was not found in ${join(ROUTINES_DIRECTORY, TEMPLATES_DIRECTORY)}`,
        );
      }
      const template = parseRoutineFile(templatePath, text);
      const vars = { ...template.vars, ...input.vars };
      routine = {
        ...template,
        name: routineName(
          input.name ??
            `${templateName}-${Bun.hash(JSON.stringify(vars)).toString(36).slice(0, 6)}`,
        ),
        vars,
        schedule: input.schedule
          ? parseSchedule(input.schedule)
          : template.schedule,
        until: input.until
          ? parseUntil(input.until, this.now()).toISOString()
          : template.until,
        enabled: input.enabled ?? true,
      };
    }
    const path = join(directory, `${routine.name}.md`);
    const existing = (await this.read(agent)).routines.find(
      (item) => item.name === routine.name,
    );
    const replace = "text" in input && input.replace;
    if (existing && !replace)
      throw new DaedalusError(
        "CONFLICT",
        `Routine '${routine.name}' already exists; pass --replace to overwrite it`,
      );
    await mkdir(join(directory, TEMPLATES_DIRECTORY), { recursive: true });
    const target = existing?.path ?? path;
    await writeAtomically(
      target,
      "text" in input
        ? `${input.text.trimEnd()}\n`
        : renderRoutineFile(routine),
    );
    return { ...routine, path: target };
  }

  async setEnabled(
    agent: RoutineAgent,
    name: string,
    enabled: boolean,
  ): Promise<Routine> {
    const { routine } = await this.get(agent, name);
    const text = await readFile(routine.path, "utf8");
    await writeAtomically(
      routine.path,
      setFrontmatterField(text, "enabled", String(enabled)),
    );
    if (enabled) {
      // Enabling is the user deciding the routine should run now, on its
      // schedule, not "catch up on everything since it was switched off".
      const state = this.repositories.routineAgents.findRoutineState(
        agent.id,
        name,
      );
      if (state)
        this.repositories.routineAgents.saveRoutineState({
          ...state,
          nextRunAt:
            nextRunTime(routine.schedule, {
              now: this.now(),
              lastRunAt: state.lastRunAt,
            })?.toISOString() ?? null,
        });
    }
    return { ...routine, enabled };
  }

  async remove(agent: RoutineAgent, name: string): Promise<Routine> {
    const { routine } = await this.get(agent, name);
    await rm(routine.path, { force: true });
    this.repositories.routineAgents.deleteRoutineState(agent.id, name);
    return routine;
  }

  /**
   * Queues a run now, whatever the schedule says. A run already waiting to
   * be typed in is the same request, so it is returned rather than refused;
   * only a run that is running now is a conflict.
   */
  async runNow(
    agent: RoutineAgent,
    name: string,
  ): Promise<RoutineRun & { alreadyQueued?: boolean }> {
    const { routine } = await this.get(agent, name);
    const existing = this.inFlightRuns(agent).find(
      (run) => run.routine === routine.name,
    );
    if (existing?.deliveredAt)
      throw new DaedalusError(
        "CONFLICT",
        `Routine '${name}' is running now (run ${existing.id})`,
      );
    if (existing) return { ...existing, alreadyQueued: true };
    return this.repositories.routineAgents.createRoutineRun({
      routineAgentId: agent.id,
      routine: routine.name,
      sessionId: null,
      status: "queued",
      queuedAt: this.now().toISOString(),
      deliveredAt: null,
      startedAt: null,
      finishedAt: null,
      outcome: null,
      summary: null,
      missedMs: 0,
    });
  }

  /** Queued and running runs, including those not yet typed. */
  inFlightRuns(agent: RoutineAgent): RoutineRun[] {
    return this.repositories.routineAgents.listRoutineRuns(agent.id, {
      statuses: ["queued", "running"],
      limit: 100,
    });
  }

  /** Runs that were typed into the pane and have not ended. */
  deliveredRuns(agent: RoutineAgent): RoutineRun[] {
    return this.inFlightRuns(agent).filter((run) => run.deliveredAt);
  }

  runs(
    agent: RoutineAgent,
    filters: { routine?: string; limit?: number } = {},
  ) {
    return this.repositories.routineAgents.listRoutineRuns(agent.id, filters);
  }

  requireRun(id: number, agent?: RoutineAgent): RoutineRun {
    const run = this.repositories.routineAgents.findRoutineRun(id);
    if (!run || (agent && run.routineAgentId !== agent.id))
      throw new DaedalusError("NOT_FOUND", `Routine run ${id} was not found`);
    return run;
  }

  /**
   * The agent's side of step 4: marks the run running and hands back the
   * prompt it should give its subagent, with every placeholder filled in.
   */
  async start(agent: RoutineAgent, id: number): Promise<RoutineStart> {
    const run = this.requireRun(id, agent);
    if (run.status !== "queued")
      throw new DaedalusError(
        "CONFLICT",
        `Run ${id} is ${run.status}, not queued`,
      );
    const { routines } = await this.read(agent);
    const routine = routines.find((item) => item.name === run.routine);
    if (!routine) {
      this.finish(run, "skipped", null, "The routine file is gone");
      throw new DaedalusError(
        "NOT_FOUND",
        `Routine '${run.routine}' no longer exists`,
      );
    }
    const now = this.now().toISOString();
    const previous = this.repositories.routineAgents
      .listRoutineRuns(agent.id, {
        routine: run.routine,
        statuses: ["done"],
        limit: 1,
      })
      .find((item) => item.id !== run.id);
    const started: RoutineRun = {
      ...run,
      status: "running",
      startedAt: now,
      deliveredAt: run.deliveredAt ?? now,
      sessionId: run.sessionId ?? agent.sessionId,
    };
    this.repositories.routineAgents.updateRoutineRun(started);
    const prompt = fillPlaceholders(routine.body, {
      ...routine.vars,
      last_run: previous?.startedAt
        ? localTime(previous.startedAt)
        : "never (this is the first run; look back one schedule interval)",
      run_id: String(run.id),
      now: localTime(now),
      missed: run.missedMs ? formatDuration(run.missedMs) : "0m",
    });
    return {
      run: started,
      routine: {
        name: routine.name,
        model: routine.model,
        timeoutMs: routine.timeoutMs,
        output: routine.output,
      },
      prompt,
      openReports: this.repositories.routineAgents.listRoutineReports(
        agent.id,
        {
          states: ["open"],
        },
      ),
    };
  }

  async done(
    agent: RoutineAgent,
    id: number,
    outcomeValue: string,
    summary: string,
  ): Promise<RoutineRun> {
    if (!OUTCOMES.includes(outcomeValue as RoutineRunOutcome))
      throw new DaedalusError(
        "VALIDATION",
        `Outcome must be one of: ${OUTCOMES.join(", ")}`,
      );
    const run = this.requireRun(id, agent);
    if (run.status !== "running" && run.status !== "queued")
      throw new DaedalusError("CONFLICT", `Run ${id} already ended`);
    const finished = this.finish(
      run,
      "done",
      outcomeValue as RoutineRunOutcome,
      summary,
    );
    await this.removeFinishedOneShot(agent, run.routine);
    return finished;
  }

  async fail(
    agent: RoutineAgent,
    id: number,
    summary: string,
  ): Promise<RoutineRun> {
    const run = this.requireRun(id, agent);
    if (run.status !== "running" && run.status !== "queued")
      throw new DaedalusError("CONFLICT", `Run ${id} already ended`);
    const failed = this.finish(run, "failed", null, summary);
    await this.afterFailure(agent, failed);
    await this.removeFinishedOneShot(agent, run.routine);
    return failed;
  }

  private finish(
    run: RoutineRun,
    status: "done" | "failed" | "skipped",
    outcome: RoutineRunOutcome | null,
    summary: string | null,
  ): RoutineRun {
    const now = this.now().toISOString();
    const finished: RoutineRun = {
      ...run,
      status,
      outcome,
      summary: summary?.trim().slice(0, 2_000) || null,
      finishedAt: now,
    };
    this.repositories.transaction(() => {
      this.repositories.routineAgents.updateRoutineRun(finished);
      const state = this.repositories.routineAgents.findRoutineState(
        run.routineAgentId,
        run.routine,
      );
      if (state && status !== "skipped")
        this.repositories.routineAgents.saveRoutineState({
          ...state,
          lastSuccessAt: status === "done" ? now : state.lastSuccessAt,
          consecutiveFailures:
            status === "done" ? 0 : state.consecutiveFailures + 1,
        });
    });
    return finished;
  }

  private async afterFailure(
    agent: RoutineAgent,
    run: RoutineRun,
  ): Promise<void> {
    const state = this.repositories.routineAgents.findRoutineState(
      agent.id,
      run.routine,
    );
    if (
      !agent.sessionId ||
      !state ||
      state.consecutiveFailures !== FAILURE_BADGE_THRESHOLD
    )
      return;
    await this.raiseAttention(
      agent.sessionId,
      `Routine '${run.routine}' failed ${FAILURE_BADGE_THRESHOLD} times in a row: ${run.summary ?? "no result"}`,
    ).catch(() => undefined);
  }

  /** A one-shot `at` routine is done with once its run has ended. */
  private async removeFinishedOneShot(
    agent: RoutineAgent,
    name: string,
  ): Promise<void> {
    const routine = (await this.read(agent)).routines.find(
      (item) => item.name === name,
    );
    if (routine?.schedule.kind !== "at") return;
    await rm(routine.path, { force: true });
    this.repositories.routineAgents.deleteRoutineState(agent.id, name);
  }

  /**
   * The clock. Queues every routine that is due, once however late it is,
   * skips one whose previous run has not ended, removes routines past their
   * `until`, and fails runs past their timeout. Returns the runs it queued.
   */
  async schedule(
    agent: RoutineAgent,
    options: { queue: boolean },
  ): Promise<RoutineRun[]> {
    const now = this.now();
    const at = now.toISOString();
    const { routines } = await this.read(agent);
    const byName = new Map(routines.map((routine) => [routine.name, routine]));
    await this.expire(agent, byName, now);
    const store = this.repositories.routineAgents;
    const states = new Map(
      store.listRoutineStates(agent.id).map((state) => [state.name, state]),
    );
    for (const name of states.keys())
      if (!byName.has(name)) store.deleteRoutineState(agent.id, name);
    const queued: RoutineRun[] = [];
    const inFlight = new Set(
      this.inFlightRuns(agent).map((run) => run.routine),
    );
    for (const routine of routines) {
      if (routine.until && Date.parse(routine.until) <= now.getTime()) continue;
      let state = states.get(routine.name);
      if (!state) {
        state = {
          routineAgentId: agent.id,
          name: routine.name,
          nextRunAt:
            nextRunTime(routine.schedule, {
              now,
              lastRunAt: null,
            })?.toISOString() ?? null,
          lastRunAt: null,
          lastSuccessAt: null,
          consecutiveFailures: 0,
        };
        store.saveRoutineState(state);
      }
      if (
        !options.queue ||
        !routine.enabled ||
        !state.nextRunAt ||
        Date.parse(state.nextRunAt) > now.getTime()
      )
        continue;
      const missedMs = now.getTime() - Date.parse(state.nextRunAt);
      const next = nextRunTime(routine.schedule, { now, lastRunAt: at });
      const advanced: RoutineState = {
        ...state,
        lastRunAt: at,
        nextRunAt:
          next && next.getTime() <= now.getTime()
            ? new Date(now.getTime() + 60_000).toISOString()
            : (next?.toISOString() ?? null),
      };
      store.saveRoutineState(advanced);
      if (inFlight.has(routine.name)) {
        store.createRoutineRun({
          routineAgentId: agent.id,
          routine: routine.name,
          sessionId: null,
          status: "skipped",
          queuedAt: at,
          deliveredAt: null,
          startedAt: null,
          finishedAt: at,
          outcome: null,
          summary: "Skipped: the previous run has not ended",
          missedMs: 0,
        });
        continue;
      }
      queued.push(
        store.createRoutineRun({
          routineAgentId: agent.id,
          routine: routine.name,
          sessionId: null,
          status: "queued",
          queuedAt: at,
          deliveredAt: null,
          startedAt: null,
          finishedAt: null,
          outcome: null,
          summary: null,
          missedMs: missedMs > MISSED_GRACE_MS ? missedMs : 0,
        }),
      );
      inFlight.add(routine.name);
    }
    await this.timeOut(agent, byName, now);
    return queued;
  }

  /** Routines past their `until` delete themselves, once nothing is in flight. */
  private async expire(
    agent: RoutineAgent,
    routines: Map<string, Routine>,
    now: Date,
  ): Promise<void> {
    const inFlight = new Set(
      this.inFlightRuns(agent).map((run) => run.routine),
    );
    for (const routine of routines.values()) {
      if (!routine.until || Date.parse(routine.until) > now.getTime()) continue;
      if (inFlight.has(routine.name)) continue;
      await rm(routine.path, { force: true });
      this.repositories.routineAgents.deleteRoutineState(
        agent.id,
        routine.name,
      );
      routines.delete(routine.name);
    }
  }

  private async timeOut(
    agent: RoutineAgent,
    routines: Map<string, Routine>,
    now: Date,
  ): Promise<void> {
    for (const run of this.inFlightRuns(agent)) {
      const timeoutMs = routines.get(run.routine)?.timeoutMs ?? 10 * 60_000;
      if (run.deliveredAt) {
        const since = Date.parse(run.startedAt ?? run.deliveredAt);
        if (now.getTime() - since <= timeoutMs) continue;
        const failed = this.finish(
          run,
          "failed",
          null,
          run.startedAt
            ? `Timed out after ${formatDuration(timeoutMs)} with no result`
            : "Delivered but never started",
        );
        await this.afterFailure(agent, failed);
        await this.removeFinishedOneShot(agent, run.routine);
      } else if (
        now.getTime() - Date.parse(run.queuedAt) >
        UNDELIVERED_LIMIT_MS
      ) {
        this.finish(run, "skipped", null, "Not delivered within an hour");
        await this.removeFinishedOneShot(agent, run.routine);
      }
    }
  }

  /** Marks a run as typed into the agent's pane. */
  markDelivered(run: RoutineRun, sessionId: string): RoutineRun {
    const delivered: RoutineRun = {
      ...run,
      sessionId,
      deliveredAt: this.now().toISOString(),
    };
    this.repositories.routineAgents.updateRoutineRun(delivered);
    return delivered;
  }

  /** Drops queued runs nobody will deliver: the agent was paused. */
  skipUndelivered(agent: RoutineAgent, reason: string): number {
    const pending = this.inFlightRuns(agent).filter((run) => !run.deliveredAt);
    for (const run of pending) this.finish(run, "skipped", null, reason);
    return pending.length;
  }
}

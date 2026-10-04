import type {
  Routine,
  RoutineDefinition,
  RoutineReport,
  RoutineRun,
  RoutineRunOutcome,
  SessionAbility,
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
} from "./routine-files";

/** Failures in a row after which the session gets a badge. */
export const FAILURE_BADGE_THRESHOLD = 3;
/** A run overdue by less than this was on time, as far as `{{missed}}` goes. */
const MISSED_GRACE_MS = 90_000;
const OUTCOMES: readonly RoutineRunOutcome[] = ["quiet", "notified", "task"];

export interface RoutineView {
  routine: Routine;
  /** The newest run of this routine that was not skipped, if any. */
  lastRun: RoutineRun | null;
}

export interface RoutineStart {
  run: RoutineRun;
  routine: Pick<Routine, "name" | "model" | "timeoutMs" | "output">;
  prompt: string;
  /** What the session's routines are for, as it wrote it. */
  purpose: string | null;
  /** Every open report of the session, so one cause is reported once. */
  openReports: RoutineReport[];
}

export type RoutineAddInput =
  | { text: string; replace?: boolean; template?: boolean; name?: string }
  | {
      from: string;
      name?: string;
      vars?: Record<string, string>;
      until?: string;
      schedule?: string;
      enabled?: boolean;
    };

const localTime = (iso: string): string => {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/**
 * The routines a session holds and the runs they make. Everything lives in
 * SQLite under the ability's id, so the routines follow the ability through
 * every handoff and nothing is written into the session's folder.
 */
export class RoutineService {
  constructor(
    private readonly repositories: SqliteRepositories,
    /** Raises the session's badge after repeated failures. */
    private readonly raiseAttention: (
      sessionId: string,
      reason: string,
    ) => Promise<void>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(ability: SessionAbility): {
    routines: RoutineView[];
    templates: Routine[];
  } {
    const runs = this.repositories.routines.listRuns(ability.id, {
      limit: 500,
    });
    return {
      routines: this.repositories.routines.list(ability.id).map((routine) => ({
        routine,
        // Overlap skips are newer than the run they were skipped for, and
        // say nothing about it, so the row shows the run that is real.
        lastRun:
          runs.find(
            (run) => run.routine === routine.name && run.status !== "skipped",
          ) ?? null,
      })),
      templates: this.repositories.routines.list(ability.id, {
        templates: true,
      }),
    };
  }

  get(
    ability: SessionAbility,
    name: string,
    options: { template?: boolean } = {},
  ): Routine {
    const routine = this.repositories.routines.find(ability.id, name, options);
    if (!routine)
      throw new DaedalusError(
        "NOT_FOUND",
        `${options.template ? "Template" : "Routine"} '${name}' was not found`,
      );
    return routine;
  }

  /** The routine in the text form a session writes, for reading back. */
  text(routine: Routine): string {
    return renderRoutineFile(routine);
  }

  /**
   * Adds a routine from its text, or from a template with vars filled in.
   * The text is validated before anything is stored, so a bad schedule is
   * refused here rather than shown as a broken routine later.
   */
  add(ability: SessionAbility, input: RoutineAddInput): Routine {
    const now = this.now();
    let definition: RoutineDefinition;
    let template = false;
    if ("text" in input) {
      definition = parseRoutineFile(input.text, input.name);
      template = Boolean(input.template);
    } else {
      const source = this.get(ability, routineName(input.from), {
        template: true,
      });
      const vars = { ...source.vars, ...input.vars };
      definition = {
        name: routineName(
          input.name ??
            `${source.name}-${Bun.hash(JSON.stringify(vars)).toString(36).slice(0, 6)}`,
        ),
        schedule: input.schedule
          ? parseSchedule(input.schedule)
          : source.schedule,
        until: input.until
          ? parseUntil(input.until, now).toISOString()
          : source.until,
        model: source.model,
        timeoutMs: source.timeoutMs,
        output: source.output,
        enabled: input.enabled ?? true,
        vars,
        body: source.body,
      };
    }
    const existing = this.repositories.routines.find(
      ability.id,
      definition.name,
      { template },
    );
    const at = now.toISOString();
    if (existing) {
      if (!("text" in input) || !input.replace)
        throw new DaedalusError(
          "CONFLICT",
          `${template ? "Template" : "Routine"} '${definition.name}' already exists; pass --replace to overwrite it`,
        );
      const scheduleChanged =
        existing.schedule.text !== definition.schedule.text;
      const replaced: Routine = {
        ...existing,
        ...definition,
        // A new schedule starts from now; the old one's next slot is stale.
        nextRunAt: scheduleChanged
          ? (nextRunTime(definition.schedule, {
              now,
              lastRunAt: existing.lastRunAt,
            })?.toISOString() ?? null)
          : existing.nextRunAt,
        updatedAt: at,
      };
      this.repositories.routines.update(replaced);
      return replaced;
    }
    const routine: Routine = {
      ...definition,
      id: crypto.randomUUID(),
      abilityId: ability.id,
      isTemplate: template,
      nextRunAt: template
        ? null
        : (nextRunTime(definition.schedule, {
            now,
            lastRunAt: null,
          })?.toISOString() ?? null),
      lastRunAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.repositories.routines.create(routine);
    return routine;
  }

  setEnabled(ability: SessionAbility, name: string, enabled: boolean): Routine {
    const routine = this.get(ability, name);
    const updated: Routine = {
      ...routine,
      enabled,
      // Enabling is the user deciding the routine should run on its schedule
      // from now, not "catch up on everything since it was switched off".
      nextRunAt: enabled
        ? (nextRunTime(routine.schedule, {
            now: this.now(),
            lastRunAt: routine.lastRunAt,
          })?.toISOString() ?? null)
        : routine.nextRunAt,
      updatedAt: this.now().toISOString(),
    };
    this.repositories.routines.update(updated);
    return updated;
  }

  remove(
    ability: SessionAbility,
    name: string,
    options: { template?: boolean } = {},
  ): Routine {
    const routine = this.get(ability, name, options);
    this.repositories.routines.delete(routine.id);
    return routine;
  }

  /**
   * Queues a run now, whatever the schedule says. A run already waiting to
   * be typed in is the same request, so it is returned rather than refused;
   * only a run that is running now is a conflict.
   */
  runNow(
    ability: SessionAbility,
    name: string,
  ): RoutineRun & { alreadyQueued?: boolean } {
    const routine = this.get(ability, name);
    const existing = this.inFlightRuns(ability).find(
      (run) => run.routine === routine.name,
    );
    if (existing?.deliveredAt)
      throw new DaedalusError(
        "CONFLICT",
        `Routine '${name}' is running now (run ${existing.id})`,
      );
    if (existing) return { ...existing, alreadyQueued: true };
    return this.repositories.routines.createRun({
      abilityId: ability.id,
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
  inFlightRuns(ability: SessionAbility): RoutineRun[] {
    return this.repositories.routines.listRuns(ability.id, {
      statuses: ["queued", "running"],
      limit: 100,
    });
  }

  /** Runs that were typed into the session and have not ended. */
  deliveredRuns(ability: SessionAbility): RoutineRun[] {
    return this.inFlightRuns(ability).filter((run) => run.deliveredAt);
  }

  /** Runs waiting to be typed in, oldest first. */
  waitingRuns(ability: SessionAbility): RoutineRun[] {
    return this.inFlightRuns(ability)
      .filter((run) => !run.deliveredAt)
      .sort((left, right) => left.id - right.id);
  }

  runs(
    ability: SessionAbility,
    filters: { routine?: string; limit?: number } = {},
  ): RoutineRun[] {
    return this.repositories.routines.listRuns(ability.id, filters);
  }

  requireRun(id: number, ability?: SessionAbility): RoutineRun {
    const run = this.repositories.routines.findRun(id);
    if (!run || (ability && run.abilityId !== ability.id))
      throw new DaedalusError("NOT_FOUND", `Routine run ${id} was not found`);
    return run;
  }

  /**
   * The session's first step of a run: marks it running and hands back the
   * prompt it should give its subagent, with every placeholder filled in.
   */
  start(ability: SessionAbility, id: number): RoutineStart {
    const run = this.requireRun(id, ability);
    if (run.status !== "queued")
      throw new DaedalusError(
        "CONFLICT",
        `Run ${id} is ${run.status}, not queued`,
      );
    const routine = this.repositories.routines.find(ability.id, run.routine);
    if (!routine) {
      this.finish(run, "skipped", null, "The routine is gone");
      throw new DaedalusError(
        "NOT_FOUND",
        `Routine '${run.routine}' no longer exists`,
      );
    }
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const previous = this.repositories.routines
      .listRuns(ability.id, {
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
      sessionId: run.sessionId ?? ability.sessionId,
    };
    this.repositories.routines.updateRun(started);
    // A run that waited behind the user's typing is late by that wait too.
    const missedMs =
      run.missedMs + (nowDate.getTime() - Date.parse(run.queuedAt));
    const prompt = fillPlaceholders(routine.body, {
      ...routine.vars,
      last_run: previous?.startedAt
        ? localTime(previous.startedAt)
        : "never (this is the first run; look back one schedule interval)",
      run_id: String(run.id),
      now: localTime(now),
      missed: missedMs > MISSED_GRACE_MS ? formatDuration(missedMs) : "0m",
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
      purpose: ability.config.purpose ?? null,
      openReports: this.repositories.routines.listReports(ability.id, {
        states: ["open"],
      }),
    };
  }

  async done(
    ability: SessionAbility,
    id: number,
    outcomeValue: string,
    summary: string,
  ): Promise<RoutineRun> {
    if (!OUTCOMES.includes(outcomeValue as RoutineRunOutcome))
      throw new DaedalusError(
        "VALIDATION",
        `Outcome must be one of: ${OUTCOMES.join(", ")}`,
      );
    const run = this.requireRun(id, ability);
    if (run.status !== "running" && run.status !== "queued")
      throw new DaedalusError("CONFLICT", `Run ${id} already ended`);
    const finished = this.finish(
      run,
      "done",
      outcomeValue as RoutineRunOutcome,
      summary,
    );
    this.removeFinishedOneShot(ability, run.routine);
    return finished;
  }

  async fail(
    ability: SessionAbility,
    id: number,
    summary: string,
  ): Promise<RoutineRun> {
    const run = this.requireRun(id, ability);
    if (run.status !== "running" && run.status !== "queued")
      throw new DaedalusError("CONFLICT", `Run ${id} already ended`);
    const failed = this.finish(run, "failed", null, summary);
    await this.afterFailure(ability, failed);
    this.removeFinishedOneShot(ability, run.routine);
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
      this.repositories.routines.updateRun(finished);
      const routine = this.repositories.routines.find(
        run.abilityId,
        run.routine,
      );
      if (routine && status !== "skipped")
        this.repositories.routines.update({
          ...routine,
          lastSuccessAt: status === "done" ? now : routine.lastSuccessAt,
          consecutiveFailures:
            status === "done" ? 0 : routine.consecutiveFailures + 1,
        });
    });
    return finished;
  }

  private async afterFailure(
    ability: SessionAbility,
    run: RoutineRun,
  ): Promise<void> {
    const routine = this.repositories.routines.find(ability.id, run.routine);
    if (!routine || routine.consecutiveFailures !== FAILURE_BADGE_THRESHOLD)
      return;
    await this.raiseAttention(
      ability.sessionId,
      `Routine '${run.routine}' failed ${FAILURE_BADGE_THRESHOLD} times in a row: ${run.summary ?? "no result"}`,
    ).catch(() => undefined);
  }

  /** A one-shot `at` routine is done with once its run has ended. */
  private removeFinishedOneShot(ability: SessionAbility, name: string): void {
    const routine = this.repositories.routines.find(ability.id, name);
    if (routine?.schedule.kind === "at")
      this.repositories.routines.delete(routine.id);
  }

  /**
   * The clock. Queues every routine that is due, once however late it is.
   * A routine whose run still waits to be typed in queues nothing more: the
   * waiting run goes in once, late. One whose run is running is skipped.
   * Removes routines past their `until` and fails runs past their timeout.
   * Returns the runs it queued.
   */
  async schedule(
    ability: SessionAbility,
    options: { queue: boolean },
  ): Promise<RoutineRun[]> {
    const now = this.now();
    const at = now.toISOString();
    const store = this.repositories.routines;
    const inFlight = this.inFlightRuns(ability);
    const running = new Set(
      inFlight.filter((run) => run.deliveredAt).map((run) => run.routine),
    );
    const waiting = new Set(
      inFlight.filter((run) => !run.deliveredAt).map((run) => run.routine),
    );
    const queued: RoutineRun[] = [];
    for (const routine of store.list(ability.id)) {
      if (routine.until && Date.parse(routine.until) <= now.getTime()) {
        // Past its `until`: it deletes itself once nothing is in flight.
        if (!running.has(routine.name) && !waiting.has(routine.name))
          store.delete(routine.id);
        continue;
      }
      if (
        !options.queue ||
        !routine.enabled ||
        !routine.nextRunAt ||
        Date.parse(routine.nextRunAt) > now.getTime()
      )
        continue;
      const missedMs = now.getTime() - Date.parse(routine.nextRunAt);
      const next = nextRunTime(routine.schedule, { now, lastRunAt: at });
      store.update({
        ...routine,
        lastRunAt: at,
        nextRunAt:
          next && next.getTime() <= now.getTime()
            ? new Date(now.getTime() + 60_000).toISOString()
            : (next?.toISOString() ?? null),
      });
      if (waiting.has(routine.name)) continue;
      if (running.has(routine.name)) {
        store.createRun({
          abilityId: ability.id,
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
        store.createRun({
          abilityId: ability.id,
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
      waiting.add(routine.name);
    }
    await this.timeOut(ability, now);
    return queued;
  }

  /** A typed run with no result after its routine's timeout has failed. */
  private async timeOut(ability: SessionAbility, now: Date): Promise<void> {
    for (const run of this.deliveredRuns(ability)) {
      const routine = this.repositories.routines.find(ability.id, run.routine);
      const timeoutMs = routine?.timeoutMs ?? 10 * 60_000;
      const since = Date.parse(run.startedAt ?? run.deliveredAt!);
      if (now.getTime() - since <= timeoutMs) continue;
      const failed = this.finish(
        run,
        "failed",
        null,
        run.startedAt
          ? `Timed out after ${formatDuration(timeoutMs)} with no result`
          : "Delivered but never started",
      );
      await this.afterFailure(ability, failed);
      this.removeFinishedOneShot(ability, run.routine);
    }
  }

  /** Marks a run as typed into the session. */
  markDelivered(run: RoutineRun, sessionId: string): RoutineRun {
    const delivered: RoutineRun = {
      ...run,
      sessionId,
      deliveredAt: this.now().toISOString(),
    };
    this.repositories.routines.updateRun(delivered);
    return delivered;
  }

  /** Drops queued runs nobody will deliver: the ability was revoked. */
  skipUndelivered(ability: SessionAbility, reason: string): number {
    const pending = this.waitingRuns(ability);
    for (const run of pending) this.finish(run, "skipped", null, reason);
    return pending.length;
  }
}

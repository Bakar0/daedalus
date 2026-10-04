import type {
  AgentActivityState,
  AgentSession,
  RoutineRun,
  SessionAbility,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import { ROUTINE_RUN_SKILL, type AbilityService } from "./abilities";
import type { AgentService } from "./agents";
import type { DeliveryGate, DeliveryHold } from "./delivery";
import type { RoutineReportService } from "./routine-reports";
import type { RoutineService } from "./routines";

/**
 * Runs typed in and unfinished at once, per provider. Claude hands each run
 * to a background subagent and is back at its prompt at once; Codex has no
 * background subagents and does each run itself, so it takes one at a time.
 */
export const MAX_RUNS_IN_FLIGHT: Readonly<Record<string, number>> = {
  claude: 3,
  codex: 1,
};
/** The context share a routines session hands off at, when its workspace sets none. */
export const ROUTINES_HANDOFF_PERCENT = 60;
/** A drain waits this long for runs in flight before handing off anyway. */
export const DRAIN_LIMIT_MS = 10 * 60_000;
/** A handoff the session never completed is finished by Daedalus after this. */
const HANDOFF_LIMIT_MS = 15 * 60_000;
/** Between two lines typed into one session, at least this long. */
const DELIVERY_GAP_MS = 15_000;
/**
 * A line typed with no activity reading since is presumed lost after this,
 * so a session whose hooks do not report still gets its routines.
 */
const UNACKNOWLEDGED_DELIVERY_MS = 2 * 60_000;

export interface RoutineTickInput {
  /** Context use per session, from telemetry. */
  contextPercent: (sessionId: string) => number | undefined;
  activity: (sessionId: string) => AgentActivityState | undefined;
}

export interface RoutineTickResult {
  queued: RoutineRun[];
  delivered: RoutineRun[];
  /** Sessions a grant or revoke note was typed into. */
  notes: string[];
  events: string[];
}

/** What the routine bar above a session's terminal shows. */
export interface RoutinesStatus {
  ability: SessionAbility;
  /** Runs waiting to be typed in, oldest first. */
  waiting: RoutineRun[];
  /** Runs typed in and not finished. */
  running: number;
  /** Why the waiting runs are not going in, when they are not. */
  hold: DeliveryHold | null;
  nextRun: { routine: string; at: string } | null;
  lastKeystrokeAt: string | null;
  routines: number;
  openReports: number;
  openUrgentReports: number;
  openReportTasks: number;
}

/**
 * The clock for the routines ability, on the desktop host's tick. It queues
 * due runs and types them into their sessions through the delivery gate, the
 * same rule that types grant and revoke notes, and it drains a session whose
 * context is full before asking it to hand off.
 */
export class RoutineDelivery {
  /** The last tick's reason for holding delivery, per ability. */
  private readonly holds = new Map<string, DeliveryHold | null>();
  /** Abilities draining for a handoff: which session, and since when. */
  private readonly draining = new Map<
    string,
    { sessionId: string; since: number }
  >();
  /** When a line was last typed into each session. */
  private readonly lastTyped = new Map<string, number>();
  /** Hold changes since the last tick returned, for the host's log. */
  private holdEvents: string[] = [];

  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly abilities: AbilityService,
    private readonly agents: AgentService,
    private readonly routines: RoutineService,
    private readonly reports: RoutineReportService,
    private readonly gate: DeliveryGate,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * One pass of the clock. The desktop host calls this on its 1.2 s tick;
   * nothing fires while the app is closed. Each ability is handled on its
   * own, so one that fails does not hold up another.
   */
  async tick(input: RoutineTickInput): Promise<RoutineTickResult> {
    const result: RoutineTickResult = {
      queued: [],
      delivered: [],
      notes: [],
      events: [],
    };
    const typed = new Set<string>();
    for (const row of this.repositories.abilities.list()) {
      if (!row.pendingNote) continue;
      try {
        if (await this.deliverNote(row, input)) {
          typed.add(row.sessionId);
          result.notes.push(row.sessionId);
        }
      } catch (error) {
        result.events.push(`${row.sessionId}: ${message(error)}`);
      }
    }
    for (const ability of this.abilities.holders("routines")) {
      try {
        await this.tickAbility(ability, input, result, typed);
      } catch (error) {
        result.events.push(`${this.name(ability)}: ${message(error)}`);
      }
    }
    result.events.push(...this.holdEvents);
    this.holdEvents = [];
    return result;
  }

  /** What the bar above each routines session shows. */
  status(ability: SessionAbility): RoutinesStatus {
    const inFlight = this.routines.inFlightRuns(ability);
    const waiting = inFlight
      .filter((run) => !run.deliveredAt)
      .sort((left, right) => left.id - right.id);
    const open = this.repositories.routines.listReports(ability.id, {
      states: ["open"],
    });
    const routines = this.repositories.routines
      .list(ability.id)
      .filter((routine) => routine.enabled && routine.nextRunAt);
    const next = routines.sort((left, right) =>
      left.nextRunAt!.localeCompare(right.nextRunAt!),
    )[0];
    const quiet = this.gate.quietUntil(ability.sessionId);
    return {
      ability,
      waiting,
      running: inFlight.length - waiting.length,
      // Typing is read live, so the countdown is right between ticks.
      hold: ability.paused
        ? { reason: "paused", text: "routines are paused" }
        : waiting.length === 0
          ? null
          : quiet
            ? {
                reason: "typing",
                text: "you typed in this session",
                until: quiet.toISOString(),
              }
            : (this.holds.get(ability.id) ?? null),
      nextRun:
        !ability.paused && next
          ? { routine: next.name, at: next.nextRunAt! }
          : null,
      lastKeystrokeAt: this.gate.lastKeystrokeAt(ability.sessionId),
      routines: this.repositories.routines.list(ability.id).length,
      openReports: open.length,
      openUrgentReports: open.filter((report) => report.urgent).length,
      openReportTasks: new Set(
        open.flatMap((report) => (report.taskId ? [report.taskId] : [])),
      ).size,
    };
  }

  /**
   * Run now from the bar: queues the routine if nothing is waiting, and
   * lets the next line skip the quiet time after typing. Every other rule
   * still holds; the input box must be empty and the session idle.
   */
  runNow(
    ability: SessionAbility,
    name?: string,
  ): RoutineRun & { alreadyQueued?: boolean } {
    const run = name
      ? this.routines.runNow(ability, name)
      : this.routines.waitingRuns(ability)[0];
    if (!run) throw new DaedalusError("CONFLICT", "No routine run is waiting");
    this.gate.skipQuietOnce(ability.sessionId);
    return { ...run, ...(name ? {} : { alreadyQueued: true }) };
  }

  private async tickAbility(
    ability: SessionAbility,
    input: RoutineTickInput,
    result: RoutineTickResult,
    typed: Set<string>,
  ): Promise<void> {
    this.reports.sweep(ability);
    result.queued.push(
      ...(await this.routines.schedule(ability, { queue: !ability.paused })),
    );
    if (ability.paused)
      return this.hold(ability, {
        reason: "paused",
        text: "routines are paused",
      });
    const session = this.repositories.findAgent(ability.sessionId);
    if (!session || session.status !== "running" || session.archivedAt)
      return this.hold(ability, {
        reason: "stopped",
        text: "the session is not running",
      });
    if (typed.has(session.id) || ability.pendingNote) return;
    const delivered = this.routines.deliveredRuns(ability);
    const now = this.now().getTime();

    let drain = this.draining.get(ability.id);
    if (drain && drain.sessionId !== session.id) {
      // The handoff happened: the ability moved to the successor.
      this.draining.delete(ability.id);
      drain = undefined;
    }
    if (!drain) {
      const workspace = this.repositories.findWorkspace(session.workspaceId);
      const threshold =
        workspace?.autoHandoffPercent ?? ROUTINES_HANDOFF_PERCENT;
      const percent = input.contextPercent(session.id);
      if (percent !== undefined && percent >= threshold) {
        drain = { sessionId: session.id, since: now };
        this.draining.set(ability.id, drain);
        result.events.push(`${session.name}: draining for a full context`);
      }
    }
    if (drain) return this.drain(ability, session, drain, delivered, input);

    if (session.handoffRequestedAt)
      return this.hold(ability, {
        reason: "handoff",
        text: "the session is handing off",
      });
    const limit = MAX_RUNS_IN_FLIGHT[session.provider] ?? 1;
    if (delivered.length >= limit)
      return this.hold(ability, {
        reason: "in-flight-limit",
        text: `${delivered.length} ${delivered.length === 1 ? "run is" : "runs are"} in flight`,
      });
    const busy = new Set(delivered.map((run) => run.routine));
    const next = this.routines
      .waitingRuns(ability)
      .find((run) => !busy.has(run.routine));
    if (!next) return this.hold(ability, null);
    const activity = input.activity(session.id);
    if (!this.settled(session.id, activity)) return;
    const screen = await this.agents
      .screen(session.id, { styled: true })
      .catch(() => "");
    const hold = this.gate.check({ session, activity, screen });
    if (hold) return this.hold(ability, hold);
    try {
      await this.agents.invokeSkill(
        session.id,
        ROUTINE_RUN_SKILL,
        String(next.id),
      );
    } catch (error) {
      if (error instanceof DaedalusError && error.code === "CONFLICT")
        return this.hold(ability, {
          reason: "skill-missing",
          text: error.message,
        });
      throw error;
    }
    this.typed(session.id);
    this.hold(ability, null);
    result.delivered.push(this.routines.markDelivered(next, session.id));
  }

  /**
   * A full context: no new runs go in. Once the runs in flight finish, or
   * after `DRAIN_LIMIT_MS`, the handoff is typed under the delivery rule
   * like any other line. A handoff the session never completes is finished
   * by Daedalus, without a note: the routines live outside the conversation.
   */
  private async drain(
    ability: SessionAbility,
    session: AgentSession,
    drain: { since: number },
    delivered: RoutineRun[],
    input: RoutineTickInput,
  ): Promise<void> {
    const now = this.now().getTime();
    this.hold(ability, {
      reason: "handoff",
      text:
        delivered.length && now - drain.since < DRAIN_LIMIT_MS
          ? "waiting for runs in flight before a handoff"
          : "the session is handing off",
    });
    if (session.handoffRequestedAt) {
      if (now - Date.parse(session.handoffRequestedAt) >= HANDOFF_LIMIT_MS)
        await this.agents.continueSession({ id: session.id });
      return;
    }
    if (delivered.length && now - drain.since < DRAIN_LIMIT_MS) return;
    const activity = input.activity(session.id);
    if (!this.settled(session.id, activity)) return;
    const screen = await this.agents
      .screen(session.id, { styled: true })
      .catch(() => "");
    if (this.gate.check({ session, activity, screen })) return;
    await this.agents.requestHandoff(session.id);
    this.typed(session.id);
  }

  /** Types a grant or revoke note under the delivery rule. */
  private async deliverNote(
    row: SessionAbility,
    input: RoutineTickInput,
  ): Promise<boolean> {
    const note = row.pendingNote!;
    const session = this.repositories.findAgent(row.sessionId);
    if (!session || session.archivedAt || session.status !== "running")
      return false;
    const activity = input.activity(session.id);
    if (!this.settled(session.id, activity)) return false;
    const screen = await this.agents
      .screen(session.id, { styled: true })
      .catch(() => "");
    if (this.gate.check({ session, activity, screen })) return false;
    await this.agents.send(session.id, note);
    this.abilities.noteDelivered(row, note);
    this.typed(session.id);
    return true;
  }

  /**
   * Whether the last line typed into the session has had time to land: a
   * gap between lines, and an activity reading since the last one, or long
   * enough without one that it was lost.
   */
  private settled(
    sessionId: string,
    activity: AgentActivityState | undefined,
  ): boolean {
    const last = this.lastTyped.get(sessionId);
    if (last === undefined) return true;
    const now = this.now().getTime();
    if (now - last < DELIVERY_GAP_MS) return false;
    const seen = activity && Date.parse(activity.observedAt) > last;
    return Boolean(seen) || now - last >= UNACKNOWLEDGED_DELIVERY_MS;
  }

  private typed(sessionId: string): void {
    this.lastTyped.set(sessionId, this.now().getTime());
    this.gate.delivered(sessionId);
  }

  /**
   * Records why delivery is held, and logs when the reason changes, so a run
   * that never goes in can be explained after the fact.
   */
  private hold(ability: SessionAbility, hold: DeliveryHold | null): void {
    const before = this.holds.get(ability.id);
    this.holds.set(ability.id, hold);
    if ((before?.reason ?? null) !== (hold?.reason ?? null))
      this.holdEvents.push(
        `${this.name(ability)}: ${hold ? `holding, ${hold.text}` : "not holding"}`,
      );
  }

  private name(ability: SessionAbility): string {
    return this.repositories.findAgent(ability.sessionId)?.name ?? ability.id;
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

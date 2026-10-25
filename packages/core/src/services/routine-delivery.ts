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
import type { DeliveryHold } from "./delivery";
import type { RoutineReportService } from "./routine-reports";
import type { RoutineService } from "./routines";
import type { SessionChannel } from "./session-channel";

/**
 * Runs typed in and unfinished at once, per provider. Claude hands each run
 * to a background subagent and is back at its prompt at once; Codex has no
 * background subagents and does each run itself, so it takes one at a time.
 */
export const MAX_RUNS_IN_FLIGHT: Readonly<Record<string, number>> = {
  claude: 3,
  codex: 1,
};
/**
 * The context share a routines session is reborn at when its threshold comes
 * to off. The renderer's copy is `ROUTINES_REBIRTH_PERCENT` in the protocol.
 */
export const ROUTINES_REBIRTH_PERCENT = 60;
/** A drain waits this long for runs in flight before being reborn anyway. */
export const DRAIN_LIMIT_MS = 10 * 60_000;
/** A rebirth the session never completed is finished by Daedalus after this. */
const REBIRTH_LIMIT_MS = 15 * 60_000;

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
 * due runs and hands them to their sessions through the session channel, the
 * same way grant and revoke notes go in, and it drains a session whose
 * context is full before asking it to be reborn.
 */
export class RoutineDelivery {
  /** The last tick's reason for holding delivery, per ability. */
  private readonly holds = new Map<string, DeliveryHold | null>();
  /** Abilities draining for a rebirth: which session, and since when. */
  private readonly draining = new Map<
    string,
    { sessionId: string; since: number }
  >();
  /** Hold changes since the last tick returned, for the host's log. */
  private holdEvents: string[] = [];

  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly abilities: AbilityService,
    private readonly agents: AgentService,
    private readonly routines: RoutineService,
    private readonly reports: RoutineReportService,
    private readonly channel: SessionChannel,
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
    const owner = this.repositories.findAgent(ability.sessionId);
    const quiet = owner ? this.channel.quietUntil(owner) : null;
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
      lastKeystrokeAt: this.channel.lastKeystrokeAt(ability.sessionId),
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
    this.channel.skipQuietOnce(ability.sessionId);
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
    if (!session || session.status !== "running" || session.archivedAt) {
      // Asleep with its cloud workspace and a run due: woken and resumed,
      // and a later tick delivers. One that cannot resume says why on its
      // card and is not woken again.
      if (session && this.routines.waitingRuns(ability).length)
        void this.agents.wakeIfAsleep(session).catch(() => undefined);
      return this.hold(ability, {
        reason: "stopped",
        text: "the session is not running",
      });
    }
    if (typed.has(session.id) || ability.pendingNote) return;
    const delivered = this.routines.deliveredRuns(ability);
    const now = this.now().getTime();

    let drain = this.draining.get(ability.id);
    if (drain && drain.sessionId !== session.id) {
      // The rebirth happened: the ability moved to the successor.
      this.draining.delete(ability.id);
      drain = undefined;
    }
    if (!drain) {
      // Routines need a rebirth to keep running, so off means this default.
      const threshold =
        this.agents.autoRebirthThreshold(session) ?? ROUTINES_REBIRTH_PERCENT;
      const percent = input.contextPercent(session.id);
      if (percent !== undefined && percent >= threshold) {
        drain = { sessionId: session.id, since: now };
        this.draining.set(ability.id, drain);
        result.events.push(`${session.name}: draining for a full context`);
      }
    }
    if (drain) return this.drain(ability, session, drain, delivered, input);

    if (session.rebirthRequestedAt)
      return this.hold(ability, {
        reason: "rebirth",
        text: "the session is being reborn",
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
    const outcome = await this.channel.deliver(
      session,
      `Daedalus: routine run ${next.id} is due. Carry it out now with the ${this.abilities.skillName(ROUTINE_RUN_SKILL)} skill, for run id ${next.id}.`,
      {
        when: "at-prompt",
        activity: input.activity(session.id),
        skill: { id: ROUTINE_RUN_SKILL, args: String(next.id) },
      },
    );
    if (outcome.kind === "settling") return;
    if (outcome.kind === "held") return this.hold(ability, outcome.held);
    this.hold(ability, null);
    result.delivered.push(this.routines.markDelivered(next, session.id));
  }

  /**
   * A full context: no new runs go in. Once the runs in flight finish, or
   * after `DRAIN_LIMIT_MS`, the rebirth is typed under the delivery rule
   * like any other line. A rebirth the session never completes is finished
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
    const waiting = delivered.length > 0 && now - drain.since < DRAIN_LIMIT_MS;
    const rebirth: DeliveryHold = {
      reason: "rebirth",
      text: waiting
        ? "waiting for runs in flight before a rebirth"
        : "the session is being reborn",
    };
    if (session.rebirthRequestedAt) {
      this.hold(ability, rebirth);
      if (now - Date.parse(session.rebirthRequestedAt) >= REBIRTH_LIMIT_MS)
        await this.agents.continueSession({ id: session.id });
      return;
    }
    if (waiting) return this.hold(ability, rebirth);
    const outcome = await this.agents.requestRebirthAtPrompt(
      session,
      input.activity(session.id),
    );
    // Still a rebirth on the bar; the gate's reason goes in the text.
    this.hold(
      ability,
      outcome.kind === "held"
        ? { ...rebirth, text: `rebirth waits: ${outcome.held.text}` }
        : rebirth,
    );
  }

  /**
   * Hands a grant or revoke note to its session. An inbox takes it at once
   * and it arrives when the session is next at its prompt; typed, it waits
   * for the delivery rule.
   */
  private async deliverNote(
    row: SessionAbility,
    input: RoutineTickInput,
  ): Promise<boolean> {
    const note = row.pendingNote!;
    const session = this.repositories.findAgent(row.sessionId);
    if (!session || session.archivedAt || session.status !== "running")
      return false;
    const outcome = await this.channel.deliver(session, note, {
      when: "next-prompt",
      activity: input.activity(session.id),
    });
    if (outcome.kind !== "delivered") return false;
    this.abilities.noteDelivered(row, note);
    return true;
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

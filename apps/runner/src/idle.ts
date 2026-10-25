/**
 * Tracks how long the workspace has had nothing working. `observe` is called
 * on every tick with whether anything works; it answers true once the
 * workspace has been idle for the whole period.
 */
export class IdleTracker {
  #idleSince: number | undefined;

  constructor(private readonly idleMs: number) {}

  observe(active: boolean, now: number): boolean {
    if (active || this.idleMs <= 0) {
      this.#idleSince = undefined;
      return false;
    }
    this.#idleSince ??= now;
    return now - this.#idleSince >= this.idleMs;
  }
}

/**
 * A session that said it works and then said nothing for this long is taken
 * to have died mid-turn, so it no longer holds the pod awake.
 */
export const WORKING_SILENCE_MS = 4 * 60 * 60_000;

/** Events that start or carry on a turn, or a long tool call. */
const WORKING_EVENTS = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "PreCompact",
]);

/**
 * Which sessions in the pod are working, from the hook events their Claude
 * sends through `daedal agent event <Event>`. A Claude waiting for its user,
 * at its prompt or at a permission question, is not working. A tool call is
 * working from `PreToolUse` until its result, however long it runs. A
 * subagent's events are proof its parent's turn is alive, so a background
 * agent still running after its parent's `Stop` makes the session work again.
 * Only the event name, the session id and these payload fields are read.
 */
export class WorkingSessions {
  readonly #working = new Map<string, number>();

  constructor(private readonly silenceMs = WORKING_SILENCE_MS) {}

  observe(
    sessionId: string,
    event: string,
    payload: Record<string, unknown>,
    now: number,
  ): void {
    const subagent =
      typeof payload.agent_id === "string" ||
      typeof payload.agent_type === "string" ||
      event.startsWith("Subagent");
    const working =
      (subagent && event !== "SessionEnd") ||
      (WORKING_EVENTS.has(event) &&
        // Escape on a running tool ends the turn, and no `Stop` follows.
        !(event === "PostToolUseFailure" && payload.is_interrupt === true));
    if (working) this.#working.set(sessionId, now);
    else this.#working.delete(sessionId);
  }

  /** Whether any session works now; sessions silent too long are dropped. */
  any(now: number): boolean {
    for (const [sessionId, at] of this.#working)
      if (now - at >= this.silenceMs) this.#working.delete(sessionId);
    return this.#working.size > 0;
  }
}

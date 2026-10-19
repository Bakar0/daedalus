/**
 * Tracks how long the workspace has had nothing running. `observe` is called
 * on every tick with whether anything is live; it answers true once the
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

/**
 * How long after a mouse selection or drag a cloud session's terminal may
 * still write the clipboard. tmux copies a drag with OSC 52 as the mouse
 * button comes up, so a real copy lands well inside this.
 */
export const CLOUD_CLIPBOARD_WINDOW_MS = 1500;

/** How far the pointer moves while pressed before a click counts as a drag. */
export const DRAG_DISTANCE_PX = 4;

/**
 * Whether an OSC 52 clipboard write from a terminal is honoured. A local
 * session runs the user's own programs, so its writes always are. A cloud
 * session's output comes from a pod running code this Mac does not trust, so
 * a program there could put a command on the clipboard for the user to paste
 * somewhere else later. Its writes are honoured only within
 * `CLOUD_CLIPBOARD_WINDOW_MS` of the release that ends a gesture that copies,
 * a drag (press, move, release) or one that leaves a selection in the
 * terminal, and only one write per gesture (N-3). A plain click to focus the
 * terminal allows nothing.
 */
export class TerminalClipboardGate {
  #pressedAt: { x: number; y: number } | undefined;
  #dragged = false;
  /** When the last gesture ended, until a write uses it. */
  #gestureAt: number | undefined;

  press(x: number, y: number): void {
    this.#pressedAt = { x, y };
    this.#dragged = false;
    this.#gestureAt = undefined;
  }

  move(x: number, y: number): void {
    if (!this.#pressedAt) return;
    if (
      Math.hypot(x - this.#pressedAt.x, y - this.#pressedAt.y) >=
      DRAG_DISTANCE_PX
    )
      this.#dragged = true;
  }

  release(now: number): void {
    if (!this.#pressedAt) return;
    this.#gestureAt = now;
    this.#pressedAt = undefined;
  }

  /**
   * Decides one write, and uses up the gesture that allowed it.
   * `hasSelection` is whether the terminal holds a selection now, which a
   * double click makes without a drag.
   */
  accepts(input: {
    cloud: boolean;
    now: number;
    hasSelection: boolean;
  }): boolean {
    if (!input.cloud) return true;
    const at = this.#gestureAt;
    if (
      at === undefined ||
      input.now < at ||
      input.now - at > CLOUD_CLIPBOARD_WINDOW_MS ||
      !(this.#dragged || input.hasSelection)
    )
      return false;
    this.#gestureAt = undefined;
    return true;
  }
}

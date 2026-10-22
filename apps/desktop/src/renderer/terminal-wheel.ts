export type WheelInput = Pick<
  WheelEvent,
  "deltaY" | "deltaMode" | "altKey" | "ctrlKey"
>;

// WheelEvent's constants, which a test run without a DOM does not have.
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/**
 * Turns wheel events into whole lines, the way a browser scrolls a page: one
 * line for every line height the content would have moved.
 *
 * xterm.js does this differently for a program that asked for the mouse, and
 * every session's tmux does. It scales a trackpad's pixels by 0.75 and then
 * sends at most one wheel report per event, however many lines the event was
 * worth, so a fast flick was capped at one line a frame while a slow drag fell
 * behind the finger. Here the lines are counted exactly and the remainder is
 * kept for the next event, so a gesture moves as far as the finger did.
 */
export class WheelLines {
  #partial = 0;

  /** Signed lines to scroll for `event`: negative is up, toward history. */
  take(event: WheelInput, lineHeight: number, rows: number): number {
    if (event.deltaY === 0 || lineHeight <= 0) return 0;
    const lines =
      event.deltaMode === DOM_DELTA_LINE
        ? event.deltaY
        : event.deltaMode === DOM_DELTA_PAGE
          ? event.deltaY * rows
          : event.deltaY / lineHeight;
    // A change of direction starts over rather than first paying back what
    // the old direction left behind.
    if (Math.sign(lines) !== Math.sign(this.#partial)) this.#partial = 0;
    this.#partial += lines;
    const whole = Math.trunc(this.#partial);
    this.#partial -= whole;
    if (whole === 0) return 0;
    return Math.max(-rows, Math.min(rows, whole));
  }

  reset(): void {
    this.#partial = 0;
  }
}

/**
 * SGR (mode 1006) wheel reports for `lines`, one report per line, at the
 * 1-based cell `col`, `row`. tmux asks for SGR whenever its mouse is on, and
 * passes each report on to the program or scrolls copy mode a line with it.
 */
export function sgrWheelReports(
  lines: number,
  col: number,
  row: number,
  event: Pick<WheelInput, "altKey" | "ctrlKey">,
): string {
  if (lines === 0) return "";
  const button =
    (lines < 0 ? 64 : 65) + (event.altKey ? 8 : 0) + (event.ctrlKey ? 16 : 0);
  return `\u001b[<${button};${col};${row}M`.repeat(Math.abs(lines));
}

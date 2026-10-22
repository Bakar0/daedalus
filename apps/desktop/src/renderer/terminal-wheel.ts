export type WheelInput = Pick<
  WheelEvent,
  "deltaY" | "deltaMode" | "altKey" | "ctrlKey"
>;

export type TerminalWheelEvent = WheelInput &
  Pick<WheelEvent, "shiftKey" | "clientX" | "clientY">;

/** What the wheel handler needs to know about the terminal under the wheel. */
export interface WheelTarget {
  /** The program asked for SGR mouse reports (mode 1006). */
  sgrMouse: boolean;
  /** The program asked for mouse reports at all. */
  mouseTracking: boolean;
  cols: number;
  rows: number;
  /** The screen element's box, in client pixels. */
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">;
}

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

/**
 * The wheel reports to send the program for `event`, or `undefined` when the
 * event is xterm's to handle: no program reading SGR mouse reports, or Shift
 * held, which xterm keeps for itself. `consumed` says whether to cancel the
 * browser's default: every vertical event over such a program is the
 * program's, even one not yet worth a line, while a horizontal-only one is not.
 */
export function wheelToReports(
  lines: WheelLines,
  event: TerminalWheelEvent,
  target: WheelTarget,
): { reports: string; consumed: boolean } | undefined {
  if (!target.sgrMouse || !target.mouseTracking || event.shiftKey) {
    lines.reset();
    return undefined;
  }
  const consumed = event.deltaY !== 0;
  const cellWidth = target.bounds.width / target.cols;
  const cellHeight = target.bounds.height / target.rows;
  if (!(cellWidth > 0 && cellHeight > 0)) return { reports: "", consumed };
  const cell = (offset: number, size: number, count: number) =>
    Math.max(1, Math.min(count, Math.floor(offset / size) + 1));
  return {
    reports: sgrWheelReports(
      lines.take(event, cellHeight, target.rows),
      cell(event.clientX - target.bounds.left, cellWidth, target.cols),
      cell(event.clientY - target.bounds.top, cellHeight, target.rows),
      event,
    ),
    consumed,
  };
}

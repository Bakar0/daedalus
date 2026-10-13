/**
 * Mouse reports, as xterm.js writes them when the program asked for mouse
 * tracking (tmux runs with `mouse on`): SGR (`ESC [ < b ; x ; y M`), urxvt
 * (`ESC [ b ; x ; y M`) and the old X10 form (`ESC [ M` and three bytes).
 */
const MOUSE_REPORTS =
  /\u001b\[<[^Mm]*[Mm]|\u001b\[\d+;[^;]*;[^M]*M|\u001b\[M[\s\S]{3}/g;

/**
 * What the phone sends to the terminal for a chunk of xterm input. A touch
 * has no mouse coordinates, so xterm turns a tap into a report full of
 * `NaN`, and tmux types the broken sequence into the program. The phone has
 * no mouse, so every report is dropped.
 */
export function phoneTerminalInput(data: string): string {
  return data.replace(MOUSE_REPORTS, "");
}

/** What a terminal receives as Backspace. */
export const BACKSPACE = "\u007f";

/**
 * The keystrokes that turn the text the terminal was typed so far into the
 * message box's new text: Backspace back to where they differ, then the
 * rest. Counted in characters, not UTF-16 units, so an emoji is one
 * Backspace. Newlines become spaces: in a terminal a newline is Enter, and
 * only Send presses that.
 */
export function typingDiff(before: string, after: string): string {
  const old = Array.from(before);
  const next = Array.from(after.replaceAll(/\r?\n/g, " "));
  let same = 0;
  while (same < old.length && same < next.length && old[same] === next[same])
    same += 1;
  return BACKSPACE.repeat(old.length - same) + next.slice(same).join("");
}

/**
 * The SGR mouse wheel reports for scrolling `steps` notches at a cell (1-based
 * column and row). A positive count scrolls back to older output, as a finger
 * dragging down does. tmux reads them whatever mouse mode it asked for: it
 * passes them to a program that tracks the mouse, such as Claude's fullscreen
 * view, and otherwise scrolls its own history in copy mode.
 */
export function wheelReports(
  steps: number,
  column: number,
  row: number,
): string {
  const button = steps > 0 ? 64 : 65;
  return `\u001b[<${button};${column};${row}M`.repeat(Math.abs(steps));
}

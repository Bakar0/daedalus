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

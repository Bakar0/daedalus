/**
 * Keeping what tmux copied on screen. A program that reads no mouse, Codex or
 * a plain shell, leaves a drag to tmux, which highlights it in copy mode,
 * copies it with OSC 52 as the button comes up, and leaves copy mode, so the
 * highlight went with it. The terminal then selects the same text itself:
 * it stays until the next click or key, as in any terminal, and ⌘C copies it.
 */

/** A 1-based cell, as an SGR mouse report gives it. */
export interface Cell {
  col: number;
  row: number;
}

/** What `Terminal.select` takes: 0-based, `row` within the screen. */
export interface ScreenSelection {
  column: number;
  row: number;
  length: number;
}

/**
 * The left button's press or release in an SGR mouse report
 * (`ESC [ < b ; col ; row M|m`), or undefined for anything else: a drag, a
 * wheel, another button, typed text.
 */
export function leftButtonReport(
  data: string,
): { kind: "press" | "release"; cell: Cell } | undefined {
  const match = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
  if (!match) return undefined;
  // The low two bits are the button, 0 the left; 4, 8 and 16 are modifiers,
  // 32 is a drag and 64 a wheel.
  const button = Number(match[1]);
  if ((button & 0b11) !== 0 || button & (32 | 64)) return undefined;
  return {
    kind: match[4] === "M" ? "press" : "release",
    cell: { col: Number(match[2]), row: Number(match[3]) },
  };
}

const sameText = (a: string, b: string) =>
  a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/**
 * Where on screen `copied` sits, given the press and release that copied it
 * and the screen's rows (`lineAt`, 1-based). A drag runs from press to
 * release, either way round, with or without the release cell; a double
 * click copied the word under it. Undefined when the screen no longer shows
 * the text there, as after scrolling back in copy mode, so nothing wrong is
 * selected.
 */
export function copiedSelection({
  copied,
  press,
  release,
  cols,
  lineAt,
}: {
  copied: string;
  press: Cell;
  release: Cell;
  cols: number;
  lineAt: (row: number) => string | undefined;
}): ScreenSelection | undefined {
  if (!copied.trim()) return undefined;
  const forward =
    press.row < release.row ||
    (press.row === release.row && press.col <= release.col);
  const [from, to] = forward ? [press, release] : [release, press];
  for (const endCol of [to.col, to.col - 1]) {
    if (from.row === to.row && endCol < from.col) continue;
    const rows: string[] = [];
    for (let row = from.row; row <= to.row; row += 1) {
      const line = lineAt(row) ?? "";
      const start = row === from.row ? from.col - 1 : 0;
      const end = row === to.row ? endCol : line.length;
      rows.push(line.slice(start, end));
    }
    if (sameText(rows.join("\n"), copied))
      return {
        column: from.col - 1,
        row: from.row - 1,
        length: (to.row - from.row) * cols + endCol - (from.col - 1),
      };
  }
  // A double click: the word on the release row that covers the release.
  if (copied.includes("\n")) return undefined;
  const line = lineAt(release.row) ?? "";
  for (
    let index = line.indexOf(copied);
    index !== -1;
    index = line.indexOf(copied, index + 1)
  ) {
    if (index < release.col && release.col <= index + copied.length)
      return { column: index, row: release.row - 1, length: copied.length };
  }
  return undefined;
}

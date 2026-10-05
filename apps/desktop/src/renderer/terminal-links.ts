/** Cells on one buffer row, 1-based and inclusive like xterm's link ranges. */
export type LinkRow = { y: number; x1: number; x2: number };

export type LinkRange = {
  start: { x: number; y: number };
  end: { x: number; y: number };
};

/**
 * Every row a hovered link occupies, not only the piece under the mouse.
 *
 * xterm hands over one row's piece of an OSC 8 link at a time when the program
 * broke the URL with real line breaks rather than letting the terminal wrap it,
 * which is how Claude Code draws a long one. The URL itself is whole, so the
 * rows around the piece belong to the link while they spell out the rest of it:
 * the end of the row above is the part of the URL before the piece, and the
 * start of the row below, after any indent, is the part after it.
 *
 * `rowText` returns a buffer row's text, one character per cell.
 */
export function wholeLinkRows(
  url: string,
  range: LinkRange,
  cols: number,
  rowText: (y: number) => string | undefined,
): LinkRow[] {
  const rows: LinkRow[] = [];
  for (let y = range.start.y; y <= range.end.y; y++)
    rows.push({
      y,
      x1: y === range.start.y ? range.start.x : 1,
      x2: y === range.end.y ? range.end.x : cols,
    });
  const piece = rows
    .map((row) => rowText(row.y)?.slice(row.x1 - 1, row.x2) ?? "")
    .join("");
  const at = piece ? url.indexOf(piece) : -1;
  if (at < 0) return rows;

  let before = url.slice(0, at);
  for (let y = range.start.y - 1; before && y >= 1; y--) {
    const text = rowText(y)?.trimEnd();
    if (!text) break;
    const shared = commonSuffix(text, before);
    // The rest of the row must be indent unless this row is where it starts.
    if (!shared || (shared < before.length && text.slice(0, -shared).trim()))
      break;
    rows.unshift({ y, x1: text.length - shared + 1, x2: text.length });
    before = before.slice(0, -shared);
  }

  let after = url.slice(at + piece.length);
  for (let y = range.end.y + 1; after; y++) {
    const text = rowText(y)?.trimEnd();
    if (!text) break;
    const indent = text.length - text.trimStart().length;
    const shared = commonPrefix(text.slice(indent), after);
    if (!shared || (shared < after.length && shared < text.length - indent))
      break;
    rows.push({ y, x1: indent + 1, x2: indent + shared });
    after = after.slice(shared);
  }
  return rows;
}

function commonSuffix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a.at(-1 - n) === b.at(-1 - n)) n++;
  return n;
}

function commonPrefix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

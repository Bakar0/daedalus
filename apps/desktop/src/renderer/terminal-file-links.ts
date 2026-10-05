/**
 * Picks out what in a line of terminal text looks like a path to a file:
 * `src/a.ts`, `./notes.md:12`, `/Users/me/x.tsx:4:2`, `a.py(10,3)`. A path
 * needs a slash or an extension, so ordinary words are left alone, and a
 * URL's tail is not mistaken for one. Whether it exists is the caller's
 * question.
 */
export function findPathCandidates(line: string): Array<{
  text: string;
  index: number;
  path: string;
  line?: number;
  column?: number;
}> {
  const pattern =
    /(?<![\w./~-])((?:~|\.{1,2})?\/?(?:[\w.@+-]+\/)*[\w.@+-]*[\w@+-]\.[A-Za-z0-9]{1,12}|(?:~|\.{1,2})?\/?(?:[\w.@+-]+\/)+[\w.@+-]+)(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?/g;
  const found: ReturnType<typeof findPathCandidates> = [];
  for (const match of line.matchAll(pattern)) {
    const [text, path] = match;
    const index = match.index ?? 0;
    if (!path || /:\/\/$/.test(line.slice(Math.max(0, index - 3), index)))
      continue;
    if (/^v?\d+(\.\d+)+$/.test(path)) continue;
    const lineNumber = match[2] ?? match[4];
    const column = match[3] ?? match[5];
    found.push({
      text,
      index,
      path,
      ...(lineNumber ? { line: Number.parseInt(lineNumber, 10) } : {}),
      ...(column ? { column: Number.parseInt(column, 10) } : {}),
    });
  }
  return found;
}

import { diffLines } from "diff";

export interface QuickDiffRange {
  kind: "added" | "modified" | "deleted";
  /** 1-based lines of the current text; for a deletion, the line it sits above. */
  startLine: number;
  endLine: number;
}

/**
 * Lines the current text added, changed or lost against an earlier version,
 * as VS Code's editor margin marks them: a removal followed by an addition
 * is a modification, and a removal alone is a marker on the line that now
 * stands where the removed lines were.
 */
export function quickDiff(original: string, current: string): QuickDiffRange[] {
  const ranges: QuickDiffRange[] = [];
  const parts = diffLines(original, current);
  const lastLine = Math.max(1, current.split("\n").length);
  let line = 1;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const count = part.count ?? 0;
    if (!part.added && !part.removed) {
      line += count;
      continue;
    }
    if (part.removed) {
      const next = parts[index + 1];
      if (next?.added) {
        const added = next.count ?? 0;
        ranges.push({
          kind: "modified",
          startLine: line,
          endLine: line + added - 1,
        });
        line += added;
        index += 1;
      } else {
        const at = Math.min(line, lastLine);
        ranges.push({ kind: "deleted", startLine: at, endLine: at });
      }
      continue;
    }
    ranges.push({ kind: "added", startLine: line, endLine: line + count - 1 });
    line += count;
  }
  return ranges;
}

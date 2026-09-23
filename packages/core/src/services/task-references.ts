import type { Task } from "../domain";

/**
 * Task-to-task references, read from the brief. There is no relations table:
 * briefs in this workspace already say "Depends on #10" in prose, and a second
 * place to record the same fact would drift from the first.
 *
 * Two kinds. A hard dependency is written `depends on #N`, `after #N` or
 * `blocked by #N`, with one or more numbers joined by commas or "and". Any
 * other `#N` is a plain reference: linked, never blocking. Neither is a lock;
 * the board warns on Start and sorts a waiting task below the ready ones.
 */
export interface TaskReference {
  number: number;
  hard: boolean;
}

export interface ResolvedTaskReference extends TaskReference {
  taskId: string;
}

/**
 * Code is an example, not a claim. A brief that shows `after #23` in a code
 * span or sketches a board in an indented block is not declaring anything,
 * and #25's own brief does both.
 */
function withoutCode(markdown: string): string {
  const lines: string[] = [];
  let fenced = false;
  let previousBlank = true;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      previousBlank = false;
      continue;
    }
    if (fenced) continue;
    // Indented code: four spaces or a tab, not a list item's continuation.
    const indented = /^( {4,}|\t)/.test(line);
    const listItem = /^\s*([-*+]|\d+[.)])\s/.test(line);
    if (indented && !listItem && (previousBlank || lines.at(-1) === ""))
      continue;
    lines.push(line.replace(/`[^`\n]*`/g, " "));
    previousBlank = line.trim() === "";
  }
  return lines.join("\n");
}

/**
 * `#N` standing on its own. A number glued to a word or path (`other#3`,
 * `pull/3`) belongs to something else, and `PR #22` is a pull request.
 */
const REFERENCE =
  /(?<![\w#/.-])(?<!\b(?:PRs?|pull requests?|issues?)\s)#(\d+)\b/gi;

const HARD =
  /\b(?:depends\s+on|after|blocked\s+by)\s+(#\d+(?:\s*(?:,\s*(?:and\s+)?|and\s+|&\s*)#\d+)*)/gi;

/** Every task number the text names, in order of first mention. */
export function parseTaskReferences(text: string): TaskReference[] {
  const prose = withoutCode(text);
  const hard = new Set<number>();
  for (const match of prose.matchAll(HARD))
    for (const number of match[1]!.matchAll(/#(\d+)/g))
      hard.add(Number(number[1]));
  const seen = new Map<number, TaskReference>();
  for (const match of prose.matchAll(REFERENCE)) {
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || seen.has(number)) continue;
    seen.set(number, { number, hard: hard.has(number) });
  }
  return [...seen.values()];
}

/**
 * References that point at a real task in the same workspace. Numbers are
 * per workspace, so a number that only exists elsewhere is not this task's
 * business, and a task naming itself is not a dependency.
 */
export function resolveTaskReferences(
  task: Task,
  workspaceTasks: readonly Task[],
): ResolvedTaskReference[] {
  const byNumber = new Map(
    workspaceTasks
      .filter((item) => item.workspaceId === task.workspaceId)
      .map((item) => [item.number, item]),
  );
  return parseTaskReferences(`${task.title}\n${task.description}`).flatMap(
    (reference) => {
      const target = byNumber.get(reference.number);
      return target && target.id !== task.id
        ? [{ ...reference, taskId: target.id }]
        : [];
    },
  );
}

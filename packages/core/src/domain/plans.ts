import { DaedalusError } from "../errors";

/**
 * A plan is a markdown file, `plans/<slug>.plan.md`, that people and agents
 * both edit. Frontmatter names it and its owner; the `## Tasks` section is a
 * nested checklist; every other section is free markdown.
 *
 *     ---
 *     plan: Cart API v2
 *     owner: checkout-lead
 *     ---
 *
 *     ## Tasks
 *
 *     - [/] Cart endpoints @api ^endpoints
 *       Any markdown under a task is its details.
 *       > ? A line like this is a question for the user.
 *       - [ ] A nested task
 *
 * States: `[ ]` todo, `[/]` doing, `[x]` done, `[!]` blocked, `[-]` dropped.
 *
 * Parsing never changes the text, and every edit here rewrites only the
 * lines it is about: an agent's or the user's formatting elsewhere survives
 * byte for byte, line endings included.
 */

export type PlanTaskState = "todo" | "doing" | "done" | "blocked" | "dropped";

export const PLAN_TASK_STATES: readonly PlanTaskState[] = [
  "todo",
  "doing",
  "done",
  "blocked",
  "dropped",
];

const STATE_OF_MARK: Record<string, PlanTaskState> = {
  " ": "todo",
  "/": "doing",
  x: "done",
  X: "done",
  "!": "blocked",
  "-": "dropped",
};

export const PLAN_STATE_MARK: Record<PlanTaskState, string> = {
  todo: " ",
  doing: "/",
  done: "x",
  blocked: "!",
  dropped: "-",
};

/** Markdown inside a task or between tasks, with where it came from. */
export interface PlanMarkdownPart {
  kind: "markdown";
  /** Dedented to the task's content column. */
  text: string;
  /** 1-based, inclusive, in the whole file. */
  startLine: number;
  endLine: number;
}

/** A `> ? ...` line: the task's owner asks the user something. */
export interface PlanQuestionPart {
  kind: "question";
  text: string;
  line: number;
}

export interface PlanTaskPart {
  kind: "task";
  task: PlanTask;
}

export type PlanTaskBodyPart =
  PlanMarkdownPart | PlanQuestionPart | PlanTaskPart;

export interface PlanTask {
  /** `^id` when it has one, else `L<line>`: what a command names it by. */
  key: string;
  id: string | null;
  state: PlanTaskState;
  /** Inline markdown, without its `@owner` and `^id`. */
  title: string;
  /** The handle without `@`, or null. */
  owner: string | null;
  /** The task's own line. */
  line: number;
  /** Its last line, nested tasks and details included. */
  endLine: number;
  depth: number;
  /** Details, questions and nested tasks, in the file's order. */
  body: PlanTaskBodyPart[];
}

/** The body of a plan in order: markdown, and the tasks of `## Tasks`. */
export type PlanBlock = PlanMarkdownPart | PlanTaskPart;

export interface PlanQuestion {
  task: PlanTask;
  text: string;
  line: number;
  /** Whoever answers for the task: its owner, its parent's, or the plan's. */
  owner: string | null;
}

export interface PlanDocument {
  /** `plan:` in the frontmatter, else the first `# ` heading. */
  title: string | null;
  /** `owner:` in the frontmatter, without `@`. */
  owner: string | null;
  /** The frontmatter's last line, or 0 without one. */
  frontmatterEnd: number;
  blocks: PlanBlock[];
  /** Whether the file has a `## Tasks` section at all. */
  hasTasksSection: boolean;
  lineCount: number;
  eol: "\n" | "\r\n";
}

interface Line {
  /** Without its line ending. */
  text: string;
  /** Offset of the line's first character in the source. */
  start: number;
}

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline === -1 ? source.length : newline;
    const text = source.slice(
      start,
      end > start && source[end - 1] === "\r" ? end - 1 : end,
    );
    lines.push({ text, start });
    start = end + 1;
  }
  return lines;
}

const TASK_LINE =
  /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+\[([ xX/!-])\](?:[ \t]+(.*?))?[ \t]*$/;
const HEADING = /^(#{1,6})(?:[ \t]+(.*?))?[ \t#]*$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const QUESTION = /^[ \t]*>[ \t]?\?[ \t]*(.*)$/;
const OWNER_TOKEN =
  /(^|\s)@([A-Za-z0-9][A-Za-z0-9_.-]*[A-Za-z0-9_]|[A-Za-z0-9])/;
const ID_TOKEN = /(^|\s)\^([A-Za-z0-9][A-Za-z0-9_-]*)(?=\s|$)/;

/** Columns of leading whitespace, a tab to the next multiple of four. */
function indentOf(text: string): number {
  let column = 0;
  for (const character of text) {
    if (character === " ") column += 1;
    else if (character === "\t") column += 4 - (column % 4);
    else break;
  }
  return column;
}

const blank = (text: string) => text.trim() === "";

/** Removes up to `columns` of leading whitespace. */
function dedent(text: string, columns: number): string {
  let column = 0;
  let index = 0;
  while (index < text.length && column < columns) {
    const character = text[index];
    if (character === " ") column += 1;
    else if (character === "\t") column += 4 - (column % 4);
    else break;
    index += 1;
  }
  return text.slice(index);
}

/** A fence opened on this line, as the closing line must repeat it. */
const fenceOf = (text: string): string | undefined => FENCE.exec(text)?.[1];

const closesFence = (text: string, fence: string): boolean => {
  const match = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(text);
  return Boolean(
    match && match[1]![0] === fence[0] && match[1]!.length >= fence.length,
  );
};

/** A handle as people write it, without the `@`. */
export function planHandle(value: string): string {
  return value.trim().replace(/^@+/, "");
}

/** A name made into a handle: `Cart endpoints` is `cart-endpoints`. */
export function handleOf(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "agent"
  );
}

/** A plan's file name stem from its title. */
export function planSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  if (!slug)
    throw new DaedalusError(
      "VALIDATION",
      "A plan title needs at least one letter or digit",
    );
  return slug;
}

export const PLAN_SUFFIX = ".plan.md";

export const isPlanPath = (path: string): boolean =>
  path.toLowerCase().endsWith(PLAN_SUFFIX);

function parseTitle(rest: string): {
  title: string;
  owner: string | null;
  id: string | null;
} {
  const owner = OWNER_TOKEN.exec(rest)?.[2] ?? null;
  const id = ID_TOKEN.exec(rest)?.[2] ?? null;
  const title = rest
    .replace(new RegExp(OWNER_TOKEN.source, "g"), "$1")
    .replace(new RegExp(ID_TOKEN.source, "g"), "$1")
    .replace(/\s+/g, " ")
    .trim();
  return { title, owner, id };
}

function parseFrontmatter(lines: Line[]): {
  fields: Record<string, string>;
  end: number;
} {
  if (lines[0]?.text.trim() !== "---") return { fields: {}, end: 0 };
  const fields: Record<string, string> = {};
  for (let index = 1; index < lines.length; index += 1) {
    const text = lines[index]!.text;
    if (text.trim() === "---") return { fields, end: index + 1 };
    const match = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(text);
    if (!match) continue;
    let value = match[2]!.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1);
    fields[match[1]!.toLowerCase()] = value;
  }
  // An opening `---` with no closing one is not frontmatter.
  return { fields: {}, end: 0 };
}

class Parser {
  constructor(private readonly lines: Line[]) {}

  text(line: number): string {
    return this.lines[line - 1]?.text ?? "";
  }

  /**
   * The task on `line` and everything under it: blank lines, lines inside a
   * fence it opened, and lines indented past its marker.
   */
  task(line: number, limit: number, depth: number): PlanTask {
    const match = TASK_LINE.exec(this.text(line))!;
    const indent = indentOf(match[1]!);
    const { title, owner, id } = parseTitle(match[4] ?? "");
    let end = line;
    let fence: string | undefined;
    for (let next = line + 1; next <= limit; next += 1) {
      const text = this.text(next);
      if (fence) {
        if (closesFence(text, fence)) fence = undefined;
        end = next;
        continue;
      }
      if (blank(text)) continue;
      if (indentOf(text) <= indent) break;
      fence = fenceOf(text);
      end = next;
    }
    return {
      key: id ? `^${id}` : `L${line}`,
      id,
      state: STATE_OF_MARK[match[3]!]!,
      title,
      owner,
      line,
      endLine: end,
      depth,
      body: this.parts(line + 1, end, depth + 1, true),
    };
  }

  /**
   * Lines `from`..`to` as markdown, questions and tasks. Inside a task the
   * markdown is dedented to its common indent, so a nested list or a fence
   * renders as written.
   */
  parts(
    from: number,
    to: number,
    depth: number,
    inTask: boolean,
  ): PlanTaskBodyPart[] {
    const parts: PlanTaskBodyPart[] = [];
    let pending: number[] = [];
    const flush = () => {
      while (pending.length && blank(this.text(pending.at(-1)!))) pending.pop();
      while (pending.length && blank(this.text(pending[0]!))) pending.shift();
      if (pending.length) {
        const texts = pending.map((line) => this.text(line));
        const columns = inTask
          ? Math.min(
              ...texts.filter((text) => !blank(text)).map((t) => indentOf(t)),
            )
          : 0;
        parts.push({
          kind: "markdown",
          text: texts.map((text) => dedent(text, columns)).join("\n"),
          startLine: pending[0]!,
          endLine: pending.at(-1)!,
        });
      }
      pending = [];
    };
    let fence: string | undefined;
    for (let line = from; line <= to; line += 1) {
      const text = this.text(line);
      if (fence) {
        if (closesFence(text, fence)) fence = undefined;
        pending.push(line);
        continue;
      }
      if (TASK_LINE.test(text)) {
        flush();
        const task = this.task(line, to, depth);
        parts.push({ kind: "task", task });
        line = task.endLine;
        continue;
      }
      const question = inTask ? QUESTION.exec(text) : null;
      if (question) {
        flush();
        parts.push({ kind: "question", text: question[1]!.trim(), line });
        continue;
      }
      fence = fenceOf(text);
      pending.push(line);
    }
    flush();
    return parts;
  }
}

export function parsePlan(source: string): PlanDocument {
  const lines = splitLines(source);
  const { fields, end } = parseFrontmatter(lines);
  const parser = new Parser(lines);
  const blocks: PlanBlock[] = [];
  let firstHeading: string | null = null;
  let hasTasksSection = false;
  let fence: string | undefined;
  let markdownFrom = end + 1;
  const pushMarkdown = (to: number) => {
    for (const part of parser.parts(markdownFrom, to, 0, false))
      if (part.kind === "markdown") blocks.push(part);
  };
  let tasksFrom: number | undefined;
  const closeTasks = (to: number) => {
    if (tasksFrom === undefined) return;
    for (const part of parser.parts(tasksFrom, to, 0, false))
      if (part.kind !== "question") blocks.push(part);
    tasksFrom = undefined;
    markdownFrom = to + 1;
  };
  for (let line = end + 1; line <= lines.length; line += 1) {
    const text = parser.text(line);
    if (fence) {
      if (closesFence(text, fence)) fence = undefined;
      continue;
    }
    const heading = HEADING.exec(text);
    if (heading) {
      const level = heading[1]!.length;
      const name = (heading[2] ?? "").trim();
      if (level === 1 && firstHeading === null) firstHeading = name;
      if (tasksFrom !== undefined && level <= 2) closeTasks(line - 1);
      if (level === 2 && name.toLowerCase() === "tasks") {
        // The heading stays with the markdown before it.
        pushMarkdown(line);
        hasTasksSection = true;
        tasksFrom = line + 1;
      }
      continue;
    }
    fence = fenceOf(text);
  }
  if (tasksFrom !== undefined) closeTasks(lines.length);
  else pushMarkdown(lines.length);
  return {
    title: fields.plan || firstHeading,
    owner: fields.owner ? planHandle(fields.owner) || null : null,
    frontmatterEnd: end,
    blocks,
    hasTasksSection,
    lineCount: lines.length,
    eol: source.includes("\r\n") ? "\r\n" : "\n",
  };
}

/** Every task, depth first, in the file's order. */
export function planTasks(plan: PlanDocument): PlanTask[] {
  const out: PlanTask[] = [];
  const walk = (parts: readonly PlanTaskBodyPart[]) => {
    for (const part of parts)
      if (part.kind === "task") {
        out.push(part.task);
        walk(part.task.body);
      }
  };
  walk(plan.blocks);
  return out;
}

/** Tasks counted for progress: all but the dropped ones. */
export function planProgress(plan: PlanDocument): {
  done: number;
  total: number;
} {
  const tasks = planTasks(plan).filter((task) => task.state !== "dropped");
  return {
    done: tasks.filter((task) => task.state === "done").length,
    total: tasks.length,
  };
}

/**
 * The open questions: those under a task that is not done or dropped, each
 * with whoever answers for its task.
 */
export function planQuestions(plan: PlanDocument): PlanQuestion[] {
  const out: PlanQuestion[] = [];
  const walk = (parts: readonly PlanTaskBodyPart[], owner: string | null) => {
    for (const part of parts) {
      if (part.kind !== "task") continue;
      const { task } = part;
      const answers = task.owner ?? owner;
      if (task.state !== "done" && task.state !== "dropped")
        for (const item of task.body)
          if (item.kind === "question" && item.text)
            out.push({
              task,
              text: item.text,
              line: item.line,
              owner: answers,
            });
      walk(task.body, answers);
    }
  };
  walk(plan.blocks, plan.owner);
  return out;
}

/** A task by `^id`, `id` or `L<line>`. */
export function findPlanTask(plan: PlanDocument, reference: string): PlanTask {
  const wanted = reference.trim();
  const tasks = planTasks(plan);
  const line = /^L(\d+)$/.exec(wanted);
  const found = line
    ? tasks.find((task) => task.line === Number(line[1]))
    : tasks.find((task) => task.id === wanted.replace(/^\^/, ""));
  if (!found)
    throw new DaedalusError(
      "NOT_FOUND",
      line
        ? `No task starts on line ${line[1]} of the plan`
        : `No task has the id ^${wanted.replace(/^\^/, "")}; 'daedal plan show' lists the ids`,
    );
  return found;
}

/** The owner a task answers to: its own, its parent's, or the plan's. */
export function planTaskOwner(
  plan: PlanDocument,
  task: PlanTask,
): string | null {
  if (task.owner) return task.owner;
  let owner: string | null = plan.owner;
  const walk = (
    parts: readonly PlanTaskBodyPart[],
    inherited: string | null,
  ): boolean => {
    for (const part of parts) {
      if (part.kind !== "task") continue;
      const answers = part.task.owner ?? inherited;
      if (part.task === task) {
        owner = inherited;
        return true;
      }
      if (walk(part.task.body, answers)) return true;
    }
    return false;
  };
  walk(plan.blocks, plan.owner);
  return owner;
}

// ---- Edits. Each takes the source and returns it with one change. ----

function replaceLine(
  source: string,
  line: number,
  edit: (text: string) => string,
): string {
  const lines = splitLines(source);
  const target = lines[line - 1];
  if (!target)
    throw new DaedalusError("NOT_FOUND", `The plan has no line ${line}`);
  const end = target.start + target.text.length;
  return source.slice(0, target.start) + edit(target.text) + source.slice(end);
}

function taskMatch(text: string): RegExpExecArray {
  const match = TASK_LINE.exec(text);
  if (!match)
    throw new DaedalusError(
      "CONFLICT",
      "The plan changed: that line is no longer a task",
    );
  return match;
}

export function setPlanTaskState(
  source: string,
  reference: string,
  state: PlanTaskState,
): string {
  const task = findPlanTask(parsePlan(source), reference);
  return replaceLine(source, task.line, (text) => {
    const match = taskMatch(text);
    const bracket = match[1]!.length + match[2]!.length;
    const open = text.indexOf("[", bracket);
    return (
      text.slice(0, open + 1) + PLAN_STATE_MARK[state] + text.slice(open + 2)
    );
  });
}

/** Sets the `@owner` on the task's line, adding it before a `^id`. */
export function setPlanTaskOwner(
  source: string,
  reference: string,
  owner: string,
): string {
  const handle = planHandle(owner);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(handle))
    throw new DaedalusError(
      "VALIDATION",
      `'${owner}' is not a handle; use letters, digits, '-', '_' and '.'`,
    );
  const task = findPlanTask(parsePlan(source), reference);
  return replaceLine(source, task.line, (text) => {
    taskMatch(text);
    const current = OWNER_TOKEN.exec(text);
    if (current) {
      const at = current.index + current[1]!.length;
      return `${text.slice(0, at)}@${handle}${text.slice(at + 1 + current[2]!.length)}`;
    }
    const content = text.trimEnd();
    const id = ID_TOKEN.exec(content);
    if (id && id.index + id[0].length === content.length) {
      const at = id.index + id[1]!.length;
      return `${content.slice(0, at)}@${handle} ${content.slice(at)}${text.slice(content.length)}`;
    }
    return `${content} @${handle}${text.slice(content.length)}`;
  });
}

/** Gives a task an id, from its title, unless it has one. */
export function ensurePlanTaskId(
  source: string,
  reference: string,
): { source: string; id: string } {
  const plan = parsePlan(source);
  const task = findPlanTask(plan, reference);
  if (task.id) return { source, id: task.id };
  const taken = new Set(planTasks(plan).map((item) => item.id));
  const base = handleOf(task.title.replace(/[`*_~[\]]/g, "")).slice(0, 32);
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return {
    id,
    source: replaceLine(source, task.line, (text) => {
      taskMatch(text);
      const content = text.trimEnd();
      return `${content} ^${id}${text.slice(content.length)}`;
    }),
  };
}

/**
 * Adds a `> ? question` line to a task: after its own details, before its
 * nested tasks.
 */
export function addPlanTaskQuestion(
  source: string,
  reference: string,
  question: string,
): string {
  const text = question.replace(/\s+/g, " ").trim();
  if (!text)
    throw new DaedalusError("VALIDATION", "The question must not be empty");
  const plan = parsePlan(source);
  const task = findPlanTask(plan, reference);
  let after = task.line;
  for (const part of task.body) {
    if (part.kind === "task") break;
    after = part.kind === "question" ? part.line : part.endLine;
  }
  const lines = splitLines(source);
  const taskText = lines[task.line - 1]!.text;
  const match = taskMatch(taskText);
  const detail = task.body.find((part) => part.kind !== "task");
  const firstDetailLine =
    detail?.kind === "markdown"
      ? detail.startLine
      : detail?.kind === "question"
        ? detail.line
        : undefined;
  const indent =
    firstDetailLine !== undefined
      ? /^[ \t]*/.exec(lines[firstDetailLine - 1]!.text)![0]
      : " ".repeat(indentOf(match[1]!) + match[2]!.length + 1);
  const anchor = lines[after - 1]!;
  const lineEnd = anchor.start + anchor.text.length;
  const hasEnding = lineEnd < source.length;
  const ending = hasEnding
    ? source.slice(lineEnd, source.indexOf("\n", lineEnd) + 1)
    : plan.eol;
  const insertAt = hasEnding ? lineEnd + ending.length : source.length;
  return (
    source.slice(0, insertAt) +
    (hasEnding ? "" : plan.eol) +
    `${indent}> ? ${text}` +
    (hasEnding ? ending : "") +
    source.slice(insertAt)
  );
}

/** A new plan's file: frontmatter, a title and the body, or a skeleton. */
export function renderNewPlan(input: {
  title: string;
  owner?: string | null;
  body?: string;
}): string {
  const title = input.title.replace(/\s+/g, " ").trim();
  if (!title) throw new DaedalusError("VALIDATION", "A plan needs a title");
  const owner = input.owner ? planHandle(input.owner) : null;
  const front = [
    "---",
    `plan: ${JSON.stringify(title)}`,
    ...(owner ? [`owner: ${owner}`] : []),
    "---",
    "",
  ];
  const body = input.body?.replace(/\r\n/g, "\n").trim();
  if (body)
    return `${[...front, ...(/^# /m.test(body) ? [] : [`# ${title}`, ""]), body].join("\n")}\n`;
  return `${[
    ...front,
    `# ${title}`,
    "",
    "What this plan is for, and what is out of scope.",
    "",
    "## Tasks",
    "",
    "- [ ] First task ^first",
    "",
    "## Done when",
    "",
    "- ",
  ].join("\n")}\n`;
}

// ---- Owners: a handle names a session; its live state is the chip's. ----

/** What an owner chip shows. `none` is a handle no session answers to. */
export type PlanOwnerState =
  "working" | "waiting" | "idle" | "error" | "stopped" | "none";

interface OwnerCandidate {
  id: string;
  name: string;
  teamHandle: string | null;
  status: string;
  archivedAt: string | null;
  startedAt: string;
}

/**
 * The session a handle names: by its team handle, then its name made into a
 * handle, then its name. A running session beats a stopped one, and the
 * newest wins a tie. Archived sessions answer to nothing.
 */
export function resolvePlanOwner<T extends OwnerCandidate>(
  handle: string,
  sessions: readonly T[],
): T | undefined {
  const wanted = planHandle(handle).toLowerCase();
  if (!wanted) return undefined;
  const live = sessions.filter((session) => !session.archivedAt);
  const rank = (session: T) =>
    session.status === "running" || session.status === "starting" ? 1 : 0;
  const best = (matches: T[]) =>
    matches.sort(
      (a, b) =>
        rank(b) - rank(a) || Date.parse(b.startedAt) - Date.parse(a.startedAt),
    )[0];
  return (
    best(live.filter((s) => s.teamHandle?.toLowerCase() === wanted)) ??
    best(live.filter((s) => handleOf(s.name) === wanted)) ??
    best(live.filter((s) => s.name.trim().toLowerCase() === wanted))
  );
}

/** A session's chip state from its status, activity and attention badge. */
export function planOwnerState(
  session: { status: string } | undefined,
  activity: string | undefined,
  needsAttention: boolean,
): PlanOwnerState {
  if (!session) return "none";
  if (session.status !== "running" && session.status !== "starting")
    return "stopped";
  if (
    needsAttention ||
    activity === "needs_input" ||
    activity === "needs_permission"
  )
    return "waiting";
  if (activity === "working") return "working";
  if (activity === "error") return "error";
  return "idle";
}

/** A session's handle in a plan: its team handle, else its name as one. */
export const sessionPlanHandle = (session: {
  name: string;
  teamHandle: string | null;
}): string => session.teamHandle ?? handleOf(session.name);

/**
 * What the owner receives when the user asks about part of a plan: the
 * question first, then where, then the quote.
 */
export function planAskMessage(input: {
  question: string;
  path: string;
  startLine: number;
  endLine: number;
  quote: string;
}): string {
  const lines =
    input.endLine > input.startLine
      ? `${input.startLine}-${input.endLine}`
      : `${input.startLine}`;
  const quoted = input.quote
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, all) => line || (index > 0 && index < all.length - 1))
    .slice(0, 12)
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return `${input.question.trim()}\n\n${input.path}:${lines}:\n${quoted}`;
}

/** The first message of an agent started on a plan's task. */
export function planTaskBrief(input: {
  planPath: string;
  planTitle: string | null;
  task: PlanTask;
  details: string;
}): string {
  const { task } = input;
  const ref = `^${task.id}`;
  return [
    `You own the task "${task.title}" (${ref}) in the plan ${input.planTitle ? `"${input.planTitle}" ` : ""}at ${input.planPath}.`,
    input.details.trim() ? `\nIts details:\n${input.details.trim()}\n` : "",
    "Read the whole plan first for context. Keep your task's line current as you go:",
    `  daedal plan done ${input.planPath} ${ref}     when it is finished`,
    `  daedal plan block ${input.planPath} ${ref}    when you are stuck`,
    `  daedal plan ask ${input.planPath} ${ref} "<question>"   to put a question to the user in the plan`,
    "Nested tasks under yours are yours too; tick them off in the file as you finish them.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** A task's details as the markdown under its line, nested tasks left out. */
export function planTaskDetails(task: PlanTask): string {
  return task.body
    .flatMap((part) =>
      part.kind === "markdown"
        ? [part.text]
        : part.kind === "question"
          ? [`> ? ${part.text}`]
          : [],
    )
    .join("\n\n");
}

import { join } from "node:path";
import { readTextFile } from "@daedalus/platform";
import type {
  AgentSession,
  ClearedAttentionReason,
  SessionAttention,
  SessionWorktree,
  Task,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import { sessionLaunchModel } from "./providers";
import { parseTaskReferences } from "./task-references";
import type { TelemetryService } from "./telemetry";
import type { WorkspaceService } from "./workspaces";

/**
 * What happened to a task, in order. Almost all of it is a join over rows
 * and files that already exist; the one addition is the attention history,
 * because the badge itself keeps only what is still open.
 */
export type TaskTimelineKind =
  | "created"
  | "brief_edited"
  | "session_spawned"
  | "worktree_created"
  | "attention_raised"
  | "attention_cleared"
  | "session_stopped"
  | "session_archived"
  | "journal"
  | "done"
  | "cancelled";

export interface TaskTimelineEvent {
  kind: TaskTimelineKind;
  /**
   * An ISO timestamp; a bare `YYYY-MM-DD` for a journal heading that carries
   * only a date; or null for a journal heading that carries none. Undated
   * entries sort last, in the order the journal lists them, which is the
   * order they were written.
   */
  at: string | null;
  text: string;
  detail?: string;
  sessionId?: string;
  /** For `journal`: the heading exactly as written, to find it again. */
  journalHeading?: string;
  /** For `attention_raised`: the reason is still on the badge. */
  open?: boolean;
}

export interface JournalEntryRef {
  heading: string;
  /** Zero-based line in `JOURNAL.md`. */
  line: number;
  /** `YYYY-MM-DD` when the heading starts with one. */
  date: string | null;
}

/**
 * Whether `text` names task `number` as `#N`, by the same rule the board
 * uses for dependencies: `PR #22` is a pull request, not task 22, which this
 * journal says often.
 */
export function mentionsTaskNumber(text: string, number: number): boolean {
  return parseTaskReferences(text).some(
    (reference) => reference.number === number,
  );
}

/**
 * The journal entries about one task: second- and third-level headings that
 * mention `#N`. Headings inside fenced code are examples, not entries.
 */
export function journalEntriesForTask(
  journal: string,
  number: number,
): JournalEntryRef[] {
  const entries: JournalEntryRef[] = [];
  let fenced = false;
  journal.split("\n").forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const heading = line.match(/^#{2,3}\s+(.+?)\s*#*\s*$/)?.[1];
    if (!heading || !mentionsTaskNumber(heading, number)) return;
    entries.push({
      heading,
      line: index,
      date: heading.match(/^(\d{4}-\d{2}-\d{2})\b/)?.[1] ?? null,
    });
  });
  return entries;
}

const providerName = (session: AgentSession) =>
  session.kind === "terminal"
    ? "terminal"
    : session.provider.slice(0, 1).toUpperCase() + session.provider.slice(1);

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Journal dates are days; they sort after everything else that day. */
const sortKey = (event: TaskTimelineEvent) =>
  event.at === null
    ? "\uffff"
    : event.at.length === 10
      ? `${event.at}T23:59:59.999Z`
      : event.at;

export interface TaskTimelineInput {
  task: Task;
  /** Every session linked to the task, archived ones included. */
  sessions: readonly AgentSession[];
  worktrees: readonly SessionWorktree[];
  openAttention: readonly SessionAttention[];
  clearedAttention: readonly ClearedAttentionReason[];
  journal: string;
  /** Best-known model per session id, when something better than args knows. */
  models?: ReadonlyMap<string, string>;
}

export function buildTaskTimeline(
  input: TaskTimelineInput,
): TaskTimelineEvent[] {
  const { task } = input;
  const events: TaskTimelineEvent[] = [
    { kind: "created", at: task.createdAt, text: "Created" },
  ];
  if (task.briefUpdatedAt)
    events.push({
      kind: "brief_edited",
      at: task.briefUpdatedAt,
      text: "Brief edited",
    });
  const sessionById = new Map(input.sessions.map((item) => [item.id, item]));
  for (const session of input.sessions) {
    const model =
      input.models?.get(session.id) ?? sessionLaunchModel(session.args);
    events.push({
      kind: "session_spawned",
      at: session.startedAt,
      text:
        session.kind === "terminal"
          ? "Terminal opened"
          : `${providerName(session)} started${model ? ` · ${model}` : ""}`,
      detail: session.name,
      sessionId: session.id,
    });
    if (
      session.endedAt &&
      (session.status === "exited" || session.status === "lost")
    )
      events.push({
        kind: "session_stopped",
        at: session.endedAt,
        text:
          session.status === "lost"
            ? `${providerName(session)} session lost`
            : `${providerName(session)} session stopped`,
        ...(session.lostReason ? { detail: session.lostReason } : {}),
        sessionId: session.id,
      });
    if (session.archivedAt)
      events.push({
        kind: "session_archived",
        at: session.archivedAt,
        text: `${providerName(session)} session archived`,
        sessionId: session.id,
      });
  }
  for (const worktree of input.worktrees)
    events.push({
      kind: "worktree_created",
      at: worktree.createdAt,
      text: `Worktree ${worktree.branchName}`,
      detail: worktree.path,
      sessionId: worktree.sessionId,
    });
  const asked = (sessionId: string) => {
    const session = sessionById.get(sessionId);
    return session ? `${providerName(session)} asked` : "Asked";
  };
  const clears = new Map<string, ClearedAttentionReason[]>();
  for (const reason of input.clearedAttention) {
    events.push({
      kind: "attention_raised",
      at: reason.raisedAt,
      text: asked(reason.sessionId),
      detail: reason.text,
      sessionId: reason.sessionId,
    });
    const key = `${reason.sessionId}\u0000${reason.clearedAt}`;
    clears.set(key, [...(clears.get(key) ?? []), reason]);
  }
  // One clear is one event, however many reasons it took off the badge.
  for (const group of clears.values()) {
    const first = group[0]!;
    events.push({
      kind: "attention_cleared",
      at: first.clearedAt,
      text:
        group.length === 1
          ? "Attention cleared"
          : `Attention cleared (${plural(group.length, "reason")})`,
      sessionId: first.sessionId,
    });
  }
  for (const attention of input.openAttention)
    for (const reason of attention.reasons)
      events.push({
        kind: "attention_raised",
        at: reason.raisedAt,
        text: asked(attention.sessionId),
        detail: reason.text,
        sessionId: attention.sessionId,
        open: true,
      });
  for (const entry of journalEntriesForTask(input.journal, task.number))
    events.push({
      kind: "journal",
      at: entry.date,
      text: "Journal entry",
      detail: entry.heading,
      journalHeading: entry.heading,
    });
  if (task.status === "done" && task.completedAt)
    events.push({ kind: "done", at: task.completedAt, text: "Marked done" });
  if (task.status === "cancelled")
    events.push({ kind: "cancelled", at: task.updatedAt, text: "Cancelled" });
  // Stable, so equal keys keep the order they were added in: a journal's
  // undated entries stay in the order the journal lists them.
  return events
    .map((event, index) => ({ event, index }))
    .sort(
      (left, right) =>
        sortKey(left.event).localeCompare(sortKey(right.event)) ||
        left.index - right.index,
    )
    .map(({ event }) => event);
}

/**
 * Reads a task's history. Nothing here is written; the timeline is assembled
 * on demand from the sessions table, the worktrees table, the badge, its
 * history, and `JOURNAL.md`.
 */
export class TaskHistoryService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaces: WorkspaceService,
    private readonly telemetry: TelemetryService,
  ) {}

  private task(id: string): Task {
    const task = this.repositories.findTask(id);
    if (!task)
      throw new DaedalusError("NOT_FOUND", `Task '${id}' was not found`);
    return task;
  }

  /** Every session ever linked to the task, archived ones included. */
  sessionsFor(task: Task): AgentSession[] {
    return this.repositories
      .listAgents()
      .filter((session) => session.taskId === task.id);
  }

  /** What each live session reports as its model, which beats `--model`. */
  private async liveModels(): Promise<Map<string, string>> {
    return new Map(
      (await this.telemetry.sessionTelemetry()).flatMap((item) =>
        item.model ? [[item.sessionId, item.model] as const] : [],
      ),
    );
  }

  async timeline(taskId: string): Promise<TaskTimelineEvent[]> {
    const task = this.task(taskId);
    const models = await this.liveModels();
    const sessions = this.sessionsFor(task);
    const ids = sessions.map((session) => session.id);
    let journal = "";
    try {
      const workspace = await this.workspaces.get(task.workspaceId);
      journal = await readTextFile(join(workspace.path, "JOURNAL.md"));
    } catch {
      // A workspace whose directory is missing still has a history in the
      // database; it just has no journal to read.
    }
    return buildTaskTimeline({
      task,
      sessions,
      worktrees: ids.flatMap((sessionId) =>
        this.repositories.listSessionWorktrees({ sessionId }),
      ),
      openAttention: ids.flatMap(
        (sessionId) => this.repositories.findSessionAttention(sessionId) ?? [],
      ),
      clearedAttention: this.repositories.listAttentionHistory(ids),
      journal,
      models,
    });
  }
}

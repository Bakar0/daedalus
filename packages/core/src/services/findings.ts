import type {
  Finding,
  FindingSeverity,
  FindingVerdict,
  Resident,
  RoutineFindings,
  Task,
  TaskPriority,
  Workspace,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { NotificationService } from "./notifications";

/** A key that comes back within this long reopens its old task. */
export const REOPEN_WINDOW_MS = 14 * 86_400_000;
/** A cleared finding nobody worked on closes its task after this long. */
export const CLOSE_AFTER_CLEARED_MS = 24 * 3_600_000;

const TASK_BRIEF_LIMIT = 20_000;
const SEVERITIES: readonly FindingSeverity[] = ["info", "warn", "urgent"];
const PRIORITY: Record<FindingSeverity, TaskPriority> = {
  info: "low",
  warn: "normal",
  urgent: "high",
};
const APPENDED_SECTION =
  /\n(?=## (?:Update |Came back at |Cleared at |Also seen by |Marked |Closed by ))/;
const KEY = /^[\w.:/#@+-][\w .:/#@+=,()-]{0,239}$/;

export function findingSeverity(value: string): FindingSeverity {
  if (!SEVERITIES.includes(value as FindingSeverity))
    throw new DaedalusError(
      "VALIDATION",
      `Severity must be one of: ${SEVERITIES.join(", ")}`,
    );
  return value as FindingSeverity;
}

export function findingKey(value: string): string {
  const key = value.trim();
  if (!KEY.test(key))
    throw new DaedalusError(
      "VALIDATION",
      "A finding key is 1-240 characters of letters, digits, spaces and :/#@.+-_=,()",
    );
  return key;
}

const localTime = (iso: string): string => {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/**
 * Appends a section to a task brief without ever passing the task limit.
 * When it would, the oldest appended sections go first; the original report
 * at the top stays, because that is what the task is about.
 */
export function appendToBrief(
  brief: string,
  heading: string,
  body = "",
  limit = TASK_BRIEF_LIMIT,
): string {
  const section = `## ${heading}\n\n${body.trim()}`.trim();
  const trimmedNote = "_Older updates were trimmed to keep the brief short._";
  const withoutNote = (text: string) => text.replace(`\n\n${trimmedNote}`, "");
  // Only the sections this service appends are split off; a report's own
  // `## Evidence` headings belong to the report and are never trimmed.
  const parts = brief
    .trimEnd()
    .split(APPENDED_SECTION)
    .map((part) => part.trim());
  const head = withoutNote(parts[0] ?? "");
  let appended = [...parts.slice(1), section];
  let result = [head, ...appended].join("\n\n");
  while (result.length > limit && appended.length > 1) {
    appended = appended.slice(1);
    result = [head, trimmedNote, ...appended].join("\n\n");
  }
  if (result.length > limit) result = result.slice(0, limit - 1) + "…";
  return `${result}\n`;
}

export interface FindingReport {
  resident: Resident;
  workspace: Workspace;
  routine: string;
  findings: RoutineFindings;
  runId: number;
  key: string;
  sameAs?: string;
  severity: FindingSeverity;
  title: string;
  url?: string;
  body: string;
}

export type FindingAction =
  | "opened"
  | "updated"
  | "reopened"
  | "merged"
  /** The user marked this key Noise: seen and recorded, nothing raised. */
  | "suppressed";

export interface FindingReportResult {
  action: FindingAction;
  finding: Finding;
  task: Task | null;
  /** How the user was told, or why they were not. */
  notified: string | null;
}

/**
 * Findings and the tasks they open. Everything that decides whether a report
 * is new, an update or a return happens in one immediate transaction, so two
 * runs reporting one key at the same moment produce one task: the second
 * waits for the first one's write and then finds its row.
 */
export class FindingService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly notifications: NotificationService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async report(input: FindingReport): Promise<FindingReportResult> {
    const key = findingKey(input.key);
    const sameAs = input.sameAs ? findingKey(input.sameAs) : undefined;
    const title = input.title.trim().slice(0, 240);
    if (!title)
      throw new DaedalusError("VALIDATION", "A finding needs a title");
    if (input.findings === "none")
      throw new DaedalusError(
        "VALIDATION",
        `Routine '${input.routine}' has findings: none, so it cannot report`,
      );
    const url = input.url?.trim() || null;
    const at = this.now().toISOString();
    const source = `Reported by ${input.resident.name} from routine \`${input.routine}\`, run ${input.runId}, at ${localTime(at)}.`;
    const evidence = [
      `> ${source}`,
      `> Key: \`${key}\` · Severity: ${input.severity}${url ? ` · ${url}` : ""}`,
      "",
      input.body.trim(),
    ].join("\n");
    const result = this.repositories.immediateTransaction(
      (): FindingReportResult => {
        const residents = this.repositories.residents;
        const latest = residents.findLatestFinding(input.resident.id, key);
        if (latest?.verdict === "noise") {
          const seen: Finding = { ...latest, lastSeenAt: at };
          residents.updateFinding(seen);
          return {
            action: "suppressed",
            finding: seen,
            task: null,
            notified: null,
          };
        }
        const open = residents.findOpenFinding(input.resident.id, key);
        if (open) return this.update(open, input, evidence, at);
        if (sameAs) {
          const target = residents.findOpenFinding(input.resident.id, sameAs);
          if (!target)
            throw new DaedalusError(
              "NOT_FOUND",
              `No open finding has key '${sameAs}'`,
            );
          const finding: Finding = {
            id: crypto.randomUUID(),
            residentId: input.resident.id,
            routine: input.routine,
            key,
            sameAs,
            severity: input.severity,
            title,
            url,
            taskId: target.taskId,
            state: "open",
            verdict: null,
            openedAt: at,
            lastSeenAt: at,
            clearedAt: null,
            closedAt: null,
            reopenCount: 0,
          };
          residents.createFinding(finding);
          const task = target.taskId
            ? this.appendSection(
                target.taskId,
                `Also seen by \`${input.routine}\` at ${localTime(at)}`,
                evidence,
                at,
              )
            : null;
          return { action: "merged", finding, task, notified: null };
        }
        // Measured from when the issue went away, not from when its task
        // was closed a day later.
        const endedAt = latest?.clearedAt ?? latest?.closedAt;
        if (
          latest &&
          endedAt &&
          Date.parse(at) - Date.parse(endedAt) <= REOPEN_WINDOW_MS &&
          (latest.taskId === null ||
            this.repositories.findTask(latest.taskId) !== undefined)
        )
          return this.reopen(latest, input, evidence, at);
        return this.open(input, key, title, url, evidence, at, latest);
      },
    );
    if (result.action === "opened" || result.action === "reopened")
      result.notified = await this.notify(input, result);
    return result;
  }

  private open(
    input: FindingReport,
    key: string,
    title: string,
    url: string | null,
    evidence: string,
    at: string,
    earlier: Finding | undefined,
  ): FindingReportResult {
    const earlierTask = earlier?.taskId
      ? this.repositories.findTask(earlier.taskId)
      : undefined;
    const description = `${
      earlierTask
        ? `${evidence}\n\nThis came back after more than 14 days. The earlier task was ${input.workspace.slug}#${earlierTask.number}.`
        : evidence
    }\n`;
    const task =
      input.findings === "task"
        ? this.repositories.createNumberedTask({
            workspaceId: input.workspace.id,
            title,
            description: description.slice(0, TASK_BRIEF_LIMIT),
            status: "todo",
            priority: PRIORITY[input.severity],
            createdAt: at,
            updatedAt: at,
            completedAt: null,
            briefUpdatedAt: null,
          })
        : null;
    const finding: Finding = {
      id: crypto.randomUUID(),
      residentId: input.resident.id,
      routine: input.routine,
      key,
      sameAs: null,
      severity: input.severity,
      title,
      url,
      taskId: task?.id ?? null,
      state: "open",
      verdict: null,
      openedAt: at,
      lastSeenAt: at,
      clearedAt: null,
      closedAt: null,
      reopenCount: 0,
    };
    this.repositories.residents.createFinding(finding);
    return { action: "opened", finding, task, notified: null };
  }

  /**
   * The same key again while it is open: one update section, no new task and
   * no second notification. A task the user already closed is the exception:
   * the issue is still there, so the task comes back like a reopened one.
   */
  private update(
    open: Finding,
    input: FindingReport,
    evidence: string,
    at: string,
  ): FindingReportResult {
    const current = open.taskId
      ? this.repositories.findTask(open.taskId)
      : undefined;
    if (
      current &&
      (current.status === "done" || current.status === "cancelled")
    )
      return this.reopen(open, input, evidence, at);
    const finding: Finding = {
      ...open,
      severity: input.severity,
      lastSeenAt: at,
    };
    this.repositories.residents.updateFinding(finding);
    const task = current
      ? this.appendSection(current.id, `Update ${localTime(at)}`, evidence, at)
      : null;
    return { action: "updated", finding, task, notified: null };
  }

  private reopen(
    previous: Finding,
    input: FindingReport,
    evidence: string,
    at: string,
  ): FindingReportResult {
    const finding: Finding = {
      ...previous,
      severity: input.severity,
      state: "open",
      lastSeenAt: at,
      clearedAt: null,
      closedAt: null,
      reopenCount: previous.reopenCount + 1,
    };
    this.repositories.residents.updateFinding(finding);
    let task = previous.taskId
      ? this.appendSection(
          previous.taskId,
          `Came back at ${localTime(at)}`,
          evidence,
          at,
        )
      : null;
    if (task && (task.status === "done" || task.status === "cancelled")) {
      task = { ...task, status: "todo", completedAt: null, updatedAt: at };
      this.repositories.updateTask(task);
    }
    return { action: "reopened", finding, task, notified: null };
  }

  private appendSection(
    taskId: string,
    heading: string,
    body: string,
    at: string,
  ): Task | null {
    const task = this.repositories.findTask(taskId);
    if (!task) return null;
    const updated: Task = {
      ...task,
      description: appendToBrief(task.description, heading, body),
      updatedAt: at,
      briefUpdatedAt: at,
    };
    this.repositories.updateTask(updated);
    return updated;
  }

  private async notify(
    input: FindingReport,
    result: FindingReportResult,
  ): Promise<string> {
    const where = result.task
      ? `${input.workspace.slug}#${result.task.number}`
      : input.routine;
    const decision = await this.notifications.notify({
      sessionId: input.resident.sessionId,
      workspaceId: input.workspace.id,
      level: input.severity === "urgent" ? "error" : "info",
      title: `${input.resident.name} · ${where}`,
      body: `${result.action === "reopened" ? "Came back: " : ""}${result.finding.title}`,
      desktop: input.severity === "urgent",
      urgent: input.severity === "urgent",
      ...(result.task ? { taskId: result.task.id } : {}),
    });
    return decision.reason;
  }

  /**
   * Marks an open finding cleared: its routine looked again and it was gone.
   * Clearing a key that is not open does nothing, so a resident can clear
   * without first checking.
   */
  clear(resident: Resident, keyValue: string): Finding | null {
    const key = findingKey(keyValue);
    const at = this.now().toISOString();
    return this.repositories.immediateTransaction(() => {
      const open = this.repositories.residents.findOpenFinding(
        resident.id,
        key,
      );
      if (!open) return null;
      const cleared: Finding = { ...open, state: "cleared", clearedAt: at };
      this.repositories.residents.updateFinding(cleared);
      if (open.taskId && !open.sameAs)
        this.appendSection(open.taskId, `Cleared at ${localTime(at)}`, "", at);
      return cleared;
    });
  }

  /**
   * The user's word on a finding. Noise also closes it if it is open, and
   * from then on the key raises nothing: it is recorded as seen and dropped.
   * `null` undoes a verdict, so the key can open a task again. The task
   * itself is left as it is either way; its status is the user's.
   */
  verdict(
    resident: Resident,
    id: string,
    value: FindingVerdict | null,
    note?: string,
  ): Finding {
    const finding = this.repositories.residents.findFinding(id);
    if (!finding || finding.residentId !== resident.id)
      throw new DaedalusError("NOT_FOUND", `Finding '${id}' was not found`);
    const at = this.now().toISOString();
    const updated: Finding =
      value === "noise" && finding.state !== "closed"
        ? { ...finding, verdict: value, state: "closed", closedAt: at }
        : { ...finding, verdict: value };
    this.repositories.transaction(() => {
      this.repositories.residents.updateFinding(updated);
      if (finding.taskId)
        this.appendSection(
          finding.taskId,
          value
            ? `Marked ${value} at ${localTime(at)}`
            : `Verdict removed at ${localTime(at)}`,
          note ?? "",
          at,
        );
    });
    return updated;
  }

  /**
   * Closes what has ended. A finding whose task the user closed is closed
   * with it. A finding cleared a day ago closes too, and if no agent was ever
   * started on its task, the task moves to done: the one status change a
   * resident makes, approved by the user as an exception to the rule that
   * status is theirs.
   */
  sweep(resident: Resident): { closedTasks: Task[] } {
    const now = this.now();
    const at = now.toISOString();
    const closedTasks: Task[] = [];
    this.repositories.transaction(() => {
      const residents = this.repositories.residents;
      for (const finding of residents.listFindings(resident.id, {
        states: ["open", "cleared"],
      })) {
        const task = finding.taskId
          ? this.repositories.findTask(finding.taskId)
          : undefined;
        const taskEnded =
          task && (task.status === "done" || task.status === "cancelled");
        if (finding.state === "open") {
          // A task the user closed as done counts as useful; one they
          // cancelled says nothing either way.
          if (taskEnded)
            residents.updateFinding({
              ...finding,
              state: "closed",
              closedAt: task.completedAt ?? at,
              verdict:
                finding.verdict ?? (task.status === "done" ? "useful" : null),
            });
          continue;
        }
        if (
          !finding.clearedAt ||
          now.getTime() - Date.parse(finding.clearedAt) < CLOSE_AFTER_CLEARED_MS
        )
          continue;
        residents.updateFinding({ ...finding, state: "closed", closedAt: at });
        if (
          task &&
          !taskEnded &&
          !finding.sameAs &&
          !this.stillOpenOnTask(resident.id, task.id) &&
          !residents.taskHasSessions(task.id)
        ) {
          const closed: Task = {
            ...task,
            status: "done",
            completedAt: at,
            updatedAt: at,
            briefUpdatedAt: at,
            description: appendToBrief(
              task.description,
              `Closed by ${resident.name}: cleared at ${localTime(finding.clearedAt)}, no action taken`,
            ),
          };
          this.repositories.updateTask(closed);
          closedTasks.push(closed);
        }
      }
    });
    return { closedTasks };
  }

  /** A merged finding still open keeps the shared task alive. */
  private stillOpenOnTask(residentId: string, taskId: string): boolean {
    return this.repositories.residents
      .listFindings(residentId, { states: ["open"] })
      .some((finding) => finding.taskId === taskId);
  }
}

import type {
  RoutineOutput,
  RoutineReport,
  RoutineReportVerdict,
  SessionAbility,
  Task,
  Workspace,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { NotificationService } from "./notifications";

/** A key that comes back within this long reopens its old task. */
export const REOPEN_WINDOW_MS = 14 * 86_400_000;
/** A resolved report nobody worked on closes its task after this long. */
export const CLOSE_AFTER_RESOLVED_MS = 24 * 3_600_000;

const TASK_BRIEF_LIMIT = 20_000;
const APPENDED_SECTION =
  /\n(?=## (?:Update |Came back at |Resolved at |Also seen by |Marked |Verdict removed |Closed by ))/;
const KEY = /^[\w.:/#@+-][\w .:/#@+=,()-]{0,239}$/;

export function reportKey(value: string): string {
  const key = value.trim();
  if (!KEY.test(key))
    throw new DaedalusError(
      "VALIDATION",
      "A report key is 1-240 characters of letters, digits, spaces and :/#@.+-_=,()",
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

export interface RoutineReportInput {
  ability: SessionAbility;
  workspace: Workspace;
  routine: string;
  output: RoutineOutput;
  runId: number;
  key: string;
  sameAs?: string;
  urgent: boolean;
  title: string;
  url?: string;
  body: string;
}

export type RoutineReportAction =
  | "opened"
  | "updated"
  | "reopened"
  | "merged"
  /** The user marked this key Noise: seen and recorded, nothing raised. */
  | "suppressed";

export interface RoutineReportResult {
  action: RoutineReportAction;
  report: RoutineReport;
  task: Task | null;
  /** How the user was told, or why they were not. */
  notified: string | null;
}

/**
 * Routine reports and the tasks they open. Everything that decides whether a report
 * is new, an update or a return happens in one immediate transaction, so two
 * runs reporting one key at the same moment produce one task: the second
 * waits for the first one's write and then finds its row.
 */
export class RoutineReportService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly notifications: NotificationService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async report(input: RoutineReportInput): Promise<RoutineReportResult> {
    const key = reportKey(input.key);
    const sameAs = input.sameAs ? reportKey(input.sameAs) : undefined;
    const title = input.title.trim().slice(0, 240);
    if (!title) throw new DaedalusError("VALIDATION", "A report needs a title");
    if (input.output === "none")
      throw new DaedalusError(
        "VALIDATION",
        `Routine '${input.routine}' has output: none, so it cannot report`,
      );
    const url = input.url?.trim() || null;
    const at = this.now().toISOString();
    const source = `Reported by ${this.ownerName(input.ability)} from routine \`${input.routine}\`, run ${input.runId}, at ${localTime(at)}.`;
    const evidence = [
      `> ${source}`,
      `> Key: \`${key}\`${input.urgent ? " · Urgent" : ""}${url ? ` · ${url}` : ""}`,
      "",
      input.body.trim(),
    ].join("\n");
    const result = this.repositories.immediateTransaction(
      (): RoutineReportResult => {
        const store = this.repositories.routines;
        const latest = store.findLatestReport(input.ability.id, key);
        if (latest?.verdict === "noise") {
          const seen: RoutineReport = { ...latest, lastSeenAt: at };
          store.updateReport(seen);
          return {
            action: "suppressed",
            report: seen,
            task: null,
            notified: null,
          };
        }
        const open = store.findOpenReport(input.ability.id, key);
        if (open) return this.update(open, input, evidence, at);
        if (sameAs) {
          const target = store.findOpenReport(input.ability.id, sameAs);
          if (!target)
            throw new DaedalusError(
              "NOT_FOUND",
              `No open report has key '${sameAs}'`,
            );
          const report: RoutineReport = {
            id: crypto.randomUUID(),
            abilityId: input.ability.id,
            routine: input.routine,
            key,
            sameAs,
            urgent: input.urgent,
            title,
            url,
            taskId: target.taskId,
            state: "open",
            verdict: null,
            openedAt: at,
            lastSeenAt: at,
            resolvedAt: null,
            closedAt: null,
            reopenCount: 0,
          };
          store.createReport(report);
          const task = target.taskId
            ? this.appendSection(
                target.taskId,
                `Also seen by \`${input.routine}\` at ${localTime(at)}`,
                evidence,
                at,
              )
            : null;
          return { action: "merged", report, task, notified: null };
        }
        // Measured from when the issue went away, not from when its task
        // was closed a day later.
        const endedAt = latest?.resolvedAt ?? latest?.closedAt;
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
    input: RoutineReportInput,
    key: string,
    title: string,
    url: string | null,
    evidence: string,
    at: string,
    earlier: RoutineReport | undefined,
  ): RoutineReportResult {
    const earlierTask = earlier?.taskId
      ? this.repositories.findTask(earlier.taskId)
      : undefined;
    const description = `${
      earlierTask
        ? `${evidence}\n\nThis came back after more than 14 days. The earlier task was ${input.workspace.slug}#${earlierTask.number}.`
        : evidence
    }\n`;
    const task =
      input.output === "task"
        ? this.repositories.createNumberedTask({
            workspaceId: input.workspace.id,
            title,
            description: description.slice(0, TASK_BRIEF_LIMIT),
            status: "todo",
            priority: input.urgent ? "high" : "normal",
            createdAt: at,
            updatedAt: at,
            completedAt: null,
            briefUpdatedAt: null,
          })
        : null;
    const report: RoutineReport = {
      id: crypto.randomUUID(),
      abilityId: input.ability.id,
      routine: input.routine,
      key,
      sameAs: null,
      urgent: input.urgent,
      title,
      url,
      taskId: task?.id ?? null,
      state: "open",
      verdict: null,
      openedAt: at,
      lastSeenAt: at,
      resolvedAt: null,
      closedAt: null,
      reopenCount: 0,
    };
    this.repositories.routines.createReport(report);
    return { action: "opened", report, task, notified: null };
  }

  /**
   * The same key again while it is open: one update section, no new task and
   * no second notification. A task the user already closed is the exception:
   * the issue is still there, so the task comes back like a reopened one.
   */
  private update(
    open: RoutineReport,
    input: RoutineReportInput,
    evidence: string,
    at: string,
  ): RoutineReportResult {
    const current = open.taskId
      ? this.repositories.findTask(open.taskId)
      : undefined;
    if (
      current &&
      (current.status === "done" || current.status === "cancelled")
    )
      return this.reopen(open, input, evidence, at);
    const report: RoutineReport = {
      ...open,
      urgent: input.urgent,
      lastSeenAt: at,
    };
    this.repositories.routines.updateReport(report);
    const task = current
      ? this.appendSection(current.id, `Update ${localTime(at)}`, evidence, at)
      : null;
    return { action: "updated", report, task, notified: null };
  }

  private reopen(
    previous: RoutineReport,
    input: RoutineReportInput,
    evidence: string,
    at: string,
  ): RoutineReportResult {
    const report: RoutineReport = {
      ...previous,
      urgent: input.urgent,
      state: "open",
      lastSeenAt: at,
      resolvedAt: null,
      closedAt: null,
      reopenCount: previous.reopenCount + 1,
    };
    this.repositories.routines.updateReport(report);
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
    return { action: "reopened", report, task, notified: null };
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
    input: RoutineReportInput,
    result: RoutineReportResult,
  ): Promise<string> {
    const where = result.task
      ? `${input.workspace.slug}#${result.task.number}`
      : input.routine;
    const decision = await this.notifications.notify({
      sessionId: input.ability.sessionId,
      workspaceId: input.workspace.id,
      level: input.urgent ? "error" : "info",
      title: `${this.ownerName(input.ability)} · ${where}`,
      body: `${result.action === "reopened" ? "Came back: " : ""}${result.report.title}`,
      desktop: input.urgent,
      urgent: input.urgent,
      ...(result.task ? { taskId: result.task.id } : {}),
    });
    return decision.reason;
  }

  /**
   * Marks an open report resolved: its routine looked again and it was
   * gone. Resolving a key that is not open does nothing, so an agent can
   * resolve without first checking.
   */
  resolve(ability: SessionAbility, keyValue: string): RoutineReport | null {
    const key = reportKey(keyValue);
    const at = this.now().toISOString();
    return this.repositories.immediateTransaction(() => {
      const open = this.repositories.routines.findOpenReport(ability.id, key);
      if (!open) return null;
      const resolved: RoutineReport = {
        ...open,
        state: "resolved",
        resolvedAt: at,
      };
      this.repositories.routines.updateReport(resolved);
      if (open.taskId && !open.sameAs)
        this.appendSection(open.taskId, `Resolved at ${localTime(at)}`, "", at);
      return resolved;
    });
  }

  /**
   * The user's word on a report. Noise also closes it if it is open, and
   * from then on the key raises nothing: it is recorded as seen and dropped.
   * `null` undoes a verdict, so the key can open a task again. The task
   * itself is left as it is either way; its status is the user's.
   */
  verdict(
    ability: SessionAbility,
    id: string,
    value: RoutineReportVerdict | null,
    note?: string,
    quiet = false,
  ): RoutineReport {
    const report = this.repositories.routines.findReport(id);
    if (!report || report.abilityId !== ability.id)
      throw new DaedalusError("NOT_FOUND", `Report '${id}' was not found`);
    const at = this.now().toISOString();
    const updated: RoutineReport =
      value === "noise" && report.state !== "closed"
        ? { ...report, verdict: value, state: "closed", closedAt: at }
        : { ...report, verdict: value };
    this.repositories.transaction(() => {
      this.repositories.routines.updateReport(updated);
      if (report.taskId && !quiet)
        this.appendSection(
          report.taskId,
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
   * The user's word on a task a routine made, applied to every report filed
   * on it, so Noise on a merged task silences each key that fed it.
   */
  feedbackForTask(
    taskId: string,
    value: RoutineReportVerdict | null,
    note?: string,
  ): RoutineReport[] {
    const reports = this.repositories.routines.listReportsForTask(taskId);
    if (!reports.length)
      throw new DaedalusError(
        "NOT_FOUND",
        "No routine report was filed on that task",
      );
    // Only the latest report per key counts; older rows are its history.
    const latest = new Map<string, RoutineReport>();
    for (const report of reports)
      latest.set(`${report.abilityId}\0${report.key}`, report);
    return [...latest.values()].map((report, index) => {
      const ability = this.repositories.abilities.find(report.abilityId);
      if (!ability)
        throw new DaedalusError("NOT_FOUND", "The routines ability is gone");
      // The task brief gets one line, not one per key.
      return this.verdict(ability, report.id, value, note, index > 0);
    });
  }

  /**
   * Closes what has ended. A report whose task the user closed is closed
   * with it. A report resolved a day ago closes too, and if no agent was ever
   * started on its task, the task moves to done: the one status change
   * routines make, approved by the user as an exception to the rule that
   * status is theirs.
   */
  sweep(ability: SessionAbility): { closedTasks: Task[] } {
    const now = this.now();
    const at = now.toISOString();
    const closedTasks: Task[] = [];
    this.repositories.transaction(() => {
      const store = this.repositories.routines;
      for (const report of store.listReports(ability.id, {
        states: ["open", "resolved"],
      })) {
        const task = report.taskId
          ? this.repositories.findTask(report.taskId)
          : undefined;
        const taskEnded =
          task && (task.status === "done" || task.status === "cancelled");
        if (report.state === "open") {
          // A task the user closed as done counts as useful; one they
          // cancelled says nothing either way.
          if (taskEnded)
            store.updateReport({
              ...report,
              state: "closed",
              closedAt: task.completedAt ?? at,
              verdict:
                report.verdict ?? (task.status === "done" ? "useful" : null),
            });
          continue;
        }
        if (
          !report.resolvedAt ||
          now.getTime() - Date.parse(report.resolvedAt) <
            CLOSE_AFTER_RESOLVED_MS
        )
          continue;
        store.updateReport({ ...report, state: "closed", closedAt: at });
        if (
          task &&
          !taskEnded &&
          !report.sameAs &&
          !this.stillOpenOnTask(ability.id, task.id) &&
          !store.taskHasSessions(task.id)
        ) {
          const closed: Task = {
            ...task,
            status: "done",
            completedAt: at,
            updatedAt: at,
            briefUpdatedAt: at,
            description: appendToBrief(
              task.description,
              `Closed by ${this.ownerName(ability)}: resolved at ${localTime(report.resolvedAt)}, no action taken`,
            ),
          };
          this.repositories.updateTask(closed);
          closedTasks.push(closed);
        }
      }
    });
    return { closedTasks };
  }

  /** A merged report still open keeps the shared task alive. */
  private stillOpenOnTask(abilityId: string, taskId: string): boolean {
    return this.repositories.routines
      .listReports(abilityId, { states: ["open"] })
      .some((report) => report.taskId === taskId);
  }

  /** The session's name, which is how its reports are signed. */
  private ownerName(ability: SessionAbility): string {
    return this.repositories.findAgent(ability.sessionId)?.name ?? "Routines";
  }
}

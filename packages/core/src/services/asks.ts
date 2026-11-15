import { readFile } from "node:fs/promises";
import type { AgentSession, Ask } from "../domain";
import { parsePlan, planTasks } from "../domain/plans";
import { DaedalusError } from "../errors";
import type { AskContent, SqliteRepositories } from "../repositories";
import type { AgentService } from "./agents";
import type { PlanFile, PlanService } from "./plans";
import { teamDescendants } from "./team-tree";
import type { TeamDelivery, TeamTransport } from "./team-transport";

/** The longest question title; the details go in the context. */
export const ASK_TITLE_MAX = 160;
/** The longest context or why. */
export const ASK_TEXT_MAX = 4_000;
/** The most options an ask offers. */
export const ASK_OPTIONS_MAX = 8;
/** How long an ended ask still shows under Activity, as "today". */
export const ASK_ENDED_SHOWN_MS = 24 * 60 * 60_000;

/** What an agent writes when it asks. */
export interface AskInput {
  /** The asking session: its id, or its name when only one has it. */
  session: string;
  title: string;
  context?: string;
  why?: string;
  options?: string[];
  /** The 1-based number of the recommended option. */
  recommend?: number;
  /** A plan in the session's workspace: slug, path or absolute path. */
  plan?: string;
  /** A task of that plan: `^id` or `L<line>`. */
  task?: string;
}

/** An ask, with what the app shows beside it. */
export interface AskView extends Ask {
  sessionName: string | null;
  workspaceName: string | null;
}

const clean = (value: string | undefined): string | null => {
  const text = value?.trim();
  return text ? text : null;
};

const age = (from: string, now: Date): string => {
  const minutes = Math.max(
    0,
    Math.round((now.getTime() - Date.parse(from)) / 60_000),
  );
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

/** Every body line indented, so no line of it passes for a header. */
const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

/**
 * Activity: questions for the user that a session asks once and the app
 * keeps until the user answers or dismisses them there, or they close: the
 * agent got its answer in its session, its plan task ended, or the session
 * was archived. When the user answers or dismisses one, the asking session
 * is told, with the question and its context. Every message Daedalus brings
 * a session with open asks ends with one line naming them, so it never has
 * to remember, or repeat, what it asked.
 */
export class AskService {
  private readonly listeners = new Set<(ask: Ask) => void>();

  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly plans: () => Pick<PlanService, "find" | "pinTask">,
    private readonly agents: Pick<AgentService, "recoverCodexThread">,
    private readonly transport: () => TeamTransport,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Called after any ask is created, changed or ended. */
  onChange(listener: (ask: Ask) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(ask: Ask): Ask {
    for (const listener of this.listeners) {
      try {
        listener(ask);
      } catch {
        // A listener's failure is its own.
      }
    }
    return ask;
  }

  private session(reference: string): AgentSession {
    const wanted = reference.trim();
    const byId = this.repositories.findAgent(wanted);
    if (byId) return byId;
    const named = this.repositories
      .listAgents()
      .filter((item) => !item.archivedAt && item.name === wanted);
    if (named.length === 1) return named[0]!;
    throw new DaedalusError(
      named.length ? "VALIDATION" : "NOT_FOUND",
      named.length
        ? `${named.length} sessions are named '${wanted}'; pass its id`
        : `No session '${wanted}'`,
    );
  }

  private ask(id: number): Ask {
    const ask = this.repositories.asks.find(id);
    if (!ask) throw new DaedalusError("NOT_FOUND", `No ask #${id}`);
    return ask;
  }

  private async content(
    session: AgentSession,
    input: Omit<AskInput, "session">,
  ): Promise<AskContent> {
    const title = input.title.trim().replace(/\s+/g, " ");
    if (!title)
      throw new DaedalusError(
        "VALIDATION",
        'An ask needs a question: daedal activity ask "<question>"',
      );
    if (title.length > ASK_TITLE_MAX)
      throw new DaedalusError(
        "VALIDATION",
        `A question has at most ${ASK_TITLE_MAX} characters; put the details in --context`,
      );
    const context = clean(input.context);
    const why = clean(input.why);
    for (const [name, text] of [
      ["--context", context],
      ["--why", why],
    ] as const)
      if (text && text.length > ASK_TEXT_MAX)
        throw new DaedalusError(
          "VALIDATION",
          `${name} has at most ${ASK_TEXT_MAX} characters; put longer text in a file and point to it`,
        );
    const options = (input.options ?? [])
      .map((option) => option.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    if (options.length > ASK_OPTIONS_MAX)
      throw new DaedalusError(
        "VALIDATION",
        `An ask offers at most ${ASK_OPTIONS_MAX} options`,
      );
    let recommended: number | null = null;
    if (input.recommend !== undefined) {
      if (
        !Number.isInteger(input.recommend) ||
        input.recommend < 1 ||
        input.recommend > options.length
      )
        throw new DaedalusError(
          "VALIDATION",
          options.length
            ? `--recommend takes an option's number, 1 to ${options.length}`
            : "--recommend needs options to pick from",
        );
      recommended = input.recommend - 1;
    }
    let planPath: string | null = null;
    let taskKey: string | null = null;
    if (input.task && !input.plan)
      throw new DaedalusError(
        "VALIDATION",
        "Name the plan the task is in: --plan <plan> ^<id>",
      );
    if (input.plan) {
      const file = await this.plans().find(
        { workspace: session.workspaceId },
        input.plan,
      );
      planPath = file.absolutePath;
      if (input.task) taskKey = await this.plans().pinTask(file, input.task);
    }
    return { title, context, why, options, recommended, planPath, taskKey };
  }

  /**
   * Asks the user. The same question asked again by the same session while
   * it is still open rewrites that ask instead of adding one.
   */
  async create(input: AskInput): Promise<{ ask: Ask; updated: boolean }> {
    const session = this.session(input.session);
    const content = await this.content(session, input);
    const at = this.now().toISOString();
    const open = this.repositories.asks.findOpenByTitle(
      session.id,
      content.title,
    );
    if (open)
      return {
        ask: this.changed(this.repositories.asks.update(open.id, content, at)),
        updated: true,
      };
    return {
      ask: this.changed(
        this.repositories.asks.create({
          ...content,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          at,
        }),
      ),
      updated: false,
    };
  }

  /** Rewrites an open ask; only the session that asked may. */
  async update(
    id: number,
    input: Partial<Omit<AskInput, "session">> & { session: string },
  ): Promise<Ask> {
    const ask = this.ask(id);
    const session = this.owned(ask, input.session);
    if (ask.state !== "open")
      throw new DaedalusError("CONFLICT", `Ask #${id} is ${ask.state} already`);
    const content = await this.content(session, {
      title: input.title ?? ask.title,
      context: input.context ?? ask.context ?? undefined,
      why: input.why ?? ask.why ?? undefined,
      options: input.options ?? ask.options,
      ...(input.recommend !== undefined
        ? { recommend: input.recommend }
        : ask.recommended !== null && !input.options
          ? { recommend: ask.recommended + 1 }
          : {}),
    });
    if (!input.plan) {
      content.planPath = ask.planPath;
      content.taskKey = ask.taskKey;
    } else {
      const pinned = await this.content(session, {
        title: content.title,
        plan: input.plan,
        ...(input.task ? { task: input.task } : {}),
      });
      content.planPath = pinned.planPath;
      content.taskKey = pinned.taskKey;
    }
    return this.changed(
      this.repositories.asks.update(id, content, this.now().toISOString()),
    );
  }

  private owned(ask: Ask, reference: string): AgentSession {
    const session = this.session(reference);
    if (session.id !== ask.sessionId)
      throw new DaedalusError(
        "VALIDATION",
        `Ask #${ask.id} belongs to another session; only the session that asked can change it`,
      );
    return session;
  }

  /** One ask, by its number. */
  get(id: number): AskView {
    return this.view(this.ask(id));
  }

  private view(ask: Ask): AskView {
    return {
      ...ask,
      sessionName: this.repositories.findAgent(ask.sessionId)?.name ?? null,
      workspaceName:
        this.repositories.findWorkspace(ask.workspaceId)?.name ?? null,
    };
  }

  /**
   * Asks, newest first: open ones and those ended in the last day. `mine`
   * is one session's; `team` adds every member below it; `workspace` is
   * one workspace's; none of them is every ask.
   */
  list(
    filter: {
      session?: string;
      team?: boolean;
      workspaceId?: string;
      openOnly?: boolean;
    } = {},
  ): AskView[] {
    let sessionIds: string[] | undefined;
    if (filter.session) {
      const session = this.session(filter.session);
      sessionIds = [session.id];
      if (filter.team) sessionIds.push(...this.membersBelow(session.id));
    }
    const endedSince = new Date(
      this.now().getTime() - ASK_ENDED_SHOWN_MS,
    ).toISOString();
    return this.repositories.asks
      .list({
        ...(sessionIds ? { sessionIds } : {}),
        ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
        ...(filter.openOnly ? { openOnly: true } : { endedSince }),
      })
      .map((ask) => this.view(ask));
  }

  /** Every session in the teams a session leads, down every level. */
  private membersBelow(leadId: string): string[] {
    return teamDescendants(this.repositories, leadId).map(
      (member) => member.id,
    );
  }

  /** Open asks pinned to a plan, for its view. */
  onPlan(planPath: string): Ask[] {
    return this.repositories.asks
      .list({ openOnly: true })
      .filter((ask) => ask.planPath === planPath);
  }

  /**
   * The user answers in the app: an option, words, or both. The asking
   * session is told, with the question and its context.
   */
  async answer(
    id: number,
    input: { option?: number | null; note?: string | null },
  ): Promise<Ask> {
    const ask = this.ask(id);
    if (ask.state !== "open")
      throw new DaedalusError("CONFLICT", `Ask #${id} is ${ask.state} already`);
    const option =
      input.option === null || input.option === undefined
        ? null
        : (ask.options[input.option] ??
          (() => {
            throw new DaedalusError(
              "VALIDATION",
              `Ask #${id} has no option ${input.option + 1}`,
            );
          })());
    const note = clean(input.note ?? undefined);
    if (!option && !note)
      throw new DaedalusError(
        "VALIDATION",
        "Pick an option or write an answer",
      );
    return this.end(id, {
      state: "answered",
      answer: option,
      note,
      notify: true,
    });
  }

  /** The user dismisses an ask in the app; the asking session is told. */
  async dismiss(id: number): Promise<Ask> {
    return this.end(id, {
      state: "dismissed",
      reason: "The user dismissed it",
      notify: true,
    });
  }

  /**
   * The asking session closes its own ask: the user answered in the
   * session, or it is no longer needed. Nobody is told.
   */
  async resolve(
    id: number,
    input: { session: string; answer?: string; withdraw?: boolean },
  ): Promise<Ask> {
    const ask = this.ask(id);
    this.owned(ask, input.session);
    const answer = clean(input.answer);
    return this.end(id, {
      state: input.withdraw ? "closed" : "answered",
      ...(input.withdraw
        ? { reason: answer ?? "The session withdrew it" }
        : {
            note: answer,
            reason: "Answered in its session",
          }),
      notify: false,
    });
  }

  /** Undo: an ended ask is open again. */
  reopen(id: number): Ask {
    const ask = this.repositories.asks.reopen(id, this.now().toISOString());
    if (ask) return this.changed(ask);
    const current = this.ask(id);
    throw new DaedalusError(
      "CONFLICT",
      current.state === "open"
        ? `Ask #${id} is open already`
        : current.state === "closed"
          ? `Ask #${id} closed on its own and cannot be opened again`
          : `${this.repositories.findAgent(current.sessionId)?.name ?? "The session"} already has the answer to #${id}; send it a message to change it`,
    );
  }

  private async end(
    id: number,
    input: Parameters<SqliteRepositories["asks"]["end"]>[1] extends infer T
      ? Omit<T, "at">
      : never,
  ): Promise<Ask> {
    const ended = this.repositories.asks.end(id, {
      ...input,
      at: this.now().toISOString(),
    });
    if (!ended) {
      const ask = this.ask(id);
      throw new DaedalusError("CONFLICT", `Ask #${id} is ${ask.state} already`);
    }
    this.changed(ended);
    if (input.notify) await this.flushSession(ended.sessionId);
    return ended;
  }

  /**
   * Closes the open asks of a session that was archived or deleted. Called
   * when a session ends; one that only stopped keeps its asks.
   */
  closeForSession(sessionId: string): Ask[] {
    const session = this.repositories.findAgent(sessionId);
    if (session && !session.archivedAt) return [];
    const reason = session
      ? `'${session.name}' was archived`
      : "Its session was deleted";
    return this.closeWhere(
      this.repositories.asks.list({ sessionIds: [sessionId], openOnly: true }),
      reason,
    );
  }

  /**
   * Closes the open asks pinned to tasks of a plan that are done or
   * dropped, or that no longer exist in it.
   */
  closeForPlan(
    planPath: string,
    tasks: ReadonlyMap<
      string,
      "todo" | "doing" | "done" | "blocked" | "dropped"
    >,
  ): Ask[] {
    const ended = this.onPlan(planPath).filter((ask) => {
      if (!ask.taskKey) return false;
      const state = tasks.get(ask.taskKey);
      return !state || state === "done" || state === "dropped";
    });
    return this.closeWhere(ended, (ask) =>
      tasks.has(ask.taskKey!)
        ? `Its task ^${ask.taskKey} is ${tasks.get(ask.taskKey!)}`
        : `Its task ^${ask.taskKey} is no longer in the plan`,
    );
  }

  /**
   * Reads the plans open asks are pinned to and closes those whose task is
   * done, dropped or gone. Plans change outside Daedalus too, so this runs
   * before the asks are shown. A plan that cannot be read is left alone.
   */
  async sweepPlans(): Promise<Ask[]> {
    const paths = new Set(
      this.repositories.asks
        .list({ openOnly: true })
        .flatMap((ask) => (ask.planPath && ask.taskKey ? [ask.planPath] : [])),
    );
    const closed: Ask[] = [];
    for (const path of paths) {
      const source = await readFile(path, "utf8").catch(() => null);
      if (source === null) continue;
      const tasks = new Map(
        planTasks(parsePlan(source)).flatMap((task) =>
          task.id ? [[task.id, task.state] as const] : [],
        ),
      );
      closed.push(...this.closeForPlan(path, tasks));
    }
    return closed;
  }

  private closeWhere(
    asks: Ask[],
    reason: string | ((ask: Ask) => string),
  ): Ask[] {
    const at = this.now().toISOString();
    return asks.flatMap((ask) => {
      const ended = this.repositories.asks.end(ask.id, {
        state: "closed",
        reason: typeof reason === "string" ? reason : reason(ask),
        notify: false,
        at,
      });
      return ended ? [this.changed(ended)] : [];
    });
  }

  /**
   * The asks the user was not notified about yet, each once: the app's tick
   * sends them, whichever process asked.
   */
  claimNew(): AskView[] {
    return this.repositories.asks
      .claimUnnotified(this.now().toISOString())
      .map((ask) => this.view(ask));
  }

  /**
   * The line every message to a session with open asks ends with, or
   * undefined when it has none.
   */
  openLine(sessionId: string): string | undefined {
    const open = this.repositories.asks
      .list({ sessionIds: [sessionId], openOnly: true })
      .reverse();
    if (!open.length) return undefined;
    const now = this.now();
    const items = open
      .map((ask) => `#${ask.id} ${ask.title} (${age(ask.createdAt, now)})`)
      .join("; ");
    return `[Activity] Open asks: ${items}. They show to the user until answered; do not repeat them. 'daedal activity resolve <n>' when the user answers one here.`;
  }

  /** The notice for an ask that ended, with what the session needs to act. */
  noticeText(ask: Ask): string {
    const lines: string[] = [];
    if (ask.state === "answered") {
      lines.push(`[ask #${ask.id} answered by the user]`);
      lines.push(`Q: ${ask.title}`);
      if (ask.context) lines.push(`You asked:\n${indent(ask.context)}`);
      const answer = [ask.answer, ask.note ? `"${ask.note}"` : null]
        .filter(Boolean)
        .join(", ");
      lines.push(`Answer: ${answer}`);
    } else {
      lines.push(`[ask #${ask.id} dismissed by the user]`);
      lines.push(`Q: ${ask.title}`);
      lines.push("Do not ask it again; carry on without it.");
    }
    if (ask.planPath && ask.taskKey)
      lines.push(
        `Plan: ${ask.planPath} ^${ask.taskKey} is no longer waiting on the user.`,
      );
    return lines.join("\n");
  }

  /**
   * Tells a session how its asks ended, those not told yet. A session not
   * running is told when it runs again. Never throws.
   */
  async flushSession(sessionId: string): Promise<boolean> {
    const session = this.repositories.findAgent(sessionId);
    if (!session || session.archivedAt) return false;
    if (session.status !== "running" && session.status !== "starting")
      return false;
    const at = this.now().toISOString();
    const claimed = this.repositories.asks.claimNotices(sessionId, at);
    if (!claimed.length) return false;
    try {
      await this.transport().deliver({
        session: await this.agents
          .recoverCodexThread(session)
          .catch(() => session),
        text: claimed.map((ask) => this.noticeText(ask)).join("\n\n"),
        from: "[Activity] the user",
      });
      return true;
    } catch {
      // A held or failed delivery goes again on the app's next tick.
      this.repositories.asks.releaseNotices(
        claimed.map((ask) => ask.id),
        at,
      );
      return false;
    }
  }

  /** Delivers every notice still waiting; the app's tick calls it. */
  async flushDue(): Promise<string[]> {
    const delivered: string[] = [];
    for (const sessionId of this.repositories.asks.sessionsWithNotices())
      if (await this.flushSession(sessionId).catch(() => false))
        delivered.push(sessionId);
    return delivered;
  }

  /** The plan file of an ask, for callers that want to open it. */
  async planOf(ask: Ask): Promise<PlanFile | undefined> {
    if (!ask.planPath) return undefined;
    return this.plans()
      .find(undefined, ask.planPath)
      .catch(() => undefined);
  }
}

/**
 * A transport that ends every message to a session with open asks with the
 * line naming them, so a woken agent knows what it already asked.
 */
export class OpenAsksTransport implements TeamTransport {
  constructor(
    private readonly inner: TeamTransport,
    private readonly line: (sessionId: string) => string | undefined,
  ) {}

  deliver(delivery: TeamDelivery): Promise<void> {
    const line = this.line(delivery.session.id);
    return this.inner.deliver(
      line ? { ...delivery, text: `${delivery.text}\n\n${line}` } : delivery,
    );
  }
}

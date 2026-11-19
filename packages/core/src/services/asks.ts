import { readFile } from "node:fs/promises";
import type { AgentSession, Ask } from "../domain";
import { parsePlan, planTasks } from "../domain/plans";
import { DaedalusError } from "../errors";
import type { AskContent, SqliteRepositories } from "../repositories";
import type { AgentService } from "./agents";
import { lastAgentMessage, type MainMessage } from "./main-messages";
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
    private readonly agents: Pick<
      AgentService,
      "recoverCodexThread" | "spawn" | "archive" | "restore"
    >,
    private readonly transport: () => TeamTransport,
    private readonly now: () => Date = () => new Date(),
    private readonly messages: (
      session: AgentSession,
    ) => Promise<MainMessage[]> = async () => [],
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
        'A thread needs a question: daedal thread start "<question>"',
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
    // The thread hangs off what the agent last wrote in main, which its
    // transcript already holds: each block is written before the next tool.
    const anchor = lastAgentMessage(await this.read(session));
    return {
      ask: this.changed(
        this.repositories.asks.create({
          ...content,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          at,
          anchorId: anchor?.id ?? null,
          anchorText: anchor?.text ?? null,
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

  /**
   * Puts an open ask off until `until` (an ISO time in the future), or
   * brings it back now with null. Only the user snoozes; the asking session
   * is not told.
   */
  snooze(id: number, until: string | null): Ask {
    const now = this.now();
    if (until !== null) {
      const time = Date.parse(until);
      if (Number.isNaN(time))
        throw new DaedalusError("VALIDATION", `'${until}' is not a time`);
      if (time <= now.getTime())
        throw new DaedalusError(
          "VALIDATION",
          "A snooze ends in the future; pick a later time",
        );
    }
    const ask = this.repositories.asks.snooze(
      id,
      until === null ? null : new Date(until).toISOString(),
      now.toISOString(),
    );
    if (ask) return this.changed(ask);
    throw new DaedalusError(
      "CONFLICT",
      `Ask #${id} is ${this.ask(id).state}; only an open ask can be snoozed`,
    );
  }

  /**
   * The asking session is now blocked on an open ask. The user is notified
   * again, once: a second bump before the user replies changes nothing.
   */
  bump(id: number, session: string): { ask: Ask; bumped: boolean } {
    const ask = this.ask(id);
    this.owned(ask, session);
    if (ask.state !== "open")
      throw new DaedalusError(
        "CONFLICT",
        `Thread #${id} is ${ask.state} already`,
      );
    const bumped = this.repositories.asks.bump(id, this.now().toISOString());
    return bumped
      ? { ask: this.changed(bumped), bumped: true }
      : { ask, bumped: false };
  }

  /**
   * A session's messages. A Codex session learns its conversation id from a
   * hook, so one whose hook has not reported yet is looked up first.
   */
  private async read(session: AgentSession): Promise<MainMessage[]> {
    const known = await this.agents
      .recoverCodexThread(session)
      .catch(() => session);
    return this.messages(known).catch(() => []);
  }

  /** A session's main messages, oldest first, for the thread view. */
  async mainMessages(sessionId: string): Promise<MainMessage[]> {
    const session = this.repositories.findAgent(sessionId);
    if (!session)
      throw new DaedalusError("NOT_FOUND", `No session ${sessionId}`);
    return this.read(session);
  }

  /**
   * The user opens a fork thread on a message in a session's main: a
   * read-only fork of the session's conversation that the user talks to
   * while the session works on. Without a message it hangs off the agent's
   * last one.
   */
  async openFork(input: {
    sessionId: string;
    anchorId?: string | null;
    /** An open thread to fork: the fork becomes part of that thread. */
    threadId?: number;
  }): Promise<Ask> {
    const live = (ask: Ask | undefined) => {
      const fork = ask?.forkSessionId
        ? this.repositories.findAgent(ask.forkSessionId)
        : undefined;
      return Boolean(fork && !fork.archivedAt);
    };
    if (input.threadId !== undefined) {
      const thread = this.ask(input.threadId);
      if (thread.state !== "open")
        throw new DaedalusError(
          "CONFLICT",
          `Thread #${thread.id} is ${thread.state} already`,
        );
      if (live(thread)) return thread;
      const at = this.now().toISOString();
      const fork = await this.spawnFork(thread.sessionId);
      const attached = this.repositories.asks.attachFork(
        thread.id,
        fork.id,
        at,
      );
      if (!attached)
        throw new DaedalusError("CONFLICT", `Thread #${thread.id} ended`);
      return this.changed(attached);
    }
    // The same message forked again: the fork already open on it.
    const again = this.repositories.asks
      .list({ sessionIds: [input.sessionId], openOnly: true })
      .find(
        (ask) =>
          ask.kind === "fork" &&
          input.anchorId &&
          ask.anchorId === input.anchorId &&
          live(ask),
      );
    if (again) return again;
    const main = this.repositories.findAgent(input.sessionId);
    if (!main || main.archivedAt)
      throw new DaedalusError("NOT_FOUND", `No session ${input.sessionId}`);
    this.canFork(main);
    const messages = await this.read(main);
    const anchor = input.anchorId
      ? messages.find((message) => message.id === input.anchorId)
      : lastAgentMessage(messages);
    const at = this.now().toISOString();
    const fork = await this.spawnFork(main.id);
    const title = (anchor?.text ?? main.name)
      .split("\n")[0]!
      .replace(/\s+/g, " ")
      .slice(0, ASK_TITLE_MAX);
    return this.changed(
      this.repositories.asks.create({
        title,
        context: null,
        why: null,
        options: [],
        recommended: null,
        planPath: null,
        taskKey: null,
        workspaceId: main.workspaceId,
        sessionId: main.id,
        at,
        anchorId: anchor?.id ?? input.anchorId ?? null,
        anchorText: anchor?.text ?? null,
        kind: "fork",
        forkSessionId: fork.id,
      }),
    );
  }

  /**
   * Only Claude and Codex on this Mac fork read-only: a custom command has no
   * fork, and a cloud workspace's pod would start a fresh, writable session.
   */
  private canFork(main: AgentSession): void {
    if (main.kind !== "agent")
      throw new DaedalusError("VALIDATION", "Only an agent session can fork");
    if (main.provider !== "claude" && main.provider !== "codex")
      throw new DaedalusError(
        "VALIDATION",
        "Only a Claude or Codex session can fork",
      );
    if (this.repositories.findWorkspace(main.workspaceId)?.place === "cloud")
      throw new DaedalusError(
        "VALIDATION",
        "A session in a cloud workspace cannot fork yet",
      );
  }

  /** When a thread's fork began: what it wrote is after this. */
  private forkStart(thread: Ask, fork: AgentSession): number {
    return Date.parse(
      this.repositories.asks.forkStartedAt(thread.id) ?? fork.startedAt,
    );
  }

  /** A read-only fork of a session's conversation, for a thread. */
  private async spawnFork(sessionId: string) {
    const main = this.repositories.findAgent(sessionId);
    if (!main || main.archivedAt)
      throw new DaedalusError("NOT_FOUND", `No session ${sessionId}`);
    this.canFork(main);
    return this.agents.spawn({
      workspace: main.workspaceId,
      provider: main.provider,
      ...(main.account ? { account: main.account } : {}),
      name: `Thread on ${main.name}`,
      spawnedBy: main.id,
      forkOf: main,
    });
  }

  private forkSessions(id: number) {
    const thread = this.ask(id);
    if (!thread.forkSessionId)
      throw new DaedalusError("VALIDATION", `Thread #${id} has no fork`);
    const fork = this.repositories.findAgent(thread.forkSessionId);
    const main = this.repositories.findAgent(thread.sessionId);
    if (!fork || !main)
      throw new DaedalusError("NOT_FOUND", `Thread #${id} lost its session`);
    return { thread, fork, main };
  }

  /**
   * Before a fork's turn: main's messages since the fork last read it, as
   * text for the fork's context. Undefined when nothing is new, or when the
   * session is no thread's fork. The first time, "since" is when the fork
   * started, since it was born with main's conversation up to then.
   */
  async forkCatchUp(forkSessionId: string): Promise<string | undefined> {
    const thread = this.repositories.asks.findByFork(forkSessionId);
    if (!thread || thread.state !== "open") return undefined;
    const fork = this.repositories.findAgent(forkSessionId);
    const main = this.repositories.findAgent(thread.sessionId);
    if (!fork || !main) return undefined;
    const synced = this.repositories.asks.forkSyncedAt(thread.id);
    const since = synced ? Date.parse(synced) : this.forkStart(thread, fork);
    const fresh = (await this.read(main)).filter(
      (message) => message.at && Date.parse(message.at) > since,
    );
    if (!fresh.length) return undefined;
    this.repositories.asks.setForkSynced(thread.id, fresh.at(-1)!.at);
    return [
      `[Threads] While you talked here, ${main.name} (the session you fork) went on. Its new messages in main, oldest first:`,
      ...fresh.map(
        (message) =>
          `${message.role === "user" ? "The user" : main.name}: ${message.text}`,
      ),
      "If main has moved past what this thread is about, say so.",
    ].join("\n\n");
  }

  /**
   * What "send to main" starts from: the fork's last reply, for the user to
   * read and edit before it goes. Empty while the fork has written nothing.
   */
  async forkDraft(id: number): Promise<string> {
    return lastAgentMessage(await this.forkConversation(id))?.text ?? "";
  }

  /**
   * The user sends a message from a fork thread to the session it forks,
   * with the message the thread hangs off. Returns the text sent.
   */
  async sendForkToMain(id: number, text: string): Promise<string> {
    const { thread, main, fork } = this.forkSessions(id);
    const body = text.trim();
    if (!body)
      throw new DaedalusError("VALIDATION", "Write what to send to main");
    // A question's fork answers the question: one answer, told the usual way.
    if (thread.kind === "question") {
      await this.answer(id, {
        note: `${body}\n(Worked out in a fork: daedal thread show ${id})`,
      });
      await this.agents.archive(fork.id, true).catch(() => undefined);
      return body;
    }
    const lines = [
      `[thread #${id}] The user talked this through with a read-only fork of you and sends you this:`,
      indent(body),
    ];
    if (thread.anchorText)
      lines.push(`It is about your message:\n${indent(thread.anchorText)}`);
    lines.push(
      `The fork's whole conversation, if you need the reasoning: daedal thread show ${id}`,
    );
    await this.transport().deliver({
      session: await this.agents.recoverCodexThread(main).catch(() => main),
      text: lines.join("\n"),
      from: "[Threads] the user",
    });
    return body;
  }

  /**
   * What was said in a fork thread: the fork's messages since it opened,
   * without the conversation it copied from main. Empty for a question.
   */
  async forkConversation(id: number): Promise<MainMessage[]> {
    const thread = this.ask(id);
    if (!thread.forkSessionId) return [];
    const fork = this.repositories.findAgent(thread.forkSessionId);
    if (!fork) return [];
    const since = this.forkStart(thread, fork);
    return (await this.read(fork)).filter(
      (message) => !message.at || Date.parse(message.at) >= since,
    );
  }

  /**
   * The user resolves a thread. A question ends without an answer and its
   * owner is told; a fork thread just ends. Either way its fork is archived.
   */
  async closeThread(id: number): Promise<Ask> {
    const thread = this.ask(id);
    const ended =
      thread.kind === "question"
        ? await this.end(id, {
            state: "dismissed",
            reason: "The user resolved it without an answer",
            notify: true,
          })
        : await this.end(id, {
            state: "closed",
            reason: "Closed by the user",
            notify: false,
          });
    if (thread.forkSessionId)
      await this.agents
        .archive(thread.forkSessionId, true)
        .catch(() => undefined);
    return ended;
  }

  /**
   * The user reopens a resolved thread. A fork thread gets its fork back. A
   * question whose owner was already told it ended is reopened and the owner
   * told so; one the owner withdrew stays ended.
   */
  async reopenThread(id: number): Promise<Ask> {
    const thread = this.ask(id);
    if (thread.state === "open")
      throw new DaedalusError("CONFLICT", `Thread #${id} is open already`);
    if (thread.kind === "question") {
      if (thread.state === "closed")
        throw new DaedalusError(
          "CONFLICT",
          `${this.repositories.findAgent(thread.sessionId)?.name ?? "The session"} withdrew #${id}; it cannot be reopened`,
        );
      // Not told yet: the end is simply taken back.
      const quiet = this.repositories.asks.reopen(id, this.now().toISOString());
      if (quiet) {
        await this.restoreFork(thread);
        return this.changed(quiet);
      }
    }
    const reopened = this.repositories.asks.reopenEnded(
      id,
      this.now().toISOString(),
    );
    if (!reopened)
      throw new DaedalusError("CONFLICT", `Thread #${id} could not reopen`);
    await this.restoreFork(thread);
    if (thread.kind === "question") {
      const main = this.repositories.findAgent(thread.sessionId);
      if (main && !main.archivedAt) {
        const before = [thread.answer, thread.note].filter(Boolean).join(", ");
        await this.transport()
          .deliver({
            session: await this.agents
              .recoverCodexThread(main)
              .catch(() => main),
            text: [
              `[thread #${id}] The user reopened "${thread.title}".`,
              before
                ? `Set aside the answer they gave before (${before}) and wait for a new one in the thread.`
                : "Wait for their answer in the thread.",
            ].join(" "),
            from: "[Threads] the user",
          })
          .catch(() => undefined);
      }
    }
    return this.changed(reopened);
  }

  /** A reopened thread gets its archived fork back. */
  private async restoreFork(thread: Ask): Promise<void> {
    const fork = thread.forkSessionId
      ? this.repositories.findAgent(thread.forkSessionId)
      : undefined;
    if (fork?.archivedAt)
      await this.agents.restore(fork.id).catch(() => undefined);
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
   * Closes the open asks of a session that was archived or deleted, and
   * archives their forks. Called when a session ends; one that only stopped
   * keeps its asks.
   */
  closeForSession(sessionId: string): Ask[] {
    const session = this.repositories.findAgent(sessionId);
    if (session && !session.archivedAt) return [];
    const reason = session
      ? `'${session.name}' was archived`
      : "Its session was deleted";
    const closed = this.closeWhere(
      this.repositories.asks.list({ sessionIds: [sessionId], openOnly: true }),
      reason,
    );
    // A thread's fork has nothing to fork once its session is gone.
    for (const ask of closed)
      if (ask.forkSessionId) {
        const archiving = this.agents
          .archive(ask.forkSessionId, true)
          .then(() => undefined)
          .catch(() => undefined)
          .finally(() => this.archiving.delete(archiving));
        this.archiving.add(archiving);
      }
    return closed;
  }

  /**
   * Forks still being archived after their session was. A short-lived
   * process, such as the CLI, waits for them before it exits.
   */
  async settled(): Promise<void> {
    while (this.archiving.size) await Promise.all([...this.archiving]);
  }

  private readonly archiving = new Set<Promise<void>>();

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
      .filter((ask) => ask.kind === "question")
      .reverse();
    if (!open.length) return undefined;
    const now = this.now();
    const items = open
      .map((ask) => `#${ask.id} ${ask.title} (${age(ask.createdAt, now)})`)
      .join("; ");
    return `[Threads] Open threads: ${items}. They show to the user until answered; do not repeat them. 'daedal thread resolve <n>' when the user answers one here; 'daedal thread bump <n>' once when you are blocked on one.`;
  }

  /** The notice for an ask that ended, with what the session needs to act. */
  noticeText(ask: Ask): string {
    const lines: string[] = [];
    if (ask.state === "answered") {
      lines.push(`[thread #${ask.id} answered by the user]`);
      lines.push(`Q: ${ask.title}`);
      if (ask.context) lines.push(`You asked:\n${indent(ask.context)}`);
      const answer = [ask.answer, ask.note ? `"${ask.note}"` : null]
        .filter(Boolean)
        .join(", ");
      lines.push(`Answer: ${answer}`);
      lines.push("The thread is closed already; there is nothing to resolve.");
    } else {
      lines.push(`[thread #${ask.id} dismissed by the user]`);
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
        from: "[Threads] the user",
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

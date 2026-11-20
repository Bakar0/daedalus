import { readFile } from "node:fs/promises";
import {
  AGENT,
  DAEDALUS,
  LEAD,
  USER,
  type AgentSession,
  type Cursor,
  type Message,
  type Participant,
  type Resolver,
  type Thread,
} from "../domain";
import { parsePlan, planTasks } from "../domain/plans";
import { DaedalusError } from "../errors";
import type { SqliteRepositories, ThreadChange } from "../repositories";
import type { AgentService } from "./agents";
import { lastAgentMessage, type MainMessage } from "./main-messages";
import type { PlanFile, PlanService } from "./plans";
import { teamAncestors, teamDescendants } from "./team-tree";
import type { TeamDelivery, TeamTransport } from "./team-transport";

/** The longest thread title; a longer first message is cut for it. */
export const THREAD_TITLE_MAX = 160;
/** The longest message body. */
export const THREAD_MESSAGE_MAX = 4_000;
/** The longest details. */
export const THREAD_DETAILS_MAX = 8_000;
/** The most options a message offers. */
export const THREAD_OPTIONS_MAX = 8;
/** How long a resolved thread still shows in the list. */
export const THREAD_RESOLVED_SHOWN_MS = 24 * 60 * 60_000;
/** How far back `find` looks unless told otherwise. */
export const THREAD_FIND_DAYS = 14;
/** How many related threads `start` names. */
const RELATED_MAX = 3;

/** What the list shows of a thread, derived from its messages. */
export interface ThreadStatus {
  /** The user has not read its latest message from someone else. */
  unread: boolean;
  /**
   * Who is to reply: the side that did not write the latest message.
   * Null for a resolved thread or one with no message yet.
   */
  turn: typeof USER | typeof AGENT | null;
  /** The owner said it is blocked on it, and the user has not replied since. */
  blocking: boolean;
}

/** A thread with its conversation and what the app shows beside it. */
export interface ThreadView extends Thread {
  ownerName: string | null;
  workspaceName: string | null;
  messages: Message[];
  status: ThreadStatus;
}

/** A thread that matched a search, with its best matching message. */
export interface ThreadHit {
  thread: ThreadView;
  match: Message;
}

/** What someone writes in a thread. */
export interface ThreadPost {
  body: string;
  details?: string | null;
  options?: string[];
}

/** A notice's event and, after a colon, its reason: `resolved: done`. */
export type ThreadEvent = "blocked" | "resolved" | "reopened";

export function noticeEvent(
  message: Pick<Message, "kind" | "body">,
): { event: ThreadEvent; reason: string | null } | undefined {
  if (message.kind !== "notice") return undefined;
  const at = message.body.indexOf(":");
  const event = (at < 0 ? message.body : message.body.slice(0, at)).trim();
  if (event !== "blocked" && event !== "resolved" && event !== "reopened")
    return undefined;
  const reason = at < 0 ? "" : message.body.slice(at + 1).trim();
  return { event, reason: reason || null };
}

const clean = (value: string | null | undefined): string | null => {
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

/** A text's first line, cut short. */
export const firstLine = (text: string, max = 120): string => {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Every body line indented, so no line of it passes for a header. */
const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

/**
 * Threads: conversations between an agent and the user, each hanging off a
 * line in the agent's main. Anyone in it posts; posting in a resolved
 * thread reopens it. The owner is brought what the user and its lead write,
 * the user is notified of what the owner writes, and every message Daedalus
 * brings a session with open threads ends with a line naming them, so it
 * never has to remember, or repeat, what it asked.
 */
export class ThreadService {
  private readonly listeners = new Set<(thread: Thread) => void>();
  private readonly archiving = new Set<Promise<void>>();

  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly plans: () => Pick<PlanService, "find" | "pinTask">,
    private readonly agents: Pick<
      AgentService,
      "recoverCodexThread" | "spawn" | "archive" | "restore"
    >,
    private readonly transport: () => TeamTransport,
    private readonly now: () => Date = () => new Date(),
    private readonly mainOf: (
      session: AgentSession,
    ) => Promise<MainMessage[]> = async () => [],
  ) {}

  /** Called after any thread is created, written in, or changed. */
  onChange(listener: (thread: Thread) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed<T extends Thread>(thread: T): T {
    for (const listener of this.listeners) {
      try {
        listener(thread);
      } catch {
        // A listener's failure is its own.
      }
    }
    return thread;
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

  private thread(number: number): Thread {
    const thread = this.repositories.conversations.thread(number);
    if (!thread) throw new DaedalusError("NOT_FOUND", `No thread #${number}`);
    return thread;
  }

  private at(): string {
    return this.now().toISOString();
  }

  private post(input: ThreadPost): Required<ThreadPost> {
    const body = input.body.trim();
    if (!body) throw new DaedalusError("VALIDATION", "Write a message");
    if (body.length > THREAD_MESSAGE_MAX)
      throw new DaedalusError(
        "VALIDATION",
        `A message has at most ${THREAD_MESSAGE_MAX} characters; put the rest in --details`,
      );
    const details = clean(input.details);
    if (details && details.length > THREAD_DETAILS_MAX)
      throw new DaedalusError(
        "VALIDATION",
        `--details has at most ${THREAD_DETAILS_MAX} characters; put longer text in a file and point to it`,
      );
    const options = (input.options ?? [])
      .map((option) => option.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    if (options.length > THREAD_OPTIONS_MAX)
      throw new DaedalusError(
        "VALIDATION",
        `A message offers at most ${THREAD_OPTIONS_MAX} options`,
      );
    return { body, details, options };
  }

  /** Who a session is in a thread: its owner, or the owner's lead. */
  private participant(thread: Thread, reference: string): Participant {
    const session = this.session(reference);
    if (session.id === thread.ownerSessionId) return AGENT;
    if (
      teamAncestors(this.repositories, thread.ownerSessionId).some(
        (lead) => lead.id === session.id,
      )
    )
      return LEAD;
    throw new DaedalusError(
      "VALIDATION",
      `Thread #${thread.number} belongs to ${this.repositories.findAgent(thread.ownerSessionId)?.name ?? "another session"}; only it and its leads write in it`,
    );
  }

  view(thread: Thread): ThreadView {
    const messages = this.repositories.conversations.messages(thread.id);
    return {
      ...thread,
      ownerName:
        this.repositories.findAgent(thread.ownerSessionId)?.name ?? null,
      workspaceName:
        this.repositories.findWorkspace(thread.workspaceId)?.name ?? null,
      messages,
      status: this.status(thread, messages),
    };
  }

  private status(thread: Thread, messages: Message[]): ThreadStatus {
    const read = this.repositories.conversations.cursor(
      thread.id,
      USER,
    ).readThrough;
    const unread = messages.some(
      (message) =>
        message.id > read &&
        message.author !== USER &&
        (message.kind === "message" ||
          noticeEvent(message)?.event === "blocked"),
    );
    const last = messages
      .filter((message) => message.kind === "message")
      .at(-1);
    return {
      unread,
      turn:
        thread.resolvedAt || !last ? null : last.author === USER ? AGENT : USER,
      blocking: Boolean(thread.blockedAt && !thread.resolvedAt),
    };
  }

  /** One thread, by its number. */
  get(number: number): ThreadView {
    return this.view(this.thread(number));
  }

  /**
   * Opens a thread on the session's last line in main, with its first
   * message. Also returns up to three threads from the last two weeks
   * whose words match, so the agent can post there instead next time.
   */
  async new(
    input: ThreadPost & {
      /** The owner: its id, or its name when only one has it. */
      session: string;
      /** A plan in the session's workspace: slug, path or absolute path. */
      plan?: string;
      /** A task of that plan: `^id` or `L<line>`. */
      task?: string;
    },
  ): Promise<{ thread: ThreadView; related: ThreadView[] }> {
    const session = this.session(input.session);
    const post = this.post(input);
    const pinned = await this.pin(session, input.plan, input.task);
    const related = this.related(session, post.body);
    // The thread hangs off what the agent last wrote in main, which its
    // transcript already holds: each block is written before the next tool.
    const anchor = lastAgentMessage(await this.read(session));
    const at = this.at();
    const thread = this.repositories.immediateTransaction(() => {
      const created = this.repositories.conversations.createThread({
        workspaceId: session.workspaceId,
        ownerSessionId: session.id,
        title: firstLine(post.body, THREAD_TITLE_MAX),
        anchorId: anchor?.id ?? null,
        anchorText: anchor?.text ?? null,
        ...pinned,
        at,
      });
      const message = this.repositories.conversations.post(created.id, {
        author: AGENT,
        ...post,
        createdAt: at,
      });
      this.repositories.conversations.advance(
        created.id,
        AGENT,
        "delivered",
        message.id,
      );
      this.repositories.conversations.advance(
        created.id,
        AGENT,
        "read",
        message.id,
      );
      return created;
    });
    return { thread: this.changed(this.view(thread)), related };
  }

  private async pin(
    session: AgentSession,
    plan: string | undefined,
    task: string | undefined,
  ): Promise<{ planPath: string | null; taskKey: string | null }> {
    if (task && !plan)
      throw new DaedalusError(
        "VALIDATION",
        "Name the plan the task is in: --plan <plan> ^<id>",
      );
    if (!plan) return { planPath: null, taskKey: null };
    const file = await this.plans().find(
      { workspace: session.workspaceId },
      plan,
    );
    return {
      planPath: file.absolutePath,
      taskKey: task ? await this.plans().pinTask(file, task) : null,
    };
  }

  /**
   * Threads that share the new one's longer words. Short ones ("the",
   * "and") would match nearly every thread, so they are left out here;
   * `find` keeps them, since the agent chose them.
   */
  private related(session: AgentSession, text: string): ThreadView[] {
    const words = text
      .split(/\W+/)
      .filter((word) => word.length >= 4)
      .join(" ");
    if (!words) return [];
    return this.find(words, {
      session: session.id,
      since: new Date(
        this.now().getTime() - THREAD_FIND_DAYS * 24 * 60 * 60_000,
      ).toISOString(),
    })
      .slice(0, RELATED_MAX)
      .map((hit) => hit.thread);
  }

  /**
   * Threads whose messages match the words, best first, one hit each:
   * the session's workspace's (every workspace's with `all`), open or
   * resolved, written since `since` (two weeks unless given).
   */
  find(
    words: string,
    filter: { session?: string; since?: string; all?: boolean; limit?: number },
  ): ThreadHit[] {
    const since =
      filter.since ??
      new Date(
        this.now().getTime() - THREAD_FIND_DAYS * 24 * 60 * 60_000,
      ).toISOString();
    const workspaceId =
      filter.all || !filter.session
        ? undefined
        : this.session(filter.session).workspaceId;
    const limit = filter.limit ?? 10;
    const hits = this.repositories.conversations.search(words, {
      kind: "thread",
      ...(workspaceId ? { workspaceId } : {}),
      since,
      limit: limit * 5,
    });
    const found: ThreadHit[] = [];
    const seen = new Set<number>();
    for (const { message } of hits) {
      if (seen.has(message.conversationId)) continue;
      seen.add(message.conversationId);
      const thread = this.repositories.conversations.threadById(
        message.conversationId,
      );
      if (thread) found.push({ thread: this.view(thread), match: message });
      if (found.length >= limit) break;
    }
    return found;
  }

  /**
   * Writes in a thread. `as` is `user` from the app, or a session: the
   * owner, or its lead. A post in a resolved thread reopens it; a post from
   * the user clears a block. `picked` is an option of the latest message
   * that offers some, sent as its text.
   */
  async say(
    number: number,
    input: Partial<ThreadPost> & { as: string; picked?: number | null },
  ): Promise<{ thread: ThreadView; message: Message }> {
    const thread = this.thread(number);
    const author =
      input.as === USER ? USER : this.participant(thread, input.as);
    const messages = this.repositories.conversations.messages(thread.id);
    let picked: number | null = null;
    let pickedText: string | null = null;
    if (input.picked !== undefined && input.picked !== null) {
      const offered = messages
        .filter(
          (message) => message.options.length && message.author !== author,
        )
        .at(-1);
      pickedText = offered?.options[input.picked] ?? null;
      if (pickedText === null)
        throw new DaedalusError(
          "VALIDATION",
          `Thread #${number} offers no option ${input.picked + 1}`,
        );
      picked = input.picked;
    }
    const note = clean(input.body);
    const post = this.post({
      body: [pickedText, note].filter(Boolean).join("\n") || "",
      ...(input.details !== undefined ? { details: input.details } : {}),
      ...(input.options ? { options: input.options } : {}),
    });
    const at = this.at();
    const message = this.repositories.immediateTransaction(() => {
      const conversations = this.repositories.conversations;
      if (thread.resolvedAt)
        conversations.post(thread.id, {
          author,
          kind: "notice",
          body: "reopened",
          createdAt: at,
        });
      const written = conversations.post(thread.id, {
        author,
        ...post,
        picked,
        createdAt: at,
      });
      const change: ThreadChange = {};
      if (thread.resolvedAt) {
        change.resolvedAt = null;
        change.resolvedBy = null;
      }
      if (author === USER) change.blockedAt = null;
      if (Object.keys(change).length)
        conversations.updateThread(thread.id, change, at);
      // Its author has seen it. The user need not be notified of it; the
      // owner's delivery cursor stays, since a reply below it may still wait.
      conversations.advance(thread.id, author, "read", written.id);
      if (author === USER)
        conversations.advance(thread.id, author, "delivered", written.id);
      return written;
    });
    if (thread.resolvedAt && thread.forkSessionId)
      await this.restoreFork(thread);
    const view = this.changed(this.get(number));
    if (author !== AGENT) await this.flushSession(thread.ownerSessionId);
    return { thread: view, message };
  }

  /** Marks a thread read by a participant up to its latest message. */
  markRead(number: number, participant: Participant = USER): ThreadView {
    const thread = this.thread(number);
    const last = this.repositories.conversations.lastMessageId(thread.id);
    if (last)
      this.repositories.conversations.advance(
        thread.id,
        participant,
        "read",
        last,
      );
    return this.get(number);
  }

  /**
   * `read` from the CLI: marks it read as the owner or lead the session
   * is, or as the user outside any session. Another session only reads.
   */
  readAs(number: number, session: string | undefined): ThreadView {
    if (!session) return this.markRead(number, USER);
    const thread = this.thread(number);
    let participant: Participant;
    try {
      participant = this.participant(thread, session);
    } catch {
      return this.view(thread);
    }
    return this.markRead(number, participant);
  }

  /**
   * Threads, newest first: open ones and those resolved in the last day.
   * `session` is one session's; `team` adds every member below it;
   * `workspaceId` is one workspace's; none of them is every thread.
   */
  list(
    filter: {
      session?: string;
      team?: boolean;
      workspaceId?: string;
      open?: boolean;
    } = {},
  ): ThreadView[] {
    let owners: string[] | undefined;
    if (filter.session) {
      const session = this.session(filter.session);
      owners = [session.id];
      if (filter.team)
        owners.push(
          ...teamDescendants(this.repositories, session.id).map(
            (member) => member.id,
          ),
        );
    }
    const activeSince = new Date(
      this.now().getTime() - THREAD_RESOLVED_SHOWN_MS,
    ).toISOString();
    return this.repositories.conversations
      .threads({
        ...(owners ? { owners } : {}),
        ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
        ...(filter.open ? { open: true } : { activeSince }),
      })
      .map((thread) => this.view(thread));
  }

  /** Open threads pinned to a plan, for its view. */
  onPlan(planPath: string): ThreadView[] {
    return this.repositories.conversations
      .threads({ open: true })
      .filter((thread) => thread.planPath === planPath)
      .map((thread) => this.view(thread));
  }

  /**
   * The owner is now blocked on an open thread. The user is notified once:
   * a second bump before the user replies changes nothing.
   */
  bump(
    number: number,
    session: string,
  ): { thread: ThreadView; bumped: boolean } {
    const thread = this.thread(number);
    if (this.participant(thread, session) !== AGENT)
      throw new DaedalusError(
        "VALIDATION",
        `Only ${this.repositories.findAgent(thread.ownerSessionId)?.name ?? "its owner"} is blocked on thread #${number}`,
      );
    if (thread.resolvedAt)
      throw new DaedalusError(
        "CONFLICT",
        `Thread #${number} is resolved; write in it to reopen it`,
      );
    if (thread.blockedAt) return { thread: this.get(number), bumped: false };
    const at = this.at();
    this.repositories.immediateTransaction(() => {
      this.repositories.conversations.post(thread.id, {
        author: AGENT,
        kind: "notice",
        body: "blocked",
        createdAt: at,
      });
      this.repositories.conversations.updateThread(
        thread.id,
        { blockedAt: at },
        at,
      );
    });
    return { thread: this.changed(this.get(number)), bumped: true };
  }

  /**
   * Resolves a thread, with a notice others are brought. `by` is `user`
   * from the app, or a session (the owner or its lead). Its fork, if any,
   * is archived.
   */
  async resolve(
    number: number,
    input: { by: string; reason?: string | null },
  ): Promise<ThreadView> {
    const thread = this.thread(number);
    const by: Resolver =
      input.by === USER
        ? USER
        : (this.participant(thread, input.by) as Resolver);
    const resolved = this.end(thread, by, clean(input.reason));
    if (!resolved)
      throw new DaedalusError(
        "CONFLICT",
        `Thread #${number} is resolved already`,
      );
    if (thread.forkSessionId)
      await this.agents
        .archive(thread.forkSessionId, true)
        .catch(() => undefined);
    if (by !== AGENT) await this.flushSession(thread.ownerSessionId);
    return this.get(number);
  }

  /** The user reopens a resolved thread; the owner is told. */
  async reopen(number: number): Promise<ThreadView> {
    const thread = this.thread(number);
    if (!thread.resolvedAt)
      throw new DaedalusError("CONFLICT", `Thread #${number} is open already`);
    const at = this.at();
    this.repositories.immediateTransaction(() => {
      const message = this.repositories.conversations.post(thread.id, {
        author: USER,
        kind: "notice",
        body: "reopened",
        createdAt: at,
      });
      this.repositories.conversations.advance(
        thread.id,
        USER,
        "read",
        message.id,
      );
      this.repositories.conversations.updateThread(
        thread.id,
        { resolvedAt: null, resolvedBy: null },
        at,
      );
    });
    await this.restoreFork(thread);
    this.changed(this.get(number));
    await this.flushSession(thread.ownerSessionId);
    return this.get(number);
  }

  /**
   * Resolves an open thread with a notice, in one transaction. Undefined
   * when it was resolved already.
   */
  private end(
    thread: Thread,
    by: Resolver,
    reason: string | null,
  ): Thread | undefined {
    const at = this.at();
    const ended = this.repositories.immediateTransaction(() => {
      const current = this.repositories.conversations.threadById(thread.id);
      if (!current || current.resolvedAt) return undefined;
      const message = this.repositories.conversations.post(thread.id, {
        author: by,
        kind: "notice",
        body: reason ? `resolved: ${reason}` : "resolved",
        createdAt: at,
      });
      this.repositories.conversations.advance(
        thread.id,
        by,
        "read",
        message.id,
      );
      // A thread nothing was written in (a fork the owner never knew of)
      // ends without telling the owner. Its own and Daedalus's endings are
      // never brought to it: delivery skips their notices.
      if (
        !this.repositories.conversations
          .messages(thread.id)
          .some((written) => written.kind === "message")
      )
        this.repositories.conversations.advance(
          thread.id,
          AGENT,
          "delivered",
          message.id,
        );
      return this.repositories.conversations.updateThread(
        thread.id,
        { resolvedAt: at, resolvedBy: by, blockedAt: null },
        at,
      );
    });
    return ended ? this.changed(ended) : undefined;
  }

  /**
   * Puts an open thread off until `until` (an ISO time in the future), or
   * brings it back now with null. While snoozed the user is not notified;
   * when it is due, the user is notified of it again.
   */
  snooze(number: number, until: string | null): ThreadView {
    const thread = this.thread(number);
    if (thread.resolvedAt)
      throw new DaedalusError(
        "CONFLICT",
        `Thread #${number} is resolved; only an open thread can be snoozed`,
      );
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
    const at = now.toISOString();
    this.repositories.immediateTransaction(() => {
      this.repositories.conversations.updateThread(
        thread.id,
        { snoozedUntil: until === null ? null : new Date(until).toISOString() },
        at,
      );
      if (until === null) return;
      // Notify again when it is due: the user's notification rewinds to
      // just before the owner's latest message.
      const latest = this.repositories.conversations
        .messages(thread.id)
        .filter((message) => message.author !== USER)
        .at(-1);
      if (!latest) return;
      const cursor = this.repositories.conversations.cursor(thread.id, USER);
      this.repositories.conversations.saveCursor({
        ...cursor,
        deliveredThrough: Math.min(cursor.deliveredThrough, latest.id - 1),
      });
    });
    return this.changed(this.get(number));
  }

  /**
   * A session's messages. A Codex session learns its conversation id from a
   * hook, so one whose hook has not reported yet is looked up first.
   */
  private async read(session: AgentSession): Promise<MainMessage[]> {
    const known = await this.agents
      .recoverCodexThread(session)
      .catch(() => session);
    return this.mainOf(known).catch(() => []);
  }

  /** A session's main messages, oldest first, for the thread view. */
  async mainMessages(sessionId: string): Promise<MainMessage[]> {
    const session = this.repositories.findAgent(sessionId);
    if (!session)
      throw new DaedalusError("NOT_FOUND", `No session ${sessionId}`);
    return this.read(session);
  }

  private liveFork(thread: Thread | undefined): boolean {
    const fork = thread?.forkSessionId
      ? this.repositories.findAgent(thread.forkSessionId)
      : undefined;
    return Boolean(fork && !fork.archivedAt);
  }

  /**
   * The user talks a thread through with a read-only fork of its owner
   * while the owner works on. With `threadNumber`, an open thread gets its
   * own fork; otherwise a new thread opens on a message in a session's
   * main (its last agent message without one). The same message forked
   * again is the thread already open on it.
   */
  async openFork(input: {
    sessionId: string;
    anchorId?: string | null;
    threadNumber?: number;
  }): Promise<ThreadView> {
    if (input.threadNumber !== undefined) {
      const thread = this.thread(input.threadNumber);
      if (thread.resolvedAt)
        throw new DaedalusError(
          "CONFLICT",
          `Thread #${thread.number} is resolved; reopen it first`,
        );
      if (this.liveFork(thread)) return this.view(thread);
      const fork = await this.spawnFork(thread.ownerSessionId);
      const at = this.at();
      const attached = this.repositories.conversations.updateThread(
        thread.id,
        { forkSessionId: fork.id, forkStartedAt: at, forkSyncedAt: null },
        at,
      );
      if (!attached)
        throw new DaedalusError("CONFLICT", `Thread #${thread.number} is gone`);
      return this.changed(this.view(attached));
    }
    const again = this.repositories.conversations
      .threads({ owners: [input.sessionId], open: true })
      .find(
        (thread) =>
          input.anchorId &&
          thread.anchorId === input.anchorId &&
          this.liveFork(thread),
      );
    if (again) return this.view(again);
    const main = this.repositories.findAgent(input.sessionId);
    if (!main || main.archivedAt)
      throw new DaedalusError("NOT_FOUND", `No session ${input.sessionId}`);
    this.canFork(main);
    const messages = await this.read(main);
    const anchor = input.anchorId
      ? messages.find((message) => message.id === input.anchorId)
      : lastAgentMessage(messages);
    const fork = await this.spawnFork(main.id);
    const thread = this.repositories.conversations.createThread({
      workspaceId: main.workspaceId,
      ownerSessionId: main.id,
      title: firstLine(anchor?.text ?? main.name, THREAD_TITLE_MAX),
      anchorId: anchor?.id ?? input.anchorId ?? null,
      anchorText: anchor?.text ?? null,
      planPath: null,
      taskKey: null,
      forkSessionId: fork.id,
      at: this.at(),
    });
    return this.changed(this.view(thread));
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

  /** When a thread's fork began: what it wrote is after this. */
  private forkStart(thread: Thread, fork: AgentSession): number {
    return Date.parse(
      this.repositories.conversations.forkTimes(thread.id).startedAt ??
        fork.startedAt,
    );
  }

  /**
   * Before a fork's turn: a reminder of what the fork is, then main's
   * messages since the fork last read it. Undefined when the session is no
   * open thread's fork. The first time, "since" is when the fork started,
   * since it was born with main's conversation up to then.
   */
  async forkCatchUp(forkSessionId: string): Promise<string | undefined> {
    const thread = this.repositories.conversations.threadByFork(forkSessionId);
    if (!thread || thread.resolvedAt) return undefined;
    const fork = this.repositories.findAgent(forkSessionId);
    const main = this.repositories.findAgent(thread.ownerSessionId);
    if (!fork || !main) return undefined;
    const synced = this.repositories.conversations.forkTimes(
      thread.id,
    ).syncedAt;
    const since = synced ? Date.parse(synced) : this.forkStart(thread, fork);
    const fresh = (await this.read(main)).filter(
      (message) => message.at && Date.parse(message.at) > since,
    );
    // Every turn: plan mode's own prompt returns each turn and pulls the
    // fork toward writing a plan and asking to build it.
    const reminder = `[Threads] You are thread #${thread.number}, a read-only fork of ${main.name}. Plan mode only keeps you read-only here: write no plan, do not offer to make changes, and answer in chat. When you and the user settle something, end with "For main:" and one to three lines the user can send to ${main.name}.`;
    if (!fresh.length) return reminder;
    this.repositories.conversations.updateThread(
      thread.id,
      { forkSyncedAt: fresh.at(-1)!.at },
      thread.updatedAt,
    );
    return [
      reminder,
      `While you talked here, ${main.name} (the session you fork) went on. Its new messages in main, oldest first:`,
      ...fresh.map(
        (message) =>
          `${message.role === "user" ? "The user" : main.name}: ${message.text}`,
      ),
      "If main has moved past what this thread is about, say so.",
    ].join("\n\n");
  }

  /**
   * What "send to main" starts from: the fork's last reply, or only its
   * "For main:" part when it wrote one, for the user to read and edit before
   * it goes. Empty while the fork has written nothing.
   */
  async forkDraft(number: number): Promise<string> {
    const reply =
      lastAgentMessage(await this.forkConversation(number))?.text ?? "";
    const marker = /(?:^|\n)\s*\**For main:?\**:?\s*/i.exec(reply);
    const forMain = marker
      ? reply.slice(marker.index + marker[0].length).trim()
      : "";
    return forMain || reply;
  }

  /**
   * The user sends what they worked out in a thread's fork to its owner: a
   * message from the user in the thread, brought to the owner like any
   * other. Returns the text sent.
   */
  async sendForkToMain(number: number, text: string): Promise<string> {
    const thread = this.thread(number);
    if (!thread.forkSessionId)
      throw new DaedalusError("VALIDATION", `Thread #${number} has no fork`);
    const body = text.trim();
    if (!body)
      throw new DaedalusError("VALIDATION", "Write what to send to main");
    await this.say(number, {
      as: USER,
      body,
      details: `Worked out with a read-only fork of you: daedal thread read ${number}`,
    });
    return body;
  }

  /**
   * What was said in a thread's fork: the fork's messages since it opened,
   * without the conversation it copied from main. Empty without a fork.
   */
  async forkConversation(number: number): Promise<MainMessage[]> {
    const thread = this.thread(number);
    if (!thread.forkSessionId) return [];
    const fork = this.repositories.findAgent(thread.forkSessionId);
    if (!fork) return [];
    const since = this.forkStart(thread, fork);
    return (await this.read(fork)).filter(
      (message) => !message.at || Date.parse(message.at) >= since,
    );
  }

  /** A reopened thread gets its archived fork back. */
  private async restoreFork(thread: Thread): Promise<void> {
    const fork = thread.forkSessionId
      ? this.repositories.findAgent(thread.forkSessionId)
      : undefined;
    if (fork?.archivedAt)
      await this.agents.restore(fork.id).catch(() => undefined);
  }

  /**
   * Resolves the open threads of a session that was archived or deleted,
   * and archives their forks. A session that only stopped keeps them.
   */
  closeForSession(sessionId: string): Thread[] {
    const session = this.repositories.findAgent(sessionId);
    if (session && !session.archivedAt) return [];
    const reason = session
      ? `'${session.name}' was archived`
      : "its session was deleted";
    const closed = this.closeWhere(
      this.repositories.conversations.threads({
        owners: [sessionId],
        open: true,
      }),
      reason,
    );
    // A thread's fork has nothing to fork once its session is gone.
    for (const thread of closed)
      if (thread.forkSessionId) {
        const archiving = this.agents
          .archive(thread.forkSessionId, true)
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

  /**
   * Resolves the open threads pinned to tasks of a plan that are done or
   * dropped, or that no longer exist in it.
   */
  closeForPlan(
    planPath: string,
    tasks: ReadonlyMap<
      string,
      "todo" | "doing" | "done" | "blocked" | "dropped"
    >,
  ): Thread[] {
    const ended = this.repositories.conversations
      .threads({ open: true })
      .filter((thread) => {
        if (thread.planPath !== planPath || !thread.taskKey) return false;
        const state = tasks.get(thread.taskKey);
        return !state || state === "done" || state === "dropped";
      });
    return this.closeWhere(ended, (thread) =>
      tasks.has(thread.taskKey!)
        ? `its task ^${thread.taskKey} is ${tasks.get(thread.taskKey!)}`
        : `its task ^${thread.taskKey} is no longer in the plan`,
    );
  }

  /**
   * Reads the plans open threads are pinned to and resolves those whose
   * task is done, dropped or gone. Plans change outside Daedalus too, so
   * this runs before threads are shown. A plan that cannot be read is
   * left alone.
   */
  async sweepPlans(): Promise<Thread[]> {
    const paths = new Set(
      this.repositories.conversations
        .threads({ open: true })
        .flatMap((thread) =>
          thread.planPath && thread.taskKey ? [thread.planPath] : [],
        ),
    );
    const closed: Thread[] = [];
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
    threads: Thread[],
    reason: string | ((thread: Thread) => string),
  ): Thread[] {
    return threads.flatMap((thread) => {
      const ended = this.end(
        thread,
        DAEDALUS,
        typeof reason === "string" ? reason : reason(thread),
      );
      return ended ? [ended] : [];
    });
  }

  /**
   * The threads with news the user was not notified of yet, each once:
   * the owner wrote, or said it is blocked. Snoozed ones wait until due.
   * The app's tick sends them, whichever process wrote.
   */
  claimNew(): ThreadView[] {
    const now = this.now();
    const at = now.toISOString();
    return this.repositories
      .immediateTransaction(() =>
        this.repositories.conversations
          .threadsWithNews(USER, { noticesFrom: [AGENT] })
          .filter(
            (thread) =>
              !thread.resolvedAt &&
              (!thread.snoozedUntil || thread.snoozedUntil <= at),
          )
          .map((thread) => {
            this.repositories.conversations.advance(
              thread.id,
              USER,
              "delivered",
              this.repositories.conversations.lastMessageId(thread.id),
            );
            return thread;
          }),
      )
      .map((thread) => this.view(thread));
  }

  /**
   * The line every message to a session with open threads ends with, or
   * undefined when it has none. Threads that only fork it are left out.
   */
  openLine(sessionId: string): string | undefined {
    const open = this.repositories.conversations
      .threads({ owners: [sessionId], open: true })
      .map((thread) => this.view(thread))
      .filter((thread) => thread.messages.some((m) => m.kind === "message"))
      .reverse();
    if (!open.length) return undefined;
    const now = this.now();
    const items = open
      .map(
        (thread) =>
          `#${thread.number} ${thread.title} (${age(thread.createdAt, now)}${thread.status.turn === AGENT ? ", the user replied" : ""})`,
      )
      .join("; ");
    return `[Threads] Open threads: ${items}. Talk about a thread only in it: 'daedal thread say <n> "..."'. 'daedal thread resolve <n>' when it is settled; 'daedal thread bump <n>' once when you are blocked on one.`;
  }

  /** How a participant shows in a delivered message. */
  private label(thread: Thread, author: Participant): string {
    if (author === USER) return "The user";
    if (author === LEAD) {
      const lead = teamAncestors(this.repositories, thread.ownerSessionId)[0];
      return lead ? `Your lead ${lead.name}` : "Your lead";
    }
    return "Daedalus";
  }

  /**
   * What the owner is brought of a thread: each new message from someone
   * else, with the last thing it wrote quoted so the reply reads on its own.
   */
  deliveryText(thread: Thread, fresh: Message[], before: Message[]): string {
    const lines: string[] = [];
    const own = before.filter(
      (message) => message.author === AGENT && message.kind === "message",
    );
    const quoted = own.at(-1)?.body ?? thread.anchorText;
    for (const message of fresh) {
      const who = this.label(thread, message.author);
      const notice = noticeEvent(message);
      if (notice?.event === "resolved")
        lines.push(
          `[thread #${thread.number}] ${who} resolved it${notice.reason ? `: ${notice.reason}` : "."}`,
        );
      else if (notice?.event === "reopened")
        lines.push(
          `[thread #${thread.number}] ${who} reopened it; wait for their reply there.`,
        );
      else if (message.kind === "message") {
        const picked =
          message.picked !== null
            ? ` (picked option ${message.picked + 1})`
            : "";
        lines.push(`[thread #${thread.number}] ${who}${picked}:`);
        lines.push(indent(message.body));
        if (message.details) lines.push(indent(message.details));
      }
    }
    if (quoted)
      lines.push(
        `In reply to "${firstLine(quoted)}" (daedal thread read ${thread.number}).`,
      );
    if (thread.resolvedAt && thread.planPath && thread.taskKey)
      lines.push(
        `Plan: ${thread.planPath} ^${thread.taskKey} is no longer waiting on the user.`,
      );
    else if (!thread.resolvedAt)
      lines.push(
        `Reply in the thread: daedal thread say ${thread.number} "...". Resolve it when settled: daedal thread resolve ${thread.number}.`,
      );
    return lines.join("\n");
  }

  /**
   * Brings a session what the user and its lead wrote in its threads since
   * it was last brought anything. Claimed in one transaction, so two
   * processes never send the same message; put back when the delivery
   * fails. A session not running is brought them when it runs again.
   * Never throws.
   */
  async flushSession(sessionId: string): Promise<boolean> {
    const session = this.repositories.findAgent(sessionId);
    if (!session || session.archivedAt) return false;
    if (session.status !== "running" && session.status !== "starting")
      return false;
    const conversations = this.repositories.conversations;
    const claimed = this.repositories.immediateTransaction(() =>
      conversations
        .threadsWithNews(AGENT, { owner: sessionId, noticesFrom: [USER, LEAD] })
        .map((thread) => {
          const cursor = conversations.cursor(thread.id, AGENT);
          const all = conversations.messages(thread.id);
          const fresh = all.filter(
            (message) =>
              message.id > cursor.deliveredThrough &&
              message.author !== AGENT &&
              message.author !== DAEDALUS,
          );
          const through = all.at(-1)!.id;
          conversations.advance(thread.id, AGENT, "delivered", through);
          return {
            thread,
            cursor,
            through,
            text: this.deliveryText(
              thread,
              fresh,
              all.filter((message) => message.id < fresh[0]!.id),
            ),
          };
        }),
    );
    if (!claimed.length) return false;
    try {
      await this.transport().deliver({
        session: await this.agents
          .recoverCodexThread(session)
          .catch(() => session),
        text: claimed.map((item) => item.text).join("\n\n"),
        from: "[Threads] the user",
      });
      return true;
    } catch (error) {
      // A held or failed delivery goes again on the app's next tick.
      // Put back only what no other process moved on since.
      const at = this.at();
      this.repositories.immediateTransaction(() => {
        for (const { cursor, through } of claimed) {
          const current = conversations.cursor(cursor.conversationId, AGENT);
          conversations.saveCursor({
            ...current,
            ...(current.deliveredThrough === through
              ? { deliveredThrough: cursor.deliveredThrough }
              : {}),
            lastError: error instanceof Error ? error.message : String(error),
            lastAttemptAt: at,
          } satisfies Cursor);
        }
      });
      return false;
    }
  }

  /** Delivers everything still waiting; the app's tick calls it. */
  async flushDue(): Promise<string[]> {
    const owners = new Set(
      this.repositories.conversations
        .threadsWithNews(AGENT, { noticesFrom: [USER, LEAD] })
        .map((thread) => thread.ownerSessionId),
    );
    const delivered: string[] = [];
    for (const sessionId of owners)
      if (await this.flushSession(sessionId).catch(() => false))
        delivered.push(sessionId);
    return delivered;
  }

  /** The plan file of a thread, for callers that want to open it. */
  async planOf(thread: Thread): Promise<PlanFile | undefined> {
    if (!thread.planPath) return undefined;
    return this.plans()
      .find(undefined, thread.planPath)
      .catch(() => undefined);
  }
}

/**
 * A transport that ends every message to a session with the notes waiting
 * for it (what changed under it, once) and the line naming its open
 * threads, so a woken agent knows what it already asked.
 */
export class OpenThreadsTransport implements TeamTransport {
  constructor(
    private readonly inner: TeamTransport,
    private readonly line: (sessionId: string) => string | undefined,
    private readonly notes: {
      take(sessionId: string): string[];
      restore(sessionId: string, bodies: readonly string[], at: string): void;
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  async deliver(delivery: TeamDelivery): Promise<void> {
    const id = delivery.session.id;
    const notes = this.notes.take(id);
    const line = this.line(id);
    const extra = [...notes, ...(line ? [line] : [])];
    try {
      await this.inner.deliver(
        extra.length
          ? { ...delivery, text: [delivery.text, ...extra].join("\n\n") }
          : delivery,
      );
    } catch (error) {
      if (notes.length) this.notes.restore(id, notes, this.now().toISOString());
      throw error;
    }
  }
}

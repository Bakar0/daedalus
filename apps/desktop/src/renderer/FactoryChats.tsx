/**
 * The Factory tab's chats. Each agent on a box has one chat, a window that
 * floats over the plans: the user drags it, resizes it and minimizes it to
 * the dock at the bottom, and opens as many as they want, so several flows
 * are talked to at once.
 *
 * A chat holds everything between the user and that agent. What the agent
 * asks arrives as its messages, with the choices under them. What the user
 * types is answered by a read-only copy of the agent, which does not
 * interrupt it; the switch on the typing box sends a message to the working
 * agent instead. Only messages are shown, never a terminal or a transcript.
 */
import { factoryWhere } from "./factory-where";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MainMessageDto,
  SessionTurnDto,
  ThreadDto,
  ThreadMessageDto,
} from "@daedalus/protocol";
import {
  conversationMark,
  copyState,
  showConversation,
  useSeen,
  type CopyState,
  type SeenState,
} from "./chat-unread";
import type { DesktopClient } from "./client-types";
import { MarkdownPreview, OpenLinkContext } from "./markdown-preview";
import { snoozeChoices } from "./threads-shared";

const REFRESH_MS = 5_000;
/** How often a chat with an answer on its way is read again. */
const ANSWER_MS = 2_500;
/** How often a working agent's own conversation is read again. */
const WORKING_MS = 1_000;
/** How long the working row stays for an answer that is still being read. */
const SETTLE_MS = 6_000;
/** How long a sent message shows as on its way to an agent that is not working. */
const SENDING_MS = 30_000;

/** An agent of the workspace that can be talked to: a live session on a box. */
export interface FactoryAgent {
  sessionId: string;
  handle: string;
}

/** An open chat and where its window is. */
export interface ChatWindow extends FactoryAgent {
  /** The box it was opened from. */
  about: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  /** Stacking order: the highest is in front. */
  order: number;
  /** Text to put in the typing box once, such as a question a box offers. */
  draft?: string | undefined;
  /** The conversation it shows: the agent's own, or one with a copy. */
  tab?: ChatTabId | undefined;
  /**
   * What Direct shows: the agent's messages, or its terminal. Both are the
   * same conversation, so one window holds them and switches between them.
   */
  view?: "thread" | "terminal" | undefined;
}

/** The size a window opens at: enough for an agent's terminal. */
export const CHAT_WIDTH = 760;
export const CHAT_HEIGHT = 560;

const isMessage = (message: ThreadMessageDto) => message.kind === "message";

/** A thread the user opened by asking: nobody has written in it. */
const isQuestion = (thread: ThreadDto) => !thread.messages.some(isMessage);

const snoozed = (thread: ThreadDto, now: number) =>
  thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > now;

/** Whether an agent's thread waits for the user's answer. */
export const waitsOnUser = (thread: ThreadDto, now: number = Date.now()) =>
  !thread.resolvedAt &&
  !isQuestion(thread) &&
  thread.turn === "user" &&
  !snoozed(thread, now);

/** How many asks wait for the user, by the session that asked. */
export function waitingBySession(
  threads: readonly ThreadDto[],
  now: number = Date.now(),
): Map<string, { count: number; blocking: boolean }> {
  const out = new Map<string, { count: number; blocking: boolean }>();
  for (const thread of threads) {
    if (!waitsOnUser(thread, now)) continue;
    const entry = out.get(thread.sessionId) ?? { count: 0, blocking: false };
    out.set(thread.sessionId, {
      count: entry.count + 1,
      blocking: entry.blocking || thread.blocking,
    });
  }
  return out;
}

/**
 * What a conversation is called until the user names it: its first
 * question. A thread opened on one of the agent's messages is titled with
 * that message, which says nothing about what was asked.
 */
export function conversationName(
  thread: Pick<ThreadDto, "title" | "anchorText">,
  messages: readonly MainMessageDto[],
): string {
  const first = messages.find(
    (message) =>
      message.role === "user" &&
      !message.text.trimStart().startsWith("[Threads]") &&
      !INTERRUPTED.test(message.text.trimStart()),
  );
  const question = first
    ? splitAbout(first.text).question.trim().split("\n")[0]
    : undefined;
  if (question) return question;
  const titled = thread.title.replace(/…$/, "");
  return thread.anchorText?.trimStart().startsWith(titled)
    ? "Untitled"
    : thread.title;
}

export interface ChatItem {
  id: string;
  at: string;
  /** `copy` is the read-only copy of the agent answering the user. */
  from: "agent" | "copy" | "you";
  text: string;
  /** Folded under an agent's message: ids, logs, links. */
  details?: string;
  /** Choices under an agent's ask that still waits, and its thread. */
  options?: { threadId: number; choices: string[] };
  /** On the user's message: who it went to. */
  to?: "agent" | "copy";
  /** The copy has not answered yet. */
  pending?: boolean;
  /** On a question to a copy and its answer: the question's thread. */
  threadId?: number;
  /** On a question about one of the agent's messages: how that one begins. */
  about?: string;
}

/** What an agent is doing now, as its hooks last reported. */
export interface AgentLive {
  /** `working`, `done`, `needs_input` or `needs_permission`. */
  state: string;
  /** The tool it is on, such as `Bash(bun test)`, while it works. */
  detail: string | null;
  /** When it entered this state. */
  since: string;
  /** Its workflow step, such as `build · step 3 of 7`. */
  step?: string | undefined;
}

/** A row of the agent's own chat: a message, or a turn's work folded away. */
export type ChatRow =
  | { kind: "item"; item: ChatItem }
  | {
      kind: "fold";
      id: string;
      /** From the user's message to the agent's last one. */
      startedAt: string;
      endedAt: string;
      /** What the agent wrote on the way to its final reply. */
      hidden: ChatItem[];
      /** The turn's tool calls, when its hooks recorded them. */
      turn?: SessionTurnDto;
    }
  | {
      /** Under a turn's reply: the files it edited. */
      kind: "files";
      id: string;
      files: string[];
    };

/** How far a transcript's clock and a hook's may differ. */
const CLOCK_SLACK_MS = 3_000;

/**
 * The agent's own chat with each turn's work folded: of the messages an
 * agent writes between two of the user's, only the last one is its reply.
 */
export function foldTurns(
  items: readonly ChatItem[],
  turns: readonly SessionTurnDto[] = [],
): ChatRow[] {
  const rows: ChatRow[] = [];
  let run: ChatItem[] = [];
  let startedAt = "";
  const used = new Set<SessionTurnDto>();
  /** The recorded turn the messages from `from` to `to` were written in. */
  const turnOf = (from: string, to: string) => {
    const turn = turns.findLast(
      (one) =>
        !used.has(one) &&
        Date.parse(one.startedAt) <= Date.parse(to) + CLOCK_SLACK_MS &&
        (one.endedAt === null ||
          Date.parse(one.endedAt) >= Date.parse(from) - CLOCK_SLACK_MS),
    );
    if (turn) used.add(turn);
    return turn;
  };
  const flush = () => {
    const reply = run.at(-1);
    if (!reply) return;
    const hidden = run.slice(0, -1);
    const from = startedAt || run[0]!.at;
    const turn = turnOf(from, reply.at);
    if (hidden.length || turn?.toolCalls)
      rows.push({
        kind: "fold",
        id: `fold:${reply.id}`,
        startedAt: from,
        endedAt: reply.at,
        hidden,
        ...(turn ? { turn } : {}),
      });
    rows.push({ kind: "item", item: reply });
    if (turn?.files.length)
      rows.push({ kind: "files", id: `files:${reply.id}`, files: turn.files });
    run = [];
  };
  for (const item of items) {
    if (item.from === "agent" && item.id.startsWith("m:")) {
      run.push(item);
      continue;
    }
    flush();
    if (item.from === "you") startedAt = item.at;
    rows.push({ kind: "item", item });
  }
  flush();
  return rows;
}

/** `6m 12s`, `41s` or `1h 24m` between two moments. */
export function elapsed(from: string, to: string | number): string {
  const end = typeof to === "number" ? to : Date.parse(to);
  const seconds = Math.max(0, Math.round((end - Date.parse(from)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A question the user took back before its copy answered. */
export interface Withdrawn {
  threadId: number;
  text: string;
  /** When it was taken back; the same words asked later are a new question. */
  at: string;
}

/**
 * A question about one of the agent's messages reaches the copy with a note
 * naming the message. The question and the message's first words, apart.
 */
export function splitAbout(text: string): { question: string; about?: string } {
  const note = /\n\n\(About your message that begins: "([\s\S]*)"\)\s*$/.exec(
    text,
  );
  return note
    ? { question: text.slice(0, note.index), about: note[1]! }
    : { question: text };
}

/** What a stopped agent writes in its own transcript in the user's place. */
const INTERRUPTED = /^\[Request interrupted by user/;

const isWithdrawn = (
  withdrawn: readonly Withdrawn[],
  threadId: number,
  message: MainMessageDto,
) =>
  withdrawn.some(
    (entry) =>
      entry.threadId === threadId &&
      entry.text === splitAbout(message.text).question.trim() &&
      (!message.at || Date.parse(message.at) <= Date.parse(entry.at)),
  );

/** A message the user sent the working agent from a chat, kept in the page. */
export interface SentMessage {
  id: string;
  sessionId: string;
  text: string;
  at: string;
  /** The conversation it came out of, when it was sent from one. */
  threadId?: number;
}

/**
 * Which part of an agent's chat is shown: `agent` is what the agent asked
 * and what the user told it, a number is one conversation with a copy (its
 * question thread), `new` is a conversation not asked in yet, and `history`
 * lists the threads put away. A number may also be a thread the agent
 * began: what it wrote there, the user's answers, and a fork's when asked.
 */
export type ChatTabId = "agent" | "new" | "history" | number;

/** A thread the user began by asking a fork of the agent, not deleted. */
const isConversation = (thread: ThreadDto, sessionId: string) =>
  thread.sessionId === sessionId &&
  !thread.resolvedAt &&
  isQuestion(thread) &&
  thread.forkSessionId !== null;

/** A thread the agent began: it wrote in it, to ask or to tell. */
export const isAgentThread = (thread: ThreadDto) => !isQuestion(thread);

/**
 * An agent's threads that are listed, oldest first: the ones it began that
 * are not resolved, and the ones the user began with a fork and has not
 * closed. One whose fork has stopped is still listed: asking wakes the fork.
 */
export const openThreads = (
  threads: readonly ThreadDto[],
  sessionId: string,
): ThreadDto[] =>
  threads
    .filter((thread) =>
      isQuestion(thread)
        ? isConversation(thread, sessionId) && !thread.closedAt
        : thread.sessionId === sessionId && !thread.resolvedAt,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** When a thread went to its agent's history. */
export const putAwayAt = (thread: ThreadDto): string =>
  (isQuestion(thread) ? thread.closedAt : thread.resolvedAt) ?? "";

/**
 * An agent's history, newest first: the threads with a fork that the user
 * closed, and the agent's own threads that were resolved.
 */
export const closedThreads = (
  threads: readonly ThreadDto[],
  sessionId: string,
): ThreadDto[] =>
  threads
    .filter((thread) =>
      isQuestion(thread)
        ? isConversation(thread, sessionId) && thread.closedAt
        : thread.sessionId === sessionId && thread.resolvedAt,
    )
    .sort((a, b) => putAwayAt(b).localeCompare(putAwayAt(a)));

/**
 * Where a listed thread stands for the user: the agent `asks` in it, a fork
 * is `answering`, a fork's answer is `unread`, or there is nothing new.
 */
export type ThreadMark = "asks" | "answering" | "unread" | "read";

export const threadMark = (
  thread: ThreadDto,
  liveOf: ((sessionId: string) => CopyState | undefined) | undefined,
  seen: SeenState,
  now: number = Date.now(),
): ThreadMark =>
  waitsOnUser(thread, now)
    ? "asks"
    : conversationMark(thread.id, copyState(thread, liveOf), seen);

/**
 * What a thread is called: the name the user gave it, the agent's subject
 * for one it began, or the user's first question in one with a fork.
 */
export const threadName = (
  thread: ThreadDto,
  names: Readonly<Record<string, string>>,
  messages: readonly MainMessageDto[] = [],
): string =>
  names[thread.id] ??
  (isAgentThread(thread) ? thread.title : conversationName(thread, messages));

/**
 * One agent's chat, oldest first: its asks and the user's answers, the
 * user's questions and the copy's answers, and what the user sent the
 * agent. An agent writes several messages while it looks things up; the
 * last one before the next question is the copy's answer. Notes Daedalus
 * sends a copy are not the user's.
 */
export function chatItems(input: {
  sessionId: string;
  threads: readonly ThreadDto[];
  /** A question thread's fork conversation, by thread id. */
  conversations: ReadonlyMap<number, readonly MainMessageDto[]>;
  sent: readonly SentMessage[];
  /** Questions taken back: they and their unwritten answers are left out. */
  withdrawn?: readonly Withdrawn[];
  /** One part of the chat only; everything when left out. */
  tab?: ChatTabId;
  /** The agent's own conversation, for its part of the chat. */
  main?: readonly MainMessageDto[];
  now?: number;
}): ChatItem[] {
  const now = input.now ?? Date.now();
  const { tab } = input;
  const items: ChatItem[] = [];
  if (tab === "new" || tab === "history") return items;
  for (const thread of input.threads) {
    if (thread.sessionId !== input.sessionId) continue;
    if (typeof tab === "number" ? thread.id !== tab : false) continue;
    if (isQuestion(thread) && tab === "agent") continue;
    // What was asked of a fork: in a thread the user began, and in the
    // agent's own thread once it is the one shown.
    if (isQuestion(thread) || tab === thread.id) {
      let open: ChatItem | undefined;
      for (const message of input.conversations.get(thread.id) ?? []) {
        if (message.role === "user") {
          if (message.text.trimStart().startsWith("[Threads]")) continue;
          if (INTERRUPTED.test(message.text.trimStart())) continue;
          // An answer that never came before the next question never will.
          if (open && !open.pending) items.push(open);
          open = undefined;
          if (isWithdrawn(input.withdrawn ?? [], thread.id, message)) continue;
          const { question, about } = splitAbout(message.text);
          items.push({
            id: `q${thread.id}:${message.id}`,
            at: message.at,
            from: "you",
            text: question,
            to: "copy",
            threadId: thread.id,
            ...(about ? { about } : {}),
          });
          open = {
            id: `a${thread.id}:${message.id}`,
            at: message.at,
            from: "copy",
            text: "",
            pending: true,
            threadId: thread.id,
          };
        } else if (open)
          open = {
            ...open,
            at: message.at,
            text: message.text,
            pending: false,
          };
      }
      if (open && (!open.pending || !thread.resolvedAt)) items.push(open);
    }
    const messages = thread.messages.filter(isMessage);
    messages.forEach((message, index) => {
      const mine = message.author === "user";
      const last = index === messages.length - 1;
      items.push({
        id: `t${thread.id}:${message.id}`,
        at: message.createdAt,
        from: mine ? "you" : "agent",
        text:
          message.body || (message.picked !== null ? "Picked an option" : ""),
        ...(mine ? { to: "agent" as const } : {}),
        ...(message.details ? { details: message.details } : {}),
        ...(last && !mine && message.options.length && waitsOnUser(thread, now)
          ? { options: { threadId: thread.id, choices: message.options } }
          : {}),
      });
    });
  }
  // What the agent said and was told in its own session. Notes Daedalus
  // brings it start with a bracket and are not the user's words.
  const told = new Set<string>();
  if (typeof tab !== "number") {
    let at = "";
    for (const message of (input.main ?? []).slice(-MAIN_SHOWN)) {
      at = message.at || at;
      const text = message.text.trim();
      if (!text || !at) continue;
      if (message.role === "user") {
        if (text.startsWith("[")) continue;
        told.add(text);
      }
      items.push({
        id: `m:${message.id}`,
        at,
        from: message.role === "user" ? "you" : "agent",
        text,
        ...(message.role === "user" ? { to: "agent" as const } : {}),
      });
    }
  }
  for (const message of input.sent)
    if (
      message.sessionId === input.sessionId &&
      // Its own session holds it once the agent has read it.
      !(typeof tab !== "number" && told.has(message.text.trim())) &&
      (typeof tab !== "number" || message.threadId === tab)
    )
      items.push({
        id: message.id,
        at: message.at,
        from: "you",
        text: message.text,
        to: "agent",
      });
  // A stable sort: an answer stays after its question when the times tie.
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        Date.parse(a.item.at) - Date.parse(b.item.at) || a.index - b.index,
    )
    .map(({ item }) => item);
}

/** Every workspace's threads, for the sidebar's lists of conversations. */
export function useAllThreads(client: DesktopClient) {
  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const reload = useCallback(() => {
    void client.request.threadList({}).then(
      (response) => {
        if (response.ok) setThreads(response.data);
      },
      () => undefined,
    );
  }, [client]);
  useEffect(() => {
    reload();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, REFRESH_MS);
    const unsubscribe = client.subscribe((change) => {
      if (!change?.parts?.length) reload();
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [client, reload]);
  return { threads, reload };
}

/** The workspace's threads, read again as they change. */
export function useWorkspaceThreads(
  client: DesktopClient,
  workspaceId: string,
) {
  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const reload = useCallback(() => {
    void client.request.threadList({}).then(
      (response) => {
        if (response.ok)
          setThreads(
            response.data.filter(
              (thread) => thread.workspaceId === workspaceId,
            ),
          );
      },
      () => undefined,
    );
  }, [client, workspaceId]);
  useEffect(() => {
    setThreads([]);
    reload();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, REFRESH_MS);
    const unsubscribe = client.subscribe((change) => {
      if (!change?.parts?.length) reload();
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [client, reload]);
  return { threads, reload };
}

/**
 * The fork conversations of an agent's question threads: the listed ones,
 * and the closed ones only while `closedToo` says they show.
 */
function useConversations(
  client: DesktopClient,
  threads: readonly ThreadDto[],
  sessionId: string,
  closedToo: boolean,
) {
  const [conversations, setConversations] = useState(
    () => new Map<number, MainMessageDto[]>(),
  );
  const ids = threads
    .filter(
      (thread) =>
        thread.sessionId === sessionId &&
        !thread.resolvedAt &&
        thread.forkSessionId !== null &&
        (closedToo || !thread.closedAt),
    )
    .map((thread) => thread.id)
    .join(",");
  const reload = useCallback(() => {
    for (const id of ids ? ids.split(",").map(Number) : [])
      void client.request.threadConversation({ id }).then(
        (response) => {
          if (response.ok)
            setConversations((before) =>
              new Map(before).set(id, response.data),
            );
        },
        () => undefined,
      );
  }, [client, ids]);
  useEffect(() => {
    reload();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, ANSWER_MS);
    return () => window.clearInterval(timer);
  }, [reload]);
  return { conversations, reload };
}

const SENT_KEY = "daedalus.factory.sent";
const SENT_KEPT = 200;
const NAMES_KEY = "daedalus.factory.conversation-names";

function stored<T>(key: string, fallback: T): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return value === null || typeof value !== typeof fallback
      ? fallback
      : (value as T);
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Without storage it holds until the page reloads.
  }
}

const SENT_EVENT = "daedalus:factory-sent";

/**
 * Records a message the user sent an agent from outside its window, the
 * Factory's start box for one, so the window shows it before the agent's
 * own session does.
 */
export function noteSent(message: SentMessage): void {
  store(
    SENT_KEY,
    [...stored<SentMessage[]>(SENT_KEY, []), message].slice(-SENT_KEPT),
  );
  window.dispatchEvent(new Event(SENT_EVENT));
}

/** What the user sent agents from chats, kept across reloads. */
function useSent() {
  const [sent, setSent] = useState<SentMessage[]>(() =>
    stored<SentMessage[]>(SENT_KEY, []),
  );
  useEffect(() => {
    const read = () => setSent(stored<SentMessage[]>(SENT_KEY, []));
    window.addEventListener(SENT_EVENT, read);
    return () => window.removeEventListener(SENT_EVENT, read);
  }, []);
  const add = useCallback((message: SentMessage) => noteSent(message), []);
  return { sent, add };
}

/** The names the user gave conversations, by thread. */
export function useConversationNames() {
  const [names, setNames] = useState<Record<string, string>>(() =>
    stored<Record<string, string>>(NAMES_KEY, {}),
  );
  const rename = useCallback(
    (threadId: number, name: string) =>
      setNames((before) => {
        const next = { ...before };
        if (name.trim()) next[threadId] = name.trim();
        else delete next[threadId];
        store(NAMES_KEY, next);
        return next;
      }),
    [],
  );
  return { names, rename };
}

/** How many of the agent's own messages its part of the chat shows. */
const MAIN_SHOWN = 80;

/** The agent's own conversation, read while its part of the chat shows. */
function useMainMessages(
  client: DesktopClient,
  sessionId: string,
  shown: boolean,
  /** The agent is working: read often, and at once when it stops. */
  working = false,
) {
  const [messages, setMessages] = useState<MainMessageDto[]>([]);
  useEffect(() => {
    if (!shown) return;
    let stale = false;
    const read = () =>
      void client.request.sessionMessages({ sessionId }).then(
        (response) => {
          if (!stale && response.ok) setMessages(response.data);
        },
        () => undefined,
      );
    read();
    const timer = window.setInterval(
      () => {
        if (document.visibilityState === "visible") read();
      },
      working ? WORKING_MS : ANSWER_MS,
    );
    // What it wrote last reaches its session a moment after it stops.
    const after = working
      ? []
      : [400, 1200].map((ms) => window.setTimeout(read, ms));
    return () => {
      stale = true;
      window.clearInterval(timer);
      for (const one of after) window.clearTimeout(one);
    };
  }, [client, sessionId, shown, working]);
  return messages;
}

/** The agent's turns as its hooks recorded them, read while they show. */
function useTurns(
  client: DesktopClient,
  sessionId: string,
  shown: boolean,
  working = false,
) {
  const [turns, setTurns] = useState<SessionTurnDto[]>([]);
  useEffect(() => {
    if (!shown) return;
    let stale = false;
    const read = () =>
      void client.request.sessionTurns({ sessionId }).then(
        (response) => {
          if (!stale && response.ok) setTurns(response.data);
        },
        () => undefined,
      );
    read();
    const timer = window.setInterval(
      () => {
        if (document.visibilityState === "visible") read();
      },
      working ? WORKING_MS : ANSWER_MS,
    );
    // What it wrote last reaches its session a moment after it stops.
    const after = working
      ? []
      : [400, 1200].map((ms) => window.setTimeout(read, ms));
    return () => {
      stale = true;
      window.clearInterval(timer);
      for (const one of after) window.clearTimeout(one);
    };
  }, [client, sessionId, shown, working]);
  return turns;
}

const WITHDRAWN_KEY = "daedalus.factory.withdrawn:";
const WITHDRAWN_KEPT = 50;

/** The questions the user took back in one agent's chat, kept across reloads. */
function useWithdrawn(sessionId: string) {
  const [withdrawn, setWithdrawn] = useState<Withdrawn[]>(() => {
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem(WITHDRAWN_KEY + sessionId) ?? "[]",
      );
      return Array.isArray(stored) ? (stored as Withdrawn[]) : [];
    } catch {
      return [];
    }
  });
  const add = useCallback(
    (entry: Withdrawn) =>
      setWithdrawn((before) => {
        const next = [...before, entry].slice(-WITHDRAWN_KEPT);
        try {
          localStorage.setItem(WITHDRAWN_KEY + sessionId, JSON.stringify(next));
        } catch {
          // Without storage it holds until the page reloads.
        }
        return next;
      }),
    [sessionId],
  );
  return { withdrawn, add };
}

/** The address of the markdown link an event landed on, when it did. */
const linkAt = (target: EventTarget) =>
  (target as HTMLElement).closest?.(".markdown-body a")?.getAttribute("href") ??
  undefined;

/**
 * Links in a chat open as they do in a session's terminal: with Cmd held,
 * and by the same opener (a workspace file in the editor, a local dev
 * server in a web tab, anything else in the browser). A plain click only
 * places the cursor, so text with a link in it can be selected.
 */
export function ChatLinks({
  children,
  onOpenLink,
}: {
  children: React.ReactNode;
  onOpenLink: (url: string) => void;
}) {
  const [armed, setArmed] = useState(false);
  /** The link Cmd was pressed on, opened when the button comes up on it. */
  const pressed = useRef<string | undefined>(undefined);
  useEffect(() => {
    const arm = (event: KeyboardEvent | MouseEvent) => setArmed(event.metaKey);
    const disarm = () => setArmed(false);
    window.addEventListener("keydown", arm, true);
    window.addEventListener("keyup", arm, true);
    window.addEventListener("mousemove", arm, true);
    window.addEventListener("blur", disarm);
    return () => {
      window.removeEventListener("keydown", arm, true);
      window.removeEventListener("keyup", arm, true);
      window.removeEventListener("mousemove", arm, true);
      window.removeEventListener("blur", disarm);
    };
  }, []);
  return (
    <OpenLinkContext.Provider value={onOpenLink}>
      <div
        className={`chat-links ${armed ? "links-armed" : ""}`}
        // A click on a link never opens it: the press and release with Cmd
        // do, as in the terminal, since Chromium sends no click with Cmd held.
        onClickCapture={(event) => {
          if (!linkAt(event.target)) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onMouseDownCapture={(event) => {
          pressed.current = undefined;
          const href = linkAt(event.target);
          if (event.button !== 0 || !event.metaKey || !href) return;
          event.preventDefault();
          pressed.current = href;
        }}
        onMouseUpCapture={(event) => {
          const href = pressed.current;
          pressed.current = undefined;
          if (href && linkAt(event.target) === href) onOpenLink(href);
        }}
      >
        {children}
      </div>
    </OpenLinkContext.Provider>
  );
}

/** A message's first line of words, without markdown's marks. */
export function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const words = line.replace(/^[\s#>*\-]+/, "").replace(/[*_`]/g, "");
    // A heading alone says little; the line after it says more.
    if (words.trim() && !/^\s*#/.test(line)) return words.trim();
  }
  return (
    text
      .trim()
      .split("\n")[0]
      ?.replace(/^[\s#]+/, "") ?? ""
  );
}

/** `11:16` for today, `Mon` within a week, `Nov 20` before that. */
function day(at: string, now: number = Date.now()): string {
  const date = new Date(at);
  const age = now - date.getTime();
  if (new Date(now).toDateString() === date.toDateString()) return clock(at);
  return date.toLocaleDateString(
    [],
    age < 6 * 86_400_000
      ? { weekday: "short" }
      : { month: "short", day: "numeric" },
  );
}

const clock = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Something to do with one message, as an icon under it. */
interface MessageAction {
  key: string;
  /** What a screen reader calls it. */
  label: string;
  /** A few words, shown when the pointer rests on it. */
  tip: string;
  /** The shapes of its icon, drawn in a 16 by 16 box. */
  icon: React.ReactNode;
  run: () => void;
}

/**
 * The actions under a message, the same for every kind of message: icons
 * that show when the pointer is on the message, and always under the
 * latest one.
 */
function MessageActions({
  actions,
  shown,
}: {
  actions: readonly MessageAction[];
  shown: boolean;
}) {
  if (actions.length === 0) return null;
  return (
    <div className={`chat-actions ${shown ? "is-shown" : ""}`}>
      {actions.map((action) => (
        <button
          aria-label={action.label}
          className="chat-action"
          key={action.key}
          onClick={action.run}
          title={action.tip}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16">
            {action.icon}
          </svg>
        </button>
      ))}
    </div>
  );
}

/** Puts an agent's question off: the lengths to pick from, in a row. */
function SnoozeChoices({
  busy,
  onSnooze,
}: {
  busy: boolean;
  onSnooze: (until: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button
        className="chat-link"
        disabled={busy}
        onClick={() => setOpen(true)}
        title="Put this question off. It stops counting as waiting until then."
        type="button"
      >
        Snooze
      </button>
    );
  return (
    <span className="chat-snooze">
      Snooze for
      {snoozeChoices(new Date()).map((choice) => (
        <button
          className="chat-link"
          disabled={busy}
          key={choice.label}
          onClick={() => {
            setOpen(false);
            onSnooze(choice.until.toISOString());
          }}
          type="button"
        >
          {choice.label}
        </button>
      ))}
      <button
        aria-label="Do not snooze"
        className="chat-link"
        onClick={() => setOpen(false)}
        type="button"
      >
        ×
      </button>
    </span>
  );
}

function Message({
  busy,
  handle,
  item,
  onAskAbout,
  onPick,
  onTell,
  shownActions = false,
}: {
  /** Its actions show without hovering: it is the agent's latest message. */
  shownActions?: boolean;
  /** Starts a conversation with a copy about this message of the agent. */
  onAskAbout?: ((item: ChatItem) => void) | undefined;
  busy: boolean;
  handle: string;
  item: ChatItem;
  onPick: (threadId: number, option: number) => void;
  /** Puts a copy's answer in the typing box, to send to the agent. */
  onTell: (text: string) => void;
}) {
  const actions: MessageAction[] = [];
  if (onAskAbout && item.from === "agent" && item.id.startsWith("m:"))
    actions.push({
      key: "ask",
      label: `Ask about this without interrupting @${handle}`,
      tip: "Ask about this without interrupting",
      // One line of work, and a second that branches off it.
      icon: (
        <>
          <circle cx="4.5" cy="3.5" r="1.6" />
          <circle cx="4.5" cy="12.5" r="1.6" />
          <circle cx="11.5" cy="6" r="1.6" />
          <path d="M4.5 5.1v5.8M11.5 7.6c0 2.2-2.4 2.6-7 2.6" />
        </>
      ),
      run: () => onAskAbout(item),
    });
  if (item.from === "copy" && !item.pending)
    actions.push({
      key: "tell",
      label: `Send this answer to @${handle}`,
      tip: `Send to @${handle}`,
      // An arrow that turns and goes on: passed along.
      icon: <path d="M9.5 4.5 13 8l-3.5 3.5M13 8H6.5A3.5 3.5 0 0 0 3 11.5" />,
      run: () => onTell(item.text),
    });
  if (item.from === "you")
    return (
      <div className="chat-row is-you">
        <div className="chat-bubble">
          <MarkdownPreview source={item.text} />
        </div>
        <span className="chat-meta">
          {item.about && (
            <>
              about <q>{item.about}</q> ·{" "}
            </>
          )}
          {item.to === "agent" ? `to @${handle}` : "to a fork"} ·{" "}
          {clock(item.at)}
        </span>
      </div>
    );
  return (
    <div className={`chat-row is-${item.from}`}>
      <span className="chat-meta">
        <span className="chat-who">@{handle}</span>
        {item.from === "copy" && (
          <span
            className="chat-tag"
            title={`A read-only fork of @${handle} answered. @${handle} was not interrupted.`}
          >
            fork
          </span>
        )}
        {!item.pending && clock(item.at)}
      </span>
      {item.pending ? (
        <span aria-label="Answering" className="chat-typing">
          <i />
          <i />
          <i />
        </span>
      ) : (
        <div className="chat-text">
          <MarkdownPreview source={item.text} />
        </div>
      )}
      {item.details && (
        <details className="chat-details">
          <summary>Details</summary>
          <MarkdownPreview source={item.details} />
        </details>
      )}
      {item.options && (
        <div className="chat-options">
          {item.options.choices.map((choice, index) => (
            <button
              className="chat-option"
              disabled={busy}
              key={choice}
              onClick={() => onPick(item.options!.threadId, index)}
              type="button"
            >
              {choice}
            </button>
          ))}
        </div>
      )}
      <MessageActions actions={actions} shown={shownActions} />
    </div>
  );
}

type FoldRow = Extract<ChatRow, { kind: "fold" }>;

const count = (many: number, one: string) =>
  `${many} ${one}${many === 1 ? "" : "s"}`;

/** `14 tool calls, 2 messages`, leaving out what there is none of. */
export function foldCounts(row: FoldRow): string {
  return [
    row.turn?.toolCalls ? count(row.turn.toolCalls, "tool call") : "",
    row.hidden.length ? count(row.hidden.length, "message") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** A folded turn opened: its tool calls and interim messages, in order. */
function FoldBody({ row }: { row: FoldRow }) {
  const steps = row.turn?.steps ?? [];
  const left = (row.turn?.toolCalls ?? 0) - steps.length;
  const lines = [
    ...steps.map((step, index) => ({ at: step.at, step, index })),
    ...row.hidden.map((item, index) => ({ at: item.at, item, index })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.index - b.index);
  return (
    <>
      {left > 0 && (
        <div className="chat-step is-more">{left} earlier tool calls</div>
      )}
      {lines.map((line) =>
        "step" in line ? (
          <div
            className={`chat-step ${line.step.failed ? "is-failed" : ""}`}
            key={`s${line.index}`}
          >
            <b>{line.step.tool}</b>
            {line.step.detail && <code>{line.step.detail}</code>}
            {line.step.failed && <span>failed</span>}
            {line.step.durationMs !== null && line.step.durationMs >= 1000 && (
              <span>· {Math.round(line.step.durationMs / 1000)}s</span>
            )}
          </div>
        ) : (
          <div className="chat-fold-item" key={line.item.id}>
            <MarkdownPreview source={line.item.text} />
          </div>
        ),
      )}
    </>
  );
}

/** The part of a copy's answer meant for the agent, when it wrote one. */
function forAgent(answer: string): string {
  const marker = /(?:^|\n)\s*\**For main:?\**:?\s*/i.exec(answer);
  return marker
    ? answer.slice(marker.index + marker[0].length).trim() || answer
    : answer;
}

function Chat({
  chat,
  client,
  docked = false,
  onChange,
  onClose,
  onError,
  onFront,
  onMoveBack,
  onOpenSession,
  onOpenTab,
  onSent,
  onTab,
  onTerminal,
  live,
  liveOf,
  reloadThreads,
  renderTerminal,
  sent,
  shownTab,
  terminalRelease,
  threads,
  where,
  onWhere,
}: {
  /** Where the agent is in the Factory: the plan, the task, the step. */
  where?: readonly string[] | undefined;
  /** Shows that box on the Factory page. */
  onWhere?: (() => void) | undefined;
  /** What any session is doing now, for the marks on copies' answers. */
  liveOf?: ((sessionId: string) => AgentLive | undefined) | undefined;
  /** Draws the agent's terminal; without it the window has no Terminal view. */
  renderTerminal?: ((sessionId: string) => React.ReactNode) | undefined;
  /** Told while this window draws the terminal: it is drawn in one place. */
  onTerminal?: ((sessionId: string, shown: boolean) => void) | undefined;
  /** A new number asks this window to give the terminal up. */
  terminalRelease?: number | undefined;
  chat: ChatWindow;
  client: DesktopClient;
  /**
   * The part to show, when something outside picks it, such as the
   * sidebar's list of conversations. The chat then draws no tabs of its own.
   */
  shownTab?: ChatTabId | undefined;
  /** The chat moved to another part by itself: a question began one. */
  onTab?: ((tab: ChatTabId) => void) | undefined;
  /** What the agent is doing now, for the working line of its own chat. */
  live?: AgentLive | undefined;
  /** Fills its tab instead of floating: no dragging, sizing or closing. */
  docked?: boolean;
  /** Moves the chat to a tab of its own. */
  onOpenTab?: (() => void) | undefined;
  /** In a tab: moves the window back over the Factory, on this thread. */
  onMoveBack?: ((tab: ChatTabId) => void) | undefined;
  onChange: (change: Partial<ChatWindow>) => void;
  onClose: () => void;
  onError: (message: string) => void;
  onFront: () => void;
  onOpenSession: (sessionId: string) => void;
  onSent: (message: SentMessage) => void;
  reloadThreads: () => void;
  sent: readonly SentMessage[];
  threads: readonly ThreadDto[];
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const draft = chat.draft;
  useEffect(() => {
    if (!draft) return;
    setText(draft);
    onChange({ draft: undefined });
    // The draft is taken once; `onChange` is the page's and changes each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  /** The user's question, shown until the copy's transcript holds it. */
  const [asking, setAsking] = useState<string | null>(null);
  /** The thread `asking` went to, once the copy has it. */
  const [askedIn, setAskedIn] = useState<number | undefined>(undefined);
  const asks = threads
    .filter(
      (thread) => thread.sessionId === chat.sessionId && waitsOnUser(thread),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const open = openThreads(threads, chat.sessionId);
  const { names } = useConversationNames();
  const [ownTab, setOwnTab] = useState<ChatTabId>("agent");
  const picked = shownTab ?? ownTab;
  const setPicked = (next: ChatTabId) => {
    setOwnTab(next);
    onTab?.(next);
  };
  // A conversation that was closed falls back to the agent; one just asked
  // in is kept while the threads are read again.
  const tab: ChatTabId =
    typeof picked === "number" &&
    picked !== askedIn &&
    !open.some((thread) => thread.id === picked)
      ? "agent"
      : picked;
  const closed = closedThreads(threads, chat.sessionId);
  /** The thread shown, when it is one the agent began. */
  const own =
    typeof tab === "number"
      ? threads.find((thread) => thread.id === tab && isAgentThread(thread))
      : undefined;
  /** The agent's thread in which the user is talking with a fork first. */
  const [forkIn, setForkIn] = useState<number | undefined>(undefined);
  const viaFork = own !== undefined && forkIn === own.id;
  const { conversations, reload } = useConversations(
    client,
    threads,
    chat.sessionId,
    tab === "history",
  );
  // The terminal is Direct's other view: a fork is read-only, and an
  // agent's question is answered in words.
  const canTerminal = tab === "agent" && renderTerminal !== undefined;
  const terminalView = canTerminal && chat.view === "terminal";
  const terminalDrawn = terminalView && !chat.minimized;
  useEffect(() => {
    if (!terminalDrawn) return;
    onTerminal?.(chat.sessionId, true);
    return () => onTerminal?.(chat.sessionId, false);
    // `onTerminal` is the app's and changes each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalDrawn, chat.sessionId]);
  const released = useRef(terminalRelease);
  useEffect(() => {
    if (released.current === terminalRelease) return;
    released.current = terminalRelease;
    onChange({ view: "thread" });
    // `onChange` is the page's and changes each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalRelease]);
  /** The history row whose delete button was pressed once. */
  const [deleting, setDeleting] = useState<number | undefined>(undefined);
  // The agent's asks are answered in Direct, and each in its own thread.
  const waiting =
    tab === "agent" ? asks[0] : own && waitsOnUser(own) ? own : undefined;
  // Direct and the agent's own threads reach the agent; a fork is asked in
  // the user's threads, and in the agent's when the user wants to talk an
  // answer through first.
  const to: "agent" | "copy" =
    tab === "agent" || (own && !viaFork) ? "agent" : "copy";
  /** The conversation an instruction being written came out of. */
  const [toldFrom, setToldFrom] = useState<number | undefined>(undefined);
  const [menu, setMenu] = useState(false);
  // The menu closes on Escape and on a press anywhere outside it.
  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(false);
    };
    const onPress = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest?.(".chat-menu, .chat-pick"))
        setMenu(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPress, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPress, true);
    };
  }, [menu]);
  /** The agent's message a new conversation will be about. */
  const [about, setAbout] = useState<{ id: string; text: string } | undefined>(
    undefined,
  );
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const show = (next: ChatTabId) => {
    setPicked(next);
    setMenu(false);
  };
  const working = tab === "agent" && live?.state === "working";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [working]);
  const seen = useSeen();
  // The conversation on screen is read, and stays read once it leaves.
  const showing = typeof tab === "number" && !chat.minimized ? tab : undefined;
  useEffect(
    () => (showing === undefined ? undefined : showConversation(showing)),
    [showing],
  );
  const markOf = (thread: ThreadDto) => threadMark(thread, liveOf, seen);
  const { withdrawn, add: addWithdrawn } = useWithdrawn(chat.sessionId);
  /** Set when the user takes a question back while it is still being sent. */
  const takenBack = useRef(false);
  const main = useMainMessages(
    client,
    chat.sessionId,
    tab === "agent",
    working,
  );
  const turns = useTurns(client, chat.sessionId, tab === "agent", working);
  // The agent stops a moment before its answer can be read: the working row
  // stays for that moment, so the thread never looks stopped with no answer.
  const wasWorking = useRef(false);
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (working) {
      wasWorking.current = true;
      setSettling(false);
      return;
    }
    if (!wasWorking.current) return;
    wasWorking.current = false;
    setSettling(true);
    const timer = window.setTimeout(() => setSettling(false), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [working]);
  const items = chatItems({
    sessionId: chat.sessionId,
    threads,
    conversations,
    sent,
    withdrawn,
    tab,
    main,
  });
  const shown: ChatItem[] =
    asking !== null &&
    tab === (askedIn ?? "new") &&
    !items.some((item) => item.to === "copy" && item.text === asking)
      ? [
          ...items,
          {
            id: "asking",
            at: new Date().toISOString(),
            from: "you",
            text: asking,
            to: "copy",
          },
          {
            id: "asking-answer",
            at: new Date().toISOString(),
            from: "copy",
            text: "",
            pending: true,
            ...(askedIn === undefined ? {} : { threadId: askedIn }),
          },
        ]
      : items;
  const end = useRef<HTMLDivElement>(null);
  const last = shown.at(-1);
  const awaited = settling && tab === "agent" && last?.from === "you";
  // What the user just sent has not reached the agent's session yet: a new
  // agent is starting, a running one is about to pick it up.
  const sending =
    tab === "agent" &&
    !awaited &&
    !working &&
    last !== undefined &&
    last.id.startsWith("sent:") &&
    Date.now() - Date.parse(last.at) < SENDING_MS;
  const tail = `${shown.length}:${last?.id}:${last?.pending}:${last?.text.length}`;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [tail, chat.minimized]);

  const run = async (
    work: () => Promise<{ ok: boolean; error?: { message: string } }>,
  ) => {
    if (busy) return false;
    setBusy(true);
    try {
      const response = await work();
      if (!response.ok) onError(response.error?.message ?? "It did not go");
      else {
        reloadThreads();
        reload();
      }
      return response.ok;
    } finally {
      setBusy(false);
    }
  };
  /** Stops the copy on a question and leaves the question out of the chat. */
  const withdraw = async (threadId: number, question: string) => {
    addWithdrawn({
      threadId,
      text: question.trim(),
      at: new Date().toISOString(),
    });
    setAsking(null);
    const response = await client.request
      .threadStopAsk({ id: threadId })
      .catch(() => undefined);
    if (response && !response.ok) onError(response.error.message);
    reloadThreads();
    reload();
  };
  /** The question the copy has not begun to answer, when there is one. */
  const unanswered = (() => {
    const answer = shown.at(-1);
    const question = shown.at(-2);
    return answer?.pending && question?.from === "you" && question.to === "copy"
      ? { text: question.text, threadId: answer.threadId }
      : undefined;
  })();
  /**
   * Escape, as in an agent's own terminal: the copy stops, and the question
   * it had not begun to answer goes back in the typing box to change.
   */
  const takeBack = () => {
    if (!unanswered) return false;
    setText((typed) => (typed.trim() ? typed : unanswered.text));
    if (unanswered.threadId === undefined) {
      // Still being sent: stop it once the copy has it.
      takenBack.current = true;
      setAsking(null);
    } else void withdraw(unanswered.threadId, unanswered.text);
    return true;
  };
  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    if (to === "copy") {
      // A question outside a conversation starts one, with its own copy.
      const into = typeof tab === "number" ? tab : undefined;
      setAsking(value);
      setAskedIn(into);
      if (into === undefined) setPicked("new");
      setText("");
      takenBack.current = false;
      let asked: number | undefined;
      const ok = await run(async () => {
        const response = await client.request.threadAsk({
          sessionId: chat.sessionId,
          question: value,
          ...(into === undefined ? {} : { threadId: into }),
          ...(into === undefined && about ? { anchorId: about.id } : {}),
        });
        if (response.ok) setAbout(undefined);
        if (response.ok) {
          asked = response.data.id;
          setAskedIn(asked);
          setPicked(asked);
        }
        return response;
      });
      if (!ok) {
        setAsking(null);
        if (!takenBack.current) setText(value);
      } else if (takenBack.current && asked !== undefined)
        // Escape came while the question was on its way to the copy.
        await withdraw(asked, value);
      takenBack.current = false;
      return;
    }
    // In the agent's thread every message is part of it, asked or not.
    const into = own ?? waiting;
    const ok = into
      ? await run(() =>
          client.request.threadSay({
            id: into.id,
            body: value,
            option: null,
          }),
        )
      : await run(() =>
          client.request.agentSend({ id: chat.sessionId, text: value }),
        );
    if (!ok) return;
    if (!into)
      onSent({
        id: `sent:${Date.now()}`,
        sessionId: chat.sessionId,
        text: value,
        at: new Date().toISOString(),
        ...(toldFrom === undefined ? {} : { threadId: toldFrom }),
      });
    setText("");
    setToldFrom(undefined);
  };

  const drag = useRef<
    { x: number; y: number; left: number; top: number } | undefined
  >(undefined);
  const box = useRef<HTMLElement>(null);
  // The browser's own resize handle sizes the window; keep what it left.
  const keepSize = () => {
    const node = box.current;
    if (!node) return;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    if (width !== chat.width || height !== chat.height)
      onChange({ width, height });
  };
  const tabName = (which: ChatTabId): string =>
    which === "agent"
      ? "Direct"
      : which === "new"
        ? "New thread"
        : which === "history"
          ? "History"
          : nameOf(
              threads.find((thread) => thread.id === which),
              which,
            );
  const nameOf = (thread: ThreadDto | undefined, id: number) =>
    thread
      ? threadName(thread, names, conversations.get(id))
      : (names[id] ?? "Untitled");
  // The agent's question, answered above the typing box.
  const asked = waiting?.messages.filter(isMessage).at(-1);
  const rows: ChatRow[] =
    tab === "agent"
      ? foldTurns(shown, turns)
      : shown.map((item) => ({ kind: "item" as const, item }));
  /** The latest message that is not the user's: its actions always show. */
  const latestReply = rows
    .flatMap((row) => (row.kind === "item" ? [row.item] : []))
    .findLast((item) => item.from !== "you" && !item.pending)?.id;
  if (chat.minimized) return null;
  return (
    <section
      aria-label={`Threads with @${chat.handle}`}
      className={`chat-window ${docked ? "is-docked" : ""}`}
      onPointerDown={docked ? undefined : onFront}
      onPointerUp={docked ? undefined : keepSize}
      ref={box}
      style={
        docked
          ? undefined
          : {
              // Kept inside the page when it or the app's window shrinks.
              left: `clamp(0px, ${chat.x}px, calc(100% - ${chat.width}px - 4px))`,
              top: `clamp(0px, ${chat.y}px, calc(100% - 120px))`,
              width: chat.width,
              height: chat.height,
              zIndex: 10 + chat.order,
            }
      }
    >
      <header
        className="chat-head"
        onPointerDown={(event) => {
          if (docked || (event.target as HTMLElement).closest("button")) return;
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: chat.x,
            top: chat.y,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const from = drag.current;
          if (!from) return;
          const shell = box.current?.offsetParent as HTMLElement | null;
          const maxX = (shell?.clientWidth ?? 4000) - 80;
          const maxY = (shell?.clientHeight ?? 4000) - 40;
          onChange({
            x: Math.min(maxX, Math.max(0, from.left + event.clientX - from.x)),
            y: Math.min(maxY, Math.max(0, from.top + event.clientY - from.y)),
          });
        }}
        onPointerUp={() => (drag.current = undefined)}
      >
        <span className="chat-title">
          <button
            className="chat-agent"
            onClick={() => {
              // The agent's own conversation, as its terminal when this
              // window can draw it, else in the session's own tab.
              if (!renderTerminal) return onOpenSession(chat.sessionId);
              setPicked("agent");
              onChange({ view: "terminal" });
            }}
            title={
              renderTerminal
                ? `Show @${chat.handle}'s terminal`
                : `Open @${chat.handle}'s session`
            }
            type="button"
          >
            @{chat.handle}
          </button>
          <span
            className={`chat-kind ${tab === "agent" ? "is-agent" : ""} ${own && waiting ? "is-asks" : ""}`}
          >
            {tab === "agent"
              ? "Agent"
              : tab === "history"
                ? "Closed"
                : own
                  ? waiting
                    ? "Asks you"
                    : "Thread"
                  : "Fork"}
          </span>
          <button
            aria-expanded={menu}
            aria-haspopup="menu"
            className="chat-pick"
            onClick={() => setMenu((shown) => !shown)}
            title={`Threads with @${chat.handle}`}
            type="button"
          >
            <span>{tabName(tab)}</span>
            {open.some(
              (thread) =>
                thread.id !== tab &&
                (markOf(thread) === "unread" || markOf(thread) === "asks"),
            ) && (
              <span
                className="chat-unread-dot"
                title="Another thread has something new for you"
              />
            )}
            <svg aria-hidden="true" viewBox="0 0 16 16">
              <path d="M4.5 6.5l3.5 3.5 3.5-3.5" />
            </svg>
          </button>
          {menu && (
            <div className="chat-menu" role="menu">
              <button
                aria-checked={tab === "agent"}
                onClick={() => show("agent")}
                role="menuitemradio"
                type="button"
              >
                <span className="chat-kind is-agent">Agent</span>
                <span className="chat-menu-name">Direct</span>
                {asks.length > 0 && <small>asks you</small>}
              </button>
              {open.map((thread) => (
                <span className="chat-menu-row" key={thread.id}>
                  <button
                    aria-checked={tab === thread.id}
                    onClick={() => show(thread.id)}
                    role="menuitemradio"
                    type="button"
                  >
                    {isAgentThread(thread) ? (
                      <span
                        className={`chat-kind ${markOf(thread) === "asks" ? "is-asks" : ""}`}
                        title={`@${chat.handle} began this thread`}
                      >
                        {markOf(thread) === "asks" ? "?" : "Thread"}
                      </span>
                    ) : (
                      <span className="chat-kind">Fork</span>
                    )}
                    <span className="chat-menu-name">{tabName(thread.id)}</span>
                    {markOf(thread) === "asks" ? (
                      <small className="chat-unread">asks you</small>
                    ) : snoozed(thread, Date.now()) ? (
                      <small>snoozed</small>
                    ) : markOf(thread) === "unread" ? (
                      <small className="chat-unread">
                        <span className="chat-unread-dot" />
                        new answer
                      </small>
                    ) : markOf(thread) === "answering" ? (
                      <small>answering</small>
                    ) : (
                      sent.some(
                        (message) => message.threadId === thread.id,
                      ) && <small>sent ✓</small>
                    )}
                  </button>
                  <button
                    aria-label={`Close ${tabName(thread.id)}`}
                    className="chat-menu-close"
                    onClick={() => {
                      if (tab === thread.id) setPicked("agent");
                      void run(() =>
                        isAgentThread(thread)
                          ? client.request.threadResolve({ id: thread.id })
                          : client.request.threadCloseConversation({
                              id: thread.id,
                            }),
                      );
                    }}
                    title={
                      isAgentThread(thread)
                        ? `Resolve this thread. It goes to History and @${chat.handle} is told.`
                        : "Close this thread. It goes to History."
                    }
                    type="button"
                  >
                    ×
                  </button>
                </span>
              ))}
              <button onClick={() => show("new")} role="menuitem" type="button">
                <span className="chat-menu-name">
                  + Ask something else, without interrupting
                </span>
              </button>
              {closed.length > 0 && (
                <button
                  aria-checked={tab === "history"}
                  onClick={() => show("history")}
                  role="menuitemradio"
                  type="button"
                >
                  <span className="chat-menu-name">History</span>
                  <small>{closed.length}</small>
                </button>
              )}
            </div>
          )}
        </span>
        {canTerminal && (
          <div
            aria-label={`What to show of @${chat.handle}`}
            className="chat-views"
            role="radiogroup"
          >
            {(["thread", "terminal"] as const).map((view) => (
              <button
                aria-checked={terminalView === (view === "terminal")}
                key={view}
                onClick={() => onChange({ view })}
                role="radio"
                title={
                  view === "thread"
                    ? `@${chat.handle}'s messages`
                    : `@${chat.handle}'s terminal`
                }
                type="button"
              >
                {view === "thread" ? "Thread" : "Terminal"}
              </button>
            ))}
          </div>
        )}
        {docked && onMoveBack && (
          <button
            aria-label="Move back to the Factory"
            className="chat-icon"
            onClick={() => onMoveBack(tab)}
            title="Move back to the Factory, as a window over it"
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16">
              <path d="M9.5 12.5h-6v-6M3.5 12.5l7-7M12.5 9.5v-6h-6" />
            </svg>
          </button>
        )}
        {!docked && (
          <>
            {onOpenTab && (
              <button
                aria-label="Open as a tab"
                className="chat-icon"
                onClick={onOpenTab}
                title="Open as a tab"
                type="button"
              >
                <svg aria-hidden="true" viewBox="0 0 16 16">
                  <path d="M6.5 3.5h6v6M12.5 3.5l-7 7M3.5 6.5v6h6" />
                </svg>
              </button>
            )}
            <button
              aria-label="Minimize"
              className="chat-icon"
              onClick={() => onChange({ minimized: true })}
              title="Minimize to the bar below"
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <path d="M3.5 11.5h9" />
              </svg>
            </button>
            <button
              aria-label="Close"
              className="chat-icon"
              // As closing its tab does: the window leaves the screen and
              // every thread stays in the list. A thread is put away from
              // the list, with its ×.
              onClick={onClose}
              title="Close the window. Its threads stay in the list."
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </>
        )}
      </header>
      {where && where.length > 0 && (
        <button
          className="chat-where"
          disabled={!onWhere}
          onClick={onWhere}
          title="Show this box in the Factory"
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16">
            <path d="M1.5 6h4v4h-4zM10.5 6h4v4h-4zM5.5 8h5" />
          </svg>
          {where.map((label, index) => (
            <span className="chat-where-part" key={`${index}:${label}`}>
              {index > 0 && <span aria-hidden="true">›</span>}
              <span>{label}</span>
            </span>
          ))}
          {onWhere && (
            <span className="chat-where-go">Show in the Factory</span>
          )}
        </button>
      )}
      {terminalDrawn && (
        <div className="chat-terminal-stage">
          {renderTerminal?.(chat.sessionId)}
        </div>
      )}
      {/* Hidden, not removed, so the thread is where it was on the way back. */}
      <div className="chat-thread" hidden={terminalView}>
        {tab !== "agent" && tab !== "history" && (!own || viaFork) && (
          <p className="chat-note">
            A read-only fork answers here. @{chat.handle} keeps working and does
            not see this.
          </p>
        )}
        <div className="chat-stream">
          {tab === "history" &&
            (closed.length === 0 ? (
              <p className="chat-empty">
                No closed threads. Closing one puts it here.
              </p>
            ) : (
              <ul className="chat-history">
                {closed.map((thread) => {
                  const mine = isAgentThread(thread);
                  const last = mine
                    ? thread.messages.filter(isMessage).at(-1)?.body
                    : (conversations.get(thread.id) ?? []).findLast(
                        (message) => message.role === "agent",
                      )?.text;
                  return (
                    <li key={thread.id}>
                      <button
                        className="chat-history-open"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            mine
                              ? client.request.threadReopen({ id: thread.id })
                              : client.request.threadReopenConversation({
                                  id: thread.id,
                                }),
                          ).then((ok) => {
                            if (ok) show(thread.id);
                          })
                        }
                        title={
                          mine
                            ? `Reopen this thread. @${chat.handle} is told.`
                            : "Reopen this thread"
                        }
                        type="button"
                      >
                        <b>{tabName(thread.id)}</b>
                        <span>{last ? firstLine(last) : ""}</span>
                        <time dateTime={putAwayAt(thread)}>
                          {day(putAwayAt(thread))}
                        </time>
                      </button>
                      {/* A resolved thread of the agent's is kept: it is its record. */}
                      <button
                        hidden={mine}
                        aria-label={`Delete ${tabName(thread.id)}`}
                        className={`chat-history-delete ${deleting === thread.id ? "is-armed" : ""}`}
                        disabled={busy}
                        onBlur={() => setDeleting(undefined)}
                        onClick={() => {
                          if (deleting !== thread.id) {
                            setDeleting(thread.id);
                            return;
                          }
                          setDeleting(undefined);
                          void run(() =>
                            client.request.threadResolve({ id: thread.id }),
                          );
                        }}
                        title={
                          deleting === thread.id
                            ? "Click again to delete it for good"
                            : "Delete this thread"
                        }
                        type="button"
                      >
                        {deleting === thread.id ? "Delete?" : "×"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ))}
          {tab !== "history" && shown.length === 0 && (
            <p className="chat-empty">
              {tab === "agent"
                ? `What @${chat.handle} asks you and what you tell it shows here. Ask a question to start a thread with a fork of it.`
                : `Ask @${chat.handle} anything about this work. A fork of it answers right away and @${chat.handle} keeps working.`}
            </p>
          )}
          {rows.map((row) =>
            row.kind === "fold" ? (
              <div className="chat-fold" key={row.id}>
                <button
                  aria-expanded={unfolded.has(row.id)}
                  onClick={() =>
                    setUnfolded((before) => {
                      const next = new Set(before);
                      if (!next.delete(row.id)) next.add(row.id);
                      return next;
                    })
                  }
                  type="button"
                >
                  <svg aria-hidden="true" viewBox="0 0 16 16">
                    <path d="M6 4.5l3.5 3.5L6 11.5" />
                  </svg>
                  <b>Worked for {elapsed(row.startedAt, row.endedAt)}</b>
                  <span>· {foldCounts(row)}</span>
                </button>
                {unfolded.has(row.id) && <FoldBody row={row} />}
              </div>
            ) : row.kind === "files" ? (
              <div className="chat-files" key={row.id}>
                {row.files.map((file) => (
                  <span className="chat-file" key={file} title={file}>
                    {file.split("/").slice(-2).join("/")}
                  </span>
                ))}
              </div>
            ) : (
              <Message
                busy={busy}
                handle={chat.handle}
                item={
                  asked && row.item.options
                    ? { ...row.item, options: undefined }
                    : row.item
                }
                key={row.item.id}
                shownActions={row.item.id === latestReply}
                onPick={(threadId, option) =>
                  void run(() =>
                    client.request.threadSay({
                      id: threadId,
                      body: null,
                      option,
                    }),
                  )
                }
                onAskAbout={
                  tab === "agent"
                    ? (item) => {
                        setAbout({ id: item.id.slice(2), text: item.text });
                        setPicked("new");
                      }
                    : undefined
                }
                onTell={(answer) => {
                  setText(forAgent(answer));
                  // In the agent's thread the answer goes back to that thread.
                  if (own) {
                    setForkIn(undefined);
                    return;
                  }
                  setToldFrom(typeof tab === "number" ? tab : undefined);
                  setPicked("agent");
                }}
              />
            ),
          )}
          {sending && (
            <div className="chat-working">
              <span aria-hidden="true" className="chat-spin" />
              <span>
                {main.length === 0 ? `Starting @${chat.handle}` : "Working"}
              </span>
            </div>
          )}
          {awaited && (
            <div className="chat-working">
              <span aria-hidden="true" className="chat-spin" />
              <span>Working</span>
            </div>
          )}
          {working && live && (
            <div className="chat-working">
              <span aria-hidden="true" className="chat-spin" />
              {live.detail ? <code>{live.detail}</code> : <span>Working</span>}
              <span className="chat-working-time">
                {elapsed(live.since, now)}
              </span>
            </div>
          )}
          {tab === "agent" &&
            (live?.state === "needs_permission" ||
              live?.state === "needs_input") && (
              // The question and its choices are drawn in the terminal, where
              // they are answered; without this line the thread looks stopped.
              <div className="chat-working is-asking" role="status">
                <span aria-hidden="true" className="chat-ask-dot" />
                {live.state === "needs_permission" ? (
                  <span>
                    @{chat.handle} asks for permission
                    {live.detail ? ": " : ""}
                    {live.detail && <code>{live.detail}</code>}
                  </span>
                ) : (
                  <span>
                    @{chat.handle} waits for your answer
                    {live.detail ? `: ${live.detail}` : ""}
                  </span>
                )}
                {canTerminal && (
                  <button
                    className="chat-ask-go"
                    onClick={() => onChange({ view: "terminal" })}
                    type="button"
                  >
                    Answer in its terminal
                  </button>
                )}
                <span className="chat-working-time">
                  {elapsed(live.since, now)}
                </span>
              </div>
            )}
          <div ref={end} />
        </div>
        {asked && waiting && (
          <div className="chat-question">
            <MarkdownPreview source={asked.body || waiting.title} />
            <span className="chat-meta">
              @{chat.handle} asks you · waiting{" "}
              {elapsed(asked.createdAt, Date.now())} ·{" "}
              <SnoozeChoices
                busy={busy}
                onSnooze={(until) =>
                  void run(() =>
                    client.request.threadSnooze({ id: waiting.id, until }),
                  )
                }
              />
            </span>
            {asked.options.length > 0 && (
              <div className="chat-options">
                {asked.options.map((choice, index) => (
                  <button
                    className="chat-option"
                    disabled={busy}
                    key={choice}
                    onClick={() =>
                      void run(() =>
                        client.request.threadSay({
                          id: waiting.id,
                          body: null,
                          option: index,
                        }),
                      )
                    }
                    type="button"
                  >
                    {choice}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "new" && about && (
          <div className="chat-about">
            <span>
              About: <q>{firstLine(about.text)}</q>
            </span>
            <button
              aria-label="Ask about no message in particular"
              onClick={() => setAbout(undefined)}
              title="Ask about no message in particular"
              type="button"
            >
              ×
            </button>
          </div>
        )}
        <footer className="chat-foot" hidden={tab === "history"}>
          <textarea
            aria-label={`Message @${chat.handle}`}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              } else if (event.key === "Escape" && takeBack()) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            placeholder={
              to === "copy"
                ? "Ask the fork…"
                : waiting
                  ? "Or write your own answer…"
                  : own
                    ? `Write to @${chat.handle} in this thread…`
                    : working
                      ? `Queue another message for @${chat.handle}…`
                      : `Tell @${chat.handle} what to do…`
            }
            rows={Math.min(6, Math.max(1, text.split("\n").length))}
            value={text}
          />
          <div className="chat-foot-row">
            {working && !text.trim() && (
              <button
                aria-label={`Stop @${chat.handle}`}
                className="chat-send is-stop"
                onClick={() =>
                  void run(() =>
                    client.request.agentInterrupt({ id: chat.sessionId }),
                  )
                }
                title={`Stop what @${chat.handle} is doing`}
                type="button"
              >
                <svg aria-hidden="true" viewBox="0 0 16 16">
                  <rect height="6" rx="1" width="6" x="5" y="5" />
                </svg>
              </button>
            )}
            {working && !text.trim() ? null : unanswered && !text.trim() ? (
              <button
                aria-label="Stop and change the question"
                className="chat-send is-stop"
                onClick={takeBack}
                title="Stop the fork and change your question (Esc)"
                type="button"
              >
                <svg aria-hidden="true" viewBox="0 0 16 16">
                  <rect height="6" rx="1" width="6" x="5" y="5" />
                </svg>
              </button>
            ) : (
              <button
                aria-label={to === "copy" ? "Ask" : waiting ? "Answer" : "Send"}
                className="chat-send"
                disabled={busy || !text.trim()}
                onClick={() => void send()}
                title={to === "copy" ? "Ask" : waiting ? "Answer" : "Send"}
                type="button"
              >
                <svg aria-hidden="true" viewBox="0 0 16 16">
                  <path d="M8 12.5v-9M4 7.5l4-4 4 4" />
                </svg>
              </button>
            )}
          </div>
        </footer>
        <p className="chat-hint">
          {tab === "history" ? (
            "Click a thread to reopen it."
          ) : unanswered ? (
            "Esc stops the fork and puts your question back to change."
          ) : own && viaFork ? (
            <>
              A fork of @{chat.handle} answers; @{chat.handle} does not see it.{" "}
              <button
                className="chat-link"
                onClick={() => setForkIn(undefined)}
                type="button"
              >
                Answer @{chat.handle} →
              </button>
            </>
          ) : own && snoozed(own, Date.now()) ? (
            <>
              Snoozed until {day(own.snoozedUntil!)}.{" "}
              <button
                className="chat-link"
                onClick={() =>
                  void run(() =>
                    client.request.threadSnooze({ id: own.id, until: null }),
                  )
                }
                type="button"
              >
                Unsnooze
              </button>
            </>
          ) : own ? (
            <>
              {waiting
                ? `Your answer goes to @${chat.handle} itself.`
                : `Goes to @${chat.handle} itself, in this thread.`}{" "}
              <button
                className="chat-link"
                onClick={() => setForkIn(own.id)}
                title={`Ask a read-only fork of @${chat.handle} about this before you answer. @${chat.handle} is not interrupted.`}
                type="button"
              >
                Talk it through with a fork first →
              </button>
            </>
          ) : to === "copy" ? (
            "Esc takes back a question the fork has not started to answer."
          ) : (
            <>
              {live?.step ? `${live.step} · ` : ""}
              {waiting
                ? `Your answer goes to @${chat.handle} itself.`
                : `Goes to @${chat.handle} itself, at its next turn.`}{" "}
              <button
                className="chat-link"
                onClick={() => show("new")}
                type="button"
              >
                Ask without interrupting →
              </button>
            </>
          )}
        </p>
      </div>
    </section>
  );
}

/** Where a new window opens: stepped down and right from the last one. */
export function placeChat(
  open: readonly ChatWindow[],
  agent: FactoryAgent,
  about: string,
): ChatWindow {
  // Each one stepped down and right of the last, so every header shows.
  const step = open.length % 6;
  return {
    ...agent,
    about,
    x: 40 + step * 36,
    y: 72 + step * 32,
    width: CHAT_WIDTH,
    height: CHAT_HEIGHT,
    minimized: false,
    order: Math.max(0, ...open.map((chat) => chat.order)) + 1,
  };
}

/** The floating chats and, at the bottom, the dock. */
export function FactoryChats({
  agents,
  chats,
  client,
  onChats,
  onError,
  onOpenChat,
  onOpenSession,
  onShowBox,
  whereOf,
  live,
  onOpenTab,
  onTerminal,
  reloadThreads,
  renderTerminal,
  terminalRelease,
  threads,
}: {
  /** What an agent is doing now, by session. */
  live?: ((sessionId: string) => AgentLive | undefined) | undefined;
  renderTerminal?: ((sessionId: string) => React.ReactNode) | undefined;
  onTerminal?: ((sessionId: string, shown: boolean) => void) | undefined;
  /** Asks one agent's window to give its terminal up; `nonce` asks again. */
  terminalRelease?: { sessionId: string; nonce: number } | undefined;
  /** Moves a chat to a tab of its own; absent where there are no tabs. */
  onOpenTab?: ((chat: ChatWindow) => void) | undefined;
  /** The agents on the page, for a chat an ask opens from the dock. */
  agents: readonly FactoryAgent[];
  chats: readonly ChatWindow[];
  client: DesktopClient;
  onChats: (next: ChatWindow[]) => void;
  onError: (message: string) => void;
  onOpenChat: (agent: FactoryAgent, about: string) => void;
  onOpenSession: (sessionId: string) => void;
  /** Where an agent is on the page, as names from the plan down. */
  whereOf?: ((sessionId: string) => readonly string[] | undefined) | undefined;
  /** Shows an agent's box on the page. */
  onShowBox?: ((sessionId: string) => void) | undefined;
  reloadThreads: () => void;
  threads: readonly ThreadDto[];
}) {
  const { sent, add: addSent } = useSent();
  const seen = useSeen();
  /** Whether a copy of the agent has an answer the user has not seen. */
  const unread = (sessionId: string) =>
    openThreads(threads, sessionId).some(
      (thread) =>
        conversationMark(thread.id, copyState(thread, live), seen) === "unread",
    );
  const waiting = waitingBySession(threads);
  const front = Math.max(0, ...chats.map((chat) => chat.order));
  const change = (sessionId: string, patch: Partial<ChatWindow>) =>
    onChats(
      chats.map((chat) =>
        chat.sessionId === sessionId ? { ...chat, ...patch } : chat,
      ),
    );
  // In the dock: minimized chats, and agents that wait for the user with no
  // chat open, so an ask is seen without looking for its box.
  const minimized = chats.filter((chat) => chat.minimized);
  const knocking = [...waiting.keys()]
    .filter((sessionId) => !chats.some((chat) => chat.sessionId === sessionId))
    .map((sessionId) => ({
      sessionId,
      handle:
        agents.find((agent) => agent.sessionId === sessionId)?.handle ??
        threads.find((thread) => thread.sessionId === sessionId)?.sessionName ??
        "agent",
    }));
  return (
    <>
      {chats.map((chat) => (
        <Chat
          chat={chat}
          client={client}
          key={chat.sessionId}
          onWhere={onShowBox ? () => onShowBox(chat.sessionId) : undefined}
          where={whereOf?.(chat.sessionId)}
          onChange={(patch) => change(chat.sessionId, patch)}
          onClose={() =>
            onChats(chats.filter((one) => one.sessionId !== chat.sessionId))
          }
          onError={onError}
          onFront={() => {
            if (chat.order !== front)
              change(chat.sessionId, { order: front + 1 });
          }}
          onOpenSession={onOpenSession}
          onOpenTab={
            onOpenTab
              ? () => {
                  onOpenTab(chat);
                  onChats(
                    chats.filter((one) => one.sessionId !== chat.sessionId),
                  );
                }
              : undefined
          }
          live={live?.(chat.sessionId)}
          liveOf={live}
          onSent={addSent}
          onTab={(tab) => change(chat.sessionId, { tab })}
          onTerminal={onTerminal}
          renderTerminal={renderTerminal}
          terminalRelease={
            terminalRelease?.sessionId === chat.sessionId
              ? terminalRelease.nonce
              : undefined
          }
          reloadThreads={reloadThreads}
          shownTab={chat.tab ?? "agent"}
          sent={sent}
          threads={threads}
        />
      ))}
      {(minimized.length > 0 || knocking.length > 0) && (
        <nav aria-label="Threads" className="chat-dock">
          {knocking.map((agent) => {
            const state = waiting.get(agent.sessionId)!;
            return (
              <button
                className={`chat-chip is-waiting ${state.blocking ? "is-blocking" : ""}`}
                key={agent.sessionId}
                onClick={() => onOpenChat(agent, `@${agent.handle}`)}
                title={
                  state.blocking
                    ? `@${agent.handle} is stopped until you answer`
                    : `@${agent.handle} asks you something`
                }
                type="button"
              >
                <span className="chat-chip-dot" />@{agent.handle}
                <span className="chat-badge">{state.count}</span>
              </button>
            );
          })}
          {minimized.map((chat) => {
            const state = waiting.get(chat.sessionId);
            return (
              <button
                className={`chat-chip ${state ? "is-waiting" : ""} ${state?.blocking ? "is-blocking" : ""}`}
                key={chat.sessionId}
                onClick={() =>
                  change(chat.sessionId, {
                    minimized: false,
                    order: front + 1,
                  })
                }
                type="button"
              >
                {!state && unread(chat.sessionId) && (
                  <span
                    className="chat-unread-dot"
                    title="A fork has a new answer"
                  />
                )}
                @{chat.handle}
                {state && <span className="chat-badge">{state.count}</span>}
              </button>
            );
          })}
        </nav>
      )}
    </>
  );
}

/** Where an agent is in the Factory, read while its tab shows. */
function useWhere(
  client: DesktopClient,
  workspaceId: string,
  sessionId: string,
) {
  const [labels, setLabels] = useState<readonly string[]>();
  useEffect(() => {
    let stale = false;
    const read = () =>
      void client.request.factoryView({ workspace: workspaceId }).then(
        (response) => {
          if (!stale && response.ok)
            setLabels(factoryWhere(response.data, sessionId)?.labels);
        },
        () => undefined,
      );
    read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, REFRESH_MS);
    return () => {
      stale = true;
      window.clearInterval(timer);
    };
  }, [client, sessionId, workspaceId]);
  return labels;
}

/** One agent's chat filling a tab of the workspace. */
export function ChatTab({
  client,
  handle,
  onError,
  onOpenLink,
  live,
  liveOf,
  onMoveBack,
  onOpenSession,
  onShowBox,
  onTerminal,
  renderTerminal,
  request,
  sessionId,
  terminalRelease,
  workspaceId,
}: {
  /** Opens the Factory on the agent's box. */
  onShowBox?: (() => void) | undefined;
  /** A thread, and a view of Direct, to show; a new `nonce` asks again. */
  request?:
    | {
        tab: ChatTabId;
        view?: "thread" | "terminal" | undefined;
        nonce: number;
      }
    | undefined;
  /** Moves the window back over the Factory, on the thread and view shown. */
  onMoveBack?:
    ((tab: ChatTabId, view: "thread" | "terminal") => void) | undefined;
  live?: AgentLive | undefined;
  liveOf?: ((sessionId: string) => AgentLive | undefined) | undefined;
  renderTerminal?: ((sessionId: string) => React.ReactNode) | undefined;
  onTerminal?: ((sessionId: string, shown: boolean) => void) | undefined;
  terminalRelease?: number | undefined;
  client: DesktopClient;
  handle: string;
  onError: (message: string) => void;
  /** Opens a link in a message, as a session's terminal does. */
  onOpenLink: (url: string) => void;
  onOpenSession: (sessionId: string) => void;
  sessionId: string;
  workspaceId: string;
}) {
  const { threads, reload } = useWorkspaceThreads(client, workspaceId);
  const { sent, add: addSent } = useSent();
  const where = useWhere(client, workspaceId, sessionId);
  const [tab, setTab] = useState<ChatTabId>(request?.tab ?? "agent");
  const [view, setView] = useState<"thread" | "terminal">(
    request?.view ?? "thread",
  );
  const asked = useRef(request?.nonce);
  useEffect(() => {
    if (!request || asked.current === request.nonce) return;
    asked.current = request.nonce;
    setTab(request.tab);
    if (request.view) setView(request.view);
  }, [request]);
  return (
    <div className="factory-shell chat-tab">
      <ChatLinks onOpenLink={onOpenLink}>
        <Chat
          chat={{
            sessionId,
            handle,
            about: "",
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            minimized: false,
            order: 0,
            view,
          }}
          client={client}
          docked
          onWhere={onShowBox}
          where={where}
          onChange={(patch) => {
            if (patch.view) setView(patch.view);
          }}
          onMoveBack={
            onMoveBack ? (shown) => onMoveBack(shown, view) : undefined
          }
          onTerminal={onTerminal}
          renderTerminal={renderTerminal}
          terminalRelease={terminalRelease}
          onClose={() => undefined}
          onError={onError}
          onFront={() => undefined}
          onOpenSession={onOpenSession}
          live={live}
          liveOf={liveOf}
          onSent={addSent}
          onTab={setTab}
          reloadThreads={reload}
          shownTab={tab}
          sent={sent}
          threads={threads}
        />
      </ChatLinks>
    </div>
  );
}

import type { UUID } from "./index";

/**
 * A conversation is a log of append-only messages with a cursor per
 * participant. A `channel` is a team's chat: many participants, messages
 * routed by `@tags`, never resolved. A `thread` is between an agent and the
 * user: it hangs off a line in the agent's main, and is resolved and reopened.
 */
export type ConversationKind = "channel" | "thread";

/**
 * Who wrote a message or reads a conversation. In a channel: `lead`, `user`
 * or a member's handle. In a thread: `agent` (its owner), `user` or `lead`
 * (the owner's lead). `daedalus` writes notices and reads nothing.
 */
export type Participant = string;

export const USER = "user";
export const AGENT = "agent";
export const LEAD = "lead";
export const DAEDALUS = "daedalus";

/**
 * `message` is what someone wrote. `notice` records an event (a thread
 * blocked, resolved or reopened) and is never delivered to whoever caused
 * it. `handback` is a channel note that a member's turn ended; `waiting`
 * says a member stopped to wait on the user.
 */
export type MessageKind = "message" | "notice" | "handback" | "waiting";

export interface Message {
  id: number;
  conversationId: number;
  author: Participant;
  kind: MessageKind;
  body: string;
  /** Folded under the body: ids, logs, links. */
  details: string | null;
  /** Choices the reader can pick from. */
  options: string[];
  /** On a reply that picked one: its index in the latest offered options. */
  picked: number | null;
  /** In a channel, the handles it was pushed to. */
  tags: string[];
  createdAt: string;
}

/** What one participant has read and been brought in one conversation. */
export interface Cursor {
  conversationId: number;
  participant: Participant;
  /** The last message it read. */
  readThrough: number;
  /**
   * The last message that tags it and that it read with `channel read
   * --tagged`. Messages up to `readThrough` count as read whatever this is.
   */
  taggedReadThrough: number;
  /** The last message Daedalus brought it. */
  deliveredThrough: number;
  /** When the last delivery reached it. */
  deliveredAt: string | null;
  /** Why the last delivery failed, or null after one succeeded. */
  lastError: string | null;
  lastAttemptAt: string | null;
}

/** A team's chat. Its name is the team's. */
export interface Channel {
  id: number;
  workspaceId: string;
  /** The lead's orchestration ability id. */
  teamId: UUID;
  createdAt: string;
  updatedAt: string;
}

/** Who resolved a thread. */
export type Resolver =
  typeof USER | typeof AGENT | typeof LEAD | typeof DAEDALUS;

export interface Thread {
  id: number;
  /** The user-facing `#n`. */
  number: number;
  workspaceId: string;
  ownerSessionId: UUID;
  /** The subject: the first message, shortened, or the anchor's first line. */
  title: string;
  /**
   * The line in the owner's main the thread hangs off: its id in the
   * agent's transcript and a copy of its text. Null when there was none.
   */
  anchorId: string | null;
  anchorText: string | null;
  /** The plan it is pinned to (absolute path) and the task's `^id`. */
  planPath: string | null;
  taskKey: string | null;
  /** A read-only fork of the owner the user talks the thread through with. */
  forkSessionId: string | null;
  /** When that fork last finished a turn: its latest answer. */
  forkAnsweredAt: string | null;
  /**
   * When the user put the conversation away. It is then in its owner's
   * history: out of the list, every message kept, reopened at will.
   */
  closedAt: string | null;
  /** When the owner said it is blocked on it; cleared by the next reply. */
  blockedAt: string | null;
  /** Put off by the user until then. */
  snoozedUntil: string | null;
  resolvedAt: string | null;
  resolvedBy: Resolver | null;
  createdAt: string;
  updatedAt: string;
}

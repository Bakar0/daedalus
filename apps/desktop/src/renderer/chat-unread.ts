/**
 * Which answers from an agent's copies the user has not seen. A copy that
 * finishes a turn has answered; the answer is unread until the conversation
 * is on screen. Kept in the browser's storage, so it is per machine.
 */
import { useSyncExternalStore } from "react";

const KEY = "daedalus.factory.seen";

export interface SeenState {
  /** Answers from before this moment are read: the mark did not exist yet. */
  since: string;
  /** When each conversation was last on screen, by thread id. */
  seen: Readonly<Record<string, string>>;
  /** The conversations on screen now. */
  showing: ReadonlySet<number>;
}

function load(): SeenState {
  const fresh = (): SeenState => ({
    since: new Date().toISOString(),
    seen: {},
    showing: new Set(),
  });
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as {
      since?: unknown;
      seen?: unknown;
    } | null;
    if (
      stored &&
      typeof stored.since === "string" &&
      stored.seen &&
      typeof stored.seen === "object"
    )
      return {
        since: stored.since,
        seen: stored.seen as Record<string, string>,
        showing: new Set(),
      };
  } catch {
    // Unreadable storage starts over.
  }
  const state = fresh();
  save(state);
  return state;
}

function save(state: SeenState): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ since: state.since, seen: state.seen }),
    );
  } catch {
    // Without storage it holds until the page reloads.
  }
}

let state: SeenState | undefined;
const listeners = new Set<() => void>();
const current = () => (state ??= load());
const change = (next: SeenState, keep: boolean) => {
  state = next;
  if (keep) save(next);
  for (const listener of listeners) listener();
};

/**
 * Says a conversation is on screen until the returned function is called.
 * It counts as read while it shows and from the moment it stops showing.
 */
export function showConversation(threadId: number): () => void {
  const before = current();
  change({ ...before, showing: new Set(before.showing).add(threadId) }, false);
  return () => {
    const now = current();
    const showing = new Set(now.showing);
    showing.delete(threadId);
    change(
      {
        ...now,
        showing,
        seen: { ...now.seen, [threadId]: new Date().toISOString() },
      },
      true,
    );
  };
}

/** Where there is no browser, nothing is unread. */
const NOTHING: SeenState = {
  since: "9999-12-31T00:00:00.000Z",
  seen: {},
  showing: new Set(),
};

export function useSeen(): SeenState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current,
    () => NOTHING,
  );
}

/**
 * What a conversation's copy is doing: what its hooks last reported, or,
 * once the copy has stopped and reports nothing, when it last answered.
 */
export function copyState(
  thread: { forkSessionId: string | null; forkAnsweredAt: string | null },
  liveOf: ((sessionId: string) => CopyState | undefined) | undefined,
): CopyState | undefined {
  const live = thread.forkSessionId
    ? liveOf?.(thread.forkSessionId)
    : undefined;
  if (live && (live.state === "working" || !thread.forkAnsweredAt)) return live;
  return thread.forkAnsweredAt
    ? { state: "done", since: thread.forkAnsweredAt }
    : live;
}

export interface CopyState {
  state: string;
  since: string;
}

/** A conversation nobody touched for this long goes to its history. */
export const CONVERSATION_IDLE_MS = 24 * 60 * 60_000;

/**
 * Whether a listed conversation has sat untouched long enough to be put
 * away: nothing asked, answered or looked at for a day, and nothing unread.
 */
export function isStale(
  thread: {
    id: number;
    createdAt: string;
    updatedAt: string;
    forkAnsweredAt: string | null;
  },
  mark: "answering" | "unread" | "read",
  seen: SeenState,
  now: number,
): boolean {
  if (mark !== "read" || seen.showing.has(thread.id)) return false;
  const touched = Math.max(
    Date.parse(thread.createdAt),
    Date.parse(thread.updatedAt),
    thread.forkAnsweredAt ? Date.parse(thread.forkAnsweredAt) : 0,
    seen.seen[thread.id] ? Date.parse(seen.seen[thread.id]!) : 0,
  );
  return now - touched > CONVERSATION_IDLE_MS;
}

/**
 * Where a conversation with a copy stands for the user: the copy is
 * `answering`, its answer is `unread`, or there is nothing new (`read`).
 * `copy` is what the copy's session is doing, as its hooks last reported.
 */
export function conversationMark(
  threadId: number,
  copy: { state: string; since: string } | undefined,
  seen: SeenState,
): "answering" | "unread" | "read" {
  if (!copy) return "read";
  if (copy.state === "working") return "answering";
  // A copy that only started is `idle`: it has said nothing yet.
  if (copy.state === "idle" || copy.state === "unknown") return "read";
  if (seen.showing.has(threadId)) return "read";
  return Date.parse(copy.since) > Date.parse(seen.seen[threadId] ?? seen.since)
    ? "unread"
    : "read";
}

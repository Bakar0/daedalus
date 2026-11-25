import { expect, test } from "bun:test";
import {
  conversationMark,
  copyState,
  isStale,
  type SeenState,
} from "./chat-unread";

const seen = (more: Partial<SeenState> = {}): SeenState => ({
  since: "2026-11-24T10:00:00Z",
  seen: {},
  showing: new Set(),
  ...more,
});
const done = (since: string) => ({ state: "done", since });

test("a copy at work is answering", () => {
  expect(
    conversationMark(
      1,
      { state: "working", since: "2026-11-24T10:05:00Z" },
      seen(),
    ),
  ).toBe("answering");
});

test("an answer after the conversation was last on screen is unread", () => {
  const state = seen({ seen: { 1: "2026-11-24T10:10:00Z" } });
  expect(conversationMark(1, done("2026-11-24T10:12:00Z"), state)).toBe(
    "unread",
  );
  expect(conversationMark(1, done("2026-11-24T10:08:00Z"), state)).toBe("read");
});

test("answers from before the mark existed are read", () => {
  expect(conversationMark(1, done("2026-11-24T09:00:00Z"), seen())).toBe(
    "read",
  );
  expect(conversationMark(1, done("2026-11-24T10:01:00Z"), seen())).toBe(
    "unread",
  );
});

test("a conversation on screen, or a copy that only started, is read", () => {
  expect(
    conversationMark(
      1,
      done("2026-11-24T10:12:00Z"),
      seen({ showing: new Set([1]) }),
    ),
  ).toBe("read");
  expect(
    conversationMark(
      1,
      { state: "idle", since: "2026-11-24T10:12:00Z" },
      seen(),
    ),
  ).toBe("read");
  expect(conversationMark(1, undefined, seen())).toBe("read");
});

test("a stopped copy still shows when it last answered", () => {
  const thread = { forkSessionId: "f", forkAnsweredAt: "2026-11-24T10:12:00Z" };
  expect(copyState(thread, () => undefined)).toEqual({
    state: "done",
    since: "2026-11-24T10:12:00Z",
  });
  expect(
    copyState(thread, () => ({
      state: "working",
      since: "2026-11-24T10:20:00Z",
    }))?.state,
  ).toBe("working");
  expect(
    copyState({ forkSessionId: "f", forkAnsweredAt: null }, () => undefined),
  ).toBeUndefined();
});

test("a conversation untouched for a day is stale, unless something is new", () => {
  const thread = {
    id: 1,
    createdAt: "2026-11-20T10:00:00Z",
    updatedAt: "2026-11-20T10:00:00Z",
    forkAnsweredAt: "2026-11-20T10:05:00Z",
  };
  const now = Date.parse("2026-11-24T10:00:00Z");
  expect(isStale(thread, "read", seen(), now)).toBe(true);
  expect(isStale(thread, "unread", seen(), now)).toBe(false);
  expect(isStale(thread, "answering", seen(), now)).toBe(false);
  // Looked at an hour ago.
  expect(
    isStale(thread, "read", seen({ seen: { 1: "2026-11-24T09:00:00Z" } }), now),
  ).toBe(false);
  expect(isStale(thread, "read", seen({ showing: new Set([1]) }), now)).toBe(
    false,
  );
});

import { describe, expect, test } from "bun:test";
import type { SessionTurnDto, ThreadDto } from "@daedalus/protocol";
import {
  answerPlace,
  chatItems,
  closedThreads,
  firstLine,
  splitAbout,
  conversationName,
  foldCounts,
  foldTurns,
  type ChatItem,
  type ChatRow,
  type ChatTabId,
  placeChat,
  openThreads,
  threadMark,
  threadName,
  waitingBySession,
} from "./FactoryChats";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const at = (minute: number) =>
  `2026-11-23T10:${String(minute).padStart(2, "0")}:00.000Z`;

const thread = (id: number, over: Partial<ThreadDto> = {}): ThreadDto => ({
  id,
  workspaceId: "w",
  workspaceName: "W",
  sessionId: "s",
  sessionName: "api",
  title: `Thread ${id}`,
  planPath: null,
  taskKey: null,
  anchorId: null,
  anchorText: null,
  forkSessionId: null,
  forkAnsweredAt: null,
  closedAt: null,
  blockedAt: null,
  snoozedUntil: null,
  resolvedAt: null,
  resolvedBy: null,
  createdAt: at(id),
  updatedAt: at(id),
  messages: [
    {
      id: id * 10,
      author: "agent",
      kind: "message",
      body: "OK to merge?",
      details: "PR 12",
      options: ["Yes", "No"],
      picked: null,
      createdAt: at(id),
    },
  ],
  unread: true,
  turn: "user",
  blocking: false,
  forkOpen: false,
  ...over,
});

const asked: Partial<ThreadDto> = {
  messages: [],
  turn: null,
  forkSessionId: "f",
  forkAnsweredAt: null,
  closedAt: null,
  forkOpen: true,
};

test("asks waiting on the user are counted by the agent that asked", () => {
  const waiting = waitingBySession(
    [
      thread(1),
      thread(2, { blocking: true }),
      thread(3, { sessionId: "other" }),
      thread(4, { turn: "agent" }),
      thread(5, { resolvedAt: at(30) }),
      thread(6, { snoozedUntil: "2026-11-23T13:00:00.000Z" }),
      thread(7, asked),
    ],
    NOW,
  );
  expect(waiting.get("s")).toEqual({ count: 2, blocking: true });
  expect(waiting.get("other")).toEqual({ count: 1, blocking: false });
});

test("an agent's listed threads are the ones it began and the user's with a fork", () => {
  const threads = [
    thread(2, { ...asked, createdAt: at(5) }),
    thread(1, { ...asked, createdAt: at(1) }),
    // Its copy stopped by itself: still listed, and asking wakes it.
    thread(3, { ...asked, createdAt: at(6), forkOpen: false }),
    thread(4, { ...asked, sessionId: "other" }),
    thread(5),
    thread(6, { ...asked, resolvedAt: at(9) }),
    thread(7, { ...asked, closedAt: at(8) }),
    thread(8, { ...asked, closedAt: at(9) }),
    // The agent's own: listed until resolved, then in History.
    thread(9, { resolvedAt: at(10), turn: null }),
    thread(10, { sessionId: "other" }),
  ];
  expect(openThreads(threads, "s").map((one) => one.id)).toEqual([1, 2, 5, 3]);
  expect(openThreads(threads, "nobody")).toEqual([]);
  // History: closed or resolved, the last put away first. One with a fork
  // that was resolved is deleted and listed nowhere.
  expect(closedThreads(threads, "s").map((one) => one.id)).toEqual([9, 8, 7]);
});

test("a thread is marked by what it has for the user, and named by who began it", () => {
  const seen = { since: at(0), seen: {}, showing: new Set<number>() };
  const live = (state: string) => () => ({ state, since: at(20) });
  expect(threadMark(thread(1), undefined, seen, NOW)).toBe("asks");
  expect(threadMark(thread(1, { turn: "agent" }), undefined, seen, NOW)).toBe(
    "read",
  );
  expect(threadMark(thread(2, asked), live("working"), seen, NOW)).toBe(
    "answering",
  );
  expect(threadMark(thread(2, asked), live("done"), seen, NOW)).toBe("unread");
  // The agent's subject names its thread; the user's own name wins.
  expect(threadName(thread(1), {})).toBe("Thread 1");
  expect(threadName(thread(1), { 1: "Merge" })).toBe("Merge");
  expect(threadName(thread(2, { ...asked, title: "Per tenant?" }), {})).toBe(
    "Per tenant?",
  );
});

test("a conversation is named after its first question", () => {
  const opened = thread(3, {
    ...asked,
    title: "Moving on to the dead-letter…",
    anchorText: "Moving on to the dead-letter table.",
  });
  const said = (role: "user" | "agent", text: string) => ({
    id: text,
    role,
    text,
    at: at(1),
  });
  expect(
    conversationName(opened, [
      said("user", "[Threads] You are thread #3."),
      said("user", "Why a table?\nAnd why now?"),
    ]),
  ).toBe("Why a table?");
  expect(conversationName(opened, [])).toBe("Untitled");
  expect(
    conversationName(thread(4, { ...asked, title: "Per tenant?" }), []),
  ).toBe("Per tenant?");
});

describe("chatItems", () => {
  const message = (
    id: string,
    role: "user" | "agent",
    text: string,
    minute: number,
  ) => ({ id, role, text, at: at(minute) });

  test("each tab shows its own part: the agent's, or one conversation's", () => {
    const input = {
      sessionId: "s",
      now: NOW,
      threads: [thread(5), thread(1, asked), thread(2, asked)],
      conversations: new Map([
        [1, [message("1", "user", "Why a custom backoff?", 2)]],
        [2, [message("2", "user", "Is it per tenant?", 3)]],
      ]),
      sent: [
        { id: "a", sessionId: "s", text: "Use backoff.", at: at(8) },
        {
          id: "b",
          sessionId: "s",
          text: "Per tenant.",
          at: at(9),
          threadId: 2,
        },
      ],
    };
    const texts = (tab: ChatTabId) =>
      chatItems({ ...input, tab }).map((item) => item.text);
    expect(texts("agent")).toEqual([
      "OK to merge?",
      "Use backoff.",
      "Per tenant.",
    ]);
    expect(texts(1)).toEqual(["Why a custom backoff?", ""]);
    expect(texts(2)).toEqual(["Is it per tenant?", "", "Per tenant."]);
    expect(texts("new")).toEqual([]);
    // The agent's own thread: what it asked and what the user answered.
    expect(texts(5)).toEqual(["OK to merge?"]);
    const own = chatItems({ ...input, tab: 5 });
    expect(own[0]!.options).toEqual({ threadId: 5, choices: ["Yes", "No"] });
  });

  test("the agent's thread shows what a fork was asked in it", () => {
    const items = chatItems({
      sessionId: "s",
      now: NOW,
      threads: [thread(5, { forkSessionId: "f" })],
      conversations: new Map([
        [
          5,
          [
            message("1", "user", "What breaks if I say no?", 7),
            message("2", "agent", "Nothing ships today.", 8),
          ],
        ],
      ]),
      sent: [],
      tab: 5,
    });
    expect(items.map((item) => [item.from, item.text])).toEqual([
      ["agent", "OK to merge?"],
      ["you", "What breaks if I say no?"],
      ["copy", "Nothing ships today."],
    ]);
    // Direct shows the ask, not the side talk with the fork.
    expect(
      chatItems({
        sessionId: "s",
        now: NOW,
        threads: [thread(5, { forkSessionId: "f" })],
        conversations: new Map(),
        sent: [],
        tab: "agent",
      }).map((item) => item.text),
    ).toEqual(["OK to merge?"]);
  });

  test("a question taken back is left out, and the same words asked later are shown", () => {
    const items = chatItems({
      sessionId: "s",
      now: NOW,
      threads: [thread(1, asked)],
      conversations: new Map([
        [
          1,
          [
            message("1", "user", "Why a custom backof?", 2),
            message("2", "user", "[Request interrupted by user]", 3),
            message("3", "user", "Why a custom backoff?", 5),
            message("4", "agent", "The queue drops jobs.", 6),
            message("5", "user", "Why a custom backof?", 9),
          ],
        ],
      ]),
      sent: [],
      withdrawn: [{ threadId: 1, text: "Why a custom backof?", at: at(4) }],
    });
    expect(items.map((item) => [item.from, item.text, item.pending])).toEqual([
      ["you", "Why a custom backoff?", undefined],
      ["copy", "The queue drops jobs.", false],
      ["you", "Why a custom backof?", undefined],
      ["copy", "", true],
    ]);
    expect(items[3]!.threadId).toBe(1);
  });

  test("one agent's asks, the user's questions and what was sent, in time order", () => {
    const items = chatItems({
      sessionId: "s",
      now: NOW,
      threads: [thread(5), thread(1, asked), thread(9, { sessionId: "other" })],
      conversations: new Map([
        [
          1,
          [
            message("0", "agent", "Copied from main.", 0),
            message("1", "user", "Why a custom backoff?", 2),
            message("2", "agent", "Let me look.", 3),
            message("3", "agent", "The queue drops jobs.", 4),
            message("4", "user", "[Threads] You are thread #1.", 6),
            message("5", "user", "Per tenant?", 7),
          ],
        ],
      ]),
      sent: [{ id: "sent:1", sessionId: "s", text: "Use backoff.", at: at(8) }],
    });
    expect(items.map((item) => [item.from, item.to ?? "", item.text])).toEqual([
      ["you", "copy", "Why a custom backoff?"],
      ["copy", "", "The queue drops jobs."],
      ["agent", "", "OK to merge?"],
      ["you", "copy", "Per tenant?"],
      ["copy", "", ""],
      ["you", "agent", "Use backoff."],
    ]);
    expect(items[4]!.pending).toBe(true);
    expect(items[2]).toMatchObject({
      details: "PR 12",
      options: { threadId: 5, choices: ["Yes", "No"] },
    });
  });

  test("an answered ask keeps its messages and drops its choices", () => {
    const answered = thread(5, { turn: "agent" });
    answered.messages.push({
      id: 51,
      author: "user",
      kind: "message",
      body: "",
      details: null,
      options: [],
      picked: 0,
      createdAt: at(6),
    });
    const items = chatItems({
      sessionId: "s",
      now: NOW,
      threads: [answered],
      conversations: new Map(),
      sent: [],
    });
    expect(items.map((item) => [item.from, item.text])).toEqual([
      ["agent", "OK to merge?"],
      ["you", "Picked an option"],
    ]);
    expect(items[0]!.options).toBeUndefined();
  });
});

test("a new chat opens in front, stepped away from the ones open", () => {
  const first = placeChat([], { sessionId: "a", handle: "a" }, "Box A");
  const second = placeChat([first], { sessionId: "b", handle: "b" }, "Box B");
  expect(second.order).toBeGreaterThan(first.order);
  expect([second.x, second.y]).not.toEqual([first.x, first.y]);
  expect(second).toMatchObject({ about: "Box B", minimized: false });
});

describe("foldTurns", () => {
  const item = (
    id: string,
    from: ChatItem["from"],
    at: string,
    text = id,
  ): ChatItem => ({ id, from, at: `2026-11-24T${at}Z`, text });
  const turn = (
    startedAt: string,
    endedAt: string | null,
    more: Partial<SessionTurnDto> = {},
  ): SessionTurnDto => ({
    startedAt: `2026-11-24T${startedAt}Z`,
    endedAt: endedAt && `2026-11-24T${endedAt}Z`,
    toolCalls: 0,
    steps: [],
    files: [],
    ...more,
  });

  test("only the last message of a turn is its reply", () => {
    const rows = foldTurns([
      item("y1", "you", "10:00:00"),
      item("m:1", "agent", "10:01:00"),
      item("m:2", "agent", "10:06:12"),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["item", "fold", "item"]);
    const fold = rows[1] as Extract<ChatRow, { kind: "fold" }>;
    expect(fold.hidden.map((one) => one.id)).toEqual(["m:1"]);
    expect(foldCounts(fold)).toBe("1 message");
  });

  test("a recorded turn gives the fold its tool calls and files", () => {
    const rows = foldTurns(
      [
        item("y1", "you", "10:00:00"),
        item("m:1", "agent", "10:06:12"),
        item("y2", "you", "10:11:00"),
        item("m:2", "agent", "10:12:00"),
      ],
      [
        turn("10:00:01", "10:06:13", {
          toolCalls: 14,
          files: ["/repo/carts/service.ts"],
        }),
        turn("10:11:01", null),
      ],
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "item",
      "fold",
      "item",
      "files",
      "item",
      "item",
    ]);
    expect(foldCounts(rows[1] as Extract<ChatRow, { kind: "fold" }>)).toBe(
      "14 tool calls",
    );
    expect(rows[3]).toMatchObject({ files: ["/repo/carts/service.ts"] });
  });

  test("a turn recorded for another time is not attached", () => {
    const rows = foldTurns(
      [item("y1", "you", "10:00:00"), item("m:1", "agent", "10:01:00")],
      [turn("09:00:00", "09:05:00", { toolCalls: 3 })],
    );
    expect(rows.map((row) => row.kind)).toEqual(["item", "item"]);
  });
});

test("a history row shows the answer's first line of words", () => {
  expect(firstLine("## Status\n\n**Two** things are `left`.\nMore")).toBe(
    "Two things are left.",
  );
  expect(firstLine("ok")).toBe("ok");
  expect(firstLine("## Status")).toBe("Status");
});

test("a question about a message is shown without the note the copy gets", () => {
  expect(
    splitAbout(
      'Why 20?\n\n(About your message that begins: "The cap is 20 carts.")',
    ),
  ).toEqual({ question: "Why 20?", about: "The cap is 20 carts." });
  expect(splitAbout("Why 20?")).toEqual({ question: "Why 20?" });
});

test("a fork's handoff is one message for the agent, with no question shown", () => {
  const sentToAgent = {
    id: 51,
    author: "user" as const,
    kind: "message" as const,
    body: "Raise it.",
    details: null,
    options: [],
    picked: null,
    createdAt: at(5),
  };
  const asked = thread(5, { forkSessionId: "f", messages: [] });
  const conversations = new Map([
    [
      5,
      [
        { id: "q1", role: "user" as const, text: "Why 20?", at: at(1) },
        {
          id: "a1",
          role: "agent" as const,
          text: "Carts time out.",
          at: at(2),
        },
        {
          id: "q2",
          role: "user" as const,
          text: "[Threads] Handoff: the user wants to hand this to main.",
          at: at(3),
        },
        {
          id: "a2",
          role: "agent" as const,
          text: "Here it is.\n\nFor main:\nRaise the cap to 40.",
          at: at(4),
        },
      ],
    ],
  ]);
  const rows = (threads: ThreadDto[], tab: ChatTabId) =>
    chatItems({ sessionId: "s", threads, conversations, sent: [], tab }).map(
      (item) => [
        item.from,
        item.text,
        item.handoff ?? item.fromThread ?? false,
      ],
    );
  expect(rows([asked], 5)).toEqual([
    ["you", "Why 20?", false],
    ["copy", "Carts time out.", false],
    ["copy", "Raise the cap to 40.", true],
  ]);
  // Sent: the thread is still the user's with the fork, and the agent's
  // part shows what it was told and from which thread.
  const sent = { ...asked, messages: [sentToAgent] };
  expect(rows([sent], 5).at(-1)).toEqual(["you", "Raise it.", false]);
  expect(rows([sent], "agent")).toEqual([["you", "Raise it.", 5]]);
  expect(openThreads([sent], "s").map((one) => one.id)).toEqual([5]);
  expect(waitingBySession([sent], NOW).size).toBe(0);
});

describe("answerPlace", () => {
  const live = (state: string, asked: boolean) => ({
    state,
    detail: null,
    since: "2026-11-26T08:00:00Z",
    asked,
  });

  test("a question the agent wrote is answered in the chat", () => {
    expect(answerPlace(live("needs_input", true))).toBe("chat");
  });

  test("a prompt the provider draws is answered in the terminal", () => {
    expect(answerPlace(live("needs_input", false))).toBe("terminal");
    // A permission has keys to press, whatever else the agent asked.
    expect(answerPlace(live("needs_permission", true))).toBe("terminal");
  });
});

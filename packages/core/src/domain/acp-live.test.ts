import { describe, expect, test } from "bun:test";
import type {
  AcpHostEvent,
  AcpLogEntry,
  AcpMessage,
} from "../services/acp-host";
import { emptyAcpLive, reduceAcpLive, type AcpLive } from "./acp-live";

let seq = 0;
const at = "2026-01-01T00:00:00.000Z";
const host = (event: AcpHostEvent): AcpLogEntry => ({
  seq: ++seq,
  at,
  from: "host",
  event,
});
const agent = (message: AcpMessage): AcpLogEntry => ({
  seq: ++seq,
  at,
  from: "agent",
  message,
});
const client = (message: AcpMessage): AcpLogEntry => ({
  seq: ++seq,
  at,
  from: "client",
  message,
});
const update = (change: Record<string, unknown>) =>
  agent({ method: "session/update", params: { update: change } });
const say = (words: string) =>
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: words },
  });
const run = (entries: AcpLogEntry[], from: AcpLive = emptyAcpLive()) =>
  entries.reduce(reduceAcpLive, from);

const ask = agent({
  id: 0,
  method: "session/request_permission",
  params: {
    toolCall: { toolCallId: "t1", title: "Write hello.txt" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
      { name: "no id" },
    ],
  },
});

describe("reduceAcpLive", () => {
  test("keeps what the turn said and did, in order", () => {
    const live = run([
      host({ type: "turn_start", text: "do it" }),
      say("I will "),
      say("look."),
      update({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        name: "Bash",
        kind: "execute",
        status: "pending",
      }),
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        title: "ls -la",
        status: "completed",
      }),
      say("Two "),
      say("files."),
    ]);
    expect(live).toMatchObject({
      working: true,
      parts: [
        { kind: "text", text: "I will look." },
        {
          kind: "tool",
          id: "t1",
          title: "ls -la",
          tool: "execute",
          status: "completed",
        },
        { kind: "text", text: "Two files." },
      ],
    });
    const ended = run(
      [host({ type: "turn_end", stopReason: "end_turn" })],
      live,
    );
    expect(ended.working).toBe(false);
    // Kept until the next turn: the transcript shows it a moment later.
    expect(ended.parts).toHaveLength(3);
    expect(
      run([host({ type: "turn_start", text: "next" })], ended),
    ).toMatchObject({ working: true, parts: [] });
  });

  test("a loaded conversation's replay is not the turn's answer", () => {
    const live = run([
      say("an old answer"),
      update({ sessionUpdate: "tool_call", toolCallId: "old" }),
      host({ type: "ready", acpSessionId: "s" }),
    ]);
    expect(live).toEqual(emptyAcpLive());
  });

  test("a permission is open from the ask until its answer", () => {
    const asked = run([host({ type: "turn_start", text: "write" }), ask]);
    expect(asked.permission).toEqual({
      requestId: 0,
      title: "Write hello.txt",
      options: [
        { id: "allow", name: "Allow", kind: "allow_once" },
        { id: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    // Another response of the client leaves it open.
    expect(
      run([client({ id: 7, result: {} })], asked).permission,
    ).not.toBeNull();
    expect(
      run(
        [client({ id: 0, result: { outcome: { outcome: "selected" } } })],
        asked,
      ).permission,
    ).toBeNull();
    expect(run([host({ type: "turn_end" })], asked).permission).toBeNull();
  });

  test("queued messages wait and run in turn, through a stop too", () => {
    const waiting = run([
      host({ type: "turn_start", text: "one" }),
      host({ type: "queued", text: "two" }),
      host({ type: "queued", text: "three" }),
    ]);
    expect(waiting.queued).toEqual(["two", "three"]);
    const stopped = run(
      [client({ method: "session/cancel", params: {} })],
      waiting,
    );
    expect(stopped.queued).toEqual(["two", "three"]);
    expect(
      run(
        [host({ type: "turn_end" }), host({ type: "turn_start", text: "two" })],
        stopped,
      ),
    ).toMatchObject({ queued: ["three"], turns: 1, working: true });
  });

  test("reads the context use and the host's exit", () => {
    const live = run([
      host({ type: "turn_start", text: "one" }),
      update({ sessionUpdate: "usage_update", used: 35_592, size: 1_000_000 }),
      update({ sessionUpdate: "usage_update", used: "many" }),
      host({ type: "exit", code: 0 }),
    ]);
    expect(live).toMatchObject({
      working: false,
      ended: true,
      usage: { used: 35_592, size: 1_000_000 },
    });
  });
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, DaedalCall } from "@daedalus/remote-protocol";
import { EventQueue } from "./queue";
import {
  callFromRequest,
  listenForShim,
  prepareShimSocket,
} from "./shim-server";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-shim-server-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Sends raw bytes to the socket and resolves with the reply line. */
async function send(path: string, payload: Uint8Array | string) {
  let text = "";
  const done = Promise.withResolvers<string>();
  await Bun.connect({
    unix: path,
    socket: {
      open(socket) {
        socket.write(payload);
      },
      data(_socket, chunk) {
        text += chunk.toString();
      },
      close() {
        done.resolve(text);
      },
      error(_socket, error) {
        done.reject(error);
      },
    },
  });
  return JSON.parse(await done.promise) as CommandResult;
}

test("the runner decides queueable from argv and ignores the request's field", () => {
  const event = callFromRequest(
    JSON.stringify({
      argv: ["agent", "event", "Stop"],
      cwd: ".",
      env: {},
      queueable: false,
    }),
    new Date(0),
  );
  expect(event).toMatchObject({
    queueable: true,
    at: new Date(0).toISOString(),
  });
  const call = callFromRequest(
    JSON.stringify({
      argv: ["task", "list"],
      cwd: ".",
      env: {},
      queueable: true,
    }),
    new Date(0),
  );
  expect(call).toMatchObject({ queueable: false });
});

test("a malformed request is refused", () => {
  for (const line of [
    "not json",
    "null",
    JSON.stringify({ argv: "task", cwd: ".", env: {} }),
    JSON.stringify({ argv: [1], cwd: ".", env: {} }),
    JSON.stringify({ argv: [], cwd: ".", env: { A: 1 } }),
    JSON.stringify({ argv: [], cwd: ".", env: {}, stdin: 5 }),
  ])
    expect(callFromRequest(line, new Date())).toHaveProperty("refused");
});

test("a request over the limit is refused before it is read into a call", async () => {
  const path = join(dir, "daedal.sock");
  const calls: DaedalCall[] = [];
  const server = listenForShim(
    path,
    async (call) => {
      calls.push(call);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    { bytes: 1024 },
  );
  try {
    const big = await send(path, "x".repeat(4096));
    expect(big.exitCode).toBe(1);
    expect(big.stderr).toContain("over 1024 bytes");

    const small = await send(
      path,
      `${JSON.stringify({ argv: ["agent", "event", "Stop"], cwd: ".", env: {}, queueable: false })}\n`,
    );
    expect(small.stdout).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.queueable).toBe(true);
  } finally {
    server.stop(true);
  }
});

/** Opens a connection that sends `payload` and waits; resolves on close. */
async function hold(path: string, payload = "") {
  let text = "";
  const closed = Promise.withResolvers<string>();
  const socket = await Bun.connect({
    unix: path,
    socket: {
      open(socket) {
        if (payload) socket.write(payload);
      },
      data(_socket, chunk) {
        text += chunk.toString();
      },
      close() {
        closed.resolve(text);
      },
    },
  });
  return { socket, closed: closed.promise };
}

test("a request that never ends is closed after the read timeout", async () => {
  const path = join(dir, "daedal.sock");
  const server = listenForShim(
    path,
    async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    { readTimeoutSeconds: 1 },
  );
  try {
    const { closed } = await hold(path, '{"argv":');
    const result = JSON.parse(await closed) as CommandResult;
    expect(result.stderr).toContain("did not arrive in time");
  } finally {
    server.stop(true);
  }
});

test("connections past the limit are refused until one closes", async () => {
  const path = join(dir, "daedal.sock");
  const server = listenForShim(
    path,
    async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    { connections: 2 },
  );
  try {
    const first = await hold(path);
    const second = await hold(path);
    const third = await send(
      path,
      `${JSON.stringify({ argv: ["task", "list"], cwd: ".", env: {} })}\n`,
    );
    expect(third.stderr).toContain("busy");
    first.socket.end();
    await first.closed;
    const fourth = await send(
      path,
      `${JSON.stringify({ argv: ["task", "list"], cwd: ".", env: {} })}\n`,
    );
    expect(fourth.stdout).toBe("ok");
    second.socket.end();
  } finally {
    server.stop(true);
  }
});

test("the socket's folder is the runner's own, mode 0755", () => {
  const path = join(dir, "runner", "daedal.sock");
  prepareShimSocket(path);
  const folder = statSync(join(dir, "runner"));
  expect(folder.isDirectory()).toBe(true);
  expect(folder.mode & 0o777).toBe(0o755);
  expect(folder.uid).toBe(process.getuid!());

  // A stale socket from an earlier start is replaced.
  writeFileSync(path, "");
  prepareShimSocket(path);
  expect(() => statSync(path)).toThrow();
});

test("a path someone else put where the folder goes is refused", () => {
  writeFileSync(join(dir, "file"), "");
  expect(() => prepareShimSocket(join(dir, "file", "daedal.sock"))).toThrow();
  mkdirSync(join(dir, "elsewhere"));
  symlinkSync(join(dir, "elsewhere"), join(dir, "link"));
  expect(() => prepareShimSocket(join(dir, "link", "daedal.sock"))).toThrow(
    "not a folder the runner owns",
  );
});

const event = (id: string, stdin = ""): DaedalCall => ({
  callId: id,
  argv: ["agent", "event", "Stop"],
  cwd: ".",
  env: {},
  stdin,
  queueable: true,
  at: new Date(0).toISOString(),
});

test("the queue drops its oldest events past its count", () => {
  const file = join(dir, "queue.jsonl");
  const queue = new EventQueue(file, { calls: 3, bytes: 1 << 20 });
  for (const id of ["a", "b", "c", "d", "e"]) queue.push(event(id));
  expect(queue.length).toBe(3);
  expect(queue.peek()?.callId).toBe("c");
  expect(new EventQueue(file, { calls: 3, bytes: 1 << 20 }).length).toBe(3);
});

test("the queue drops its oldest events past its bytes, and refuses one too big", () => {
  const file = join(dir, "queue.jsonl");
  const queue = new EventQueue(file, { calls: 100, bytes: 1000 });
  for (const id of ["a", "b", "c"]) queue.push(event(id, "x".repeat(300)));
  expect(queue.bytes).toBeLessThanOrEqual(1000);
  expect(queue.peek()?.callId).toBe("b");
  queue.push(event("huge", "x".repeat(2000)));
  expect(queue.length).toBe(2);
  expect(queue.peek()?.callId).toBe("b");
});

test("an answered event is removed by id, even after a push dropped it", () => {
  const file = join(dir, "queue.jsonl");
  const queue = new EventQueue(file, { calls: 2, bytes: 1 << 20 });
  queue.push(event("a"));
  queue.push(event("b"));
  // "a" is being sent when "c" arrives and drops it.
  queue.push(event("c"));
  queue.remove("a");
  expect(queue.length).toBe(2);
  expect(queue.peek()?.callId).toBe("b");
  queue.remove("b");
  expect(queue.peek()?.callId).toBe("c");
});

test("a queue file far over the limit is not loaded", () => {
  const file = join(dir, "queue.jsonl");
  writeFileSync(
    file,
    `${JSON.stringify(event("a", "x".repeat(5000)))}\n`.repeat(2),
  );
  expect(new EventQueue(file, { calls: 100, bytes: 1000 }).length).toBe(0);
});

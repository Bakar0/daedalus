import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptHandshake,
  createIdentity,
  decodePayload,
  decodeRelayFrame,
  decodeSecurePlaintext,
  encodePlain,
  encodeRelayFrame,
  encodeSealed,
  encodeSecureMessage,
  sodiumReady,
  type DaedalCall,
  type DeviceIdentity,
  type Ready,
  type RunnerSecureMessage,
  type SecureChannel,
} from "@daedalus/remote-protocol";
import { FakeBackend } from "./fake-backend";
import type { FakeTmux } from "./fake-tmux";
import { EventQueue } from "./queue";
import { Runner, type RelayCallbacks, type RelaySocket } from "./runner";

/** The Mac's end of the relay: answers the handshake, then reads and writes secure messages. */
class FakeMac {
  channel: SecureChannel | undefined;
  received: RunnerSecureMessage[] = [];
  /** Decides what to answer to a `daedal.call`; undefined leaves it hanging. */
  onCall: (call: DaedalCall) => unknown = () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
  private finish: ((ready: Ready) => SecureChannel) | undefined;
  constructor(
    readonly identity: DeviceIdentity,
    private readonly runnerKey: string,
    private readonly sendToRunner: (frame: Uint8Array) => void,
    readonly deviceId: string,
  ) {}

  frame(payload: Uint8Array) {
    this.sendToRunner(encodeRelayFrame(this.deviceId, payload));
  }

  receive(frame: Uint8Array) {
    const { payload } = decodeRelayFrame(frame);
    const decoded = decodePayload(payload);
    if (decoded.kind === "plain") {
      const message = decoded.message;
      if (message.type === "hello") {
        const accepted = acceptHandshake(
          this.identity,
          this.runnerKey,
          message,
        );
        this.finish = accepted.finish;
        this.frame(encodePlain(accepted.welcome));
      } else if (message.type === "ready" && this.finish) {
        this.channel = this.finish(message);
      }
      return;
    }
    const plain = decodeSecurePlaintext(this.channel!.open(decoded.ciphertext));
    if (plain.kind !== "message") return;
    const message = plain.message as unknown as RunnerSecureMessage;
    this.received.push(message);
    if (message.t === "req" && message.method === "daedal.call") {
      const result = this.onCall(message.params as DaedalCall);
      if (result !== undefined)
        this.sendSecure({ t: "res", id: message.id, result });
    }
  }

  sendSecure(message: RunnerSecureMessage) {
    this.frame(
      encodeSealed(this.channel!.seal(encodeSecureMessage(message as never))),
    );
  }
}

let dir: string;
let tmux: FakeTmux;
let queue: EventQueue;
let runner: Runner;
let mac: FakeMac;
let callbacks: RelayCallbacks;
let connects: { url: string; token: string }[];
let macIdentity: DeviceIdentity;
let runnerIdentity: DeviceIdentity;
let sleeps: string[];
let backend: FakeBackend;
let now: number;
let token = "runner-token";

beforeEach(async () => {
  await sodiumReady();
  dir = mkdtempSync(join(tmpdir(), "runner-relay-"));
  backend = new FakeBackend(dir);
  tmux = backend.tmux;
  queue = new EventQueue(join(dir, "queue.jsonl"));
  macIdentity = createIdentity();
  runnerIdentity = createIdentity();
  connects = [];
  sleeps = [];
  now = 1_000_000;
  const socket: RelaySocket = {
    send: (frame) => mac.receive(frame),
    close: () => {},
  };
  runner = new Runner({
    gatewayUrl: "http://gateway.test:8080",
    readToken: () => token,
    workspaceId: "ws-1",
    macId: macIdentity.id,
    macKey: macIdentity.publicKey,
    identity: runnerIdentity,
    backend,
    queue,
    connect: (url, token, cb) => {
      connects.push({ url, token });
      callbacks = cb;
      return socket;
    },
    idleMinutes: 30,
    now: () => now,
    fetch: (async (url: URL, init: RequestInit) => {
      sleeps.push(
        `${init.method} ${url.pathname} ${(init.headers as Record<string, string>).authorization}`,
      );
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch,
    handshakeRetryMs: 10_000,
  });
  mac = new FakeMac(
    macIdentity,
    runnerIdentity.publicKey,
    (frame) => callbacks.binary(frame),
    `mac:${macIdentity.id}`,
  );
  runner.start();
  callbacks.open();
});

afterEach(() => {
  runner.stop();
  rmSync(dir, { recursive: true, force: true });
});

const macOnline = (online: boolean) =>
  callbacks.text(
    JSON.stringify({
      relay: "peer",
      deviceId: `mac:${macIdentity.id}`,
      online,
    }),
  );
const tick = () => new Promise((r) => setTimeout(r, 5));

const call = (id: string, queueable = true): DaedalCall => ({
  callId: id,
  argv: ["agent", "event", id],
  cwd: ".",
  env: {},
  queueable,
  at: "2026-10-19T00:00:00Z",
});

test("connects to /v1/connect with the token and the runner key", () => {
  const url = new URL(connects[0]!.url);
  expect(url.protocol).toBe("ws:");
  expect(url.pathname).toBe("/v1/connect");
  expect(url.searchParams.get("runnerKey")).toBe(runnerIdentity.publicKey);
  expect(connects[0]!.token).toBe("runner-token");
});

test("handshakes when the Mac comes online and serves requests", async () => {
  tmux.sessions.add("s1");
  macOnline(true);
  expect(runner.linked).toBe(true);
  mac.sendSecure({ t: "req", id: 7, method: "host.listLive", params: null });
  await tick();
  expect(mac.received).toContainEqual({ t: "res", id: 7, result: ["s1"] });
  mac.sendSecure({
    t: "req",
    id: 8,
    method: "fs.read",
    params: { path: "../x" },
  });
  mac.sendSecure({ t: "req", id: 9, method: "nope" as never, params: null });
  await tick();
  expect(mac.received).toContainEqual(
    expect.objectContaining({
      t: "err",
      id: 8,
      code: "PATH_OUTSIDE_WORKSPACE",
    }),
  );
  expect(mac.received).toContainEqual(
    expect.objectContaining({ t: "err", id: 9, code: "UNKNOWN_METHOD" }),
  );
});

test("ignores a handshake frame that is not from the Mac", () => {
  macOnline(true);
  expect(runner.linked).toBe(true);
  macOnline(false);
  expect(runner.linked).toBe(false);
});

test("a non-queueable call fails with 75 while the Mac is offline", async () => {
  const result = await runner.daedalCall(call("a", false));
  expect(result.exitCode).toBe(75);
  expect(result.stderr).toContain("Daedalus on the Mac is offline");
  expect(queue.length).toBe(0);
});

test("queueable calls wait on disk and replay in order when the Mac connects", async () => {
  expect((await runner.daedalCall(call("1"))).exitCode).toBe(0);
  await runner.daedalCall(call("2"));
  await runner.daedalCall(call("3"));
  expect(queue.length).toBe(3);
  // A new process sees the same queue.
  expect(new EventQueue(join(dir, "queue.jsonl")).length).toBe(3);

  const seen: string[] = [];
  mac.onCall = (c) => {
    seen.push(c.callId);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  macOnline(true);
  await tick();
  await tick();
  expect(seen).toEqual(["1", "2", "3"]);
  expect(queue.length).toBe(0);
});

test("an event made during replay goes after the queued ones", async () => {
  await runner.daedalCall(call("1"));
  await runner.daedalCall(call("2"));
  const seen: string[] = [];
  mac.onCall = (c) => {
    seen.push(c.callId);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  macOnline(true);
  await runner.daedalCall(call("3"));
  await tick();
  await tick();
  expect(seen).toEqual(["1", "2", "3"]);
});

test("replay stops when the Mac goes away and resumes on the next link", async () => {
  await runner.daedalCall(call("1"));
  await runner.daedalCall(call("2"));
  mac.onCall = () => undefined; // never answers
  macOnline(true);
  await tick();
  macOnline(false);
  await tick();
  expect(queue.length).toBe(2);

  const seen: string[] = [];
  mac.onCall = (c) => {
    seen.push(c.callId);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  macOnline(true);
  await tick();
  await tick();
  expect(seen).toEqual(["1", "2"]);
  expect(queue.length).toBe(0);
});

test("a live call returns the Mac's result and a lost link queues an event", async () => {
  macOnline(true);
  mac.onCall = () => ({ exitCode: 4, stdout: "out", stderr: "" });
  expect(await runner.daedalCall(call("x", false))).toEqual({
    exitCode: 4,
    stdout: "out",
    stderr: "",
  });
  mac.onCall = () => undefined;
  const pending = runner.daedalCall(call("y"));
  await tick();
  macOnline(false);
  expect((await pending).exitCode).toBe(0);
  expect(queue.peek()?.callId).toBe("y");
});

test("session.exited is sent when a started session ends, even if the Mac was offline", async () => {
  tmux.sessions.add("s1");
  runner.watchSession("s1");
  await runner.tick();
  tmux.sessions.delete("s1");
  await runner.tick();
  macOnline(true);
  expect(mac.received).toContainEqual({
    t: "session.exited",
    session: "s1",
    exitCode: null,
  });
});

test("terminals open on a live session, take input and close with the link", async () => {
  tmux.sessions.add("s1");
  macOnline(true);
  mac.sendSecure({ t: "term.open", ch: 1, session: "s1", cols: 80, rows: 24 });
  await tick();
  mac.sendSecure({
    t: "term.client",
    ch: 1,
    message: { type: "input", data: "ls\r" },
  });
  await tick();
  expect(backend.terminals[0]!.writes).toEqual(["ls\r"]);
  mac.sendSecure({
    t: "term.open",
    ch: 2,
    session: "gone",
    cols: 80,
    rows: 24,
  });
  await tick();
  expect(mac.received).toContainEqual(
    expect.objectContaining({
      t: "term.server",
      ch: 2,
      message: expect.objectContaining({ status: "lost" }),
    }),
  );
});

test("asks the gateway to sleep after the idle period, not while a session lives", async () => {
  tmux.sessions.add("s1");
  await runner.tick();
  now += 31 * 60_000;
  await runner.tick();
  expect(sleeps).toEqual([]);
  tmux.sessions.delete("s1");
  await runner.tick();
  now += 29 * 60_000;
  await runner.tick();
  expect(sleeps).toEqual([]);
  now += 2 * 60_000;
  await runner.tick();
  expect(sleeps).toEqual([
    "POST /v1/workspaces/ws-1/sleep Bearer runner-token",
  ]);
  await runner.tick();
  expect(sleeps.length).toBe(1);
});

test("reconnects with backoff after the gateway drops", async () => {
  const before = connects.length;
  callbacks.close();
  await new Promise((r) => setTimeout(r, 1500));
  expect(connects.length).toBe(before + 1);
});

test("reports the real exit code of a dead pane, then kills the session", async () => {
  tmux.sessions.add("s1");
  runner.watchSession("s1");
  macOnline(true);
  backend.dead["s1"] = 7;
  await runner.tick();
  expect(mac.received).toContainEqual({
    t: "session.exited",
    session: "s1",
    exitCode: 7,
  });
  expect(tmux.sessions.has("s1")).toBe(false);
  await runner.tick();
  expect(mac.received.filter((m) => m.t === "session.exited")).toHaveLength(1);
});

test("a keepOnExit session reports its exit once and stays in tmux", async () => {
  tmux.sessions.add("s2");
  runner.watchSession("s2", true);
  macOnline(true);
  backend.dead["s2"] = 0;
  await runner.tick();
  await runner.tick();
  expect(mac.received.filter((m) => m.t === "session.exited")).toEqual([
    { t: "session.exited", session: "s2", exitCode: 0 },
  ]);
  expect(tmux.sessions.has("s2")).toBe(true);
});

test("a dead pane does not count as activity for idle sleep", async () => {
  tmux.sessions.add("s3");
  runner.watchSession("s3", true);
  backend.dead["s3"] = 0;
  await runner.tick();
  now += 31 * 60_000;
  await runner.tick();
  expect(sleeps.length).toBe(1);
});

test("reads the token again on every connect and sleep request", async () => {
  token = "token-two";
  callbacks.close();
  await new Promise((r) => setTimeout(r, 1500));
  expect(connects.at(-1)!.token).toBe("token-two");
  token = "token-three";
  await runner.tick();
  now += 31 * 60_000;
  await runner.tick();
  expect(sleeps).toEqual(["POST /v1/workspaces/ws-1/sleep Bearer token-three"]);
});

test("an unreadable token file means no connection attempt, and a retry later", async () => {
  runner.stop();
  const before = connects.length;
  token = "";
  const failing = () => {
    throw new Error("no token file");
  };
  const second = new Runner({
    gatewayUrl: "http://gateway.test:8080",
    readToken: failing,
    workspaceId: "ws-1",
    macId: macIdentity.id,
    macKey: macIdentity.publicKey,
    identity: runnerIdentity,
    backend,
    queue,
    connect: (url, t, cb) => {
      connects.push({ url, token: t });
      callbacks = cb;
      return { send() {}, close() {} };
    },
    idleMinutes: 30,
    backoff: { initialMs: 10, maxMs: 20 },
  });
  second.start();
  await new Promise((r) => setTimeout(r, 100));
  second.stop();
  expect(connects.length).toBe(before);
});

test("answers auth.callback itself, to 127.0.0.1, never through sessiond", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      seen.push(new URL(request.url).search);
      return new Response(null, {
        status: 302,
        headers: { location: "https://platform.claude.com/oauth/code/success" },
      });
    },
  });
  try {
    macOnline(true);
    const backendCalls: string[] = [];
    const call = backend.call.bind(backend);
    backend.call = (method, params) => {
      backendCalls.push(method);
      return call(method, params);
    };
    mac.sendSecure({
      t: "req",
      id: 21,
      method: "auth.callback",
      params: {
        port: server.port,
        path: "/callback",
        query: "code=c1&state=s1",
      },
    });
    mac.sendSecure({
      t: "req",
      id: 22,
      method: "auth.callback",
      params: { port: server.port, path: "/elsewhere", query: "code=c2" },
    });
    for (let i = 0; i < 100 && mac.received.length < 2; i++) await tick();
    expect(seen).toEqual(["?code=c1&state=s1"]);
    expect(mac.received).toContainEqual({
      t: "res",
      id: 21,
      result: {
        status: 302,
        location: "https://platform.claude.com/oauth/code/success",
      },
    });
    const refused = mac.received.find(
      (message) => message.t === "err" && message.id === 22,
    );
    expect(refused).toMatchObject({ code: "VALIDATION" });
    expect(JSON.stringify(refused)).not.toContain("c2");
    expect(backendCalls).toEqual([]);
  } finally {
    server.stop(true);
  }
});

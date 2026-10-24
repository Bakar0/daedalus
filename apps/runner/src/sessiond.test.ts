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
import { FakeBackend } from "./fake-backend";
import { privateRuntimeFolder, SessionDaemon } from "./sessiond";
import { SessiondClient } from "./sessiond-client";
import type { Terminal } from "./backend";

let dir: string;
let socket: string;
let backend: FakeBackend;
let daemon: SessionDaemon;
let client: SessiondClient;
let terminalWrites: string[];
let terminalSizes: [number, number][];
let emit: ((data: Uint8Array) => void) | undefined;
let endTerminal: (() => void) | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-sessiond-"));
  socket = join(dir, "session.sock");
  backend = new FakeBackend(dir);
  terminalWrites = [];
  terminalSizes = [];
  daemon = new SessionDaemon({
    handlers: backend.handlers,
    deadPanes: async () => backend.dead,
    hasSession: (session) => backend.tmux.hasSession(session),
    openTerminal: (_session, size, onOutput) => {
      emit = onOutput;
      terminalSizes.push([size.cols, size.rows]);
      const closed = Promise.withResolvers<void>();
      endTerminal = () => closed.resolve();
      const terminal: Terminal = {
        start: () => closed.promise,
        write: (data) => terminalWrites.push(data),
        resize: (cols, rows) => terminalSizes.push([cols, rows]),
        close: () => closed.resolve(),
      };
      return terminal;
    },
  });
  daemon.listen(socket);
  client = new SessiondClient(socket, undefined, 1500);
});
afterEach(() => {
  daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test("the socket is group accessible only", () => {
  expect(statSync(socket).mode & 0o777).toBe(0o660);
});

test("the socket takes the pod's group, which the folder may not give it", () => {
  // Any group this process is in other than its own stands in for the pod's.
  const group = process.getgroups?.().find((g) => g !== process.getgid?.());
  if (group === undefined) return;
  const other = join(dir, "grouped.sock");
  const grouped = new SessionDaemon({
    handlers: backend.handlers,
    deadPanes: async () => ({}),
    hasSession: async () => false,
    openTerminal: () => {
      throw new Error("unused");
    },
  });
  grouped.listen(other, group);
  try {
    expect(statSync(other).gid).toBe(group);
    expect(statSync(other).mode & 0o777).toBe(0o660);
  } finally {
    grouped.stop();
  }
});

test("requests reach the handlers and come back", async () => {
  backend.tmux.sessions.add("s1");
  expect(await client.call("host.listLive", null)).toEqual(["s1"]);
  backend.dead = { s1: 3 };
  expect(await client.call("deadPanes", null)).toEqual({ s1: 3 });
  await client.call("fs.write", {
    files: [{ path: "a.txt", base64: Buffer.from("hi").toString("base64") }],
  });
  expect(await client.call("fs.read", { path: "a.txt" })).toEqual({
    base64: Buffer.from("hi").toString("base64"),
  });
});

test("a request and a reply larger than one socket write arrive whole", async () => {
  // 6 MiB of base64 each way: far more than a Unix socket takes in one write.
  const bytes = Buffer.alloc(4 * 1024 * 1024);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = (index * 7) % 251;
  const base64 = bytes.toString("base64");
  await client.call("fs.write", { files: [{ path: "big.bin", base64 }] });
  const read = await client.call("fs.read", { path: "big.bin" });
  expect(read?.base64.length).toBe(base64.length);
  expect(read?.base64 === base64).toBe(true);
});

test("terminal output and input larger than one socket write arrive whole", async () => {
  backend.tmux.sessions.add("s1");
  let received = 0;
  const terminal = await client.openTerminal(
    "s1",
    { cols: 80, rows: 24 },
    (data) => (received += data.byteLength),
  );
  const big = 3 * 1024 * 1024;
  emit!(new Uint8Array(big).fill(120));
  // Four frames, each under the 1 MiB frame limit, 3 MiB in all.
  for (let frame = 0; frame < 4; frame++) terminal.write("y".repeat(big / 4));
  const written = () => terminalWrites.join("").length;
  for (let tries = 0; tries < 300 && received < big; tries++) await wait(10);
  for (let tries = 0; tries < 300 && written() < big; tries++) await wait(10);
  expect(received).toBe(big);
  expect(written()).toBe(big);
  const closed = terminal.start();
  endTerminal!();
  await closed;
});

test("handler errors keep their code", async () => {
  await expect(client.call("fs.read", { path: "../x" })).rejects.toMatchObject({
    code: "PATH_OUTSIDE_WORKSPACE",
  });
});

test("a method the daemon does not know is refused", async () => {
  await expect(
    client.call("nope" as never, null as never),
  ).rejects.toMatchObject({
    code: "UNKNOWN_METHOD",
  });
});

test("a terminal opens, streams output and takes input and resizes", async () => {
  backend.tmux.sessions.add("s1");
  const received: string[] = [];
  const terminal = await client.openTerminal(
    "s1",
    { cols: 100, rows: 30 },
    (data) => received.push(new TextDecoder().decode(data)),
  );
  emit!(new TextEncoder().encode("hello"));
  await wait();
  expect(received.join("")).toBe("hello");
  terminal.write("ls\r");
  terminal.resize(120, 40);
  await wait();
  expect(terminalWrites).toEqual(["ls\r"]);
  expect(terminalSizes).toEqual([
    [100, 30],
    [120, 40],
  ]);
  const closed = terminal.start();
  endTerminal!();
  await closed;
});

test("a terminal on a missing session fails with LOST", async () => {
  await expect(
    client.openTerminal("gone", { cols: 80, rows: 24 }, () => {}),
  ).rejects.toMatchObject({ code: "LOST" });
});

test("closing the runner side closes the terminal", async () => {
  backend.tmux.sessions.add("s1");
  const terminal = await client.openTerminal(
    "s1",
    { cols: 80, rows: 24 },
    () => {},
  );
  terminal.close();
  await terminal.start();
});

test("no daemon at the socket is SESSIOND_UNAVAILABLE", async () => {
  const lonely = new SessiondClient(join(dir, "missing.sock"), undefined, 1500);
  await expect(lonely.call("host.listLive", null)).rejects.toMatchObject({
    code: "SESSIOND_UNAVAILABLE",
  });
});

/** A server that is not sessiond: the impostor an agent could run. */
function impostor(onData: (send: (data: string | Uint8Array) => void) => void) {
  daemon.stop();
  const pending = new WeakMap<object, Uint8Array>();
  const flush = (s: Bun.Socket<undefined>) => {
    const rest = pending.get(s);
    if (!rest) return;
    const written = s.write(rest);
    if (written >= rest.length) pending.delete(s);
    else pending.set(s, rest.subarray(written));
  };
  return Bun.listen<undefined>({
    unix: socket,
    socket: {
      data: (s) =>
        onData((data) => {
          pending.set(s, typeof data === "string" ? Buffer.from(data) : data);
          flush(s);
        }),
      drain: flush,
      open() {},
      close() {},
    },
  });
}

test("a reply that never ends is cut at the size limit", async () => {
  // A small limit, and a timeout no machine load reaches, so the cut is what
  // ends the call. Sending 16 MiB raced the timeout on a busy machine.
  const limit = 64 * 1024;
  const capped = new SessiondClient(socket, undefined, 10 * 60_000, limit);
  const server = impostor((send) => send(Buffer.alloc(limit + 1024, 97)));
  await expect(capped.call("host.listLive", null)).rejects.toMatchObject({
    code: "SESSIOND_REPLY_TOO_LARGE",
  });
  server.stop(true);
});

test("an unreadable reply, an empty reply and a silent server all fail", async () => {
  let mode = 0;
  const server = impostor((send) => {
    if (mode === 0) send("not json\n");
    if (mode === 1) send("null\n");
    if (mode === 2) send('{"other":1}\n');
  });
  for (mode = 0; mode < 3; mode++)
    await expect(client.call("host.listLive", null)).rejects.toMatchObject({
      code: "SESSIOND_UNAVAILABLE",
    });
  mode = 3;
  await expect(client.call("host.listLive", null)).rejects.toMatchObject({
    code: "SESSIOND_TIMEOUT",
  });
  server.stop(true);
});

test("an error from a replaced daemon is cut and its code must look like ours", async () => {
  const server = impostor((send) =>
    send(
      `${JSON.stringify({ error: { code: "x; rm -rf", message: "m".repeat(100_000) } })}\n`,
    ),
  );
  const error = (await client.call("host.listLive", null).catch((e) => e)) as {
    code: string;
    message: string;
  };
  expect(error.code).toBe("FAILED");
  expect(error.message.length).toBe(4096);
  server.stop(true);
});

test("a terminal header that is too long or false is refused", async () => {
  let reply = "";
  const server = impostor((send) => send(reply));
  reply = `${"x".repeat(5000)}`;
  await expect(
    client.openTerminal("s", { cols: 80, rows: 24 }, () => {}),
  ).rejects.toMatchObject({ code: "SESSIOND_UNAVAILABLE" });
  reply = '{"ok":false}\n';
  await expect(
    client.openTerminal("s", { cols: 80, rows: 24 }, () => {}),
  ).rejects.toBeDefined();
  server.stop(true);
});

test("privateRuntimeFolder makes a 0700 folder and refuses what it cannot own", () => {
  const made = join(dir, "runtime");
  expect(privateRuntimeFolder(made)).toBe(made);
  expect(statSync(made).mode & 0o777).toBe(0o700);
  // A second start keeps it, and tightens a loosened mode.
  mkdirSync(join(dir, "loose"), { mode: 0o777 });
  expect(privateRuntimeFolder(join(dir, "loose"))).toBe(join(dir, "loose"));
  expect(statSync(join(dir, "loose")).mode & 0o777).toBe(0o700);
  writeFileSync(join(dir, "file"), "");
  expect(privateRuntimeFolder(join(dir, "file"))).toBeUndefined();
  symlinkSync(made, join(dir, "link"));
  expect(privateRuntimeFolder(join(dir, "link"))).toBeUndefined();
  expect(privateRuntimeFolder(join(dir, "missing", "deeper"))).toBeUndefined();
});

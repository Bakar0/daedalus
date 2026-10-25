import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShimRequest } from "./shim-protocol";
import { SocketWriter } from "@daedalus/remote-protocol";

const shim = join(import.meta.dir, "shim.ts");
const browser = join(import.meta.dir, "..", "daedal-browser");
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function runShim(
  args: string[],
  reply: (request: ShimRequest) => unknown,
  stdin: string | "open" = "",
  command = (dir: string) => ["bun", shim, ...args],
) {
  dir = mkdtempSync(join(tmpdir(), "runner-shim-"));
  const path = join(dir, "shim.sock");
  let seen: ShimRequest | undefined;
  const server = Bun.listen<{ chunks: Buffer[]; writer: SocketWriter }>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { chunks: [], writer: new SocketWriter(socket) };
      },
      drain(socket) {
        socket.data.writer.flush();
      },
      data(socket, chunk) {
        socket.data.chunks.push(Buffer.from(chunk));
        if (!chunk.includes(10)) return;
        seen = JSON.parse(
          Buffer.concat(socket.data.chunks).toString("utf8"),
        ) as ShimRequest;
        socket.data.writer.write(`${JSON.stringify(reply(seen))}\n`);
        socket.data.writer.end();
      },
    },
  });
  const child = Bun.spawn(command(dir), {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH!}`,
      DAEDALUS_RUNNER_SOCKET: path,
      DAEDALUS_SESSION_ID: "sess-1",
      DAEDALUS_RUNNER_TOKEN: "tok",
      DAEDALUS_MAC_KEY: "key",
      SECRET_THING: "no",
    },
    // "open": a pipe nobody writes to or closes, as a tool may leave it.
    stdin: stdin === "open" ? "pipe" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  server.stop(true);
  return { stdout, stderr, code, seen: seen! };
}

test("sends argv, DAEDALUS_ variables and stdin; prints the result and exits with its code", async () => {
  const run = await runShim(
    ["agent", "event", "stop"],
    () => ({ exitCode: 3, stdout: "out\n", stderr: "err\n" }),
    '{"hook":1}',
  );
  expect(run.code).toBe(3);
  expect(run.stdout).toBe("out\n");
  expect(run.stderr).toBe("err\n");
  expect(run.seen.argv).toEqual(["agent", "event", "stop"]);
  // The runner decides what may wait in its queue, from argv.
  expect(run.seen).not.toHaveProperty("queueable");
  expect(run.seen.stdin).toBe('{"hook":1}');
  expect(run.seen.env.DAEDALUS_SESSION_ID).toBe("sess-1");
  expect(run.seen.env.SECRET_THING).toBeUndefined();
  expect(run.seen.env.DAEDALUS_RUNNER_TOKEN).toBeUndefined();
  expect(run.seen.env.DAEDALUS_MAC_KEY).toBeUndefined();
  expect(Object.keys(run.seen.env)).toEqual(["DAEDALUS_SESSION_ID"]);
  expect(run.seen.cwd).toBe(".");
});

test("a request and a reply larger than one socket write arrive whole", async () => {
  // 900 KiB of stdin, under the runner's 1 MiB cap, and a 3 MiB reply of
  // characters that take two and three bytes, so chunks split them.
  const stdin = "é".repeat(450 * 1024);
  const stdout = "€".repeat(1024 * 1024);
  const run = await runShim(
    ["task", "update", "7", "--description-file", "-"],
    () => ({ exitCode: 0, stdout, stderr: "" }),
    stdin,
  );
  expect(run.code).toBe(0);
  expect(run.seen.stdin === stdin).toBe(true);
  expect(run.stdout.length).toBe(stdout.length);
  expect(run.stdout === stdout).toBe(true);
});

test("exits 75 when the runner socket is missing", async () => {
  dir = mkdtempSync(join(tmpdir(), "runner-shim-"));
  const child = Bun.spawn(["bun", shim, "x"], {
    env: { PATH: process.env.PATH!, DAEDALUS_RUNNER_SOCKET: join(dir, "none") },
    stdin: "ignore",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(75);
  expect(await new Response(child.stderr).text()).toContain("not reachable");
});

test("daedal-browser sends open-url with the URL, without waiting on stdin", async () => {
  const url = "https://claude.com/cai/oauth/authorize?code=true&state=s";
  const run = await runShim(
    [],
    () => ({ exitCode: 0, stdout: "", stderr: "" }),
    "open",
    (dir) => {
      // The pod's `daedal`, as the image installs it.
      mkdirSync(join(dir, "bin"));
      writeFileSync(
        join(dir, "bin", "daedal"),
        `#!/bin/sh\nexec bun ${shim} "$@"\n`,
      );
      chmodSync(join(dir, "bin", "daedal"), 0o755);
      return ["sh", browser, url];
    },
  );
  expect(run.code).toBe(0);
  expect(run.seen.argv).toEqual(["open-url", url]);
  expect(run.seen.stdin).toBe("");
  expect(run.seen.env.DAEDALUS_SESSION_ID).toBe("sess-1");
});

test("daedal-browser takes exactly one URL", async () => {
  const child = Bun.spawn(["sh", browser, "a", "b"], { stderr: "pipe" });
  expect(await child.exited).toBe(2);
});

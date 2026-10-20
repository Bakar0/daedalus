import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShimRequest } from "./shim-protocol";

const shim = join(import.meta.dir, "shim.ts");
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function runShim(
  args: string[],
  reply: (request: ShimRequest) => unknown,
  stdin = "",
) {
  dir = mkdtempSync(join(tmpdir(), "runner-shim-"));
  const path = join(dir, "shim.sock");
  let seen: ShimRequest | undefined;
  const server = Bun.listen<{ buffer: string }>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { buffer: "" };
      },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        if (!socket.data.buffer.includes("\n")) return;
        seen = JSON.parse(socket.data.buffer) as ShimRequest;
        socket.write(`${JSON.stringify(reply(seen))}\n`);
        socket.end();
      },
    },
  });
  const child = Bun.spawn(["bun", shim, ...args], {
    env: {
      PATH: process.env.PATH!,
      DAEDALUS_RUNNER_SOCKET: path,
      DAEDALUS_SESSION_ID: "sess-1",
      DAEDALUS_RUNNER_TOKEN: "tok",
      DAEDALUS_MAC_KEY: "key",
      SECRET_THING: "no",
    },
    stdin: new Blob([stdin]),
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

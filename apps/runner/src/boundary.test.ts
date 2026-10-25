import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadOrCreateIdentity } from "./identity";
import { EventQueue } from "./queue";

// H-1: a process in the session container, whose uid is not the runner's,
// must not reach the token, the identity key or the event queue. The pod
// spec keeps those volumes out of the session container; these tests keep
// the code on the session side from needing them, and the files private.

const IMPORT = /(?:from|import)\s+["'](\.\/[^"']+)["']/g;

/** Every local module `sessiond-main.ts` loads, with its source. */
function sessionSideSources(): Map<string, string> {
  const seen = new Map<string, string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const source = readFileSync(file, "utf8");
    seen.set(file, source);
    for (const match of source.matchAll(IMPORT))
      visit(resolve(dirname(file), `${match[1]}.ts`));
  };
  visit(join(import.meta.dir, "sessiond-main.ts"));
  return seen;
}

test("the session side never loads the runner's identity, queue, relay or token code", () => {
  const files = [...sessionSideSources().keys()].map((file) =>
    file.slice(import.meta.dir.length + 1),
  );
  for (const forbidden of [
    "identity.ts",
    "queue.ts",
    "runner.ts",
    "main.ts",
    "shim.ts",
    "sessiond-client.ts",
  ])
    expect(files).not.toContain(forbidden);
});

test("the session side never names the token, state or relay credentials", () => {
  for (const [file, source] of sessionSideSources())
    for (const forbidden of [
      "RUNNER_PATHS.token",
      "RUNNER_PATHS.state",
      "readToken",
      "identity.json",
      "queue.jsonl",
      "secretKey",
      "DAEDALUS_MAC_KEY",
    ])
      expect(
        source.includes(forbidden),
        `${file.slice(import.meta.dir.length + 1)} mentions ${forbidden}`,
      ).toBe(false);
});

test("the runner side never touches /workspace, tmux or workspace commands", () => {
  for (const name of [
    "runner.ts",
    "main.ts",
    "identity.ts",
    "queue.ts",
    "sessiond-client.ts",
  ]) {
    const source = readFileSync(join(import.meta.dir, name), "utf8");
    for (const forbidden of [
      "RUNNER_PATHS.workspace",
      "@daedalus/platform",
      "createHandlers",
      "Bun.spawn",
    ])
      expect(source.includes(forbidden), `${name} mentions ${forbidden}`).toBe(
        false,
      );
  }
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-modes-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("identity and queue files are private to the runner uid", async () => {
  const state = join(dir, "state");
  const identity = await loadOrCreateIdentity(state);
  expect(statSync(join(state, "identity.json")).mode & 0o777).toBe(0o600);
  expect(statSync(state).mode & 0o777).toBe(0o700);
  // The same key comes back, so the gateway's pin keeps matching.
  expect((await loadOrCreateIdentity(state)).publicKey).toBe(
    identity.publicKey,
  );
  const queue = new EventQueue(join(state, "queue.jsonl"));
  queue.push({
    callId: "1",
    argv: [],
    cwd: ".",
    env: {},
    queueable: true,
    at: "",
  });
  expect(statSync(join(state, "queue.jsonl")).mode & 0o777).toBe(0o600);
});

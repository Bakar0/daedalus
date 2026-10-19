import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTmux } from "./fake-tmux";
import { createHandlers, MAX_OUTPUT_BYTES, MAX_READ_BYTES } from "./handlers";

let root: string;
let tmux: FakeTmux;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-handlers-"));
  tmux = new FakeTmux();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const make = (extra: Partial<Parameters<typeof createHandlers>[0]> = {}) =>
  createHandlers({
    root,
    tmux,
    version: "0.1.0",
    baseEnv: { PATH: "/usr/bin", HOME: "/workspace/.home" },
    ...extra,
  });

test("host.start resolves cwd, merges secrets into env and owns PATH and HOME", async () => {
  const started: string[] = [];
  const handlers = make({ onSessionStarted: (s) => started.push(s) });
  await handlers["host.start"]({
    session: "daedalus_1",
    cwd: "repos/app",
    executable: "claude",
    args: ["--resume"],
    env: { FOO: "1", PATH: "/Users/mac/bin", HOME: "/Users/mac" },
    secrets: { ANTHROPIC_API_KEY: "sk-secret" },
  });
  const launch = tmux.launches[0]!;
  expect(launch.cwd).toBe(join(root, "repos/app"));
  expect(launch.env).toEqual({
    FOO: "1",
    ANTHROPIC_API_KEY: "sk-secret",
    PATH: "/usr/bin",
    HOME: "/workspace/.home",
  });
  expect(started).toEqual(["daedalus_1"]);
});

test("host.start refuses a cwd outside the workspace and starts nothing", async () => {
  const handlers = make();
  await expect(
    handlers["host.start"]({
      session: "s",
      cwd: "../etc",
      executable: "claude",
      args: [],
    }),
  ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  expect(tmux.launches).toEqual([]);
});

test("host.start rejects a bad session name", async () => {
  await expect(
    make()["host.start"]({
      session: "a b;rm",
      cwd: ".",
      executable: "x",
      args: [],
    }),
  ).rejects.toMatchObject({ code: "VALIDATION" });
});

test("tmux methods pass through", async () => {
  const handlers = make();
  tmux.sessions.add("s1");
  expect(await handlers["host.isLive"]({ session: "s1" })).toBe(true);
  expect(await handlers["host.listLive"](null)).toEqual(["s1"]);
  expect(await handlers["host.capture"]({ session: "s1" })).toBe(
    "screen of s1",
  );
  await handlers["host.sendKeys"]({ session: "s1", keys: ["Enter"] });
  await handlers["host.send"]({ session: "s1", text: "hi" });
  await handlers["host.stop"]({ session: "s1" });
  expect(tmux.keys).toEqual([["s1", ["Enter"]]]);
  expect(tmux.sent).toEqual([["s1", "hi"]]);
  expect(await handlers["host.isLive"]({ session: "s1" })).toBe(false);
  expect(await handlers["host.probe"](null)).toEqual({
    version: "0.1.0 tmux 3.5",
  });
});

test("host.run runs in cwd with a clean environment and cuts output to 1 MiB", async () => {
  let seen:
    { executable: string; options: Record<string, unknown> } | undefined;
  const handlers = make({
    run: async (executable, _args, options) => {
      seen = { executable, options: options as never };
      return {
        exitCode: 3,
        stdout: "x".repeat(MAX_OUTPUT_BYTES + 10),
        stderr: "e",
      };
    },
  });
  const result = await handlers["host.run"]({
    cwd: ".",
    executable: "git",
    args: ["clone"],
    secrets: { TOKEN: "t" },
  });
  expect(result.exitCode).toBe(3);
  expect(result.stdout.length).toBe(MAX_OUTPUT_BYTES);
  expect(seen?.options.replaceEnvironment).toBe(true);
  expect(seen?.options.env).toEqual({
    TOKEN: "t",
    PATH: "/usr/bin",
    HOME: "/workspace/.home",
  });
});

test("host.run really runs a command", async () => {
  const result = await make()["host.run"]({
    cwd: ".",
    executable: "/bin/sh",
    args: ["-c", "echo hi; echo err >&2; exit 2"],
  });
  expect(result).toEqual({ exitCode: 2, stdout: "hi\n", stderr: "err\n" });
});

test("fs.write then fs.read round trips and creates folders", async () => {
  const handlers = make();
  const base64 = Buffer.from("hello").toString("base64");
  await handlers["fs.write"]({ files: [{ path: "a/b/c.txt", base64 }] });
  expect(readFileSync(join(root, "a/b/c.txt"), "utf8")).toBe("hello");
  expect(await handlers["fs.read"]({ path: "a/b/c.txt" })).toEqual({ base64 });
  expect(await handlers["fs.read"]({ path: "missing" })).toBeNull();
});

test("fs.write checks every path before writing any", async () => {
  const handlers = make();
  const base64 = Buffer.from("x").toString("base64");
  await expect(
    handlers["fs.write"]({
      files: [
        { path: "ok.txt", base64 },
        { path: "../bad.txt", base64 },
      ],
    }),
  ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  expect(existsSync(join(root, "ok.txt"))).toBe(false);
});

test("fs.read refuses large files and the state folder", async () => {
  const handlers = make();
  writeFileSync(join(root, "big"), Buffer.alloc(MAX_READ_BYTES + 1));
  await expect(handlers["fs.read"]({ path: "big" })).rejects.toMatchObject({
    code: "TOO_LARGE",
  });
  await expect(
    handlers["fs.read"]({ path: ".daedalus-runner/identity.json" }),
  ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  await expect(
    handlers["fs.write"]({
      files: [{ path: ".daedalus-runner/queue.jsonl", base64: "" }],
    }),
  ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
});

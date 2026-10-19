import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DaedalCall } from "@daedalus/remote-protocol";
import type { AgentSession, Task, Workspace } from "../domain";
import {
  CloudCalls,
  decideCall,
  mapCloudDirectory,
  REFUSED_EXIT_CODE,
} from "./cloud-calls";
import { CLOUD_CALLER_VARIABLE } from "./cloud-launch";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const HOST = `ws:${WS}`;
const SESSION = "33333333-3333-4333-8333-333333333333";
const LOCAL_SESSION = "44444444-4444-4444-8444-444444444444";
const OTHER_TASK = "55555555-5555-4555-8555-555555555555";
const OWN_TASK = "66666666-6666-4666-8666-666666666666";

let root: string;
const agents: Record<string, Partial<AgentSession>> = {
  [SESSION]: { id: SESSION, workspaceId: WS, hostId: HOST, taskId: OWN_TASK },
  [LOCAL_SESSION]: { id: LOCAL_SESSION, workspaceId: WS, hostId: null },
};
const tasks: Record<string, Partial<Task>> = {
  [OTHER_TASK]: { id: OTHER_TASK, workspaceId: OTHER_WS, number: 1 },
  [OWN_TASK]: { id: OWN_TASK, workspaceId: WS, number: 7 },
};
const repositories = {
  findAgent: (id: string) => agents[id] as AgentSession | undefined,
  findTask: (id: string) => tasks[id] as Task | undefined,
  findWorkspace: (id: string) =>
    id === WS
      ? ({ id, path: join(root, "workspace") } as Workspace)
      : undefined,
};

const decide = (argv: string[], env: Record<string, string> = {}) =>
  decideCall(repositories, HOST, {
    argv,
    env: { DAEDALUS_SESSION_ID: SESSION, ...env },
  });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "daedalus-cloud-calls-"));
  await mkdir(join(root, "workspace", "repos", "api"), { recursive: true });
  await mkdir(join(root, "outside"), { recursive: true });
  await symlink(join(root, "outside"), join(root, "workspace", "escape"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("cloud daedal calls", () => {
  test("allows a hook event and pins the session", () => {
    expect(
      decide(["agent", "event", "Stop", "--session", SESSION]),
    ).toMatchObject({
      allowed: true,
      argv: ["agent", "event", "Stop", "--session", SESSION],
      sessionId: SESSION,
    });
  });

  test("refuses spawn with a command, exec and secrets", () => {
    for (const argv of [
      ["agent", "spawn", "--command", "/bin/sh"],
      ["exec", "--secret", "TOKEN", "--", "env"],
      ["secret", "get", "TOKEN"],
      ["repo", "add", "/Users/me/private"],
      ["workspace", "list"],
      ["agent", "continue"],
    ])
      expect(decide(argv)).toMatchObject({ allowed: false });
  });

  test("refuses a session on another host or this Mac", () => {
    expect(
      decide(["agent", "event", "Stop", "--session", LOCAL_SESSION]),
    ).toMatchObject({ allowed: false });
    expect(
      decide(["attention", "Help"], { DAEDALUS_SESSION_ID: LOCAL_SESSION }),
    ).toMatchObject({ allowed: false });
  });

  test("keeps team commands to the session's own team, never as the user", () => {
    expect(decide(["team", "say", "@lead", "done"])).toMatchObject({
      allowed: true,
      argv: ["team", "say", "@lead", "done"],
    });
    expect(decide(["team", "say", "hi", "--user"])).toMatchObject({
      allowed: false,
    });
    expect(decide(["team", "chat", "--team", "other"])).toMatchObject({
      allowed: false,
    });
  });

  test("pins tasks and sessions to the host's workspace", () => {
    expect(decide(["task", "list", "--json"])).toMatchObject({
      allowed: true,
      argv: ["task", "list", "--workspace", WS, "--json"],
    });
    expect(decide(["task", "list", "--workspace", OTHER_WS])).toMatchObject({
      allowed: false,
    });
    expect(decide(["task", "get", OTHER_TASK])).toMatchObject({
      allowed: false,
    });
    expect(decide(["task", "get", "other#1"])).toMatchObject({
      allowed: false,
    });
    expect(decide(["task", "update", "#7", "--title", "New"])).toMatchObject({
      allowed: true,
      argv: ["task", "update", "#7", "--title", "New", "--workspace", WS],
    });
    expect(
      decide(["task", "update", "7", "--description-file", "/etc/passwd"]),
    ).toMatchObject({ allowed: false });
    expect(
      decide(["task", "update", "7", "--description-file", "-"]),
    ).toMatchObject({ allowed: true });
    expect(decide(["agent", "get", LOCAL_SESSION])).toMatchObject({
      allowed: true,
    });
    expect(decide(["agent", "list"])).toMatchObject({
      allowed: true,
      argv: ["agent", "list", "--workspace", WS],
    });
  });

  test("refuses an option hidden in a value or a positional", () => {
    expect(
      decide(["task", "update", "7", "--title", "--workspace"]),
    ).toMatchObject({ allowed: false });
    expect(decide(["attention", "-x"])).toMatchObject({ allowed: false });
    expect(decide(["team", "say", "--", "--user"])).toMatchObject({
      allowed: false,
    });
  });

  test("maps a pod folder inside the workspace only", async () => {
    const workspace = join(root, "workspace");
    expect(await mapCloudDirectory(workspace, ".")).toBe(
      await import("node:fs/promises").then((fs) => fs.realpath(workspace)),
    );
    expect(await mapCloudDirectory(workspace, "repos/api")).toContain(
      join("repos", "api"),
    );
    expect(await mapCloudDirectory(workspace, "not/here/yet")).toContain(
      join("not", "here", "yet"),
    );
    expect(await mapCloudDirectory(workspace, "../..")).toBeUndefined();
    expect(await mapCloudDirectory(workspace, "/etc")).toBeUndefined();
    expect(await mapCloudDirectory(workspace, "escape")).toBeUndefined();
    expect(await mapCloudDirectory(workspace, "escape/deeper")).toBeUndefined();
  });

  test("runs an allowed call as the Mac's daedal, and answers a replay from memory", async () => {
    const runs: Array<{
      executable: string;
      args: string[];
      options: Record<string, unknown>;
    }> = [];
    const calls = new CloudCalls({
      repositories,
      home: "/mac/home",
      daedal: ["/mac/home/bin/daedal"],
      run: async (executable, args, options = {}) => {
        runs.push({ executable, args, options: options as never });
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      },
    });
    const call: DaedalCall = {
      callId: "c1",
      argv: ["agent", "event", "Stop"],
      cwd: ".",
      env: { DAEDALUS_SESSION_ID: SESSION, DAEDALUS_HOME: "/pod/evil" },
      stdin: JSON.stringify({ transcript_path: "/dev/zero", session_id: "x" }),
      queueable: true,
      at: new Date().toISOString(),
    };
    expect(await calls.answer(HOST, call)).toEqual({
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
    });
    expect(await calls.answer(HOST, call)).toMatchObject({ exitCode: 0 });
    expect(runs).toHaveLength(1);
    const { executable, args, options } = runs[0]!;
    expect(executable).toBe("/mac/home/bin/daedal");
    expect(args).toEqual(["agent", "event", "Stop"]);
    expect(options.replaceEnvironment).toBe(true);
    expect(options.env).toMatchObject({
      DAEDALUS_HOME: "/mac/home",
      DAEDALUS_SESSION_ID: SESSION,
      DAEDALUS_TASK_NUMBER: "7",
      [CLOUD_CALLER_VARIABLE]: HOST,
    });
    expect(JSON.parse(options.stdin as string)).toEqual({ session_id: "x" });
  });

  test("refuses with exit code 77 before anything runs", async () => {
    let ran = false;
    const calls = new CloudCalls({
      repositories,
      home: "/mac/home",
      daedal: ["/mac/home/bin/daedal"],
      run: async () => {
        ran = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const base = {
      cwd: ".",
      env: { DAEDALUS_SESSION_ID: SESSION },
      queueable: false,
      at: new Date().toISOString(),
    };
    const spawn = await calls.answer(HOST, {
      ...base,
      callId: "spawn",
      argv: ["agent", "spawn", "--command", "/bin/sh"],
    });
    expect(spawn.exitCode).toBe(REFUSED_EXIT_CODE);
    expect(spawn.stderr).toContain("not allowed from a cloud session");
    const exec = await calls.answer(HOST, {
      ...base,
      callId: "exec",
      argv: ["exec", "--secret", "TOKEN", "--", "env"],
    });
    expect(exec.exitCode).toBe(REFUSED_EXIT_CODE);
    const escape = await calls.answer(HOST, {
      ...base,
      callId: "escape",
      cwd: "../..",
      argv: ["team", "list"],
    });
    expect(escape.exitCode).toBe(REFUSED_EXIT_CODE);
    expect(escape.stderr).toContain("outside the workspace");
    expect(ran).toBe(false);
  });
});

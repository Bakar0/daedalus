import { join } from "node:path";
import { expect, test } from "vitest";
import {
  NO_LOGIN_SHELL,
  withTemporaryDaedalusHome,
} from "@daedalus/test-utils";
import { threadAlias } from "./asks";

async function cli(home: string, args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...NO_LOGIN_SHELL,
    DAEDALUS_HOME: home,
  };
  // Run as the user, not as the session this suite may be running in.
  for (const name of Object.keys(env))
    if (name.startsWith("DAEDALUS_") && name !== "DAEDALUS_HOME")
      delete env[name];
  delete env.TMUX;
  const child = Bun.spawn(
    [process.execPath, "run", join(import.meta.dir, "index.ts"), ...args],
    { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

test("daedal activity and daedal ask map to daedal thread", () => {
  expect(threadAlias(["ask", "Which index?", "--why", "x"])).toEqual([
    "thread",
    "start",
    "Which index?",
    "--why",
    "x",
  ]);
  expect(threadAlias(["activity", "ask", "Which index?"])).toEqual([
    "thread",
    "start",
    "Which index?",
  ]);
  expect(threadAlias(["activity", "withdraw", "3", "done"])).toEqual([
    "thread",
    "close",
    "3",
    "done",
  ]);
  expect(threadAlias(["ask", "resolve", "3", "--answer", "yes"])).toEqual([
    "thread",
    "resolve",
    "3",
    "--answer",
    "yes",
  ]);
  expect(threadAlias(["activity", "list", "--team"])).toEqual([
    "thread",
    "list",
    "--team",
  ]);
  expect(threadAlias(["ask"])).toEqual(["thread"]);
  expect(threadAlias(["thread", "bump", "2"])).toEqual(["thread", "bump", "2"]);
  expect(threadAlias(["plan", "ask", "cart"])).toEqual(["plan", "ask", "cart"]);
});

test("thread commands, with daedal activity and daedal ask kept as aliases", async () => {
  await withTemporaryDaedalusHome(async (home) => {
    const help = await cli(home, ["--help"]);
    expect(help.stdout).toContain("daedal thread <start|");
    expect(help.stdout).not.toContain("daedal ask");

    const threadHelp = await cli(home, ["thread", "--help"]);
    expect(threadHelp.stdout).toContain('daedal thread start "<question>"');
    expect((await cli(home, ["activity", "--help"])).stdout).toBe(
      threadHelp.stdout,
    );
    expect((await cli(home, ["ask", "--help"])).stdout).toBe(threadHelp.stdout);

    // Outside a session a thread is refused the same way by every form.
    const started = await cli(home, ["thread", "start", "Which index?"]);
    expect(started.exitCode).not.toBe(0);
    expect(started.stderr).toContain("--session <session>");
    for (const old of [
      ["activity", "ask", "Which index?"],
      ["ask", "Which index?"],
    ]) {
      const aliased = await cli(home, old);
      expect(aliased.exitCode).toBe(started.exitCode);
      expect(aliased.stderr).toBe(started.stderr);
    }

    const listed = await cli(home, ["activity", "list", "--all", "--json"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout).data).toEqual([]);

    const unknown = await cli(home, ["thread", "frobnicate"]);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain("Unknown thread command");
  });
});

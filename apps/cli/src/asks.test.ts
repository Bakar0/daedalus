import { join } from "node:path";
import { expect, test } from "vitest";
import {
  NO_LOGIN_SHELL,
  withTemporaryDaedalusHome,
} from "@daedalus/test-utils";
import { activityAlias } from "./asks";

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

test("daedal ask maps to daedal activity", () => {
  expect(activityAlias(["ask", "Which index?", "--why", "x"])).toEqual([
    "activity",
    "ask",
    "Which index?",
    "--why",
    "x",
  ]);
  expect(activityAlias(["ask", "resolve", "3", "--answer", "yes"])).toEqual([
    "activity",
    "resolve",
    "3",
    "--answer",
    "yes",
  ]);
  expect(activityAlias(["ask", "list", "--team"])).toEqual([
    "activity",
    "list",
    "--team",
  ]);
  expect(activityAlias(["ask"])).toEqual(["activity"]);
  expect(activityAlias(["plan", "ask", "cart"])).toEqual([
    "plan",
    "ask",
    "cart",
  ]);
});

test("activity commands, with daedal ask kept as a hidden alias", async () => {
  await withTemporaryDaedalusHome(async (home) => {
    const help = await cli(home, ["--help"]);
    expect(help.stdout).toContain("daedal activity <ask|");
    expect(help.stdout).not.toContain("daedal ask");

    const activityHelp = await cli(home, ["activity", "--help"]);
    expect(activityHelp.stdout).toContain('daedal activity ask "<question>"');
    expect(activityHelp.stdout).not.toContain("Needs you");
    expect((await cli(home, ["ask", "--help"])).stdout).toBe(
      activityHelp.stdout,
    );

    // Outside a session an ask is refused the same way by both forms.
    const asked = await cli(home, ["activity", "ask", "Which index?"]);
    expect(asked.exitCode).not.toBe(0);
    expect(asked.stderr).toContain("--session <session>");
    const aliased = await cli(home, ["ask", "Which index?"]);
    expect(aliased.exitCode).toBe(asked.exitCode);
    expect(aliased.stderr).toBe(asked.stderr);

    const listed = await cli(home, ["ask", "list", "--all", "--json"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout).data).toEqual([]);

    const unknown = await cli(home, ["activity", "frobnicate"]);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain("Unknown activity command");
  });
});

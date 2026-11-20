import { join } from "node:path";
import { expect, test } from "vitest";
import {
  NO_LOGIN_SHELL,
  withTemporaryDaedalusHome,
} from "@daedalus/test-utils";
import { oldThreadAlias, oldThreadCommand, sinceTime } from "./thread";

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

const instead = (message: string | undefined) =>
  message?.split("\n").find((line) => line.startsWith("  daedal thread "));

test("each old thread command names the command to run instead, from its own arguments", () => {
  expect(
    instead(
      oldThreadCommand([
        "start",
        "How many retries?",
        "--why",
        "The config waits on it.",
        "--option",
        "3",
        "--option",
        "5",
        "--recommend",
        "2",
        "--context",
        "load test: both pass",
      ]),
    ),
  ).toBe(
    '  daedal thread new "How many retries? The config waits on it." --option 3 --option 5 --details "load test: both pass"',
  );
  expect(
    instead(
      oldThreadCommand([
        "start",
        "Skip?",
        "--plan",
        "cutover",
        "^fix",
        "--session",
        "lead",
      ]),
    ),
  ).toBe('  daedal thread new "Skip?" --plan cutover ^fix --session lead');
  expect(instead(oldThreadCommand(["show", "12"]))).toBe(
    "  daedal thread read 12",
  );
  expect(
    instead(oldThreadCommand(["update", "12", "--title", "Five retries?"])),
  ).toBe('  daedal thread say 12 "Five retries?"');
  expect(
    instead(oldThreadCommand(["resolve", "12", "--answer", "5 tries"])),
  ).toBe('  daedal thread resolve 12 "the user answered: 5 tries"');
  expect(instead(oldThreadCommand(["close", "12", "not needed"]))).toBe(
    '  daedal thread resolve 12 "not needed"',
  );
  expect(
    instead(oldThreadCommand(["say", "12", "Merged?", "--why", "CI is red"])),
  ).toBe('  daedal thread say 12 "Merged? CI is red"');
  const message = oldThreadCommand(["start", "x"])!;
  expect(message).toContain(
    "Daedalus 0.40.0-beta.7 changed thread commands; your instructions are older.",
  );
  expect(message).toContain("Nothing was written.");
  expect(message).toContain("Run 'daedal thread --help'");
  // The current commands are not old ones.
  for (const args of [
    ["new", "x", "--option", "a", "--details", "y"],
    ["say", "3", "ok"],
    ["read", "3"],
    ["resolve", "3", "done"],
    ["find", "images"],
  ])
    expect(oldThreadCommand(args)).toBeUndefined();
});

test("daedal ask and daedal activity are gone, and say what to run", () => {
  expect(instead(oldThreadAlias(["ask", "Which index?"]))).toBe(
    '  daedal thread new "Which index?"',
  );
  expect(instead(oldThreadAlias(["activity", "ask", "Which index?"]))).toBe(
    '  daedal thread new "Which index?"',
  );
  expect(instead(oldThreadAlias(["activity", "withdraw", "3", "done"]))).toBe(
    "  daedal thread resolve 3 done",
  );
  expect(oldThreadAlias(["activity", "list", "--team"])).toContain(
    "Run instead: daedal thread list --team",
  );
  expect(oldThreadAlias(["thread", "list"])).toBeUndefined();
  expect(oldThreadAlias(["plan", "ask", "cart"])).toBeUndefined();
});

test("--since takes days, hours, minutes or a time", () => {
  const now = new Date("2026-11-20T12:00:00.000Z");
  expect(sinceTime("14d", now)).toBe("2026-11-06T12:00:00.000Z");
  expect(sinceTime("48h", now)).toBe("2026-11-18T12:00:00.000Z");
  expect(sinceTime("90m", now)).toBe("2026-11-20T10:30:00.000Z");
  expect(sinceTime("2026-11-01", now)).toBe("2026-11-01T00:00:00.000Z");
  expect(() => sinceTime("soon", now)).toThrow("--since takes");
});

test("thread commands through the CLI; old ones fail with exit 2 and write nothing", async () => {
  await withTemporaryDaedalusHome(async (home) => {
    const help = await cli(home, ["--help"]);
    expect(help.stdout).toContain("daedal thread <new|say|read|find|");
    const threadHelp = await cli(home, ["thread", "--help"]);
    expect(threadHelp.stdout).toContain('daedal thread new "<message>"');
    expect(threadHelp.stdout).toContain('daedal thread find "<words>"');

    for (const old of [
      ["thread", "start", "Which index?", "--why", "x"],
      ["ask", "Which index?"],
      ["activity", "ask", "Which index?"],
      ["thread", "show", "3"],
    ]) {
      const result = await cli(home, old);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("changed thread commands");
      expect(result.stderr).toContain("Run instead:");
    }

    // Outside a session a new thread is refused.
    const opened = await cli(home, ["thread", "new", "Which index?"]);
    expect(opened.exitCode).toBe(2);
    expect(opened.stderr).toContain("--session <session>");

    const listed = await cli(home, ["thread", "list", "--all", "--json"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout).data).toEqual([]);
    const found = await cli(home, ["thread", "find", "index", "--all"]);
    expect(found.exitCode).toBe(0);
    expect(found.stdout).toContain("No thread matches 'index'");

    const unknown = await cli(home, ["thread", "frobnicate"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain("Unknown thread command");
  });
});

test("an old 'thread start' names threads on the same subject and how to write in one", () => {
  const text = oldThreadCommand(
    [
      "start",
      "How long should the docs site cache images?",
      "--option",
      "1 day",
      "--option",
      "7 days",
    ],
    (message) =>
      message.includes("cache")
        ? [{ number: 25, title: "What cache TTL should the docs site use?" }]
        : [],
  )!;
  expect(text).toContain("These threads may be about the same thing:");
  expect(text).toContain("  #25 What cache TTL should the docs site use?");
  expect(text).toContain(
    '  daedal thread say 25 "How long should the docs site cache images?" --option "1 day" --option "7 days"',
  );
  expect(text).toContain(
    '  daedal thread new "How long should the docs site cache images?" --option "1 day" --option "7 days"',
  );
});

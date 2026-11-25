import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  NO_LOGIN_SHELL,
  withTemporaryDaedalusHome,
} from "@daedalus/test-utils";
import { replayJobs, type JobEvent, type JobSpec } from "@daedalus/core";
import { jobTreeLines } from "./job";

const spec = (
  id: string,
  parentId: string | null,
  position: number,
  more: Partial<JobSpec> = {},
): JobSpec => ({
  id,
  parentId,
  name: id,
  title: id,
  instructions: "",
  needs: [],
  gives: [],
  gate: null,
  runner: { kind: "inline" },
  auto: false,
  loop: null,
  source: null,
  position,
  ...more,
});

const events: JobEvent[] = [
  {
    jobId: "root",
    type: "added",
    spec: spec("root", null, 0, {
      title: "Checkout v2",
      name: "work",
      runner: { kind: "session", sessionId: "lead" },
    }),
  },
  { jobId: "root", type: "started", sessionId: "lead" },
  {
    jobId: "plan",
    type: "added",
    spec: spec("plan", "root", 0, { gives: [{ name: "plan", kind: "file" }] }),
  },
  {
    jobId: "build",
    type: "added",
    spec: spec("build", "root", 1, { gate: "result", needs: ["plan"] }),
  },
  {
    jobId: "api",
    type: "added",
    spec: spec("api", "build", 0, {
      title: "Cart API",
      runner: { kind: "agent" },
    }),
  },
  { jobId: "plan", type: "started", sessionId: "lead" },
  {
    jobId: "plan",
    type: "output",
    name: "plan",
    kind: "file",
    value: "plans/checkout.plan.md",
  },
  { jobId: "plan", type: "done", result: "Plan with 4 tasks" },
  { jobId: "build", type: "started", sessionId: "lead" },
  { jobId: "api", type: "started", sessionId: "worker-1" },
  { jobId: "api", type: "held", reason: "hold", why: "Which database?" },
];

describe("jobTreeLines", () => {
  test("prints each job with its state, its runner and what came out", () => {
    expect(
      jobTreeLines(replayJobs(events), {
        here: "build",
        sessionName: (id) => (id === "lead" ? "Lead" : "Cart worker"),
      }),
    ).toEqual([
      "▶ Checkout v2 [work] (@Lead)",
      "  ✓ plan — Plan with 4 tasks",
      "      plan = plans/checkout.plan.md",
      "  ▶ build (gate: result)  ←",
      "    ⏸ Cart API [api] (waits for the user) (@Cart worker) — Which database?",
    ]);
  });
});

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

test("the state commands that are gone say what replaced them", async () => {
  await withTemporaryDaedalusHome(async (home) => {
    const cases: [string[], string][] = [
      [["workflow", "step", "build", "done", "--note", "x"], "daedal job done"],
      [["workflow", "approve"], "daedal job approve"],
      [["workflow", "status"], "daedal job tree"],
      [["workflow", "end"], "daedal job done --job"],
      [["plan", "start", "cart", "^api"], "daedal job add --plan"],
      [["plan", "submit", "cart", "^api", "Done"], "daedal job done"],
      [["plan", "block", "cart", "^api"], "daedal job hold"],
    ];
    for (const [args, replacement] of cases) {
      const ran = await cli(home, args);
      expect(ran.exitCode).not.toBe(0);
      expect(ran.stderr).toContain("is gone");
      expect(ran.stderr).toContain(replacement);
    }
    const outside = await cli(home, ["job", "next"]);
    expect(outside.exitCode).not.toBe(0);
    expect(outside.stderr).toContain("--session");
    expect((await cli(home, ["job", "help"])).stdout).toContain(
      "daedal job done --result",
    );
  });
}, 60_000);

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  createApplicationContext,
  describeSchedule,
  parseTranscript,
  parseWhen,
  readOutcome,
  ROUTINE_RUN_SYSTEM_PROMPT,
  type ApplicationContext,
  type RoutineSpawner,
} from "../index";

describe("parseWhen", () => {
  test.each([
    ["weekdays 9:00", 'cron "0 9 * * 1-5"'],
    ["every day at 19:00", 'cron "0 19 * * *"'],
    ["fridays 9", 'cron "0 9 * * 5"'],
    ["sun to thu at 8, 10, 13, 16", 'cron "0 8,10,13,16 * * 0-4"'],
    ["mon and wed 8:30", 'cron "30 8 * * 1,3"'],
    ["hourly", 'cron "0 * * * *"'],
    ["every 30m", "every 30m"],
    ['cron "*/15 9-18 * * 1-5"', 'cron "*/15 9-18 * * 1-5"'],
  ])("%s", (input, stored) => {
    expect(parseWhen(input)).toBe(stored);
  });

  test("refuses a schedule with no time", () => {
    expect(() => parseWhen("weekdays")).toThrow(/Add a time/);
  });
});

describe("describeSchedule", () => {
  test.each([
    ['cron "0 8,10,13,16 * * 0-4"', "Sun to Thu at 08:00, 10:00, 13:00, 16:00"],
    ['cron "0 9 * * 1-5"', "Weekdays at 09:00"],
    ['cron "0 19 * * *"', "Every day at 19:00"],
    ['cron "0 9 * * 5"', "Fridays at 09:00"],
    ["every 30m", "Every 30 min"],
    ["every 2h", "Every 2 hours"],
    ['cron "*/15 9-18 * * 1-5"', 'cron "*/15 9-18 * * 1-5"'],
  ])("%s", (stored, words) => {
    expect(describeSchedule(stored)).toBe(words);
  });
});

test("parseTranscript keeps text, tools and the result once", () => {
  const log = [
    { type: "system", subtype: "init" },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "ls -la\nmore" },
          },
        ],
      },
    },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "All green.\nDetails." }] },
    },
    { type: "result", subtype: "success", result: "All green.\nDetails." },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  expect(parseTranscript(log)).toEqual([
    { kind: "tool", text: "Bash ls -la" },
    { kind: "result", text: "All green.\nDetails." },
  ]);
});

describe("readOutcome", () => {
  test.each([
    ["OK: Quiet run.", "ok", "Quiet run."],
    ["ok - nothing new", "ok", "nothing new"],
    ["ATTENTION: SSO token expired.", "attention", "SSO token expired."],
    [
      "**ATTENTION:** kubectl can't reach stg",
      "attention",
      "kubectl can't reach stg",
    ],
    ["**OK**: All clear", "ok", "All clear"],
    // No word: never shown as all clear.
    ["Ingest lag in prod-eu.", "attention", "Ingest lag in prod-eu."],
    ["Okay, nothing found.", "attention", "Okay, nothing found."],
    ["OK.", "attention", "OK."],
  ])("%s", (line, outcome, summary) => {
    expect(readOutcome(line)).toEqual({ outcome, summary });
  });
});

class NoTmux {
  openPty() {
    return { start: async () => {}, write() {}, resize() {}, close() {} };
  }
  async pinWindowSize() {}
  async unpinWindowSize() {}
  async probe() {
    return "tmux 3.7c";
  }
  // Sessions start and stay up, as the Routines agent needs.
  readonly sessions = new Set<string>();
  async createSession(launch: { session: string }) {
    this.sessions.add(launch.session);
  }
  async hasSession(session: string) {
    return this.sessions.has(session);
  }
  async listSessions() {
    return [...this.sessions];
  }
  async stop(session: string) {
    this.sessions.delete(session);
  }
  async attach() {
    return 0;
  }
  // Claude at its prompt, so a launch counts as started.
  async capture() {
    return [
      "⏺ Ready.",
      "─".repeat(32),
      "❯ ",
      "─".repeat(32),
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
    ].join("\n");
  }
  async sendText() {}
  async sendKeys() {}
  async killSession() {}
  async setEnvironment() {}
  async displayMessage() {
    return "";
  }
}

async function withRoutines(
  spawner: RoutineSpawner,
  clock: { now: Date; notes?: Array<{ title: string; body: string }> },
  body: (context: ApplicationContext, home: string) => Promise<void>,
): Promise<void> {
  await withTemporaryDaedalusHome(async (home) => {
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        agents: { claude: { executable: process.execPath, args: ["run"] } },
      }),
    );
    const context = await createApplicationContext({
      env: {
        DAEDALUS_HOME: home,
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        CODEX_HOME: join(home, "codex"),
        DAEDALUS_AGENTS_HOME: join(home, "agents"),
        DAEDALUS_CURSOR_HOME: join(home, "cursor"),
      },
      tmux: new NoTmux() as unknown as TmuxClient,
      reconcile: false,
      routineSpawner: spawner,
      // The Routines agent's first message reaches it through its inbox.
      sessionInbox: async () => true,
      // Never the real Notification Center.
      sendNativeNotification: async (note) => {
        clock.notes?.push({ title: note.title, body: note.body });
        return { delivered: true, backend: "app" as const, degraded: false };
      },
      now: () => clock.now,
    });
    try {
      await body(context, home);
    } finally {
      context.close();
    }
  });
}

/** A provider that writes one answer to the log and exits. */
function fakeClaude(answer: string, calls: string[][] = []): RoutineSpawner {
  return (input) => {
    calls.push(input.args);
    const exited = Bun.write(
      input.logPath,
      [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: answer }] },
        },
        { type: "result", subtype: "success", result: answer },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    ).then(() => 0);
    return { exited, kill() {} };
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A provider that keeps running until the test ends. */
function neverEnds(): RoutineSpawner {
  return () => ({ exited: new Promise<number>(() => {}), kill() {} });
}

describe("RoutineService", () => {
  test("runs a due routine headless in its workspace and keeps its answer", async () => {
    const clock = { now: new Date(2026, 9, 28, 12, 59, 0) };
    const calls: string[][] = [];
    await withRoutines(
      fakeClaude("Ingest lag in prod-eu.\nMore below.", calls),
      clock,
      async (context) => {
        const workspace = await context.workspaces.create({
          name: "On call",
          slug: "on-call",
        });
        const routine = context.routines.add({
          workspace: "on-call",
          when: "sun to thu at 8, 10, 13, 16",
          prompt: "Check env health.",
        });
        expect(routine.name).toBe("check-env-health");
        expect(routine.nextRunAt).toBe(
          new Date(2026, 9, 28, 13, 0, 0).toISOString(),
        );

        expect(await context.routines.tick()).toEqual([]);
        clock.now = new Date(2026, 9, 28, 13, 0, 5);
        const [started] = await context.routines.tick();
        expect(started?.status).toBe("running");
        expect(started?.workingDirectory).toBe(workspace.path);
        expect(calls[0]).toContain("--permission-prompts");
        expect(calls[0]).toContain(ROUTINE_RUN_SYSTEM_PROMPT);
        expect(calls[0]![1]).toContain("Check env health.");
        expect(calls[0]![1]).toContain("`OK:`");

        await settle();
        const [view] = context.routines.list();
        expect(
          view!.recentRuns.map((run) => [run.status, run.outcome, run.summary]),
        ).toEqual([["done", "attention", "Ingest lag in prod-eu."]]);
        expect(view!.routine.nextRunAt).toBe(
          new Date(2026, 9, 28, 16, 0, 0).toISOString(),
        );
        expect((await context.routines.transcript(started!.id)).at(-1)).toEqual(
          {
            kind: "result",
            text: "Ingest lag in prod-eu.\nMore below.",
          },
        );

        // The next run is told what this one said.
        clock.now = new Date(2026, 9, 28, 16, 0, 1);
        await context.routines.tick();
        expect(calls[1]![1]).toContain(
          "said: ATTENTION: Ingest lag in prod-eu.",
        );
        await settle();
      },
    );
  });

  test("the Routines agent is one session, kept through archive and rebirth", async () => {
    const clock = { now: new Date(2026, 9, 28, 12, 0, 0) };
    await withRoutines(fakeClaude("Done."), clock, async (context) => {
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      await context.workspaces.create({ name: "Web", slug: "web" });
      const first = await context.routines.agent("ops");
      expect(first).toMatchObject({ name: "Routines", provider: "claude" });
      // Asked from another workspace, it is still the same session.
      expect((await context.routines.agent("web")).id).toBe(first.id);

      await context.agents.archive(first.id);
      const restored = await context.routines.agent("web");
      expect(restored.id).toBe(first.id);
      expect(restored.archivedAt).toBeNull();

      // A rebirth hands it to the successor, as it does abilities.
      const successor = await context.agents.spawn({
        workspace: "ops",
        provider: "claude",
        name: "Routines · 2",
      });
      context.repositories.routines.moveAgent(first.id, successor.id);
      expect((await context.routines.agent("ops")).id).toBe(successor.id);
    });
    // Two sessions start, which takes seconds on a loaded machine.
  }, 20_000);

  test("an OK run is read already and sends no alert", async () => {
    const clock = {
      now: new Date(2026, 9, 28, 12, 0, 0),
      notes: [] as Array<{ title: string; body: string }>,
    };
    await withRoutines(
      fakeClaude("OK: Quiet run, nothing needs a person."),
      clock,
      async (context) => {
        await context.workspaces.create({ name: "Ops", slug: "ops" });
        context.routines.add({
          workspace: "ops",
          when: "every day at 19:00",
          prompt: "Check env health.",
          name: "health",
        });
        const run = await context.routines.runNow("health");
        await settle();
        const done = context.repositories.routines.findRun(run.id);
        expect(done?.outcome).toBe("ok");
        expect(done?.summary).toBe("Quiet run, nothing needs a person.");
        expect(context.repositories.routines.unseenRunIds()).toEqual([]);
        expect(clock.notes).toEqual([]);
      },
    );
  });

  test("a finished run is unread and notifies until it is opened", async () => {
    const clock = {
      now: new Date(2026, 9, 28, 12, 0, 0),
      notes: [] as Array<{ title: string; body: string }>,
    };
    await withRoutines(
      fakeClaude("Ingest lag in prod-eu."),
      clock,
      async (context) => {
        await context.workspaces.create({ name: "Ops", slug: "ops" });
        context.routines.add({
          workspace: "ops",
          when: "every day at 19:00",
          prompt: "Check env health.",
          name: "health",
        });
        const run = await context.routines.runNow("health");
        expect(context.repositories.routines.unseenRunIds()).toEqual([]);
        await settle();
        expect(clock.notes).toEqual([
          { title: "health needs attention", body: "Ingest lag in prod-eu." },
        ]);
        expect(context.repositories.routines.unseenRunIds()).toEqual([run.id]);
        context.routines.markSeen(run.id);
        expect(context.repositories.routines.unseenRunIds()).toEqual([]);
      },
    );
  });

  test("mark all read clears every finished run but not a running one", async () => {
    const clock = { now: new Date(2026, 9, 28, 12, 0, 0) };
    await withRoutines(fakeClaude("Disk at 91%."), clock, async (context) => {
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      for (const name of ["disk", "certs"])
        context.routines.add({
          workspace: "ops",
          when: "every day at 19:00",
          prompt: `Check ${name}.`,
          name,
        });
      await context.routines.runNow("disk");
      await context.routines.runNow("certs");
      await settle();
      expect(context.repositories.routines.unseenRunIds()).toHaveLength(2);
      expect(context.routines.unseen(50).map((run) => run.summary)).toEqual([
        "Disk at 91%.",
        "Disk at 91%.",
      ]);
      // One routine's history and mark-read leave the other's runs alone.
      const certs = context.routines.get("certs");
      const history = context.routines.runs({
        routineId: certs.id,
        limit: 10,
      });
      expect(history.map((run) => run.routineId)).toEqual([certs.id]);
      expect(
        context.routines.runs({
          routineId: certs.id,
          limit: 10,
          beforeId: history[0]!.id,
        }),
      ).toEqual([]);
      expect(context.routines.markAllSeen("certs")).toBe(1);
      expect(context.routines.view("disk").unseenRuns).toBe(1);
      expect(context.routines.markAllSeen()).toBe(1);
      expect(context.repositories.routines.unseenRunIds()).toEqual([]);
      expect(context.routines.markAllSeen()).toBe(0);
    });
  });

  test("a run on all workspaces continues in the workspace that is open", async () => {
    const clock = { now: new Date(2026, 9, 28, 12, 0, 0) };
    await withRoutines(fakeClaude("Freed 4 GB."), clock, async (context) => {
      const ops = await context.workspaces.create({ name: "Ops", slug: "ops" });
      context.routines.add({
        workspace: null,
        when: "every day at 19:00",
        prompt: "Remove merged worktrees everywhere.",
        name: "cleanup",
      });
      const run = await context.routines.runNow("cleanup");
      await settle();
      await expect(context.routines.continueRun(run.id)).rejects.toThrow(
        "Open a workspace",
      );
      const session = await context.routines.continueRun(run.id, "ops");
      expect(session).toMatchObject({
        workspaceId: ops.id,
        name: "cleanup run",
      });
    });
  });

  test("a requested run on a due slot is that slot's run, not a skip later", async () => {
    const clock = { now: new Date(2026, 9, 28, 19, 0, 5) };
    await withRoutines(neverEnds(), clock, async (context) => {
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      const routine = context.routines.add({
        workspace: "ops",
        when: "every day at 19:00",
        prompt: "Clean up merged worktrees.",
        name: "cleanup",
      });
      context.repositories.routines.update({
        ...routine,
        nextRunAt: new Date(2026, 9, 28, 19, 0, 0).toISOString(),
      });
      context.routines.requestRun("cleanup");
      const [started] = await context.routines.tick();
      expect(started?.trigger).toBe("schedule");
      await context.routines.tick();
      expect(
        context.repositories.routines
          .listRuns({ limit: 10 })
          .map((run) => run.status),
      ).toEqual(["running"]);
    });
  });

  test("Run now keeps to the limit of runs at once", async () => {
    const clock = { now: new Date(2026, 9, 28, 12, 0, 0) };
    await withRoutines(neverEnds(), clock, async (context) => {
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      for (const name of ["a", "b", "c"])
        context.routines.add({
          workspace: "ops",
          when: "every day at 19:00",
          prompt: `Routine ${name}.`,
          name,
        });
      await context.routines.runNow("a");
      await context.routines.runNow("b");
      await expect(context.routines.runNow("c")).rejects.toThrow(
        "2 routines are running",
      );
    });
  });

  test("a run started by an app that quit is watched, then ended from its log", async () => {
    const clock = { now: new Date(2026, 9, 28, 12, 0, 0) };
    await withRoutines(fakeClaude("unused"), clock, async (context, home) => {
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      const routine = context.routines.add({
        workspace: "ops",
        when: "every day at 19:00",
        prompt: "Check.",
        name: "check",
      });
      const orphan = (pid: number | null) =>
        context.repositories.routines.createRun({
          routineId: routine.id,
          trigger: "schedule",
          status: "running",
          providerSessionId: crypto.randomUUID(),
          workingDirectory: home,
          startedAt: clock.now.toISOString(),
          finishedAt: null,
          summary: null,
          outcome: null,
          continuedSessionId: null,
          seenAt: null,
          pid,
        });
      // This test's own process stands in for a run still going.
      const going = orphan(process.pid);
      const ended = orphan(null);
      await Bun.write(
        join(home, "routine-runs", `${ended.id}.jsonl`),
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "All green.",
        }),
      );
      await context.routines.tick();
      expect(context.repositories.routines.findRun(going.id)?.status).toBe(
        "running",
      );
      expect(context.repositories.routines.findRun(ended.id)).toMatchObject({
        status: "done",
        summary: "All green.",
        // No OK: word, so it is not taken as all clear.
        outcome: "attention",
      });
    });
  });

  test("keeps the newest 100 runs of a routine, and every unread one", async () => {
    const clock = { now: new Date(2026, 9, 28, 12, 0, 0) };
    await withRoutines(fakeClaude("unused"), clock, async (context, home) => {
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      const routine = context.routines.add({
        workspace: "ops",
        when: "every 30m",
        prompt: "Check.",
        name: "check",
      });
      const ids: number[] = [];
      for (let index = 0; index < 105; index++) {
        const run = context.repositories.routines.createRun({
          routineId: routine.id,
          trigger: "schedule",
          status: "done",
          providerSessionId: null,
          workingDirectory: home,
          startedAt: clock.now.toISOString(),
          finishedAt: clock.now.toISOString(),
          summary: `Run ${index}.`,
          outcome: "ok",
          continuedSessionId: null,
          // The second run is never opened.
          seenAt: index === 1 ? null : clock.now.toISOString(),
          pid: null,
        });
        ids.push(run.id);
        await Bun.write(join(home, "routine-runs", `${run.id}.jsonl`), "{}");
      }
      expect(await context.routines.prune()).toBe(4);
      const kept = context.repositories.routines
        .listRuns({ limit: 200 })
        .map((run) => run.id);
      expect(kept).toHaveLength(101);
      expect(kept).toContain(ids[1]);
      expect(kept).not.toContain(ids[0]);
      expect(
        await Bun.file(join(home, "routine-runs", `${ids[0]}.jsonl`)).exists(),
      ).toBe(false);
      // Paging back from the newest ten.
      const first = context.routines.runs({ limit: 10 });
      expect(
        context.routines.runs({ limit: 10, beforeId: first.at(-1)!.id })[0]?.id,
      ).toBe(first.at(-1)!.id - 1);
    });
  });

  test("a run asked for from another process starts on the next tick", async () => {
    const clock = { now: new Date(2026, 9, 28, 12, 0, 0) };
    await withRoutines(fakeClaude("Done."), clock, async (context) => {
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      const routine = context.routines.add({
        workspace: "ops",
        when: "every day at 19:00",
        prompt: "Clean up merged worktrees.",
        name: "cleanup",
      });
      context.routines.update("cleanup", { enabled: false });
      context.routines.requestRun("cleanup");

      const [started] = await context.routines.tick();
      expect(started?.trigger).toBe("manual");
      const after = context.routines.get("cleanup");
      expect(after.runRequestedAt).toBeNull();
      expect(after.nextRunAt).toBe(routine.nextRunAt);
      expect(() => context.routines.requestRun("cleanup")).toThrow(
        "already running",
      );
      await settle();
      expect(await context.routines.tick()).toEqual([]);
    });
  });

  test("Run now leaves the schedule alone; a paused routine never runs", async () => {
    const clock = { now: new Date(2026, 9, 28, 12, 0, 0) };
    await withRoutines(fakeClaude("Nothing new."), clock, async (context) => {
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      const routine = context.routines.add({
        workspace: "ops",
        when: "every day at 19:00",
        prompt: "Clean up merged worktrees.",
        name: "cleanup",
      });
      const run = await context.routines.runNow("cleanup");
      expect(run.trigger).toBe("manual");
      await settle();
      expect(context.routines.get("cleanup").nextRunAt).toBe(routine.nextRunAt);

      context.routines.update("cleanup", { enabled: false });
      clock.now = new Date(2026, 9, 28, 19, 0, 5);
      expect(await context.routines.tick()).toEqual([]);
    });
  });

  test("a run whose process belonged to a closed app is failed", async () => {
    const clock = { now: new Date(2026, 9, 28, 12, 0, 0) };
    const never: RoutineSpawner = () => ({
      exited: new Promise(() => {}),
      kill() {},
    });
    await withRoutines(never, clock, async (context) => {
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      context.routines.add({
        workspace: "ops",
        when: "hourly",
        prompt: "Look.",
        name: "look",
      });
      const run = await context.routines.runNow("look");
      // A second service over the same database has no live process for it.
      const repositories = context.repositories;
      repositories.routines.updateRun({ ...run });
      const other = new (
        context.routines.constructor as new (
          ...args: unknown[]
        ) => typeof context.routines
      )(
        repositories,
        { home: "", workspaceRoot: "", agents: {} },
        async () => {
          throw new Error("unused");
        },
        never,
        () => clock.now,
      );
      await other.tick();
      expect(repositories.routines.findRun(run.id)?.status).toBe("failed");
    });
  });
});

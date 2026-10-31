import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  createApplicationContext,
  describeSchedule,
  parseTranscript,
  parseWhen,
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
  clock: { now: Date },
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

describe("WorkspaceRoutineService", () => {
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
        const routine = context.workspaceRoutines.add({
          workspace: "on-call",
          when: "sun to thu at 8, 10, 13, 16",
          prompt: "Check env health.",
        });
        expect(routine.name).toBe("check-env-health");
        expect(routine.nextRunAt).toBe(
          new Date(2026, 9, 28, 13, 0, 0).toISOString(),
        );

        expect(await context.workspaceRoutines.tick()).toEqual([]);
        clock.now = new Date(2026, 9, 28, 13, 0, 5);
        const [started] = await context.workspaceRoutines.tick();
        expect(started?.status).toBe("running");
        expect(started?.workingDirectory).toBe(workspace.path);
        expect(calls[0]).toContain("--permission-prompts");
        expect(calls[0]).toContain(ROUTINE_RUN_SYSTEM_PROMPT);
        expect(calls[0]![1]).toContain("Check env health.");

        await settle();
        const [view] = context.workspaceRoutines.list();
        expect(
          view!.recentRuns.map((run) => [run.status, run.summary]),
        ).toEqual([["done", "Ingest lag in prod-eu."]]);
        expect(view!.routine.nextRunAt).toBe(
          new Date(2026, 9, 28, 16, 0, 0).toISOString(),
        );
        expect(
          (await context.workspaceRoutines.transcript(started!.id)).at(-1),
        ).toEqual({
          kind: "result",
          text: "Ingest lag in prod-eu.\nMore below.",
        });

        // The next run is told what this one said.
        clock.now = new Date(2026, 9, 28, 16, 0, 1);
        await context.workspaceRoutines.tick();
        expect(calls[1]![1]).toContain("said: Ingest lag in prod-eu.");
        await settle();
      },
    );
  });

  test("the Routines agent is one session, kept through archive and rebirth", async () => {
    const clock = { now: new Date(2026, 9, 28, 12, 0, 0) };
    await withRoutines(fakeClaude("Done."), clock, async (context) => {
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      await context.workspaces.create({ name: "Web", slug: "web" });
      const first = await context.workspaceRoutines.agent("ops");
      expect(first).toMatchObject({ name: "Routines", provider: "claude" });
      // Asked from another workspace, it is still the same session.
      expect((await context.workspaceRoutines.agent("web")).id).toBe(first.id);

      await context.agents.archive(first.id);
      const restored = await context.workspaceRoutines.agent("web");
      expect(restored.id).toBe(first.id);
      expect(restored.archivedAt).toBeNull();

      // A rebirth hands it to the successor, as it does abilities.
      const successor = await context.agents.spawn({
        workspace: "ops",
        provider: "claude",
        name: "Routines · 2",
      });
      context.repositories.workspaceRoutines.moveAgent(first.id, successor.id);
      expect((await context.workspaceRoutines.agent("ops")).id).toBe(
        successor.id,
      );
    });
  });

  test("a run asked for from another process starts on the next tick", async () => {
    const clock = { now: new Date(2026, 9, 28, 12, 0, 0) };
    await withRoutines(fakeClaude("Done."), clock, async (context) => {
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      const routine = context.workspaceRoutines.add({
        workspace: "ops",
        when: "every day at 19:00",
        prompt: "Clean up merged worktrees.",
        name: "cleanup",
      });
      context.workspaceRoutines.update("cleanup", { enabled: false });
      context.workspaceRoutines.requestRun("cleanup");

      const [started] = await context.workspaceRoutines.tick();
      expect(started?.trigger).toBe("manual");
      const after = context.workspaceRoutines.get("cleanup");
      expect(after.runRequestedAt).toBeNull();
      expect(after.nextRunAt).toBe(routine.nextRunAt);
      expect(() => context.workspaceRoutines.requestRun("cleanup")).toThrow(
        "already running",
      );
      await settle();
      expect(await context.workspaceRoutines.tick()).toEqual([]);
    });
  });

  test("Run now leaves the schedule alone; a paused routine never runs", async () => {
    const clock = { now: new Date(2026, 9, 28, 12, 0, 0) };
    await withRoutines(fakeClaude("Nothing new."), clock, async (context) => {
      await context.workspaces.create({ name: "Ops", slug: "ops" });
      const routine = context.workspaceRoutines.add({
        workspace: "ops",
        when: "every day at 19:00",
        prompt: "Clean up merged worktrees.",
        name: "cleanup",
      });
      const run = await context.workspaceRoutines.runNow("cleanup");
      expect(run.trigger).toBe("manual");
      await settle();
      expect(context.workspaceRoutines.get("cleanup").nextRunAt).toBe(
        routine.nextRunAt,
      );

      context.workspaceRoutines.update("cleanup", { enabled: false });
      clock.now = new Date(2026, 9, 28, 19, 0, 5);
      expect(await context.workspaceRoutines.tick()).toEqual([]);
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
      context.workspaceRoutines.add({
        workspace: "ops",
        when: "hourly",
        prompt: "Look.",
        name: "look",
      });
      const run = await context.workspaceRoutines.runNow("look");
      // A second service over the same database has no live process for it.
      const repositories = context.repositories;
      repositories.workspaceRoutines.updateRun({ ...run });
      const other = new (
        context.workspaceRoutines.constructor as new (
          ...args: unknown[]
        ) => typeof context.workspaceRoutines
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
      expect(repositories.workspaceRoutines.findRun(run.id)?.status).toBe(
        "failed",
      );
    });
  });
});

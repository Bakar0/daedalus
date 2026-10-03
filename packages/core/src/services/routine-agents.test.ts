import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  appendToBrief,
  claudeReady,
  composerText,
  createApplicationContext,
  routineAgentAtPrompt,
  routineAgentSlug,
  type AgentActivityState,
  type ApplicationContext,
  type RoutineAgent,
  type RoutineAgentTickInput,
} from "../index";

class FakeTmux implements TmuxClient {
  readonly sessions = new Set<string>();
  readonly launches: TmuxLaunch[] = [];
  readonly sent: Array<{ session: string; text: string }> = [];
  async probe() {
    return "tmux 3.7c";
  }
  async createSession(launch: TmuxLaunch) {
    this.launches.push(launch);
    this.sessions.add(launch.session);
  }
  async hasSession(session: string) {
    return this.sessions.has(session);
  }
  async listSessions() {
    return [...this.sessions];
  }
  async attach() {
    return 0;
  }
  screen = "shift+tab to cycle";
  async capture() {
    return this.screen;
  }
  async sendKeys() {}
  async send(session: string, text: string) {
    this.sent.push({ session, text });
  }
  async stop(session: string) {
    this.sessions.delete(session);
  }
  async killServer() {
    this.sessions.clear();
    return true;
  }
}

interface Harness {
  context: ApplicationContext;
  tmux: FakeTmux;
  home: string;
  clock: { now: Date };
  advance(ms: number): void;
  /** A second context on the same database: another CLI process. */
  second(): Promise<ApplicationContext>;
}

async function withRoutineAgents(run: (harness: Harness) => Promise<void>) {
  await withTemporaryDaedalusHome(async (home) => {
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        agents: { claude: { executable: process.execPath, args: ["run"] } },
      }),
    );
    const env = {
      DAEDALUS_HOME: home,
      CODEX_HOME: join(home, "codex"),
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      DAEDALUS_AGENTS_HOME: join(home, "agents"),
      DAEDALUS_CURSOR_HOME: join(home, "cursor"),
    };
    const clock = { now: new Date(2026, 8, 30, 10, 0, 0) };
    const tmux = new FakeTmux();
    const extra: ApplicationContext[] = [];
    const context = await createApplicationContext({
      env,
      tmux,
      now: () => clock.now,
      sendNativeNotification: async () => ({
        delivered: true,
        backend: "app",
        degraded: false,
      }),
    });
    try {
      await context.skills.sync();
      await run({
        context,
        tmux,
        home,
        clock,
        advance: (ms) => {
          clock.now = new Date(clock.now.getTime() + ms);
        },
        second: async () => {
          const other = await createApplicationContext({
            env,
            tmux,
            now: () => clock.now,
            reconcile: false,
            sendNativeNotification: async () => ({
              delivered: true,
              backend: "app",
              degraded: false,
            }),
          });
          extra.push(other);
          return other;
        },
      });
    } finally {
      for (const other of extra) other.close();
      context.close();
    }
  });
}

const routineFile = (name: string, extra = "", schedule = "every 10m") =>
  `---
name: ${name}
schedule: ${schedule}
model: sonnet
timeout: 10m
output: task
${extra}---
Check ${name} since {{last_run}}; missed {{missed}}.
`;

/** A tick input for a session sitting idle at its prompt. */
function idle(
  harness: Harness,
  overrides: Partial<RoutineAgentTickInput> = {},
): RoutineAgentTickInput {
  return {
    contextPercent: () => 10,
    lastInputAt: () => undefined,
    activity: (sessionId): AgentActivityState => ({
      sessionId,
      activity: "idle",
      detail: null,
      since: harness.clock.now.toISOString(),
      observedAt: harness.clock.now.toISOString(),
      source: "hook",
    }),
    ...overrides,
  };
}

async function argus(harness: Harness): Promise<RoutineAgent> {
  await harness.context.workspaces.create({ name: "Ops", slug: "ops" });
  return harness.context.routineAgents.create({
    workspace: "ops",
    name: "Argus",
  });
}

const routineLines = (tmux: FakeTmux) =>
  tmux.sent
    .map((item) => item.text)
    .filter((text) => text.startsWith("/daedalus-routine"));

describe("routine agents", () => {
  test("create writes its folder in the workspace and launches there", async () => {
    await withRoutineAgents(async (harness) => {
      const { context, tmux } = harness;
      const agent = await argus(harness);
      expect(agent).toMatchObject({
        name: "Argus",
        slug: "argus",
        state: "on_duty",
      });
      const workspace = await context.workspaces.get("ops");
      const folder = join(workspace.path, "worktrees", "agents", "argus");
      expect(await context.routineAgents.folder(agent)).toBe(folder);
      for (const file of [
        "AGENT.md",
        "routines/templates",
        ".claude/skills/daedalus-routine/SKILL.md",
        ".claude/skills/daedalus-routine-agent/SKILL.md",
      ])
        expect(await Bun.file(join(folder, file)).exists()).toBe(
          !file.endsWith("templates"),
        );
      expect(await readFile(join(folder, "AGENT.md"), "utf8")).toContain(
        "You are Argus",
      );
      const settings = JSON.parse(
        await readFile(join(folder, ".claude", "settings.json"), "utf8"),
      );
      expect(settings.permissions.deny).toEqual(["AskUserQuestion"]);
      expect(settings.permissions.allow).toContain(
        `Bash(${join(harness.home, "bin", "daedal")} routine:*)`,
      );
      const skill = await readFile(
        join(folder, ".claude/skills/daedalus-routine/SKILL.md"),
        "utf8",
      );
      expect(skill).toContain(join(harness.home, "bin", "daedal"));
      expect(skill).not.toContain("{{daedal}}");
      const session = await context.agents.get(agent.sessionId!);
      expect(session.workingDirectory).toBe(folder);
      expect(session.workspaceId).toBe(workspace.id);
      expect(session.name).toBe("Argus");
      const launch = tmux.launches.at(-1)!;
      expect(launch.cwd).toBe(folder);
      expect(launch.env?.DAEDALUS_ROUTINE_AGENT).toBe("1");
      expect(launch.args.join(" ")).toContain("--permission-mode auto");
      expect(launch.args.at(-1)).toContain("You are Argus");
      // One name per workspace; another workspace may reuse it.
      await expect(
        context.routineAgents.create({ workspace: "ops", name: "argus" }),
      ).rejects.toThrow("already has a routine agent");
      await context.workspaces.create({ name: "Web", slug: "web" });
      const second = await context.routineAgents.create({
        workspace: "web",
        name: "Argus",
      });
      expect(() => context.routineAgents.get("argus")).toThrow(
        "pass --workspace",
      );
      expect(context.routineAgents.get("argus", second.workspaceId).id).toBe(
        second.id,
      );
      // Several agents in one workspace, each in its own folder.
      const herald = await context.routineAgents.create({
        workspace: "ops",
        name: "Herald of Builds",
      });
      expect(herald.slug).toBe("herald-of-builds");
      expect(context.routineAgents.list(workspace.id)).toHaveLength(2);
    });
  });

  test("delivers a due routine when the session is idle, and not otherwise", async () => {
    await withRoutineAgents(async (harness) => {
      const { context, tmux } = harness;
      const agent = await argus(harness);
      await context.routines.add(agent, { text: routineFile("ci-health") });
      // Working on something of its own: queued, not typed.
      await context.routineAgents.tick(
        idle(harness, {
          activity: (sessionId) => ({
            sessionId,
            activity: "working",
            detail: "Bash(ls)",
            since: harness.clock.now.toISOString(),
            observedAt: harness.clock.now.toISOString(),
            source: "hook",
          }),
        }),
      );
      expect(routineLines(tmux)).toEqual([]);
      const [queued] = context.routines.inFlightRuns(agent);
      expect(queued).toMatchObject({ routine: "ci-health", status: "queued" });
      // The user typed 30 s ago: still held.
      harness.advance(1_000);
      await context.routineAgents.tick(
        idle(harness, {
          lastInputAt: () => harness.clock.now.getTime() - 30_000,
        }),
      );
      expect(routineLines(tmux)).toEqual([]);
      // A real question on screen is never typed over.
      await context.routineAgents.tick(
        idle(harness, {
          activity: (sessionId) => ({
            sessionId,
            activity: "needs_permission",
            detail: "Bash(rm)",
            since: harness.clock.now.toISOString(),
            observedAt: harness.clock.now.toISOString(),
            source: "hook",
          }),
        }),
      );
      expect(routineLines(tmux)).toEqual([]);
      await context.routineAgents.tick(idle(harness));
      expect(routineLines(tmux)).toEqual([`/daedalus-routine ${queued!.id}`]);
      const started = await context.routines.start(agent, queued!.id);
      expect(started.prompt).toBe(
        "Check ci-health since never (this is the first run; look back one schedule interval); missed 0m.",
      );
      expect(started.run.status).toBe("running");
      await expect(context.routines.start(agent, queued!.id)).rejects.toThrow(
        "not queued",
      );
    });
  });

  test("holds delivery while text waits in the input box", async () => {
    await withRoutineAgents(async (harness) => {
      const { context, tmux } = harness;
      const agent = await argus(harness);
      await context.routines.add(agent, { text: routineFile("ci-health") });
      tmux.screen = [
        "⏺ ci-health run 2 found nothing to report.",
        "──────────────────────────────── Argus ─",
        "❯ run slack-needs-me now",
        "────────────────────────────────",
        "  ⏵⏵ auto mode on (shift+tab to cycle)",
      ].join("\n");
      await context.routineAgents.tick(idle(harness));
      expect(routineLines(tmux)).toEqual([]);
      // Said out loud, not a silent queue.
      expect(
        (await context.routineAgents.overviews())[0]!.deliveryHold,
      ).toContain(
        'unsent text in Argus\'s input box: "run slack-needs-me now"',
      );
      // Run now asks for what is already waiting: no error, the same run.
      const queued = context.routines.inFlightRuns(agent)[0]!;
      const again = await context.routines.runNow(agent, "ci-health");
      expect(again).toMatchObject({ id: queued.id, alreadyQueued: true });
      tmux.screen = tmux.screen.replace("❯ run slack-needs-me now", "❯ ");
      harness.advance(1_000);
      await context.routineAgents.tick(idle(harness));
      expect(routineLines(tmux)).toHaveLength(1);
      expect(
        (await context.routineAgents.overviews())[0]!.deliveryHold,
      ).toBeNull();
      await expect(context.routines.runNow(agent, "ci-health")).rejects.toThrow(
        "is running now",
      );
    });
  });

  test("an unknown reading falls back to what the pane shows", async () => {
    await withRoutineAgents(async (harness) => {
      const { context, tmux } = harness;
      const agent = await argus(harness);
      await context.routines.add(agent, { text: routineFile("ci-health") });
      const unknown = idle(harness, {
        activity: (sessionId) => ({
          sessionId,
          activity: "unknown",
          detail: null,
          since: harness.clock.now.toISOString(),
          observedAt: harness.clock.now.toISOString(),
          source: "hook",
        }),
      });
      tmux.screen =
        "✻ Churning… (12s · esc to interrupt)\n────────────\n❯ \n────";
      await context.routineAgents.tick(unknown);
      expect(routineLines(tmux)).toEqual([]);
      expect((await context.routineAgents.overviews())[0]!.deliveryHold).toBe(
        "Argus is busy",
      );
      tmux.screen = "⏺ done\n────────────\n❯ \n────";
      await context.routineAgents.tick(unknown);
      expect(routineLines(tmux)).toHaveLength(1);
    });
  });

  test("Claude's idle notice does not hold a routine agent's routines", async () => {
    await withRoutineAgents(async (harness) => {
      const { context, tmux } = harness;
      const agent = await argus(harness);
      expect(tmux.launches[0]!.env?.DAEDALUS_ROUTINE_AGENT).toBe("1");
      await context.routines.add(agent, { text: routineFile("ci-health") });
      await context.routineAgents.tick(
        idle(harness, {
          activity: (sessionId) => ({
            sessionId,
            activity: "needs_input",
            detail: "Claude is waiting for your input",
            since: harness.clock.now.toISOString(),
            observedAt: harness.clock.now.toISOString(),
            source: "hook",
          }),
        }),
      );
      expect(routineLines(tmux)).toHaveLength(1);
    });
  });

  test("keeps at most three runs in flight, one per routine", async () => {
    await withRoutineAgents(async (harness) => {
      const { context, tmux } = harness;
      const agent = await argus(harness);
      for (const name of ["one", "two", "three", "four"])
        await context.routines.add(agent, { text: routineFile(name) });
      // A Claude session with background agents running still takes lines.
      const waiting = idle(harness, {
        activity: (sessionId) => ({
          sessionId,
          activity: "working",
          detail: "Waiting for 2 background agents",
          since: harness.clock.now.toISOString(),
          observedAt: harness.clock.now.toISOString(),
          source: "hook",
        }),
      });
      for (let index = 0; index < 6; index += 1) {
        await context.routineAgents.tick(waiting);
        harness.advance(16_000);
      }
      expect(routineLines(tmux)).toHaveLength(3);
      expect(context.routines.deliveredRuns(agent)).toHaveLength(3);
      // One finishes: the fourth goes out.
      const [first] = context.routines.deliveredRuns(agent);
      await context.routines.start(agent, first!.id);
      await context.routines.done(agent, first!.id, "quiet", "all green");
      await context.routineAgents.tick(waiting);
      expect(routineLines(tmux)).toHaveLength(4);
    });
  });

  test("skips a routine whose previous run has not ended", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const agent = await argus(harness);
      await context.routines.add(agent, {
        text: routineFile("slow", "", "every 5m"),
      });
      await context.routineAgents.tick(idle(harness));
      harness.advance(5 * 60_000 + 1_000);
      await context.routineAgents.tick(
        idle(harness, { activity: () => undefined }),
      );
      const runs = context.routines.runs(agent);
      expect(runs.map((run) => run.status)).toEqual(["skipped", "queued"]);
      expect(runs[0]!.summary).toContain("previous run has not ended");
    });
  });

  test("an overdue routine fires once, with how late it was", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const agent = await argus(harness);
      await context.routines.add(agent, {
        text: routineFile("hourly", "", "every 1h"),
      });
      await context.routineAgents.tick(idle(harness));
      const [first] = context.routines.inFlightRuns(agent);
      await context.routines.start(agent, first!.id);
      await context.routines.done(agent, first!.id, "quiet", "ok");
      // The app was closed for five hours.
      harness.advance(5 * 3_600_000);
      await context.routineAgents.tick(
        idle(harness, { activity: () => undefined }),
      );
      const queued = context.routines.inFlightRuns(agent);
      expect(queued).toHaveLength(1);
      const started = await context.routines.start(agent, queued[0]!.id);
      expect(started.prompt).toContain("missed 4h");
      expect(started.prompt).toContain("since 2026-09-30 10:00");
    });
  });

  test("times out a silent run and raises the badge after three failures", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const agent = await argus(harness);
      await context.routines.add(agent, {
        text: routineFile("flaky", "", "every 15m"),
      });
      for (let round = 0; round < 3; round += 1) {
        await context.routineAgents.tick(idle(harness));
        harness.advance(11 * 60_000);
        await context.routineAgents.tick(
          idle(harness, { activity: () => undefined }),
        );
        harness.advance(5 * 60_000);
      }
      const failed = context.routines
        .runs(agent, { routine: "flaky" })
        .filter((run) => run.status === "failed");
      expect(failed).toHaveLength(3);
      expect(failed[0]!.summary).toContain("never started");
      expect(
        context.activity
          .attentionFor(agent.sessionId!)
          ?.reasons.map((reason) => reason.text)
          .join(" "),
      ).toContain("Routine 'flaky' failed 3 times in a row");
      // The badge the agent carries does not stop delivery.
      expect(routineAgentAtPrompt(context.activity.get(agent.sessionId!))).toBe(
        true,
      );
    });
  });

  test("drains before a handoff and moves the duty to the successor", async () => {
    await withRoutineAgents(async (harness) => {
      const { context, tmux } = harness;
      const agent = await argus(harness);
      await context.routines.add(agent, { text: routineFile("ci-health") });
      await context.routines.add(agent, { text: routineFile("merges") });
      await context.routineAgents.tick(idle(harness));
      harness.advance(16_000);
      expect(context.routines.deliveredRuns(agent)).toHaveLength(1);
      // Context passes 60%: drain, deliver nothing more, do not hand off yet.
      const full = idle(harness, { contextPercent: () => 72 });
      await context.routineAgents.tick(full);
      expect(context.routineAgents.get("argus").state).toBe("draining");
      harness.advance(16_000);
      await context.routineAgents.tick(full);
      expect(routineLines(tmux)).toHaveLength(1);
      expect(
        tmux.sent.some((item) => item.text.includes("daedalus-handoff")),
      ).toBe(false);
      // The run in flight ends: now the handoff.
      const [inFlight] = context.routines.deliveredRuns(agent);
      await context.routines.start(agent, inFlight!.id);
      await context.routines.done(agent, inFlight!.id, "quiet", "ok");
      await context.routineAgents.tick(full);
      expect(tmux.sent.at(-1)!.text).toContain("daedalus-handoff");
      // The agent runs `daedal agent continue` itself.
      const { session: successor } = await context.agents.continueSession({
        id: agent.sessionId!,
        handoff: "Nothing in flight.",
      });
      const after = context.routineAgents.get("argus");
      expect(after).toMatchObject({
        state: "on_duty",
        sessionId: successor.id,
        drainingSince: null,
      });
      expect(successor.name).toBe("Argus");
      expect(successor.workingDirectory).toBe(
        await context.routineAgents.folder(agent),
      );
      expect(tmux.launches.at(-1)!.args.at(-1)).toContain("You are Argus");
      // The queued run goes to the successor.
      harness.advance(16_000);
      await context.routineAgents.tick(idle(harness));
      expect(tmux.sent.at(-1)).toMatchObject({
        session: successor.tmuxSession,
        text: expect.stringMatching(/^\/daedalus-routine \d+$/),
      });
    });
  });

  test("archiving its session pauses the agent, and restoring resumes it", async () => {
    await withRoutineAgents(async (harness) => {
      const { context, tmux } = harness;
      const agent = await argus(harness);
      await context.routines.add(agent, { text: routineFile("ci-health") });
      await context.routines.runNow(agent, "merges").catch(() => undefined);
      await context.routines.runNow(agent, "ci-health");
      await context.agents.archive(agent.sessionId!, true);
      expect(context.routineAgents.get("argus").state).toBe("paused");
      expect(context.routines.runs(agent, { limit: 1 })[0]!.summary).toContain(
        "archived",
      );
      // Paused: no new session, nothing queued.
      harness.advance(20 * 60_000);
      await context.routineAgents.tick(idle(harness));
      expect(tmux.launches).toHaveLength(1);
      expect(context.routines.inFlightRuns(agent)).toEqual([]);
      // Resume restores the archived session, which puts it back on duty.
      const resumed = await context.routineAgents.resume("argus");
      expect(resumed).toMatchObject({
        state: "on_duty",
        sessionId: agent.sessionId,
      });
      expect(
        (await context.agents.get(agent.sessionId!)).archivedAt,
      ).toBeNull();
      // A handoff archives the predecessor without pausing the agent.
      const { session, predecessor } = await context.agents.continueSession({
        id: agent.sessionId!,
      });
      expect(predecessor.archivedAt).not.toBeNull();
      expect(context.routineAgents.get("argus")).toMatchObject({
        state: "on_duty",
        sessionId: session.id,
      });
    });
  });

  test("a session that exited is replaced in the same folder", async () => {
    await withRoutineAgents(async (harness) => {
      const { context, tmux } = harness;
      const agent = await argus(harness);
      const session = await context.agents.get(agent.sessionId!);
      tmux.sessions.delete(session.tmuxSession);
      context.repositories.updateAgent({ ...session, status: "exited" });
      await context.routineAgents.tick(idle(harness));
      expect(tmux.launches).toHaveLength(2);
      const replaced = context.routineAgents.get("argus");
      expect(replaced.sessionId).not.toBe(agent.sessionId);
      expect(tmux.launches.at(-1)!.cwd).toBe(
        await context.routineAgents.folder(agent),
      );
    });
  });

  test("remove forgets the agent and keeps its folder", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const agent = await argus(harness);
      const folder = await context.routineAgents.folder(agent);
      await expect(context.routineAgents.remove("argus", {})).rejects.toThrow(
        "requires --force",
      );
      await context.routineAgents.remove("argus", { force: true });
      expect(context.routineAgents.list()).toEqual([]);
      expect(await Bun.file(join(folder, "AGENT.md")).exists()).toBe(true);
      expect(
        (await context.agents.get(agent.sessionId!)).archivedAt,
      ).not.toBeNull();
    });
  });
});

describe("routine reports", () => {
  async function reportSetup(harness: Harness) {
    const agent = await argus(harness);
    await harness.context.routines.add(agent, {
      text: routineFile("ci-health"),
    });
    await harness.context.routines.add(agent, {
      text: routineFile("merges").replace("output: task", "output: notify"),
    });
    const run = await harness.context.routines.runNow(agent, "ci-health");
    const workspace = await harness.context.workspaces.get("ops");
    const report = (overrides: Record<string, unknown> = {}) =>
      harness.context.routineReports.report({
        agent: harness.context.routineAgents.get("argus"),
        workspace,
        routine: "ci-health",
        output: "task",
        runId: run.id,
        key: "ci-health:org/repo:main:CI:test",
        urgent: false,
        title: "main red: test fails",
        body: "## Evidence\n\nexit 1",
        ...overrides,
      });
    return { agent, workspace, run, report };
  }

  test("the same key again is an update, not a second task", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const { workspace, report } = await reportSetup(harness);
      const first = await report();
      expect(first.action).toBe("opened");
      expect(first.task).toMatchObject({
        title: "main red: test fails",
        priority: "normal",
      });
      expect(first.notified).not.toBeNull();
      harness.advance(30 * 60_000);
      const second = await report({ urgent: true });
      expect(second.action).toBe("updated");
      expect(second.notified).toBeNull();
      const tasks = context.repositories.listTasks({
        workspaceId: workspace.id,
      });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.description).toContain("## Update 2026-09-30 10:30");
      expect(tasks[0]!.description).toContain("· Urgent");
    });
  });

  test("two processes reporting one key at once make one task", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const { workspace, report } = await reportSetup(harness);
      const other = await harness.second();
      const otherReport = other.routineReports.report({
        agent: other.routineAgents.get("argus"),
        workspace,
        routine: "ci-health",
        output: "task",
        runId: 1,
        key: "ci-health:org/repo:main:CI:test",
        urgent: false,
        title: "main red: test fails",
        body: "from the other run",
      });
      const results = await Promise.all([report(), otherReport]);
      expect(results.map((result) => result.action).sort()).toEqual([
        "opened",
        "updated",
      ]);
      expect(
        context.repositories.listTasks({ workspaceId: workspace.id }),
      ).toHaveLength(1);
      expect(
        context.repositories.routineAgents.listRoutineReports(
          results[0]!.report.routineAgentId,
        ),
      ).toHaveLength(1);
    });
  });

  test("a second key with the same cause joins the first task", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const { workspace, report } = await reportSetup(harness);
      await report();
      const merged = await report({
        routine: "post-merge-watch",
        key: "post-merge-watch:org/repo#57:deploy",
        sameAs: "ci-health:org/repo:main:CI:test",
        title: "deploy failed",
      });
      expect(merged.action).toBe("merged");
      expect(merged.notified).toBeNull();
      const tasks = context.repositories.listTasks({
        workspaceId: workspace.id,
      });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.description).toContain(
        "## Also seen by `post-merge-watch`",
      );
      // Reported again under its own key: still an update to the shared task.
      const again = await report({
        key: "post-merge-watch:org/repo#57:deploy",
        title: "deploy failed",
      });
      expect(again.action).toBe("updated");
      expect(again.task?.id).toBe(tasks[0]!.id);
      await expect(
        report({ key: "x:y", sameAs: "nothing:open" }),
      ).rejects.toThrow("No open report");
    });
  });

  test("resolves, closes after a day untouched, and reopens within 14 days", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const { workspace, report } = await reportSetup(harness);
      const agent = context.routineAgents.get("argus");
      const opened = await report();
      const resolved = context.routineReports.resolve(
        agent,
        "ci-health:org/repo:main:CI:test",
      );
      expect(resolved?.state).toBe("resolved");
      expect(
        context.routineReports.resolve(
          agent,
          "ci-health:org/repo:main:CI:test",
        ),
      ).toBeNull();
      harness.advance(23 * 3_600_000);
      context.routineReports.sweep(agent);
      expect(context.tasks.get(opened.task!.id).status).toBe("todo");
      harness.advance(2 * 3_600_000);
      const { closedTasks } = context.routineReports.sweep(agent);
      expect(closedTasks).toHaveLength(1);
      const closed = context.tasks.get(opened.task!.id);
      expect(closed.status).toBe("done");
      expect(closed.description).toContain("## Resolved at 2026-09-30 10:00");
      expect(closed.description).toContain(
        "## Closed by Argus: resolved at 2026-09-30 10:00, no action taken",
      );
      // Back five days later: the same task, back in todo, notified again.
      harness.advance(5 * 86_400_000);
      const back = await report();
      expect(back.action).toBe("reopened");
      expect(back.task?.id).toBe(opened.task!.id);
      expect(back.task?.status).toBe("todo");
      expect(back.report.reopenCount).toBe(1);
      expect(back.notified).not.toBeNull();
      expect(context.tasks.get(opened.task!.id).description).toContain(
        "## Came back at",
      );
      // Resolved again and back after three weeks: a new task naming the old.
      context.routineReports.resolve(agent, "ci-health:org/repo:main:CI:test");
      harness.advance(21 * 86_400_000);
      context.routineReports.sweep(agent);
      const later = await report();
      expect(later.action).toBe("opened");
      expect(later.task?.id).not.toBe(opened.task!.id);
      expect(later.task?.description).toContain(
        `The earlier task was ops#${opened.task!.number}`,
      );
      expect(
        context.repositories.listTasks({ workspaceId: workspace.id }),
      ).toHaveLength(2);
    });
  });

  test("a resolved task an agent worked on is left for the user", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const { report } = await reportSetup(harness);
      const agent = context.routineAgents.get("argus");
      const opened = await report();
      await context.agents.spawn({
        workspace: "ops",
        taskId: opened.task!.id,
        provider: "claude",
      });
      const status = context.tasks.get(opened.task!.id).status;
      context.routineReports.resolve(agent, "ci-health:org/repo:main:CI:test");
      harness.advance(25 * 3_600_000);
      expect(context.routineReports.sweep(agent).closedTasks).toEqual([]);
      expect(context.tasks.get(opened.task!.id).status).toBe(status);
    });
  });

  test("a task the user closed comes back when the issue is still there", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const { report } = await reportSetup(harness);
      const opened = await report();
      context.tasks.setStatus(opened.task!.id, "done");
      const again = await report();
      expect(again.action).toBe("reopened");
      expect(context.tasks.get(opened.task!.id).status).toBe("todo");
    });
  });

  test("a key marked Noise raises nothing until the verdict is removed", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const { workspace, report } = await reportSetup(harness);
      const agent = context.routineAgents.get("argus");
      const opened = await report();
      const noise = context.routineReports.verdict(
        agent,
        opened.report.id,
        "noise",
        "flaky runner",
      );
      expect(noise).toMatchObject({ verdict: "noise", state: "closed" });
      expect(context.tasks.get(opened.task!.id).description).toContain(
        "## Marked noise at",
      );
      harness.advance(3_600_000);
      const quiet = await report({ urgent: true });
      expect(quiet).toMatchObject({
        action: "suppressed",
        task: null,
        notified: null,
      });
      expect(quiet.report.lastSeenAt).toBe(harness.clock.now.toISOString());
      expect(
        context.repositories.listTasks({ workspaceId: workspace.id }),
      ).toHaveLength(1);
      context.routineReports.verdict(agent, opened.report.id, null);
      const back = await report();
      expect(back.action).toBe("reopened");
      expect(back.task?.id).toBe(opened.task!.id);
    });
  });

  test("feedback on a task covers every key filed on it", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const { report } = await reportSetup(harness);
      const opened = await report();
      await report({
        routine: "post-merge-watch",
        key: "post-merge-watch:org/repo#57:deploy",
        sameAs: "ci-health:org/repo:main:CI:test",
        title: "deploy failed",
      });
      const marked = context.routineReports.feedbackForTask(
        opened.task!.id,
        "noise",
        "not ours",
      );
      expect(marked.map((item) => item.verdict)).toEqual(["noise", "noise"]);
      // One line in the brief, not one per key.
      expect(
        context.tasks
          .get(opened.task!.id)
          .description.match(/## Marked noise at/g),
      ).toHaveLength(1);
      expect((await report()).action).toBe("suppressed");
      context.routineReports.feedbackForTask(opened.task!.id, null);
      expect((await report()).action).toBe("reopened");
      expect(() =>
        context.routineReports.feedbackForTask("no-such-task", "useful"),
      ).toThrow("No routine report");
    });
  });

  test("a task the user closes as done counts as useful", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const { report } = await reportSetup(harness);
      const agent = context.routineAgents.get("argus");
      const opened = await report();
      context.tasks.setStatus(opened.task!.id, "done");
      context.routineReports.sweep(agent);
      expect(
        context.repositories.routineAgents.findRoutineReport(opened.report.id),
      ).toMatchObject({
        state: "closed",
        verdict: "useful",
      });
    });
  });

  test("an urgent report gets through Focus mode and others do not", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const { report } = await reportSetup(harness);
      await context.presence.setFocusMode(true);
      const warning = await report();
      expect(warning.notified).toBe("focus mode is on");
      const urgent = await report({
        key: "ci-health:org/repo:main:CI:deploy",
        urgent: true,
      });
      expect(urgent.notified).not.toBe("focus mode is on");
      expect(urgent.task?.priority).toBe("high");
    });
  });

  test("a notify routine notifies and opens no task", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const { workspace, report } = await reportSetup(harness);
      const result = await report({
        routine: "slack",
        output: "notify",
        key: "slack:dm:123",
        title: "Dana asked about the deploy",
      });
      expect(result).toMatchObject({ action: "opened", task: null });
      expect(result.notified).not.toBeNull();
      expect(
        context.repositories.listTasks({ workspaceId: workspace.id }),
      ).toEqual([]);
      expect(
        (
          await report({
            routine: "slack",
            output: "notify",
            key: "slack:dm:123",
          })
        ).action,
      ).toBe("updated");
      await expect(report({ output: "none" })).rejects.toThrow("cannot report");
    });
  });
});

describe("routine agent overview", () => {
  test("counts what is open and in flight, and memory lists its files", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const agent = await argus(harness);
      await context.routines.add(agent, { text: routineFile("ci-health") });
      const quiet = (await context.routineAgents.overviews())[0]!;
      expect(quiet).toMatchObject({
        openReports: 0,
        routines: 1,
        runsInFlight: 0,
        workspaceSlug: "ops",
      });
      await context.routineAgents.tick(idle(harness));
      expect((await context.routineAgents.overviews())[0]!.runsInFlight).toBe(
        1,
      );
      const [run] = context.routines.deliveredRuns(agent);
      const workspace = await context.workspaces.get("ops");
      await context.routineReports.report({
        agent: context.routineAgents.get("argus"),
        workspace,
        routine: "ci-health",
        output: "task",
        runId: run!.id,
        key: "ci-health:a",
        urgent: true,
        title: "down",
        body: "",
      });
      expect((await context.routineAgents.overviews())[0]).toMatchObject({
        openReports: 1,
        openUrgentReports: 1,
        openReportTasks: 1,
      });
      const folder = await context.routineAgents.folder(agent);
      const memoryDirectory = join(
        harness.home,
        "claude",
        "projects",
        folder.replace(/[^a-zA-Z0-9]/g, "-"),
        "memory",
      );
      await Bun.write(join(memoryDirectory, "cx.md"), "archive tier");
      await Bun.write(join(memoryDirectory, "MEMORY.md"), "- [cx](cx.md)");
      const files = await context.routineAgents.memory(
        "argus",
        context.config.claudeProjectsDirectory,
      );
      expect(files.map((file) => `${file.source}:${file.name}`)).toEqual([
        "folder:AGENT.md",
        "memory:MEMORY.md",
        "memory:cx.md",
      ]);
    });
  });
});

describe("routineAgentSlug", () => {
  test("names the folder from the agent's name", () => {
    expect(routineAgentSlug("Argus")).toBe("argus");
    expect(routineAgentSlug("  Herald of Builds! ")).toBe("herald-of-builds");
    expect(() => routineAgentSlug("!!!")).toThrow("letter or digit");
  });
});

describe("composerText", () => {
  test("reads the input box under the composer rule", () => {
    const pane = (line: string) =>
      [
        "❯ You are Argus",
        "text",
        "──────────── Argus ─",
        line,
        "────────",
      ].join("\n");
    expect(composerText(pane("❯ draft here"))).toBe("draft here");
    expect(composerText(pane("❯ "))).toBe("");
    expect(composerText("no composer at all")).toBeUndefined();
  });
});

describe("claudeReady", () => {
  test("recognises the default mode footer a routine agent starts with", () => {
    expect(claudeReady("❯ \n  ⏸ manual mode on · ← for agents")).toBe(true);
    expect(claudeReady("auto mode on (shift+tab to cycle)")).toBe(true);
    expect(claudeReady("Do you trust the files in this folder?")).toBe(false);
  });
});

describe("appendToBrief", () => {
  test("drops the oldest updates first and keeps the report", () => {
    let brief = "> Reported\n\n## Evidence\n\nthe original evidence\n";
    for (let index = 0; index < 40; index += 1)
      brief = appendToBrief(brief, `Update ${index}`, "x".repeat(100), 1_500);
    expect(brief.length).toBeLessThanOrEqual(1_500);
    expect(brief).toContain("## Evidence\n\nthe original evidence");
    expect(brief).toContain("## Update 39");
    expect(brief).not.toContain("## Update 0\n");
    expect(brief.match(/Older updates were trimmed/g)).toHaveLength(1);
  });
});

describe("routine files through the service", () => {
  test("templates copy with vars and delete themselves after until", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const agent = await argus(harness);
      const workspace = await context.workspaces.get("ops");
      await writeFile(
        join(
          await context.routineAgents.folder(agent),
          "routines",
          "templates",
          "post-merge-watch.md",
        ),
        routineFile("post-merge-watch", "vars:\n  pr: none\n").replace(
          "Check post-merge-watch",
          "Watch {{pr}}",
        ),
      );
      const routine = await context.routines.add(agent, {
        template: "post-merge-watch",
        name: "watch-pr-57",
        vars: { pr: "org/repo#57" },
        until: "+60m",
      });
      expect(routine.vars.pr).toBe("org/repo#57");
      await context.routineAgents.tick(idle(harness));
      const [run] = context.routines.inFlightRuns(agent);
      expect((await context.routines.start(agent, run!.id)).prompt).toContain(
        "Watch org/repo#57",
      );
      await context.routines.done(agent, run!.id, "quiet", "clean");
      harness.advance(61 * 60_000);
      await context.routineAgents.tick(
        idle(harness, { activity: () => undefined }),
      );
      expect((await context.routines.list(agent)).routines).toEqual([]);
      expect(
        await Bun.file(
          join(
            await context.routineAgents.folder(agent),
            "routines",
            "watch-pr-57.md",
          ),
        ).exists(),
      ).toBe(false);
    });
  });

  test("a bad file is listed with its error and never runs", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const agent = await argus(harness);
      const workspace = await context.workspaces.get("ops");
      await writeFile(
        join(
          await context.routineAgents.folder(agent),
          "routines",
          "broken.md",
        ),
        "---\nname: broken\nschedule: sometimes\n---\nbody\n",
      );
      await context.routineAgents.tick(idle(harness));
      const { routines, errors } = await context.routines.list(agent);
      expect(routines).toEqual([]);
      expect(errors[0]).toMatchObject({ name: "broken" });
      expect(errors[0]!.error).toContain("is not one of");
      expect(context.routines.runs(agent)).toEqual([]);
      await expect(
        context.routines.add(agent, { text: "---\nname: x\n---\nbody" }),
      ).rejects.toThrow("'schedule' field is required");
    });
  });

  test("disabled routines do not run and enabling schedules them", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const agent = await argus(harness);
      await context.routines.add(agent, {
        text: routineFile("quiet", "enabled: false\n"),
      });
      await context.routineAgents.tick(idle(harness));
      expect(context.routines.runs(agent)).toEqual([]);
      await context.routines.setEnabled(agent, "quiet", true);
      harness.advance(1_000);
      await context.routineAgents.tick(idle(harness));
      expect(context.routines.runs(agent)).toHaveLength(1);
    });
  });

  test("a paused agent queues nothing and fires once on resume", async () => {
    await withRoutineAgents(async (harness) => {
      const { context } = harness;
      const agent = await argus(harness);
      context.routineAgents.pause("argus");
      await context.routines.add(agent, { text: routineFile("ci-health") });
      await context.routineAgents.tick(idle(harness));
      expect(context.routines.runs(agent)).toEqual([]);
      await context.routineAgents.resume("argus");
      harness.advance(60 * 60_000);
      await context.routineAgents.tick(idle(harness));
      expect(context.routines.runs(agent)).toHaveLength(1);
    });
  });
});

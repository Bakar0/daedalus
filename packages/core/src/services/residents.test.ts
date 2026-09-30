import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  appendToBrief,
  createApplicationContext,
  residentAtPrompt,
  type AgentActivityState,
  type ApplicationContext,
  type Resident,
  type ResidentTickInput,
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
  async capture() {
    return "shift+tab to cycle";
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

async function withResidents(run: (harness: Harness) => Promise<void>) {
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
findings: task
${extra}---
Check ${name} since {{last_run}}; missed {{missed}}.
`;

/** A tick input for a session sitting idle at its prompt. */
function idle(
  harness: Harness,
  overrides: Partial<ResidentTickInput> = {},
): ResidentTickInput {
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

async function argus(harness: Harness): Promise<Resident> {
  await harness.context.residents.create({ slug: "argus" });
  return harness.context.residents.start("argus");
}

const routineLines = (tmux: FakeTmux) =>
  tmux.sent
    .map((item) => item.text)
    .filter((text) => text.startsWith("/daedalus-routine"));

describe("residents", () => {
  test("create writes the workspace and start launches at its root", async () => {
    await withResidents(async (harness) => {
      const { context, tmux } = harness;
      const created = await context.residents.create({ slug: "argus" });
      expect(created).toMatchObject({ name: "Argus", state: "stopped" });
      const workspace = await context.workspaces.get("argus");
      for (const file of [
        "CHARTER.md",
        "SERVICES.md",
        "TOOLS.md",
        "BRIEF.md",
        ".claude/skills/daedalus-routine/SKILL.md",
        ".claude/skills/daedalus-resident/SKILL.md",
      ])
        expect(await Bun.file(join(workspace.path, file)).exists()).toBe(true);
      expect(
        await readFile(join(workspace.path, "CHARTER.md"), "utf8"),
      ).toContain("You are Argus");
      expect(
        await readFile(join(workspace.path, "BRIEF.md"), "utf8"),
      ).toContain("Argus reported");
      const resident = await context.residents.start("argus");
      expect(resident.state).toBe("on_duty");
      const session = await context.agents.get(resident.sessionId!);
      expect(session.workingDirectory).toBe(workspace.path);
      expect(session.name).toBe("Argus");
      const launch = tmux.launches.at(-1)!;
      expect(launch.cwd).toBe(workspace.path);
      expect(launch.args.join(" ")).toContain("--permission-mode default");
      expect(launch.args.at(-1)).toContain("You are Argus");
      // Starting again while on duty launches nothing new.
      await context.residents.start("argus");
      expect(tmux.launches).toHaveLength(1);
      await expect(context.residents.create({ slug: "argus" })).rejects.toThrow(
        "already exists",
      );
    });
  });

  test("delivers a due routine when the session is idle, and not otherwise", async () => {
    await withResidents(async (harness) => {
      const { context, tmux } = harness;
      const resident = await argus(harness);
      await context.routines.add(resident, { text: routineFile("ci-health") });
      // Working on something of its own: queued, not typed.
      await context.residents.tick(
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
      const [queued] = context.routines.inFlightRuns(resident);
      expect(queued).toMatchObject({ routine: "ci-health", status: "queued" });
      // The user typed 30 s ago: still held.
      harness.advance(1_000);
      await context.residents.tick(
        idle(harness, {
          lastInputAt: () => harness.clock.now.getTime() - 30_000,
        }),
      );
      expect(routineLines(tmux)).toEqual([]);
      // A real question on screen is never typed over.
      await context.residents.tick(
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
      await context.residents.tick(idle(harness));
      expect(routineLines(tmux)).toEqual([`/daedalus-routine ${queued!.id}`]);
      const started = await context.routines.start(resident, queued!.id);
      expect(started.prompt).toBe(
        "Check ci-health since never (this is the first run; look back one schedule interval); missed 0m.",
      );
      expect(started.run.status).toBe("running");
      await expect(
        context.routines.start(resident, queued!.id),
      ).rejects.toThrow("not queued");
    });
  });

  test("keeps at most three runs in flight, one per routine", async () => {
    await withResidents(async (harness) => {
      const { context, tmux } = harness;
      const resident = await argus(harness);
      for (const name of ["one", "two", "three", "four"])
        await context.routines.add(resident, { text: routineFile(name) });
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
        await context.residents.tick(waiting);
        harness.advance(16_000);
      }
      expect(routineLines(tmux)).toHaveLength(3);
      expect(context.routines.deliveredRuns(resident)).toHaveLength(3);
      // One finishes: the fourth goes out.
      const [first] = context.routines.deliveredRuns(resident);
      await context.routines.start(resident, first!.id);
      await context.routines.done(resident, first!.id, "quiet", "all green");
      await context.residents.tick(waiting);
      expect(routineLines(tmux)).toHaveLength(4);
    });
  });

  test("skips a routine whose previous run has not ended", async () => {
    await withResidents(async (harness) => {
      const { context } = harness;
      const resident = await argus(harness);
      await context.routines.add(resident, {
        text: routineFile("slow", "", "every 5m"),
      });
      await context.residents.tick(idle(harness));
      harness.advance(5 * 60_000 + 1_000);
      await context.residents.tick(
        idle(harness, { activity: () => undefined }),
      );
      const runs = context.routines.runs(resident);
      expect(runs.map((run) => run.status)).toEqual(["skipped", "queued"]);
      expect(runs[0]!.summary).toContain("previous run has not ended");
    });
  });

  test("an overdue routine fires once, with how late it was", async () => {
    await withResidents(async (harness) => {
      const { context } = harness;
      const resident = await argus(harness);
      await context.routines.add(resident, {
        text: routineFile("hourly", "", "every 1h"),
      });
      await context.residents.tick(idle(harness));
      const [first] = context.routines.inFlightRuns(resident);
      await context.routines.start(resident, first!.id);
      await context.routines.done(resident, first!.id, "quiet", "ok");
      // The app was closed for five hours.
      harness.advance(5 * 3_600_000);
      await context.residents.tick(
        idle(harness, { activity: () => undefined }),
      );
      const queued = context.routines.inFlightRuns(resident);
      expect(queued).toHaveLength(1);
      const started = await context.routines.start(resident, queued[0]!.id);
      expect(started.prompt).toContain("missed 4h");
      expect(started.prompt).toContain("since 2026-09-30 10:00");
    });
  });

  test("times out a silent run and raises the badge after three failures", async () => {
    await withResidents(async (harness) => {
      const { context } = harness;
      const resident = await argus(harness);
      await context.routines.add(resident, {
        text: routineFile("flaky", "", "every 15m"),
      });
      for (let round = 0; round < 3; round += 1) {
        await context.residents.tick(idle(harness));
        harness.advance(11 * 60_000);
        await context.residents.tick(
          idle(harness, { activity: () => undefined }),
        );
        harness.advance(5 * 60_000);
      }
      const failed = context.routines
        .runs(resident, { routine: "flaky" })
        .filter((run) => run.status === "failed");
      expect(failed).toHaveLength(3);
      expect(failed[0]!.summary).toContain("never started");
      expect(
        context.activity
          .attentionFor(resident.sessionId!)
          ?.reasons.map((reason) => reason.text)
          .join(" "),
      ).toContain("Routine 'flaky' failed 3 times in a row");
      // The badge the resident carries does not stop delivery.
      expect(residentAtPrompt(context.activity.get(resident.sessionId!))).toBe(
        true,
      );
    });
  });

  test("drains before a handoff and moves the duty to the successor", async () => {
    await withResidents(async (harness) => {
      const { context, tmux } = harness;
      const resident = await argus(harness);
      await context.routines.add(resident, { text: routineFile("ci-health") });
      await context.routines.add(resident, { text: routineFile("merges") });
      await context.residents.tick(idle(harness));
      harness.advance(16_000);
      expect(context.routines.deliveredRuns(resident)).toHaveLength(1);
      // Context passes 60%: drain, deliver nothing more, do not hand off yet.
      const full = idle(harness, { contextPercent: () => 72 });
      await context.residents.tick(full);
      expect(context.residents.get("argus").state).toBe("draining");
      harness.advance(16_000);
      await context.residents.tick(full);
      expect(routineLines(tmux)).toHaveLength(1);
      expect(
        tmux.sent.some((item) => item.text.includes("daedalus-handoff")),
      ).toBe(false);
      // The run in flight ends: now the handoff.
      const [inFlight] = context.routines.deliveredRuns(resident);
      await context.routines.start(resident, inFlight!.id);
      await context.routines.done(resident, inFlight!.id, "quiet", "ok");
      await context.residents.tick(full);
      expect(tmux.sent.at(-1)!.text).toContain("daedalus-handoff");
      // The resident runs `daedal agent continue` itself.
      const { session: successor } = await context.agents.continueSession({
        id: resident.sessionId!,
        handoff: "Nothing in flight.",
      });
      const after = context.residents.get("argus");
      expect(after).toMatchObject({
        state: "on_duty",
        sessionId: successor.id,
        drainingSince: null,
      });
      expect(successor.name).toBe("Argus");
      expect(successor.workingDirectory).toBe(
        (await context.workspaces.get("argus")).path,
      );
      expect(tmux.launches.at(-1)!.args.at(-1)).toContain("You are Argus");
      // The queued run goes to the successor.
      harness.advance(16_000);
      await context.residents.tick(idle(harness));
      expect(tmux.sent.at(-1)).toMatchObject({
        session: successor.tmuxSession,
        text: expect.stringMatching(/^\/daedalus-routine \d+$/),
      });
    });
  });

  test("drains once a day for a fresh context", async () => {
    await withResidents(async (harness) => {
      const { context } = harness;
      await argus(harness);
      harness.clock.now = new Date(2026, 9, 1, 4, 0, 5);
      await context.residents.tick(idle(harness));
      expect(context.residents.get("argus").state).toBe("draining");
    });
  });

  test("a stopped resident's session is archived and relaunched on start", async () => {
    await withResidents(async (harness) => {
      const { context, tmux } = harness;
      const resident = await argus(harness);
      await context.residents.stop("argus");
      expect(
        (await context.agents.get(resident.sessionId!)).archivedAt,
      ).not.toBeNull();
      expect(context.residents.get("argus").state).toBe("stopped");
      await context.residents.start("argus");
      expect(tmux.launches).toHaveLength(2);
      expect(context.residents.get("argus").sessionId).not.toBe(
        resident.sessionId,
      );
    });
  });
});

describe("findings", () => {
  async function reportSetup(harness: Harness) {
    const resident = await argus(harness);
    await harness.context.routines.add(resident, {
      text: routineFile("ci-health"),
    });
    await harness.context.routines.add(resident, {
      text: routineFile("merges").replace("findings: task", "findings: notify"),
    });
    const run = await harness.context.routines.runNow(resident, "ci-health");
    const workspace = await harness.context.workspaces.get("argus");
    const report = (overrides: Record<string, unknown> = {}) =>
      harness.context.findings.report({
        resident: harness.context.residents.get("argus"),
        workspace,
        routine: "ci-health",
        findings: "task",
        runId: run.id,
        key: "ci-health:org/repo:main:CI:test",
        severity: "warn",
        title: "main red: test fails",
        body: "## Evidence\n\nexit 1",
        ...overrides,
      });
    return { resident, workspace, run, report };
  }

  test("the same key again is an update, not a second task", async () => {
    await withResidents(async (harness) => {
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
      const second = await report({ severity: "urgent" });
      expect(second.action).toBe("updated");
      expect(second.notified).toBeNull();
      const tasks = context.repositories.listTasks({
        workspaceId: workspace.id,
      });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.description).toContain("## Update 2026-09-30 10:30");
      expect(tasks[0]!.description).toContain("Severity: urgent");
    });
  });

  test("two processes reporting one key at once make one task", async () => {
    await withResidents(async (harness) => {
      const { context } = harness;
      const { workspace, report } = await reportSetup(harness);
      const other = await harness.second();
      const otherReport = other.findings.report({
        resident: other.residents.get("argus"),
        workspace,
        routine: "ci-health",
        findings: "task",
        runId: 1,
        key: "ci-health:org/repo:main:CI:test",
        severity: "warn",
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
        context.repositories.residents.listFindings(
          results[0]!.finding.residentId,
        ),
      ).toHaveLength(1);
    });
  });

  test("a second key with the same cause joins the first task", async () => {
    await withResidents(async (harness) => {
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
      ).rejects.toThrow("No open finding");
    });
  });

  test("clears, closes after a day untouched, and reopens within 14 days", async () => {
    await withResidents(async (harness) => {
      const { context } = harness;
      const { workspace, report } = await reportSetup(harness);
      const resident = context.residents.get("argus");
      const opened = await report();
      const cleared = context.findings.clear(
        resident,
        "ci-health:org/repo:main:CI:test",
      );
      expect(cleared?.state).toBe("cleared");
      expect(
        context.findings.clear(resident, "ci-health:org/repo:main:CI:test"),
      ).toBeNull();
      harness.advance(23 * 3_600_000);
      context.findings.sweep(resident);
      expect(context.tasks.get(opened.task!.id).status).toBe("todo");
      harness.advance(2 * 3_600_000);
      const { closedTasks } = context.findings.sweep(resident);
      expect(closedTasks).toHaveLength(1);
      const closed = context.tasks.get(opened.task!.id);
      expect(closed.status).toBe("done");
      expect(closed.description).toContain("## Cleared at 2026-09-30 10:00");
      expect(closed.description).toContain(
        "## Closed by Argus: cleared at 2026-09-30 10:00, no action taken",
      );
      // Back five days later: the same task, back in todo, notified again.
      harness.advance(5 * 86_400_000);
      const back = await report();
      expect(back.action).toBe("reopened");
      expect(back.task?.id).toBe(opened.task!.id);
      expect(back.task?.status).toBe("todo");
      expect(back.finding.reopenCount).toBe(1);
      expect(back.notified).not.toBeNull();
      expect(context.tasks.get(opened.task!.id).description).toContain(
        "## Came back at",
      );
      // Cleared again and back after three weeks: a new task naming the old.
      context.findings.clear(resident, "ci-health:org/repo:main:CI:test");
      harness.advance(21 * 86_400_000);
      context.findings.sweep(resident);
      const later = await report();
      expect(later.action).toBe("opened");
      expect(later.task?.id).not.toBe(opened.task!.id);
      expect(later.task?.description).toContain(
        `The earlier task was argus#${opened.task!.number}`,
      );
      expect(
        context.repositories.listTasks({ workspaceId: workspace.id }),
      ).toHaveLength(2);
    });
  });

  test("a cleared task an agent worked on is left for the user", async () => {
    await withResidents(async (harness) => {
      const { context } = harness;
      const { report } = await reportSetup(harness);
      const resident = context.residents.get("argus");
      const opened = await report();
      await context.agents.spawn({
        workspace: "argus",
        taskId: opened.task!.id,
        provider: "claude",
      });
      const status = context.tasks.get(opened.task!.id).status;
      context.findings.clear(resident, "ci-health:org/repo:main:CI:test");
      harness.advance(25 * 3_600_000);
      expect(context.findings.sweep(resident).closedTasks).toEqual([]);
      expect(context.tasks.get(opened.task!.id).status).toBe(status);
    });
  });

  test("a task the user closed comes back when the issue is still there", async () => {
    await withResidents(async (harness) => {
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
    await withResidents(async (harness) => {
      const { context } = harness;
      const { workspace, report } = await reportSetup(harness);
      const resident = context.residents.get("argus");
      const opened = await report();
      const noise = context.findings.verdict(
        resident,
        opened.finding.id,
        "noise",
        "flaky runner",
      );
      expect(noise).toMatchObject({ verdict: "noise", state: "closed" });
      expect(context.tasks.get(opened.task!.id).description).toContain(
        "## Marked noise at",
      );
      harness.advance(3_600_000);
      const quiet = await report({ severity: "urgent" });
      expect(quiet).toMatchObject({
        action: "suppressed",
        task: null,
        notified: null,
      });
      expect(quiet.finding.lastSeenAt).toBe(harness.clock.now.toISOString());
      expect(
        context.repositories.listTasks({ workspaceId: workspace.id }),
      ).toHaveLength(1);
      context.findings.verdict(resident, opened.finding.id, null);
      const back = await report();
      expect(back.action).toBe("reopened");
      expect(back.task?.id).toBe(opened.task!.id);
    });
  });

  test("a finding task the user closes as done counts as useful", async () => {
    await withResidents(async (harness) => {
      const { context } = harness;
      const { report } = await reportSetup(harness);
      const resident = context.residents.get("argus");
      const opened = await report();
      context.tasks.setStatus(opened.task!.id, "done");
      context.findings.sweep(resident);
      expect(
        context.repositories.residents.findFinding(opened.finding.id),
      ).toMatchObject({
        state: "closed",
        verdict: "useful",
      });
    });
  });

  test("an urgent finding gets through Focus mode and a warning does not", async () => {
    await withResidents(async (harness) => {
      const { context } = harness;
      const { report } = await reportSetup(harness);
      await context.presence.setFocusMode(true);
      const warning = await report();
      expect(warning.notified).toBe("focus mode is on");
      const urgent = await report({
        key: "ci-health:org/repo:main:CI:deploy",
        severity: "urgent",
      });
      expect(urgent.notified).not.toBe("focus mode is on");
      expect(urgent.task?.priority).toBe("high");
    });
  });

  test("a notify routine notifies and opens no task", async () => {
    await withResidents(async (harness) => {
      const { context } = harness;
      const { workspace, report } = await reportSetup(harness);
      const result = await report({
        routine: "slack",
        findings: "notify",
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
            findings: "notify",
            key: "slack:dm:123",
          })
        ).action,
      ).toBe("updated");
      await expect(report({ findings: "none" })).rejects.toThrow(
        "cannot report",
      );
    });
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
    await withResidents(async (harness) => {
      const { context } = harness;
      const resident = await argus(harness);
      const workspace = await context.workspaces.get("argus");
      await writeFile(
        join(workspace.path, "routines", "templates", "post-merge-watch.md"),
        routineFile("post-merge-watch", "vars:\n  pr: none\n").replace(
          "Check post-merge-watch",
          "Watch {{pr}}",
        ),
      );
      const routine = await context.routines.add(resident, {
        template: "post-merge-watch",
        name: "watch-pr-57",
        vars: { pr: "org/repo#57" },
        until: "+60m",
      });
      expect(routine.vars.pr).toBe("org/repo#57");
      await context.residents.tick(idle(harness));
      const [run] = context.routines.inFlightRuns(resident);
      expect(
        (await context.routines.start(resident, run!.id)).prompt,
      ).toContain("Watch org/repo#57");
      await context.routines.done(resident, run!.id, "quiet", "clean");
      harness.advance(61 * 60_000);
      await context.residents.tick(
        idle(harness, { activity: () => undefined }),
      );
      expect((await context.routines.list(resident)).routines).toEqual([]);
      expect(
        await Bun.file(
          join(workspace.path, "routines", "watch-pr-57.md"),
        ).exists(),
      ).toBe(false);
    });
  });

  test("a bad file is listed with its error and never runs", async () => {
    await withResidents(async (harness) => {
      const { context } = harness;
      const resident = await argus(harness);
      const workspace = await context.workspaces.get("argus");
      await writeFile(
        join(workspace.path, "routines", "broken.md"),
        "---\nname: broken\nschedule: sometimes\n---\nbody\n",
      );
      await context.residents.tick(idle(harness));
      const { routines, errors } = await context.routines.list(resident);
      expect(routines).toEqual([]);
      expect(errors[0]).toMatchObject({ name: "broken" });
      expect(errors[0]!.error).toContain("is not one of");
      expect(context.routines.runs(resident)).toEqual([]);
      await expect(
        context.routines.add(resident, { text: "---\nname: x\n---\nbody" }),
      ).rejects.toThrow("'schedule' field is required");
    });
  });

  test("disabled routines do not run and enabling schedules them", async () => {
    await withResidents(async (harness) => {
      const { context } = harness;
      const resident = await argus(harness);
      await context.routines.add(resident, {
        text: routineFile("quiet", "enabled: false\n"),
      });
      await context.residents.tick(idle(harness));
      expect(context.routines.runs(resident)).toEqual([]);
      await context.routines.setEnabled(resident, "quiet", true);
      harness.advance(1_000);
      await context.residents.tick(idle(harness));
      expect(context.routines.runs(resident)).toHaveLength(1);
    });
  });

  test("a paused resident queues nothing and fires once on resume", async () => {
    await withResidents(async (harness) => {
      const { context } = harness;
      const resident = await argus(harness);
      context.residents.pause("argus");
      await context.routines.add(resident, { text: routineFile("ci-health") });
      await context.residents.tick(idle(harness));
      expect(context.routines.runs(resident)).toEqual([]);
      await context.residents.resume("argus");
      harness.advance(60 * 60_000);
      await context.residents.tick(idle(harness));
      expect(context.routines.runs(resident)).toHaveLength(1);
    });
  });
});

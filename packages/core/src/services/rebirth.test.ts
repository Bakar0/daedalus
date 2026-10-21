import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  buildAgentPrompt,
  buildRebirthRequest,
  createApplicationContext,
  rebirthSessionName,
  type ApplicationContext,
} from "../index";

class FakeTmux implements TmuxClient {
  openPty() {
    return {
      start: async () => {},
      write() {},
      resize() {},
      close() {},
    };
  }
  async pinWindowSize() {}
  async unpinWindowSize() {}
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
    return "Ask Codex to do anything\nshift+tab to cycle";
  }
  readonly keys: Array<{ session: string; keys: string[] }> = [];
  async sendKeys(session: string, keys: string[]) {
    this.keys.push({ session, keys });
  }
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

async function withRebirthContext(
  run: (context: ApplicationContext, tmux: FakeTmux) => Promise<void>,
) {
  await withTemporaryDaedalusHome(async (home) => {
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        agents: { codex: { executable: process.execPath, args: ["run"] } },
      }),
    );
    const tmux = new FakeTmux();
    const context = await createApplicationContext({
      // Provider homes inside the temporary home, so installing the rebirth
      // skill never touches the real ~/.claude or ~/.agents.
      env: {
        DAEDALUS_HOME: home,
        CODEX_HOME: join(home, "codex"),
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        DAEDALUS_AGENTS_HOME: join(home, "agents"),
        DAEDALUS_CURSOR_HOME: join(home, "cursor"),
      },
      tmux,
    });
    try {
      await context.skills.sync();
      await run(context, tmux);
    } finally {
      context.close();
    }
  });
}

async function startedTask(context: ApplicationContext) {
  const workspace = await context.workspaces.create({ name: "Handoffs" });
  const task = await context.tasks.create({
    workspace: workspace.id,
    title: "Long job",
  });
  const first = await context.agents.spawn({
    workspace: workspace.id,
    taskId: task.id,
    provider: "codex",
    model: "gpt-5.5",
  });
  // A worktree row, as `repo worktree create` would leave one.
  const repositoryId = crypto.randomUUID();
  context.repositories.createWorkspaceRepository({
    id: repositoryId,
    workspaceId: workspace.id,
    name: "app",
    canonicalPath: join(workspace.path, "repos", "app"),
    access: "write",
    libraryRepositoryId: null,
    referencePath: null,
    baseBranch: "main",
    baseCommit: null,
    fetchedAt: null,
    createdAt: new Date().toISOString(),
    status: "ready",
    statusError: null,
  });
  context.repositories.createSessionWorktree({
    sessionId: first.id,
    repositoryId,
    path: join(first.workingDirectory, "app"),
    branchName: "daedalus/daedalus-handoffs/long-job",
    createdAt: new Date().toISOString(),
  });
  return { workspace, task, first };
}

describe("continuing a session in a fresh one", () => {
  test("reuses the directory, takes the worktrees and archives the old one", async () => {
    await withRebirthContext(async (context, tmux) => {
      const { task, first } = await startedTask(context);
      const result = await context.agents.continueSession({
        id: first.id,
        note: "# Rebirth\n\nStep 3 is next.",
      });
      const next = result.session;
      expect(next.id).not.toBe(first.id);
      expect(next.taskId).toBe(task.id);
      expect(next.name).toBe(`${first.name} · 2`);
      expect(next.workingDirectory).toBe(first.workingDirectory);
      expect(tmux.launches.at(-1)!.cwd).toBe(first.workingDirectory);
      expect(next.args).toContain("gpt-5.5");
      expect(
        await Bun.file(join(first.workingDirectory, "REBIRTH.md")).text(),
      ).toBe("# Rebirth\n\nStep 3 is next.\n");
      const prompt = tmux.launches.at(-1)!.args.at(-1)!;
      expect(prompt).toContain(`Continue task #${task.number}`);
      expect(prompt).toContain("REBIRTH.md");
      expect(prompt).not.toContain("Execute task");
      expect(
        context.repositories.listSessionWorktrees({ sessionId: next.id }),
      ).toHaveLength(1);
      expect(
        context.repositories.listSessionWorktrees({ sessionId: first.id }),
      ).toHaveLength(0);
      expect(result.predecessor.archivedAt).not.toBeNull();
      expect(result.archiveError).toBeUndefined();
      expect(tmux.sessions.has(first.tmuxSession)).toBe(false);
    });
  });

  test("leaves archiving to the caller when asked, and works without a note", async () => {
    await withRebirthContext(async (context, tmux) => {
      const { first } = await startedTask(context);
      const result = await context.agents.continueSession({
        id: first.id,
        archive: "later",
      });
      expect(result.predecessor.archivedAt).toBeNull();
      expect(tmux.sessions.has(first.tmuxSession)).toBe(true);
      expect(
        await Bun.file(join(first.workingDirectory, "REBIRTH.md")).exists(),
      ).toBe(false);
      expect(tmux.launches.at(-1)!.args.at(-1)!).toContain("left no note");
    });
  });

  test("a successor keeps its predecessor's own rebirth threshold", async () => {
    await withRebirthContext(async (context) => {
      const { first } = await startedTask(context);
      await context.agents.setAutoRebirth(first.id, 75);
      const result = await context.agents.continueSession({
        id: first.id,
        archive: "later",
      });
      expect(result.session.autoRebirthPercent).toBe(75);
      expect(
        (await context.agents.get(result.session.id)).autoRebirthPercent,
      ).toBe(75);
    });
  });

  test("refuses terminals and archived sessions", async () => {
    await withRebirthContext(async (context) => {
      const { workspace, first } = await startedTask(context);
      const terminal = await context.agents.spawn({
        workspace: workspace.id,
        terminal: true,
      });
      await expect(
        context.agents.continueSession({ id: terminal.id }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await context.agents.archive(first.id);
      await expect(
        context.agents.continueSession({ id: first.id }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        context.agents.requestRebirth(first.id),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });
  });

  test("a rebirth request invokes the skill, and needs it installed", async () => {
    await withRebirthContext(async (context, tmux) => {
      const { first } = await startedTask(context);
      await context.agents.requestRebirth(first.id);
      const request = tmux.sent.at(-1)!;
      expect(request.session).toBe(first.tmuxSession);
      // The instructions live in the skill alone; the request only names it.
      expect(request.text).toBe("$daedalus-rebirth");
      // Codex needs a second Enter: the first only picks the skill.
      expect(tmux.keys.at(-1)).toEqual({
        session: first.tmuxSession,
        keys: ["Enter"],
      });
      expect(buildRebirthRequest("claude", "daedalus-rebirth-dev")).toBe(
        "/daedalus-rebirth-dev",
      );
      await context.skills.setEnabled("daedalus-rebirth", false);
      await expect(
        context.agents.requestRebirth(first.id),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringContaining(
          "daedal skill enable daedalus-rebirth",
        ),
      });
    });
  });

  test("a requested rebirth is recorded on the session", async () => {
    await withRebirthContext(async (context) => {
      const { first } = await startedTask(context);
      expect(first.rebirthRequestedAt).toBeNull();
      const requested = await context.agents.requestRebirth(first.id);
      expect(requested.rebirthRequestedAt).not.toBeNull();
      expect((await context.agents.get(first.id)).rebirthRequestedAt).toBe(
        requested.rebirthRequestedAt,
      );
    });
  });

  test("a successor's name counts generations instead of stacking suffixes", () => {
    expect(rebirthSessionName("Long job")).toBe("Long job · 2");
    expect(rebirthSessionName("Long job · 2")).toBe("Long job · 3");
    expect(rebirthSessionName("Long job · 9")).toBe("Long job · 10");
  });

  test("the continuation prompt resumes in the state the session stopped in", () => {
    const prompt = buildAgentPrompt({
      taskNumber: 4,
      mode: "continue",
      note: true,
    })!;
    expect(prompt).toContain("REBIRTH.md");
    expect(prompt).toContain("If it was waiting for the user");
    expect(prompt).toContain("daedal attention");
    expect(prompt).toContain(
      "Instructions from the user in the note come first",
    );
  });

  test("the continuation prompt keeps an extra message", () => {
    expect(
      buildAgentPrompt({
        taskNumber: 4,
        mode: "continue",
        note: true,
        message: "Skip the docs.",
      }),
    ).toMatch(/^Continue task #4\. .*\n\nSkip the docs\.$/s);
  });
});

describe("automatic rebirth", () => {
  test("the threshold is per workspace, off by default, and bounded", async () => {
    await withRebirthContext(async (context) => {
      const workspace = await context.workspaces.create({ name: "Auto" });
      expect(workspace.autoRebirthPercent).toBeNull();
      const on = await context.workspaces.update(workspace.id, {
        autoRebirthPercent: 80,
      });
      expect(on.autoRebirthPercent).toBe(80);
      expect(
        (await context.workspaces.get(workspace.id)).autoRebirthPercent,
      ).toBe(80);
      for (const bad of [5, 101, 80.5]) {
        await expect(
          context.workspaces.update(workspace.id, { autoRebirthPercent: bad }),
        ).rejects.toMatchObject({ code: "VALIDATION" });
      }
      const off = await context.workspaces.update(workspace.id, {
        autoRebirthPercent: null,
      });
      expect(off.autoRebirthPercent).toBeNull();
      const explicit = await context.workspaces.update(workspace.id, {
        autoRebirthPercent: "off",
      });
      expect(explicit.autoRebirthPercent).toBe("off");
      expect(
        (await context.workspaces.get(workspace.id)).autoRebirthPercent,
      ).toBe("off");
    });
  });

  test("a session takes its own threshold, else its workspace's, else the global one", async () => {
    await withRebirthContext(async (context) => {
      const { workspace, first } = await startedTask(context);
      const quiet = await context.workspaces.create({ name: "Quiet" });
      await context.workspaces.update(quiet.id, { autoRebirthPercent: "off" });
      const loud = await context.agents.spawn({
        workspace: quiet.id,
        provider: "codex",
      });
      const opted = await context.agents.spawn({
        workspace: workspace.id,
        provider: "codex",
      });
      context.config.autoRebirthPercent = 70;
      // Its own beats a workspace that is off, and off beats the global one.
      expect(
        (await context.agents.setAutoRebirth(loud.id, 90)).autoRebirthPercent,
      ).toBe(90);
      await context.agents.setAutoRebirth(opted.id, "off");
      expect((await context.agents.get(opted.id)).autoRebirthPercent).toBe(
        "off",
      );
      await expect(
        context.agents.setAutoRebirth(loud.id, 5),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      const at = (percent: number) =>
        [first, loud, opted].map((item) => ({
          sessionId: item.id,
          context: { usedPercent: percent },
        }));
      expect(
        (await context.agents.sweepAutoRebirths(at(75))).map((item) => item.id),
      ).toEqual([first.id]);
      expect(
        (await context.agents.sweepAutoRebirths(at(95))).map((item) => item.id),
      ).toEqual([loud.id]);
      expect(
        context.agents.autoRebirthThreshold(await context.agents.get(opted.id)),
      ).toBeNull();
      expect(context.agents.autoRebirthThreshold(first)).toBe(70);
    });
  });

  test("the sweep asks once, only past the threshold, only where it is on", async () => {
    await withRebirthContext(async (context, tmux) => {
      const { workspace, first } = await startedTask(context);
      const quiet = await context.workspaces.create({ name: "Quiet" });
      const other = await context.agents.spawn({
        workspace: quiet.id,
        provider: "codex",
      });
      const at = (percent: number) => [
        { sessionId: first.id, context: { usedPercent: percent } },
        { sessionId: other.id, context: { usedPercent: percent } },
      ];
      // Off everywhere: nothing happens however full the context is.
      expect(await context.agents.sweepAutoRebirths(at(99))).toEqual([]);
      await context.workspaces.update(workspace.id, {
        autoRebirthPercent: 85,
      });
      expect(await context.agents.sweepAutoRebirths(at(84))).toEqual([]);
      expect(tmux.sent).toHaveLength(0);
      const requested = await context.agents.sweepAutoRebirths(at(85));
      expect(requested.map((item) => item.id)).toEqual([first.id]);
      expect(tmux.sent).toHaveLength(1);
      expect(tmux.sent[0]!.session).toBe(first.tmuxSession);
      expect(tmux.sent[0]!.text).toBe("$daedalus-rebirth");
      // Already asked: the next tick does not ask again.
      expect(await context.agents.sweepAutoRebirths(at(95))).toEqual([]);
      expect(tmux.sent).toHaveLength(1);
      // A session with no context reading is left alone.
      const fresh = await context.agents.spawn({
        workspace: workspace.id,
        provider: "codex",
      });
      expect(
        await context.agents.sweepAutoRebirths([{ sessionId: fresh.id }]),
      ).toEqual([]);
    });
  });
});

import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import {
  withoutProviderClis,
  withTemporaryDaedalusHome,
} from "@daedalus/test-utils";
import { createApplicationContext, ReadModel } from "../index";

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
  async probe() {
    return "tmux 3.7c";
  }
  async createSession(launch: TmuxLaunch) {
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
    return "";
  }
  async sendKeys() {}
  async send() {}
  async stop(session: string) {
    this.sessions.delete(session);
  }
  async killServer() {
    const running = this.sessions.size > 0;
    this.sessions.clear();
    return running;
  }
}

const withContext = (
  run: (
    context: Awaited<ReturnType<typeof createApplicationContext>>,
  ) => Promise<void>,
) =>
  withTemporaryDaedalusHome(async (home) => {
    await withoutProviderClis(home);
    const context = await createApplicationContext({
      env: { ...process.env, DAEDALUS_HOME: home },
      tmux: new FakeTmux(),
    });
    try {
      await run(context);
    } finally {
      context.close();
    }
  });

describe("ReadModel", () => {
  test("a snapshot reads every part through the services", async () => {
    await withContext(async (context) => {
      const workspace = await context.workspaces.create({ name: "Shop" });
      await context.tasks.create({
        workspace: workspace.id,
        title: "First",
      });
      await context.tasks.create({
        workspace: workspace.id,
        title: "Second",
        description: "After #1",
      });

      const view = await new ReadModel(context).snapshot();

      expect(view.workspaces).toEqual([{ workspace, available: true }]);
      expect(
        view.tasks.map(({ task, references }) => ({
          title: task.title,
          references: references.map((item) => item.number),
        })),
      ).toEqual([
        { title: "First", references: [] },
        { title: "Second", references: [1] },
      ]);
      expect(view.settings.config).toBe(context.config);
      expect(view.agents).toEqual([]);
      expect(view.teams).toEqual([]);
    });
  });

  test("the version moves with the rows a snapshot is built from, and only then", async () => {
    await withContext(async (context) => {
      const model = new ReadModel(context);
      const empty = await model.version();
      expect(await model.version()).toBe(empty);

      const workspace = await context.workspaces.create({ name: "Shop" });
      const withWorkspace = await model.version();
      expect(withWorkspace).not.toBe(empty);

      // As the CLI would: straight to the rows, with no window to announce it.
      await context.tasks.create({ workspace: workspace.id, title: "Ship" });
      const withTask = await model.version();
      expect(withTask).not.toBe(withWorkspace);
      expect(await model.version()).toBe(withTask);
    });
  });

  test("rows are read after sessions reconcile with tmux", async () => {
    await withContext(async (context) => {
      const workspace = await context.workspaces.create({ name: "Update" });
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      // A Codex session that stopped at its startup question, and whose tmux
      // session is gone: no FakeTmux session was ever made for it.
      context.repositories.createAgent({
        id,
        workspaceId: workspace.id,
        taskId: null,
        name: "Update",
        provider: "codex",
        kind: "agent",
        tmuxSession: `daedalus_${id.replaceAll("-", "")}`,
        command: "/bin/sh",
        args: [],
        workingDirectory: workspace.path,
        status: "running",
        exitCode: null,
        startedAt: now,
        endedAt: null,
        providerSessionId: null,
        archivedAt: null,
        resumeCount: 0,
        lostReason: null,
        rebirthRequestedAt: null,
        resumeOnStart: false,
        position: context.repositories.nextAgentPosition(workspace.id),
        pinnedAt: null,
        color: null,
        account: null,
        teamId: null,
        teamHandle: null,
        spawnedBy: null,
        hostId: null,
        autoRebirthPercent: null,
      });
      context.repositories.saveSessionAttention({
        sessionId: id,
        workspaceId: workspace.id,
        reasons: [
          {
            id: crypto.randomUUID(),
            text: "Codex is asking something before it starts. Answer it in the session's terminal.",
            raisedAt: now,
            source: "pane",
          },
        ],
        raisedAt: now,
        updatedAt: now,
      });

      const view = await new ReadModel(context).snapshot();

      expect(view.agents.map((agent) => agent.status)).toEqual(["lost"]);
      expect(view.attention).toEqual([]);
    });
  });
});

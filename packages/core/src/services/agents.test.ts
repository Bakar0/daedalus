import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { buildTaskPrompt, createApplicationContext } from "../index";

class FakeTmux implements TmuxClient {
  readonly sessions = new Set<string>();
  readonly launches: TmuxLaunch[] = [];
  readonly sent: Array<{ session: string; text: string }> = [];
  attachExitCode = 0;

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
    return this.attachExitCode;
  }
  async send(session: string, text: string) {
    this.sent.push({ session, text });
  }
  async stop(session: string) {
    this.sessions.delete(session);
  }
}

describe("AgentService", () => {
  test("builds an argv-safe task launch and manages its lifecycle", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { codex: { executable: process.execPath, args: ["run"] } },
        }),
      );
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Agents" });
      const task = await context.tasks.create({
        workspace: workspace.id,
        title: "Avoid injection; $(touch nope)",
        description: "Keep this as one argument",
      });
      const agent = await context.agents.spawn({
        workspace: workspace.id,
        taskId: task.id,
        provider: "codex",
      });
      expect(agent.tmuxSession).toMatch(/^daedalus_[a-f0-9]{32}$/);
      expect(tmux.launches[0]).toMatchObject({
        executable: process.execPath,
        args: ["run", buildTaskPrompt(task.title, task.description)],
        cwd: workspace.path,
      });
      expect(tmux.launches[0]?.args).toHaveLength(2);
      await context.agents.send(agent.id, "hello; exit");
      expect(tmux.sent[0]?.text).toBe("hello; exit");
      await expect(
        context.workspaces.remove(workspace.id, { force: true }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const stopped = await context.agents.stop(agent.id);
      expect(stopped.status).toBe("exited");
      await context.agents.remove(agent.id);
      context.close();
    });
  });

  test("reconciles vanished tmux sessions as lost after restart", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { shell: { executable: process.execPath, args: [] } },
        }),
      );
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Restart" });
      const agent = await context.agents.spawn({
        workspace: workspace.id,
        command: "shell",
      });
      tmux.sessions.clear();
      await context.agents.reconcile();
      expect((await context.agents.get(agent.id)).status).toBe("lost");
      context.close();
    });
  });
});

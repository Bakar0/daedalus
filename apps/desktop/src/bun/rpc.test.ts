import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createApplicationContext } from "@daedalus/core";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { createDesktopRequestHandlers, desktopDataFingerprint } from "./rpc";

class FakeTmux implements TmuxClient {
  sessions = new Set<string>();
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
  async send() {}
  async stop(session: string) {
    this.sessions.delete(session);
  }
}

describe("desktop RPC handlers", () => {
  test("exposes workspace, task, and agent lifecycles through core services", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await mkdir(home, { recursive: true });
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { shell: { executable: "/bin/sh", args: ["-l"] } },
        }),
      );
      const context = await createApplicationContext({
        env: { ...process.env, DAEDALUS_HOME: home },
        tmux: new FakeTmux(),
      });
      let mutations = 0;
      const rpc = createDesktopRequestHandlers(context, () => mutations++);
      try {
        const workspace = await rpc.workspaceCreate({ name: "Desktop Demo" });
        expect(workspace.ok).toBe(true);
        if (!workspace.ok) return;
        const workspaceFingerprint = desktopDataFingerprint(context);

        const task = await rpc.taskCreate({
          workspace: workspace.data.id,
          title: "Build UI",
          description: "Use shared services",
          priority: "high",
        });
        expect(task.ok && task.data.status).toBe("todo");
        if (!task.ok) return;
        expect(desktopDataFingerprint(context)).not.toBe(workspaceFingerprint);

        const progressed = await rpc.taskSetStatus({
          id: task.data.id,
          status: "in_progress",
        });
        expect(progressed.ok && progressed.data.status).toBe("in_progress");

        const agent = await rpc.agentSpawn({
          workspace: workspace.data.id,
          taskId: task.data.id,
          command: "shell",
        });
        expect(agent.ok && agent.data.status).toBe("running");
        expect(agent.ok && agent.data.name).toBe("Build UI");
        if (!agent.ok) return;

        const stopped = await rpc.agentStop({
          id: agent.data.id,
          force: false,
        });
        expect(stopped.ok && stopped.data.status).toBe("exited");
        expect((await rpc.agentRemove({ id: agent.data.id })).ok).toBe(true);
        expect(
          (await rpc.taskRemove({ id: task.data.id, force: true })).ok,
        ).toBe(true);
        expect(
          (
            await rpc.workspaceRemove({
              reference: workspace.data.id,
              deleteFiles: true,
              force: true,
            })
          ).ok,
        ).toBe(true);
        expect(mutations).toBe(8);
      } finally {
        context.close();
      }
    });
  });

  test("returns stable typed failures and does not announce failed mutations", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { ...process.env, DAEDALUS_HOME: home },
        tmux: new FakeTmux(),
      });
      let mutations = 0;
      const rpc = createDesktopRequestHandlers(context, () => mutations++);
      try {
        const response = await rpc.taskRemove({ id: "missing", force: true });
        expect(response).toEqual({
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: "Task 'missing' was not found",
            details: undefined,
          },
        });
        expect(mutations).toBe(0);
      } finally {
        context.close();
      }
    });
  });

  test("snapshot reports configuration and dependency availability", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { ...process.env, DAEDALUS_HOME: home },
        tmux: new FakeTmux(),
      });
      try {
        const response = await createDesktopRequestHandlers(context).snapshot(
          {},
        );
        expect(response.ok).toBe(true);
        if (response.ok) {
          expect(response.data.settings.home).toBe(home);
          expect(response.data.settings.tmuxAvailable).toBe(true);
          expect(response.data.workspaces).toEqual([]);
        }
      } finally {
        context.close();
      }
    });
  });
});

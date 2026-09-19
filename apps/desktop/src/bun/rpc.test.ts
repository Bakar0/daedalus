import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createApplicationContext } from "@daedalus/core";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import packageJson from "../../../../package.json";
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

        const homeTerminal = await rpc.terminalCreate({});
        expect(homeTerminal.ok && homeTerminal.data.workingDirectory).toBe(
          home,
        );
        const workspaceTerminal = await rpc.terminalCreate({
          workspace: workspace.data.id,
        });
        expect(
          workspaceTerminal.ok && workspaceTerminal.data.workingDirectory,
        ).toBe(workspace.data.path);
        if (!homeTerminal.ok || !workspaceTerminal.ok) return;

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
        expect((await rpc.terminalClose({ id: homeTerminal.data.id })).ok).toBe(
          true,
        );
        expect(
          (await rpc.terminalClose({ id: workspaceTerminal.data.id })).ok,
        ).toBe(true);
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
        expect(mutations).toBe(12);
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

  test("opens only web links through the system handler", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { ...process.env, DAEDALUS_HOME: home },
        tmux: new FakeTmux(),
      });
      const opened: string[] = [];
      const rpc = createDesktopRequestHandlers(context, undefined, (url) => {
        opened.push(url);
        return true;
      });
      try {
        expect(
          await rpc.openExternal({ url: "https://example.com/docs" }),
        ).toEqual({ ok: true, data: { opened: true } });
        expect(opened).toEqual(["https://example.com/docs"]);
        expect(await rpc.openExternal({ url: "file:///tmp/private" })).toEqual({
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Only HTTP and HTTPS links can be opened",
            details: undefined,
          },
        });
        expect(opened).toHaveLength(1);
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
        const rpc = createDesktopRequestHandlers(context);
        const response = await rpc.snapshot({});
        expect(response.ok).toBe(true);
        if (response.ok) {
          // "Which build am I running" has to be answerable from inside the
          // app, or verifying an update means grepping the bundle.
          expect(response.data.settings.version).toBe(packageJson.version);
          expect(response.data.settings.channel).toBe("stable");
          expect(response.data.settings.home).toBe(home);
          expect(response.data.settings.tmuxAvailable).toBe(true);
          expect(response.data.settings.workspaceInstructionFilesEnabled).toBe(
            true,
          );
          expect(response.data.workspaces).toEqual([]);
        }
        expect(
          (await rpc.workspaceInstructionFilesSet({ enabled: false })).ok,
        ).toBe(true);
        const updated = await rpc.snapshot({});
        expect(
          updated.ok && updated.data.settings.workspaceInstructionFilesEnabled,
        ).toBe(false);
      } finally {
        context.close();
      }
    });
  });

  test("reads workspace content and appends a typed journal entry", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { ...process.env, DAEDALUS_HOME: home },
        tmux: new FakeTmux(),
      });
      const rpc = createDesktopRequestHandlers(context);
      try {
        const created = await rpc.workspaceCreate({ name: "Content" });
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const content = await rpc.workspaceContentGet({
          workspace: created.data.id,
        });
        expect(content.ok && content.data.brief).toContain("# Brief");
        const root = await rpc.workspaceDirectoryList({
          workspace: created.data.id,
        });
        expect(
          root.ok && root.data.some((item) => item.path === "BRIEF.md"),
        ).toBe(true);
        const brief = await rpc.workspaceFileRead({
          workspace: created.data.id,
          path: "BRIEF.md",
        });
        expect(brief.ok && brief.data.format).toBe("markdown");
        const createdFile = await rpc.workspaceEntryCreate({
          workspace: created.data.id,
          name: "NOTES.md",
          kind: "file",
        });
        expect(createdFile.ok && createdFile.data.path).toBe("NOTES.md");
        const savedFile = await rpc.workspaceFileWrite({
          workspace: created.data.id,
          path: "NOTES.md",
          content: "# Notes\n",
          expectedContent: "",
        });
        expect(savedFile.ok && savedFile.data.content).toBe("# Notes\n");
        const journal = await rpc.workspaceJournalAppend({
          workspace: created.data.id,
          kind: "blocker",
          summary: "Developer input is required.",
        });
        expect(journal.ok && journal.data.journal).toContain("· blocker");
        expect(journal.ok && journal.data.journal).toContain(
          "Developer input is required.",
        );
      } finally {
        context.close();
      }
    });
  });

  test("carries the quit dialog's two answers to the host", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { ...process.env, DAEDALUS_HOME: home },
        tmux: new FakeTmux(),
      });
      const decisions: Array<[string, boolean]> = [];
      let shown = 0;
      const rpc = createDesktopRequestHandlers(
        context,
        () => {},
        () => false,
        "",
        {
          dialogShown: () => {
            shown += 1;
          },
          decide: async (choice, remember) => {
            decisions.push([choice, remember]);
          },
        },
      );
      try {
        expect((await rpc.snapshot({})).ok).toBe(true);
        const snapshot = await rpc.snapshot({});
        expect(snapshot.ok && snapshot.data.settings.quitBehavior).toBe("ask");

        expect(await rpc.quitDialogShown({})).toEqual({
          ok: true,
          data: { acknowledged: true },
        });
        expect(shown).toBe(1);
        expect(
          await rpc.quitDecision({ choice: "keep", remember: false }),
        ).toEqual({ ok: true, data: { accepted: true } });
        expect(decisions).toEqual([["keep", false]]);

        expect(await rpc.quitBehaviorSet({ behavior: "keep" })).toEqual({
          ok: true,
          data: { behavior: "keep" },
        });
        const updated = await rpc.snapshot({});
        expect(updated.ok && updated.data.settings.quitBehavior).toBe("keep");
      } finally {
        context.close();
      }
    });
  });
});

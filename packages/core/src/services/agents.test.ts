import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  buildTaskPrompt,
  createApplicationContext,
  isMissingCodexConversationError,
} from "../index";

class FakeTmux implements TmuxClient {
  readonly sessions = new Set<string>();
  readonly launches: TmuxLaunch[] = [];
  readonly sent: Array<{ session: string; text: string }> = [];
  readonly keys: string[][] = [];
  screens = [
    "Ask Codex to do anything\nClaude Code v2.1.251\nshift+tab to cycle",
  ];
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
  async capture() {
    return this.screens.length > 1 ? this.screens.shift()! : this.screens[0]!;
  }
  async sendKeys(_session: string, keys: string[]) {
    this.keys.push(keys);
  }
  async send(session: string, text: string) {
    this.sent.push({ session, text });
  }
  async stop(session: string) {
    this.sessions.delete(session);
  }
}

describe("AgentService", () => {
  test("recognizes only Codex's missing-conversation archive result", () => {
    expect(
      isMissingCodexConversationError(
        "Error: No active session found matching 'daedalus-session-id'.",
      ),
    ).toBe(true);
    expect(isMissingCodexConversationError("Authentication failed")).toBe(
      false,
    );
  });

  test("confirms provider trust only for Daedalus-owned startup folders", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { claude: { executable: process.execPath, args: [] } },
        }),
      );
      const tmux = new FakeTmux();
      tmux.screens = [
        "Quick safety check\nNo, exit\nYes, I trust this folder",
        "Quick safety check\nNo, exit\n❯ Yes, I trust this folder",
        "Allow external CLAUDE.md file imports?\nNo, disable\nYes, allow",
        "Allow external CLAUDE.md file imports?\nNo, disable\n❯ Yes, allow external imports",
        "Claude Code v2.1.251\nshift+tab to cycle",
      ];
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Trust" });
      const agent = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
      });
      expect(agent.status).toBe("running");
      expect(tmux.keys).toEqual([["Down"], ["Enter"], ["Down"], ["Enter"]]);
      context.close();
    });
  });

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
      expect(agent.name).toBe(task.title);
      expect(agent.tmuxSession).toMatch(/^daedalus_[a-f0-9]{32}$/);
      expect(tmux.launches[0]).toMatchObject({
        executable: process.execPath,
        args: ["run"],
        cwd: agent.workingDirectory,
      });
      expect(agent.workingDirectory).toContain(
        join(workspace.path, "worktrees"),
      );
      expect(tmux.launches[0]?.env).toMatchObject({
        DAEDALUS_HOME: home,
        DAEDALUS_SESSION_ID: agent.id,
      });
      expect(tmux.sent[0]?.text).toBe(`/rename ${agent.providerSessionId}`);
      expect(tmux.sent[1]?.text).toContain(
        buildTaskPrompt(task.title, task.description),
      );
      expect(tmux.sent[1]?.text).not.toContain("BRIEF.md");
      await context.agents.send(agent.id, "hello; exit");
      expect(tmux.sent[2]?.text).toBe("hello; exit");
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

  test("starts a durable free terminal without an agent provider", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Shell" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        name: "Release shell",
        terminal: true,
      });
      expect(session).toMatchObject({
        name: "Release shell",
        kind: "terminal",
        provider: "custom",
        args: ["-l"],
        status: "running",
      });
      expect(tmux.launches[0]?.executable).toMatch(/^\//);
      context.close();
    });
  });

  test("archives and natively resumes a Claude conversation", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { claude: { executable: process.execPath, args: ["run"] } },
        }),
      );
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Resume" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
        name: "Persistent context",
      });
      expect(session.providerSessionId).toBe(session.id);
      expect(tmux.launches[0]?.args.slice(0, 5)).toEqual([
        "run",
        "--session-id",
        session.id,
        "--name",
        "Persistent context",
      ]);
      expect(tmux.launches[0]?.args).toHaveLength(5);
      const archived = await context.agents.archive(session.id);
      expect(archived.archivedAt).not.toBeNull();
      expect(archived.status).toBe("exited");
      const restored = await context.agents.restore(session.id);
      expect(restored).toMatchObject({
        archivedAt: null,
        status: "running",
        resumeCount: 1,
      });
      expect(tmux.launches[1]?.args.slice(0, 3)).toEqual([
        "run",
        "--resume",
        session.id,
      ]);
      expect(tmux.launches[1]?.args).toHaveLength(3);
      context.close();
    });
  });

  test("recovers an existing Claude conversation identifier before archiving", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const claudeHome = join(home, "claude");
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { claude: { executable: process.execPath, args: ["run"] } },
        }),
      );
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home, CLAUDE_CONFIG_DIR: claudeHome },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Existing" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
      });
      context.repositories.updateAgent({
        ...session,
        providerSessionId: null,
      });
      const recoveredId = "8ceaa092-b66b-4dc9-8b5d-a2e7cd40ae7b";
      const projectKey = session.workingDirectory.replace(/[^a-zA-Z0-9]/g, "-");
      const projectDirectory = join(claudeHome, "projects", projectKey);
      await mkdir(projectDirectory, { recursive: true });
      await Bun.write(
        join(projectDirectory, `${recoveredId}.jsonl`),
        `${JSON.stringify({
          type: "user",
          timestamp: new Date(
            Date.parse(session.startedAt) + 1_000,
          ).toISOString(),
          cwd: session.workingDirectory,
          sessionId: recoveredId,
        })}\n`,
      );

      const archived = await context.agents.archive(session.id);
      expect(archived.providerSessionId).toBe(recoveredId);
      expect(tmux.sessions.has(session.tmuxSession)).toBe(false);
      const restored = await context.agents.restore(session.id);
      expect(restored.providerSessionId).toBe(recoveredId);
      expect(tmux.launches[1]?.args.slice(0, 3)).toEqual([
        "run",
        "--resume",
        recoveredId,
      ]);
      expect(tmux.launches[1]?.args).toHaveLength(3);
      context.close();
    });
  });

  test("does not stop existing conversations with an ambiguous match", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { claude: { executable: process.execPath, args: [] } },
        }),
      );
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: {
          DAEDALUS_HOME: home,
          CLAUDE_CONFIG_DIR: join(home, "empty-claude"),
        },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Existing" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
      });
      context.repositories.updateAgent({
        ...session,
        providerSessionId: null,
      });
      await expect(context.agents.archive(session.id)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(tmux.sessions.has(session.tmuxSession)).toBe(true);
      context.close();
    });
  });
});

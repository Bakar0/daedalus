import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  buildAgentPrompt,
  createApplicationContext,
  hasPersistedCodexSession,
  isMissingCodexConversationError,
  recoverCodexSessionId,
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
  test("builds launch prompts from task numbers and optional messages", () => {
    expect(
      buildAgentPrompt({ message: "  Inspect the failure first.  " }),
    ).toBe("Inspect the failure first.");
    expect(buildAgentPrompt({ taskNumber: 123 })).toBe(
      "Execute task #123. Do not merely summarize or restate it; complete the task.",
    );
    expect(buildAgentPrompt({})).toBeUndefined();
  });

  test("recovers Codex's persisted UUID without typing a rename command", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const startedAt = "2026-09-14T08:10:00.000Z";
      const id = "8ceaa092-b66b-4dc9-8b5d-a2e7cd40ae7b";
      const cwd = join(home, "worktree");
      const directory = join(home, "codex", "sessions", "2026", "09", "14");
      await mkdir(directory, { recursive: true });
      await Bun.write(
        join(directory, `rollout-2026-09-14T08-10-01-${id}.jsonl`),
        `${JSON.stringify({
          type: "session_meta",
          payload: {
            id,
            timestamp: "2026-09-14T08:10:01.000Z",
            cwd,
          },
        })}\n`,
      );
      await expect(
        recoverCodexSessionId({
          sessionsDirectory: join(home, "codex", "sessions"),
          workingDirectory: cwd,
          startedAt,
        }),
      ).resolves.toBe(id);
    });
  });

  test("recovers Codex's UUID from its writer lock before the first user event", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const startedAt = new Date().toISOString();
      const id = "8ceaa092-b66b-4dc9-8b5d-a2e7cd40ae7b";
      const codexHome = join(home, "codex");
      const locksDirectory = join(codexHome, "thread-writer-locks");
      await mkdir(locksDirectory, { recursive: true });
      await Bun.write(join(locksDirectory, `${id}.lock`), "");

      await expect(
        recoverCodexSessionId({
          sessionsDirectory: join(codexHome, "sessions"),
          workingDirectory: join(home, "worktree"),
          startedAt,
        }),
      ).resolves.toBe(id);
      await expect(
        hasPersistedCodexSession({
          sessionsDirectory: join(codexHome, "sessions"),
          id,
          startedAt,
        }),
      ).resolves.toBe(false);
    });
  });

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
        env: {
          DAEDALUS_HOME: home,
          CODEX_HOME: join(home, "codex"),
        },
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
        message: "Run the relevant tests before finishing.",
      });
      expect(agent.name).toBe(task.title);
      expect(agent.tmuxSession).toMatch(/^daedalus_[a-f0-9]{32}$/);
      const launchPrompt = buildAgentPrompt({
        taskNumber: task.number,
        message: "Run the relevant tests before finishing.",
      });
      expect(tmux.launches[0]).toMatchObject({
        executable: process.execPath,
        args: [
          "run",
          "--no-alt-screen",
          "-c",
          "tui.disable_mouse_capture=true",
          launchPrompt,
        ],
        cwd: agent.workingDirectory,
      });
      expect(agent.workingDirectory).toContain(
        join(workspace.path, "worktrees"),
      );
      expect(tmux.launches[0]?.env).toMatchObject({
        DAEDALUS_HOME: home,
        DAEDALUS_SESSION_ID: agent.id,
        DAEDALUS_WORKSPACE_ID: workspace.id,
        DAEDALUS_TASK_ID: task.id,
        DAEDALUS_TASK_NUMBER: String(task.number),
      });
      expect(agent.providerSessionId).toBeNull();
      expect(launchPrompt).toContain(`#${task.number}`);
      expect(launchPrompt).not.toContain(task.title);
      expect(launchPrompt).not.toContain(task.description);
      expect(launchPrompt).not.toContain("BRIEF.md");
      expect(tmux.sent).toEqual([]);
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
        model: "claude-fable-5-1[1m]",
        name: "Persistent context",
      });
      expect(session.providerSessionId).toBe(session.id);
      expect(tmux.launches[0]?.args).toEqual([
        "run",
        "--model",
        "claude-fable-5-1[1m]",
        "--settings",
        expect.stringContaining('"agent","event","Notification"'),
        "--session-id",
        session.id,
        "--name",
        "Persistent context",
      ]);
      const archived = await context.agents.archive(session.id);
      expect(archived.archivedAt).not.toBeNull();
      expect(archived.status).toBe("exited");
      const restored = await context.agents.restore(session.id);
      expect(restored).toMatchObject({
        archivedAt: null,
        status: "running",
        resumeCount: 1,
      });
      expect(tmux.launches[1]?.args).toEqual([
        "run",
        "--settings",
        expect.stringContaining('"agent","event","Notification"'),
        "--model",
        "claude-fable-5-1[1m]",
        "--resume",
        session.id,
      ]);
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
      expect(tmux.launches[1]?.args).toEqual([
        "run",
        "--settings",
        expect.stringContaining('"agent","event","Notification"'),
        "--resume",
        recoveredId,
      ]);
      context.close();
    });
  });

  test("archives an empty Codex session and restores it as a fresh session", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const codexHome = join(home, "codex");
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { codex: { executable: process.execPath, args: ["run"] } },
        }),
      );
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home, CODEX_HOME: codexHome },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Empty" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "codex",
      });
      const nativeId = "8ceaa092-b66b-4dc9-8b5d-a2e7cd40ae7b";
      const locksDirectory = join(codexHome, "thread-writer-locks");
      await mkdir(locksDirectory, { recursive: true });
      await Bun.write(join(locksDirectory, `${nativeId}.lock`), "");

      const archived = await context.agents.archive(session.id);
      expect(archived.providerSessionId).toBe(nativeId);
      expect(archived.archivedAt).not.toBeNull();
      const restored = await context.agents.restore(session.id);
      expect(restored).toMatchObject({
        providerSessionId: null,
        status: "running",
        archivedAt: null,
      });
      expect(tmux.launches[1]?.args).toEqual([
        "run",
        "--no-alt-screen",
        "-c",
        "tui.disable_mouse_capture=true",
      ]);
      context.close();
    });
  });

  test("archives a lost Codex startup without a native conversation", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { codex: { executable: process.execPath, args: ["run"] } },
        }),
      );
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: {
          DAEDALUS_HOME: home,
          CODEX_HOME: join(home, "codex"),
        },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Lost" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "codex",
      });
      tmux.sessions.delete(session.tmuxSession);

      const archived = await context.agents.archive(session.id);
      expect(archived).toMatchObject({
        providerSessionId: null,
        status: "lost",
      });
      expect(archived.archivedAt).not.toBeNull();

      const restored = await context.agents.restore(session.id);
      expect(restored).toMatchObject({
        providerSessionId: null,
        status: "running",
        archivedAt: null,
      });
      expect(tmux.launches[1]?.args).toEqual([
        "run",
        "--no-alt-screen",
        "-c",
        "tui.disable_mouse_capture=true",
      ]);
      context.close();
    });
  });

  test("archives a Codex session that never persisted a conversation", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { codex: { executable: process.execPath, args: [] } },
        }),
      );
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home, CODEX_HOME: join(home, "empty-codex") },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Failing" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "codex",
      });
      // A Codex session that failed on startup never wrote a rollout, so there
      // is nothing to recover. `restore` handles that by starting a fresh
      // native session, so archiving must not be refused.
      expect(session.providerSessionId).toBeNull();
      const archived = await context.agents.archive(session.id);
      expect(archived.archivedAt).toBeTruthy();
      expect(tmux.sessions.has(session.tmuxSession)).toBe(false);
      context.close();
    });
  });

  test("stops answering startup prompts once the provider is ready", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { codex: { executable: process.execPath, args: [] } },
        }),
      );
      const tmux = new FakeTmux();
      // The answered trust prompt stays in the scrollback beside the ready
      // marker. Matching it again would keep pressing Enter in a session the
      // user has already taken over.
      tmux.screens = [
        "Do you trust the contents of this directory?\n❯ 1. Yes, proceed",
        "Do you trust the contents of this directory?\nAsk Codex to do anything",
      ];
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home, CODEX_HOME: join(home, "empty-codex") },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Trust" });
      await context.agents.spawn({
        workspace: workspace.id,
        provider: "codex",
      });
      expect(tmux.keys).toEqual([["Enter"]]);
      context.close();
    });
  });

  test("gives the session working directory its own workspace instructions", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { codex: { executable: process.execPath, args: [] } },
        }),
      );
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home, CODEX_HOME: join(home, "empty-codex") },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Context" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "codex",
      });
      // The session starts in an empty directory that is neither a repository
      // nor the workspace root, so a provider that only reads its working
      // directory would otherwise open with no workspace context at all.
      const instructions = await Bun.file(
        join(session.workingDirectory, "AGENTS.md"),
      ).text();
      expect(instructions).toContain(join(workspace.path, "BRIEF.md"));
      expect(instructions).toContain(join(workspace.path, "JOURNAL.md"));
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

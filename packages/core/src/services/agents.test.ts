import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  buildAgentPrompt,
  createApplicationContext,
  DaedalusError,
  hasPersistedCodexSession,
  isMissingCodexConversationError,
  recoverCodexSessionId,
  reviveFailureReason,
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
  async killServer() {
    const running = this.sessions.size > 0;
    this.sessions.clear();
    return running;
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

/**
 * A Mac reboot kills the Daedalus tmux server and leaves every row behind it.
 * Simulated here by emptying the fake server while the rows still say
 * `running`, which is exactly the state the next startup reconciles.
 */
describe("reboot recovery", () => {
  /**
   * A stand-in `codex` that records every argv it is invoked with. The revive
   * path's correctness is partly about a command it must *not* run, and an
   * executable that only fails tells you nothing about which one it was.
   */
  async function codexRecorder(
    home: string,
  ): Promise<{ path: string; invocations: () => Promise<string[]> }> {
    const path = join(home, "codex-recorder");
    const log = join(home, "codex-invocations.log");
    await Bun.write(
      path,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`,
    );
    await chmod(path, 0o755);
    return {
      path,
      invocations: async () => {
        const file = Bun.file(log);
        if (!(await file.exists())) return [];
        return (await file.text()).split("\n").filter(Boolean);
      },
    };
  }

  async function writeCodexRollout(input: {
    codexHome: string;
    id: string;
    cwd: string;
    startedAt: string;
  }): Promise<void> {
    const [year, month, day] = input.startedAt.slice(0, 10).split("-");
    const directory = join(input.codexHome, "sessions", year!, month!, day!);
    await mkdir(directory, { recursive: true });
    await Bun.write(
      join(directory, `rollout-${input.id}.jsonl`),
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: input.id, timestamp: input.startedAt, cwd: input.cwd },
      })}\n`,
    );
  }

  test("brings every resumable session back without prompting any of them", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: {
            claude: { executable: process.execPath, args: ["run"] },
            shell: { executable: process.execPath, args: [] },
          },
        }),
      );
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Reboot" });
      const first = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
        name: "First",
      });
      const second = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
        name: "Second",
      });
      // A custom session has no native resume command, so it is the one that
      // has to stay lost and say why rather than fail the whole sweep.
      const custom = await context.agents.spawn({
        workspace: workspace.id,
        command: "shell",
        name: "Custom",
      });
      const launchesBeforeReboot = tmux.launches.length;

      tmux.sessions.clear();
      await context.agents.reconcile();
      expect((await context.agents.get(first.id)).status).toBe("lost");

      const sweep = await context.agents.reviveLostSessions();
      expect(sweep.revived.map((item) => item.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
      expect((await context.agents.get(first.id)).status).toBe("running");
      expect((await context.agents.get(second.id)).status).toBe("running");
      // Resumed, not restarted: the conversation is named on the command line.
      expect(tmux.launches.at(-1)?.args).toContain("--resume");
      // Nothing was typed at any agent. A resume loads history and waits,
      // which is the whole reason this is safe to do unattended.
      expect(tmux.sent).toEqual([]);

      const stranded = await context.agents.get(custom.id);
      expect(stranded.status).toBe("lost");
      expect(stranded.lostReason).toBe(
        "Custom sessions do not define a native resume capability",
      );
      expect(sweep.skipped).toEqual([
        {
          sessionId: custom.id,
          name: "Custom",
          reason: "Custom sessions do not define a native resume capability",
        },
      ]);

      // A second sweep has nothing left to do, and `agent list` never had
      // anything to do: revival is an explicit call, never a side effect of
      // reconciliation, which runs on nearly every command.
      const launchesAfterSweep = tmux.launches.length;
      expect(launchesAfterSweep).toBe(launchesBeforeReboot + 2);
      const second_sweep = await context.agents.reviveLostSessions();
      expect(second_sweep.revived).toEqual([]);
      await context.agents.list({});
      expect(tmux.launches.length).toBe(launchesAfterSweep);
      context.close();
    });
  });

  test("keeps the attention badge raised across the reboot", async () => {
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
      const workspace = await context.workspaces.create({ name: "Blocked" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
      });
      await context.activity.record({
        sessionId: session.id,
        activity: "needs_permission",
        detail: "Bash(git push)",
        source: "hook",
      });
      expect(context.activity.attentionFor(session.id)?.reasons).toHaveLength(
        1,
      );

      tmux.sessions.clear();
      await context.agents.reconcile();
      // The agent is still blocked on the same question and the revive puts it
      // back at that point. A reboot that wiped the badges would clear every
      // reason the user had to look, all at once.
      expect(context.activity.attentionFor(session.id)?.reasons).toHaveLength(
        1,
      );
      await context.agents.reviveLostSessions();
      expect(context.activity.attentionFor(session.id)?.reasons).toHaveLength(
        1,
      );
      expect(context.activity.get(session.id)).toMatchObject({
        activity: "needs_permission",
        detail: "Bash(git push)",
      });
      context.close();
    });
  });

  test("revives a Codex conversation that was never archived", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const codexHome = join(home, "codex");
      const codex = await codexRecorder(home);
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { codex: { executable: codex.path, args: [] } },
        }),
      );
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home, CODEX_HOME: codexHome },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Codex" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "codex",
      });
      const nativeId = "8ceaa092-b66b-4dc9-8b5d-a2e7cd40ae7b";
      await writeCodexRollout({
        codexHome,
        id: nativeId,
        cwd: session.workingDirectory,
        startedAt: session.startedAt,
      });
      context.repositories.updateAgent({
        ...session,
        providerSessionId: nativeId,
      });

      tmux.sessions.clear();
      await context.agents.reconcile();
      const revived = await context.agents.reviveLost(session.id);

      expect(revived.status).toBe("running");
      expect(tmux.launches.at(-1)?.args.slice(-2)).toEqual([
        "resume",
        nativeId,
      ]);
      // The conversation never left Codex's active list, so unarchiving it is
      // not merely wasteful — it fails with wording nothing here forgives, and
      // would abort a revive that was about to work.
      expect(await codex.invocations()).not.toContain(`unarchive ${nativeId}`);
      context.close();
    });
  });

  test("still unarchives a Codex conversation that was archived", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const codexHome = join(home, "codex");
      const codex = await codexRecorder(home);
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { codex: { executable: codex.path, args: [] } },
        }),
      );
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home, CODEX_HOME: codexHome },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Archived" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "codex",
      });
      const nativeId = "8ceaa092-b66b-4dc9-8b5d-a2e7cd40ae7b";
      await writeCodexRollout({
        codexHome,
        id: nativeId,
        cwd: session.workingDirectory,
        startedAt: session.startedAt,
      });
      context.repositories.updateAgent({
        ...session,
        providerSessionId: nativeId,
      });

      await context.agents.archive(session.id);
      const restored = await context.agents.restore(session.id);

      expect(restored.status).toBe("running");
      const invocations = await codex.invocations();
      expect(invocations).toContain(`archive ${nativeId}`);
      expect(invocations).toContain(`unarchive ${nativeId}`);
      context.close();
    });
  });

  test("refuses to revive an archived session, which is what restore is for", async () => {
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
      const workspace = await context.workspaces.create({ name: "Archive" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
      });
      await context.agents.archive(session.id);
      await expect(context.agents.reviveLost(session.id)).rejects.toMatchObject(
        { code: "CONFLICT" },
      );
      // An archived session is a deliberate act, and a sweep that undid it
      // would make archiving something the user had to keep re-doing.
      const sweep = await context.agents.reviveLostSessions();
      expect(sweep.revived).toEqual([]);
      expect(sweep.skipped).toEqual([]);
      context.close();
    });
  });

  test("declines the sweep while another one holds the lock", async () => {
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
      const workspace = await context.workspaces.create({ name: "Race" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
      });
      tmux.sessions.clear();
      await context.agents.reconcile();
      // The app starting while a `daedal agent revive --all` is mid-flight:
      // without the lock both would create a tmux session under one name.
      await Bun.write(join(home, "revive.lock"), "99999\n");
      const blocked = await context.agents.reviveLostSessions();
      expect(blocked).toMatchObject({ halted: "sweep_in_progress" });
      expect((await context.agents.get(session.id)).status).toBe("lost");

      await rm(join(home, "revive.lock"));
      expect((await context.agents.reviveLostSessions()).revived).toHaveLength(
        1,
      );
      context.close();
    });
  });

  test("leaves everything alone when auto-restore is turned off", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          autoRestoreSessionsEnabled: false,
          agents: { claude: { executable: process.execPath, args: ["run"] } },
        }),
      );
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Off" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
      });
      tmux.sessions.clear();
      await context.agents.reconcile();

      expect(
        await context.agents.reviveLostSessions({ automatic: true }),
      ).toMatchObject({ halted: "disabled" });
      expect((await context.agents.get(session.id)).status).toBe("lost");
      // The setting governs what happens unasked. `daedal agent revive` is
      // the user asking, so it still works.
      expect((await context.agents.reviveLostSessions()).revived).toHaveLength(
        1,
      );
      context.close();
    });
  });

  test("says what the provider said when a revive fails", () => {
    // "claude exited before finishing startup" is a symptom. The provider
    // printed the cause on its own last screen before going, and a card that
    // reports only the symptom sends the user to the logs for a sentence
    // Daedalus already had.
    expect(
      reviveFailureReason(
        new DaedalusError(
          "INTERNAL",
          "claude exited before finishing startup",
          {
            startupOutput: "No conversation found with session ID: abc",
          },
        ),
      ),
    ).toBe(
      "claude exited before finishing startup: No conversation found with session ID: abc",
    );
    expect(reviveFailureReason(new Error("tmux is not available"))).toBe(
      "tmux is not available",
    );
    // A whole terminal screen is not a card. The provider's own sentence comes
    // first, so a cap keeps the useful part and drops the redraw behind it.
    expect(
      reviveFailureReason(
        new DaedalusError("INTERNAL", "codex exited", {
          startupOutput: "x".repeat(600),
        }),
      ).length,
    ).toBe("codex exited: ".length + 200);
  });

  test("reopens a lost integrated terminal as a fresh shell", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Shells" });
      const terminal = await context.terminals.create({
        workspace: workspace.id,
      });
      tmux.sessions.clear();
      await context.terminals.reconcile();
      expect((await context.terminals.get(terminal.id)).status).toBe("lost");

      const [revived] = await context.terminals.reviveLost();
      expect(revived).toMatchObject({
        id: terminal.id,
        tmuxSession: terminal.tmuxSession,
        workingDirectory: terminal.workingDirectory,
        status: "running",
      });
      // There is no conversation to resume, so this is honestly a new shell.
      // Saying so is what keeps an empty screen from reading as continuity.
      expect(revived?.revivedAt).not.toBeNull();
      expect(await context.terminals.reviveLost()).toEqual([]);
      context.close();
    });
  });
});

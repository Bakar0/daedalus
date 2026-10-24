import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  cloudHostId,
  createApplicationContext,
  ingestHook,
  type SessionCheckpoint,
  type SessionHost,
  type SessionHostLaunch,
  type SessionTerminal,
} from "../index";

class NoTmux implements TmuxClient {
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
  readonly launches: TmuxLaunch[] = [];
  async probe() {
    return "tmux 3.7c";
  }
  async createSession(launch: TmuxLaunch) {
    this.launches.push(launch);
  }
  async hasSession() {
    return false;
  }
  async listSessions() {
    return [];
  }
  async attach() {
    return 0;
  }
  async capture() {
    return "";
  }
  async sendKeys() {}
  async send() {}
  async stop() {}
  async killServer() {
    return false;
  }
}

class FakeCloudHost implements SessionHost {
  readonly kind = "cloud" as const;
  readonly sessions = new Set<string>();
  readonly launches: SessionHostLaunch[] = [];
  readonly sent: string[] = [];
  online = true;

  constructor(readonly id: string) {}

  readonly files = new Map<string, Uint8Array>();
  /** Claude conversations by id: the sessions here had turns. */
  readonly conversations = new Set<string>();
  /** Codex rollouts by thread id, as the pod's `find` lists them. */
  readonly rollouts = new Map<string, string>();
  screen = "Claude Code v2.1.251\nshift+tab to cycle";
  async run(command: { executable: string; args: string[] }) {
    if (command.executable === "find") {
      const thread = /^rollout-\*-(.+)\.jsonl$/.exec(
        command.args[command.args.indexOf("-name") + 1] ?? "",
      )?.[1];
      const path = thread && this.rollouts.get(thread);
      return {
        exitCode: 0,
        stdout: path ? `${command.args[0]}/${path}\0` : "",
        stderr: "",
      };
    }
    // A conversation is there once a launch started it (see `start`).
    if (command.executable === "test" && command.args[0] === "-f") {
      const id = /([^/]+)\.jsonl$/.exec(command.args[1] ?? "")?.[1];
      return {
        exitCode: id && this.conversations.has(id) ? 0 : 1,
        stdout: "",
        stderr: "",
      };
    }
    // A folder is free until something writes in it.
    const free =
      command.executable === "test" &&
      ![...this.files.keys()].some((path) =>
        path.startsWith(`${command.args[1]}/`),
      );
    return { exitCode: free ? 1 : 0, stdout: "", stderr: "" };
  }
  async readFile(path: string) {
    return this.files.get(path);
  }
  async writeFiles(files: { path: string; contents: Uint8Array }[]) {
    for (const file of files) this.files.set(file.path, file.contents);
  }

  async probe() {
    return this.online ? undefined : "The workspace is asleep";
  }
  async start(launch: SessionHostLaunch) {
    this.launches.push(launch);
    this.sessions.add(launch.session);
    const started = launch.args.indexOf("--session-id");
    if (started >= 0) this.conversations.add(launch.args[started + 1]!);
  }
  async isLive(session: string) {
    return this.sessions.has(session);
  }
  async listLive() {
    if (!this.online) throw new Error("offline");
    return [...this.sessions];
  }
  async capture() {
    return this.screen;
  }
  async sendKeys() {}
  async send(_session: string, text: string) {
    this.sent.push(text);
  }
  async stop(session: string) {
    this.sessions.delete(session);
  }
  async openTerminal(): Promise<SessionTerminal> {
    throw new Error("not in this test");
  }
  async exportCheckpoint(): Promise<SessionCheckpoint> {
    throw new Error("not in this test");
  }
  async importCheckpoint(): Promise<{ workingDirectory: string }> {
    throw new Error("not in this test");
  }
}

const setUp = async (home: string) => {
  const tmux = new NoTmux();
  const context = await createApplicationContext({
    env: { DAEDALUS_HOME: home },
    tmux,
  });
  const workspace = await context.workspaces.create({ name: "Cloud" });
  const cloudId = crypto.randomUUID();
  context.repositories.setCloudOwner({
    gatewayUrl: "https://gateway.test",
    userId: "u1",
  });
  context.repositories.linkCloudWorkspace(workspace.id, cloudId);
  context.repositories.setWorkspacePlace(workspace.id, {
    place: "cloud",
    notice: null,
  });
  context.agents.onCloudHost(async () => cloudHostId(cloudId));
  const host = new FakeCloudHost(cloudHostId(cloudId));
  context.hosts.register(host);
  return { context, tmux, workspace, host };
};

describe("cloud sessions", () => {
  test("spawn runs Claude on the cloud host in a session folder of its own", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, tmux, workspace, host } = await setUp(home);
      context.agents.onCloudSecrets(async () => ({ ANTHROPIC_API_KEY: "k" }));
      const session = await context.agents.spawn({
        workspace: workspace.id,
        message: "Hello",
      });
      const folder = `worktrees/unassigned/claude-${session.id.slice(0, 8)}`;
      expect(session).toMatchObject({
        hostId: host.id,
        workingDirectory: folder,
        status: "running",
        provider: "claude",
        providerSessionId: session.id,
      });
      expect(tmux.launches).toEqual([]);
      const launch = host.launches[0]!;
      expect(launch.executable).toBe("claude");
      expect(launch.cwd).toBe(folder);
      // Its instructions name the pod's paths, not this Mac's.
      const instructions = new TextDecoder().decode(
        host.files.get(`${folder}/AGENTS.md`),
      );
      expect(instructions).toContain("/workspace/BRIEF.md");
      expect(instructions).not.toContain(home);
      expect(launch.secrets).toEqual({ ANTHROPIC_API_KEY: "k" });
      expect(launch.env).toMatchObject({
        DAEDALUS_SESSION_ID: session.id,
        DAEDALUS_WORKSPACE_ID: workspace.id,
      });
      expect(launch.env?.DAEDALUS_HOME).toBeUndefined();
      expect(launch.env?.PATH).toBeUndefined();
      expect(launch.args).toContain("--session-id");
      expect(launch.args).toContain("--append-system-prompt");
      expect(launch.args.at(-1)).toBe("Hello");
      const settings = JSON.parse(
        launch.args[launch.args.indexOf("--settings") + 1]!,
      ) as { statusLine?: unknown; hooks: Record<string, unknown> };
      expect(settings.statusLine).toBeUndefined();
      expect(JSON.stringify(settings.hooks)).toContain('"command":"daedal"');
      // Nothing on this Mac's disk names the session's folder.
      expect(launch.args.join(" ")).not.toContain(home);
      expect(context.repositories.findAgent(session.id)?.hostId).toBe(host.id);
      await context.agents.send(session.id, "next");
      expect(host.sent).toEqual(["next"]);
      context.close();
    });
  });

  test("a cloud session holds no abilities, at spawn or later", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, host } = await setUp(home);
      for (const ability of ["orchestration", "routines"])
        await expect(
          context.agents.spawn({
            workspace: workspace.id,
            abilities: [ability],
          }),
        ).rejects.toMatchObject({
          code: "VALIDATION",
          message: expect.stringContaining("the pod has no Daedalus skills"),
        });
      expect(host.launches).toEqual([]);
      const session = await context.agents.spawn({
        workspace: workspace.id,
      });
      for (const ability of ["orchestration", "routines"])
        expect(() =>
          context.abilities.grant(session.id, ability, { live: true }),
        ).toThrow("A cloud session cannot hold");
      expect(context.abilities.list(session.id)).toEqual([]);
      context.close();
    });
  });

  test("a launch without the API key secret still starts", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, host } = await setUp(home);
      const session = await context.agents.spawn({
        workspace: workspace.id,
      });
      expect(session.status).toBe("running");
      expect(host.launches[0]!.secrets).toEqual({});
      context.close();
    });
  });

  test("refuses custom commands in the cloud", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, host } = await setUp(home);
      await expect(
        context.agents.spawn({ workspace: workspace.id, command: "rm" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(host.launches).toEqual([]);
      context.close();
    });
  });

  test("reconcile settles cloud sessions only from a host that answered", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, host } = await setUp(home);
      const session = await context.agents.spawn({
        workspace: workspace.id,
      });
      host.sessions.clear();
      host.online = false;
      await context.agents.reconcile(new Set());
      expect(context.repositories.findAgent(session.id)?.status).toBe(
        "running",
      );
      host.online = true;
      await context.agents.reconcile(new Set());
      expect(context.repositories.findAgent(session.id)?.status).toBe("lost");
      context.close();
    });
  });

  test("a host that answers nonsense settles nothing and stops nothing", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, host } = await setUp(home);
      const session = await context.agents.spawn({
        workspace: workspace.id,
      });
      host.listLive = async () => ({}) as never;
      await expect(
        context.agents.reconcile(new Set()),
      ).resolves.toBeUndefined();
      expect(context.repositories.findAgent(session.id)?.status).toBe(
        "running",
      );
      context.close();
    });
  });

  test("the start sweeps this Mac's sessions apart from the cloud's", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, host } = await setUp(home);
      const session = await context.agents.spawn({
        workspace: workspace.id,
      });
      host.sessions.clear();
      await context.agents.reconcile(new Set());
      const launches = host.launches.length;
      const mac = await context.agents.reviveLostSessions({
        automatic: true,
        where: "mac",
      });
      expect(mac.revived).toEqual([]);
      expect(host.launches).toHaveLength(launches);
      const cloud = await context.agents.reviveLostSessions({
        automatic: true,
        where: "cloud",
      });
      expect(cloud.revived.map((item) => item.id)).toEqual([session.id]);
      context.close();
    });
  });

  test("a lost cloud session that never had a turn starts its conversation", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, host } = await setUp(home);
      const session = await context.agents.spawn({
        workspace: workspace.id,
      });
      host.sessions.clear();
      host.conversations.clear();
      await context.agents.reconcile(new Set());
      const revived = await context.agents.reviveLost(session.id);
      expect(revived.status).toBe("running");
      const launch = host.launches.at(-1)!;
      expect(launch.args.slice(-2)).toEqual(["--session-id", session.id]);
      expect(launch.args).not.toContain("--resume");
      context.close();
    });
  });

  test("runs Codex in the pod, with full access and no daemon", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, host } = await setUp(home);
      host.screen = "OpenAI Codex\n› Ask Codex to do anything";
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "codex",
        message: "Hello",
      });
      expect(session.provider).toBe("codex");
      expect(session.name).toBe("Codex session");
      // Codex names its thread at the first turn; its hook reports it.
      expect(session.providerSessionId).toBeNull();
      const launch = host.launches.at(-1)!;
      expect(launch.executable).toBe("codex");
      expect(launch.args).toContain("--no-daemon");
      expect(launch.args).toContain('sandbox_mode="danger-full-access"');
      expect(launch.args.join(" ")).not.toContain(home);
      // The workspace's Anthropic key is Claude's.
      expect(launch.secrets).toEqual({});
      context.close();
    });
  });

  test("a lost cloud Codex session resumes its thread when the pod has it, else starts anew", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, host } = await setUp(home);
      host.screen = "OpenAI Codex\n› Ask Codex to do anything";
      const spawned = await context.agents.spawn({
        workspace: workspace.id,
        provider: "codex",
      });
      const thread = "01a16fbf-b6aa-7f33-8df1-3d80160ed7bc";
      context.repositories.updateAgent({
        ...spawned,
        providerSessionId: thread,
      });
      host.sessions.clear();
      await context.agents.reconcile(new Set());
      expect((await context.agents.reviveLost(spawned.id)).status).toBe(
        "running",
      );
      expect(host.launches.at(-1)!.args).not.toContain("resume");

      host.rollouts.set(
        thread,
        `2026/10/25/rollout-2026-10-25T00-09-57-${thread}.jsonl`,
      );
      host.sessions.clear();
      await context.agents.reconcile(new Set());
      await context.agents.reviveLost(spawned.id);
      expect(host.launches.at(-1)!.args.slice(-2)).toEqual(["resume", thread]);
      context.close();
    });
  });

  test("a cloud Codex session takes its thread from its first hook, once", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, host } = await setUp(home);
      host.screen = "OpenAI Codex\n› Ask Codex to do anything";
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "codex",
      });
      const thread = "01a16fbf-b6aa-7f33-8df1-3d80160ed7bc";
      const hook = (id: string, cloudMark?: string) =>
        ingestHook({
          home,
          sessionId: session.id,
          event: "UserPromptSubmit",
          readPayload: async () =>
            JSON.stringify({
              session_id: id,
              turn_id: "t1",
              cwd: "/workspace",
            }),
          ...(cloudMark ? { cloudMark } : {}),
          openContext: async () => ({ ...context, close: () => {} }),
        });
      // Only through the Mac's answer to the pod's daedal.
      await hook(thread);
      expect(
        context.repositories.findAgent(session.id)?.providerSessionId,
      ).toBeNull();
      await hook(thread, "[from cloud workspace Cloud]");
      expect(
        context.repositories.findAgent(session.id)?.providerSessionId,
      ).toBe(thread);
      await hook(
        "01a16fbf-0000-7f33-8df1-3d80160ed7bc",
        "[from cloud workspace Cloud]",
      );
      expect(
        context.repositories.findAgent(session.id)?.providerSessionId,
      ).toBe(thread);
      // Not a thread, or one another session has: nothing.
      const other = await context.agents.spawn({
        workspace: workspace.id,
        provider: "codex",
      });
      context.agents.bindCloudCodexThread(other.id, thread);
      context.agents.bindCloudCodexThread(other.id, "../x");
      expect(
        context.repositories.findAgent(other.id)?.providerSessionId,
      ).toBeNull();
      context.close();
    });
  });

  test("a lost cloud session revives with its conversation resumed", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, host } = await setUp(home);
      const session = await context.agents.spawn({
        workspace: workspace.id,
      });
      host.sessions.clear();
      await context.agents.reconcile(new Set());
      const revived = await context.agents.reviveLost(session.id);
      expect(revived.status).toBe("running");
      const launch = host.launches.at(-1)!;
      expect(launch.args.slice(-2)).toEqual(["--resume", session.id]);
      expect(launch.args).not.toContain("--session-id");
      context.close();
    });
  });

  test("a cloud session whose host is not held reports it, and has no attach", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, host } = await setUp(home);
      const session = await context.agents.spawn({
        workspace: workspace.id,
      });
      await expect(context.agents.attach(session.id)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      context.hosts.unregister(host.id);
      await expect(context.agents.send(session.id, "x")).rejects.toMatchObject({
        code: "DEPENDENCY",
      });
      context.close();
    });
  });
});

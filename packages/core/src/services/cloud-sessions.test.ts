import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  cloudHostId,
  createApplicationContext,
  type SessionCheckpoint,
  type SessionHost,
  type SessionHostLaunch,
  type SessionTerminal,
} from "../index";

class NoTmux implements TmuxClient {
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

  async probe() {
    return this.online ? undefined : "The workspace is asleep";
  }
  async start(launch: SessionHostLaunch) {
    this.launches.push(launch);
    this.sessions.add(launch.session);
  }
  async isLive(session: string) {
    return this.sessions.has(session);
  }
  async listLive() {
    if (!this.online) throw new Error("offline");
    return [...this.sessions];
  }
  async capture() {
    return "Claude Code v2.1.251\nshift+tab to cycle";
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
  const host = new FakeCloudHost(cloudHostId(workspace.id));
  context.hosts.register(host);
  return { context, tmux, workspace, host };
};

describe("cloud sessions", () => {
  test("spawn runs Claude on the cloud host in the workspace root", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, tmux, workspace, host } = await setUp(home);
      context.agents.onCloudSecrets(async () => ({ ANTHROPIC_API_KEY: "k" }));
      const session = await context.agents.spawn({
        workspace: workspace.id,
        host: host.id,
        message: "Hello",
      });
      expect(session).toMatchObject({
        hostId: host.id,
        workingDirectory: ".",
        status: "running",
        provider: "claude",
        providerSessionId: session.id,
      });
      expect(tmux.launches).toEqual([]);
      const launch = host.launches[0]!;
      expect(launch.executable).toBe("claude");
      expect(launch.cwd).toBe(".");
      expect(launch.secrets).toEqual({ ANTHROPIC_API_KEY: "k" });
      expect(launch.env).toMatchObject({
        DAEDALUS_SESSION_ID: session.id,
        DAEDALUS_WORKSPACE_ID: workspace.id,
      });
      expect(launch.env?.DAEDALUS_HOME).toBeUndefined();
      expect(launch.env?.PATH).toBeUndefined();
      expect(launch.args).toContain("--session-id");
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

  test("a launch without the API key secret still starts", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, host } = await setUp(home);
      const session = await context.agents.spawn({
        workspace: workspace.id,
        host: host.id,
      });
      expect(session.status).toBe("running");
      expect(host.launches[0]!.secrets).toEqual({});
      context.close();
    });
  });

  test("refuses another workspace's host, other providers and accounts", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, host } = await setUp(home);
      const other = await context.workspaces.create({ name: "Other" });
      await expect(
        context.agents.spawn({ workspace: other.id, host: host.id }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(
        context.agents.spawn({
          workspace: workspace.id,
          host: host.id,
          provider: "codex",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(
        context.agents.spawn({
          workspace: workspace.id,
          host: host.id,
          command: "rm",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      expect(host.launches).toEqual([]);
      context.close();
    });
  });

  test("reconcile settles cloud sessions only from a host that answered", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, host } = await setUp(home);
      const session = await context.agents.spawn({
        workspace: workspace.id,
        host: host.id,
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

  test("a lost cloud session revives with its conversation resumed", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, host } = await setUp(home);
      const session = await context.agents.spawn({
        workspace: workspace.id,
        host: host.id,
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
        host: host.id,
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

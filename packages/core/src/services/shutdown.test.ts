import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { createApplicationContext } from "../index";
import type { AgentProviderName, AgentSession, SessionKind } from "../domain";

class FakeTmux implements TmuxClient {
  readonly sessions = new Set<string>();
  serverRunning = true;
  killServerCalls = 0;

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
    this.killServerCalls += 1;
    const running = this.serverRunning;
    this.serverRunning = false;
    this.sessions.clear();
    return running;
  }
}

/**
 * Sessions are written straight to the index rather than spawned.
 *
 * What this suite is about is the *disposition* of each session — archived,
 * stopped, or failed and then stopped anyway — and that is decided by whether
 * a session has a resumable native conversation. Writing the row says so in
 * one line; reaching the same states through real provider launches would say
 * it in fifty and test the launches instead.
 */
function addSession(
  context: Awaited<ReturnType<typeof createApplicationContext>>,
  tmux: FakeTmux,
  input: {
    workspaceId: string;
    name: string;
    provider: AgentProviderName;
    kind?: SessionKind;
    providerSessionId?: string | null;
    status?: "running" | "starting";
  },
): AgentSession {
  const id = crypto.randomUUID();
  const session: AgentSession = {
    id,
    workspaceId: input.workspaceId,
    taskId: null,
    name: input.name,
    provider: input.provider,
    kind: input.kind ?? "agent",
    tmuxSession: `daedalus_${id.replaceAll("-", "")}`,
    command: "/bin/sh",
    args: [],
    workingDirectory: "/tmp",
    status: input.status ?? "running",
    exitCode: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    providerSessionId: input.providerSessionId ?? null,
    archivedAt: null,
    resumeCount: 0,
    lostReason: null,
    position: context.repositories.nextAgentPosition(input.workspaceId),
  };
  context.repositories.createAgent(session);
  tmux.sessions.add(session.tmuxSession);
  return session;
}

describe("ShutdownService", () => {
  test("plans only what is live, and says how each session would end", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Plan" });
      const resumable = addSession(context, tmux, {
        workspaceId: workspace.id,
        name: "Claude",
        provider: "claude",
        providerSessionId: crypto.randomUUID(),
      });
      const custom = addSession(context, tmux, {
        workspaceId: workspace.id,
        name: "Script",
        provider: "custom",
      });
      // Not live, so not something quitting would leave running.
      const gone = addSession(context, tmux, {
        workspaceId: workspace.id,
        name: "Dead",
        provider: "claude",
      });
      tmux.sessions.delete(gone.tmuxSession);
      await context.terminals.create({ workspace: workspace.id });

      const plan = await context.shutdown.plan();
      expect(plan.sessions.map((item) => [item.id, item.disposition])).toEqual([
        [custom.id, "stop"],
        [resumable.id, "archive"],
      ]);
      expect(plan.terminals).toHaveLength(1);
      context.close();
    });
  });

  test("archives what can resume, stops what cannot, and never dead-ends on one of them", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude") },
        tmux,
      });
      await mkdir(join(home, "claude", "projects"), { recursive: true });
      const workspace = await context.workspaces.create({ name: "Sweep" });
      const resumable = addSession(context, tmux, {
        workspaceId: workspace.id,
        name: "Claude",
        provider: "claude",
        providerSessionId: crypto.randomUUID(),
      });
      const custom = addSession(context, tmux, {
        workspaceId: workspace.id,
        name: "Script",
        provider: "custom",
      });
      // No provider session id and no transcript to recover one from, so
      // archiving refuses. It must still not be left running.
      const unresumable = addSession(context, tmux, {
        workspaceId: workspace.id,
        name: "Half-started",
        provider: "claude",
        status: "starting",
      });

      const result = await context.shutdown.run({ stopServer: true });
      const outcomes = new Map(
        result.sessions.map((item) => [item.id, item.outcome]),
      );
      expect(outcomes.get(resumable.id)).toBe("archived");
      expect(outcomes.get(custom.id)).toBe("stopped");
      expect(outcomes.get(unresumable.id)).toBe("stopped");
      // A stop that stood in for an archive says why, rather than reading as
      // the disposition anyone asked for.
      expect(
        result.sessions.find((item) => item.id === unresumable.id)?.reason,
      ).toMatch(/cannot be resumed safely/);

      expect(
        (await context.agents.get(resumable.id)).archivedAt,
      ).not.toBeNull();
      expect((await context.agents.get(custom.id)).status).toBe("exited");
      expect((await context.agents.get(unresumable.id)).status).toBe("exited");
      expect(tmux.sessions.size).toBe(0);
      expect(result.serverStopped).toBe(true);
      context.close();
    });
  });

  test("closes integrated terminals and ends the tmux server", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Terminals" });
      await context.terminals.create({ workspace: workspace.id });
      await context.terminals.create({ workspace: workspace.id });

      const result = await context.shutdown.run({ stopServer: true });
      expect(result.terminals.map((item) => item.closed)).toEqual([true, true]);
      expect(await context.terminals.list()).toHaveLength(0);
      expect(result.serverStopped).toBe(true);
      context.close();
    });
  });

  test("keeping the terminals keeps the server they live in", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Keep" });
      await context.terminals.create({ workspace: workspace.id });

      const result = await context.shutdown.run({
        keepTerminals: true,
        stopServer: true,
      });
      expect(result.terminals).toEqual([]);
      expect(result.serverStopped).toBe(false);
      expect(tmux.killServerCalls).toBe(0);
      expect(await context.terminals.list()).toHaveLength(1);
      context.close();
    });
  });

  test("a workspace archived on the way out is not archived twice", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Cascade" });
      const session = addSession(context, tmux, {
        workspaceId: workspace.id,
        name: "Claude",
        provider: "claude",
        providerSessionId: crypto.randomUUID(),
      });
      // `workspace archive` already cascades into its sessions.
      await context.workspaces.archive(workspace.id);
      const archivedAt = (await context.agents.get(session.id)).archivedAt;
      expect(archivedAt).not.toBeNull();

      const result = await context.shutdown.run({ stopServer: true });
      expect(result.sessions).toEqual([]);
      expect((await context.agents.get(session.id)).archivedAt).toBe(
        archivedAt,
      );
      context.close();
    });
  });

  test("reports a server that could not be stopped rather than throwing", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const tmux = new FakeTmux();
      tmux.killServer = async () => {
        throw new Error("permission denied");
      };
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux,
      });
      const result = await context.shutdown.run({ stopServer: true });
      expect(result.serverStopped).toBe(false);
      expect(result.serverError).toBe("permission denied");
      context.close();
    });
  });
});

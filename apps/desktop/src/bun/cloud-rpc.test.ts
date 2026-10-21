import { describe, expect, test } from "vitest";
import {
  CloudAccount,
  cloudHostId,
  createApplicationContext,
  type ApplicationContext,
  type ConnectRelay,
  type SessionCheckpoint,
  type SessionHost,
  type SessionHostLaunch,
  type SessionTerminal,
  type TokenVault,
} from "@daedalus/core";
import type { TmuxClient } from "@daedalus/platform";
import type { CloudWorkspace } from "@daedalus/remote-protocol";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { createDesktopRequestHandlers } from "./rpc";

const TOKEN = "user-token-secret-0123456789";
const RUNNER_KEY = "runner-key-secret-abcdef";

class NoTmux implements TmuxClient {
  openPty() {
    return { start: async () => {}, write() {}, resize() {}, close() {} };
  }
  async pinWindowSize() {}
  async unpinWindowSize() {}
  async probe() {
    return "tmux 3.7c";
  }
  async createSession() {}
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

/** A pod's sessions, in memory. */
class FakeCloudHost implements SessionHost {
  readonly kind = "cloud" as const;
  readonly sessions = new Set<string>();
  readonly launches: SessionHostLaunch[] = [];

  constructor(readonly id: string) {}

  async probe() {
    return undefined;
  }
  async start(launch: SessionHostLaunch) {
    this.launches.push(launch);
    this.sessions.add(launch.session);
  }
  async isLive(session: string) {
    return this.sessions.has(session);
  }
  async listLive() {
    return [...this.sessions];
  }
  async capture() {
    return "Claude Code v2.1.251\nshift+tab to cycle";
  }
  async sendKeys() {}
  async send() {}
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

const memoryVault = (): TokenVault => {
  let token: string | undefined;
  return {
    read: async () => token,
    write: async (value) => {
      token = value;
    },
    remove: async () => {
      token = undefined;
    },
  };
};

/** Relay sockets that never connect, so a test sees which ones are open. */
class FakeRelay {
  readonly sockets: Array<{ token: string; closed: boolean }> = [];
  readonly connect: ConnectRelay = (_url, token) => {
    const socket = { token, closed: false };
    this.sockets.push(socket);
    return {
      send() {},
      close() {
        socket.closed = true;
      },
    };
  };
  open() {
    return this.sockets.filter((socket) => !socket.closed);
  }
}

/** The gateway's routes, in memory, for one user. */
class FakeGateway {
  readonly workspaces = new Map<string, CloudWorkspace>();
  /** Answer every authenticated route with this status instead. */
  refuse: number | undefined;
  readonly calls: string[] = [];

  readonly fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}`);
    const json = (status: number, body?: unknown) =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/v1/dev/login") {
      const { email } = JSON.parse(String(init?.body)) as { email: string };
      return json(200, {
        user: { id: "u1", email },
        token: `${TOKEN}-${email}`,
      });
    }
    const auth = new Headers(init?.headers).get("authorization");
    if (!auth?.startsWith(`Bearer ${TOKEN}`) || this.refuse)
      return json(this.refuse ?? 401, {
        error: { code: "UNAUTHORIZED", message: "Not signed in" },
      });
    if (url.pathname === "/v1/me")
      return json(200, { id: "u1", email: "dev@example.com" });
    if (url.pathname === "/v1/workspaces" && method === "GET")
      return json(200, { workspaces: [...this.workspaces.values()] });
    if (url.pathname === "/v1/workspaces" && method === "POST") {
      const request = JSON.parse(String(init?.body)) as {
        workspaceId: string;
        name: string;
      };
      const workspace: CloudWorkspace = {
        workspaceId: request.workspaceId,
        name: request.name,
        status: "running",
        reason: null,
        runnerOnline: true,
        runnerKey: RUNNER_KEY,
        createdAt: new Date().toISOString(),
      };
      this.workspaces.set(workspace.workspaceId, workspace);
      return json(201, workspace);
    }
    const match = /^\/v1\/workspaces\/([^/]+)(?:\/(wake|sleep))?$/.exec(
      url.pathname,
    );
    const workspace = match && this.workspaces.get(match[1]!);
    if (!match || !workspace)
      return json(404, { error: { code: "NOT_FOUND", message: "No such" } });
    if (method === "DELETE") {
      this.workspaces.delete(workspace.workspaceId);
      return new Response(null, { status: 204 });
    }
    if (match[2] === "sleep") {
      workspace.status = "sleeping";
      workspace.runnerOnline = false;
    }
    if (match[2] === "wake") {
      workspace.status = "running";
      workspace.runnerOnline = true;
    }
    return json(200, workspace);
  }) as typeof fetch;
}

async function withCloud(
  run: (
    rpc: ReturnType<typeof createDesktopRequestHandlers>,
    context: ApplicationContext,
    gateway: FakeGateway,
    relay: FakeRelay,
  ) => Promise<void>,
): Promise<void> {
  await withTemporaryDaedalusHome(async (home) => {
    const gateway = new FakeGateway();
    const relay = new FakeRelay();
    const context = await createApplicationContext({
      env: { ...process.env, DAEDALUS_HOME: home },
      tmux: new NoTmux(),
      cloud: {
        fetch: gateway.fetch,
        connect: relay.connect,
        account: new CloudAccount(home, memoryVault()),
        identity: async () => ({
          id: "mac-1",
          publicKey: "mac-public",
          secretKey: "mac-secret",
        }),
      },
    });
    try {
      await run(createDesktopRequestHandlers(context), context, gateway, relay);
    } finally {
      context.close();
    }
  });
}

describe("cloud RPC", () => {
  test("signs in with the dev login, shows the account and signs out", async () => {
    await withCloud(async (rpc) => {
      expect(await rpc.cloudState({})).toEqual({
        ok: true,
        data: {
          signedIn: false,
          gatewayUrl: null,
          email: null,
          connection: "signed-out",
          error: null,
          workspaces: [],
        },
      });

      const signedIn = await rpc.cloudSignIn({
        gatewayUrl: " http://localhost:8080/ ",
        email: "dev@example.com",
      });
      expect(signedIn).toEqual({
        ok: true,
        data: {
          signedIn: true,
          gatewayUrl: "http://localhost:8080",
          email: "dev@example.com",
          connection: "online",
          error: null,
          workspaces: [],
        },
      });
      expect(JSON.stringify(await rpc.cloudState({}))).not.toContain(TOKEN);

      const out = await rpc.cloudSignOut({});
      expect(out.ok && out.data.connection).toBe("signed-out");
    });
  });

  test("refuses a plain-http gateway that is not this machine, in words", async () => {
    await withCloud(async (rpc) => {
      const response = await rpc.cloudSignIn({
        gatewayUrl: "http://gateway.example.com",
        email: "dev@example.com",
      });
      expect(response.ok).toBe(false);
      if (response.ok) return;
      expect(response.error.message).toBe(
        "A gateway address starts with https:// (http:// only for localhost)",
      );
    });
  });

  test("a gateway that refuses the token is an error message, not a throw", async () => {
    await withCloud(async (rpc, _context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      gateway.refuse = 401;
      const state = await rpc.cloudState({});
      expect(state.ok).toBe(true);
      if (!state.ok) return;
      expect(state.data.signedIn).toBe(true);
      expect(state.data.connection).toBe("error");
      expect(state.data.error).toContain("did not accept the sign-in");
      expect(JSON.stringify(state)).not.toContain(TOKEN);
    });
  });

  test("runs a workspace in the cloud, sleeps, wakes and deletes it", async () => {
    await withCloud(async (rpc, context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });

      const created = await rpc.cloudWorkspaceCreate({
        workspace: workspace.id,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id);
      expect(cloudId).toBeDefined();
      expect(created.data.workspaces).toEqual([
        {
          workspaceId: workspace.id,
          cloudId,
          status: "running",
          runnerOnline: true,
          reason: null,
        },
      ]);
      // The runner key the gateway reports stays in the host.
      expect(JSON.stringify(created)).not.toContain(RUNNER_KEY);

      const asleep = await rpc.cloudWorkspaceSleep({ workspace: workspace.id });
      expect(asleep.ok && asleep.data.workspaces[0]?.status).toBe("sleeping");
      const awake = await rpc.cloudWorkspaceWake({ workspace: workspace.id });
      expect(awake.ok && awake.data.workspaces[0]?.status).toBe("running");

      const deleted = await rpc.cloudWorkspaceDelete({
        workspace: workspace.id,
        force: true,
      });
      expect(deleted.ok && deleted.data.workspaces).toEqual([]);
      expect(
        context.repositories.cloudWorkspaceId(workspace.id),
      ).toBeUndefined();
      expect(await context.workspaces.get(workspace.id)).toBeDefined();
      expect(gateway.calls).toContain(`DELETE /v1/workspaces/${cloudId}`);
    });
  });

  test("a cloud workspace whose local one is gone is left out", async () => {
    await withCloud(async (rpc, _context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      gateway.workspaces.set("00000000-0000-4000-8000-000000000000", {
        workspaceId: "00000000-0000-4000-8000-000000000000",
        name: "Elsewhere",
        status: "running",
        reason: null,
        runnerOnline: true,
        runnerKey: RUNNER_KEY,
        createdAt: new Date().toISOString(),
      });
      const state = await rpc.cloudState({});
      expect(state.ok && state.data.workspaces).toEqual([]);
    });
  });

  test("a cloud spawn needs the workspace's cloud workspace and runs Claude or a terminal", async () => {
    await withCloud(async (rpc, context) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      const none = await rpc.agentSpawn({
        workspace: workspace.id,
        cloud: true,
      });
      expect(!none.ok && none.error.message).toBe(
        "Workspace 'Pods' has no cloud workspace; run 'daedal cloud create'",
      );

      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const codex = await rpc.agentSpawn({
        workspace: workspace.id,
        cloud: true,
        provider: "codex",
      });
      expect(!codex.ok && codex.error.message).toBe(
        "A cloud session runs Claude or a terminal",
      );
      expect(
        context.repositories.listAgents({ workspaceId: workspace.id }),
      ).toEqual([]);
    });
  });

  test("opening a session whose cloud workspace sleeps wakes it and revives the session", async () => {
    await withCloud(async (rpc, context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
      const host = new FakeCloudHost(cloudHostId(cloudId));
      context.hosts.register(host);

      const spawned = await rpc.agentSpawn({
        workspace: workspace.id,
        cloud: true,
      });
      expect(spawned.ok).toBe(true);
      if (!spawned.ok) return;
      expect(spawned.data.hostId).toBe(host.id);
      expect(host.launches).toHaveLength(1);

      await rpc.cloudWorkspaceSleep({ workspace: workspace.id });
      host.sessions.clear();
      expect((await context.agents.get(spawned.data.id)).status).toBe("lost");

      const woken = await rpc.cloudSessionWake({ sessionId: spawned.data.id });
      expect(woken.ok).toBe(true);
      if (!woken.ok) return;
      expect(woken.data.status).toBe("running");
      expect(gateway.calls).toContain(`POST /v1/workspaces/${cloudId}/wake`);
      expect(host.launches).toHaveLength(2);
      expect(host.launches[1]!.args).toContain("--resume");
    });
  });

  test("a session on this Mac is not woken as a cloud one", async () => {
    await withCloud(async (rpc, context) => {
      const workspace = await context.workspaces.create({ name: "Here" });
      const session = await rpc.agentSpawn({
        workspace: workspace.id,
        terminal: true,
      });
      if (!session.ok) return;
      const response = await rpc.cloudSessionWake({
        sessionId: session.data.id,
      });
      expect(!response.ok && response.error.message).toBe(
        "This session runs on this Mac, not in a cloud workspace",
      );
    });
  });

  test("another account's links stay unused until it signs in again", async () => {
    await withCloud(async (rpc, context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const first = context.repositories.cloudWorkspaceId(workspace.id)!;
      const host = new FakeCloudHost(cloudHostId(first));
      context.hosts.register(host);
      const spawned = await rpc.agentSpawn({
        workspace: workspace.id,
        cloud: true,
      });
      if (!spawned.ok) throw new Error(spawned.error.message);
      await rpc.cloudWorkspaceSleep({ workspace: workspace.id });

      // The fake gateway names every user u1, so another gateway it is.
      await rpc.cloudSignIn({
        gatewayUrl: "http://127.0.0.1:9090",
        email: "other@example.com",
      });
      expect(
        context.repositories.cloudWorkspaceId(workspace.id),
      ).toBeUndefined();
      expect(context.hosts.find(cloudHostId(first))).toBeUndefined();
      const woken = await rpc.cloudSessionWake({ sessionId: spawned.data.id });
      expect(!woken.ok && woken.error.message).toBe(
        "This session's cloud workspace is not in the cloud account this Mac is signed in to",
      );
      expect(gateway.calls).not.toContain(`POST /v1/workspaces/${first}/wake`);

      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      expect(context.repositories.cloudWorkspaceId(workspace.id)).toBe(first);
    });
  });

  test("signing out hides every link", async () => {
    await withCloud(async (rpc, context) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      await rpc.cloudSignOut({});
      expect(
        context.repositories.cloudWorkspaceId(workspace.id),
      ).toBeUndefined();
    });
  });

  test("a sign-out during the launch hold leaves no link running", async () => {
    await withCloud(async (rpc, context, _gateway, relay) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const holding = context.cloud.hold();
      const out = rpc.cloudSignOut({});
      expect(await holding).toBe(true);
      expect((await out).ok).toBe(true);
      expect(context.cloud.holding).toBe(false);
      expect(relay.sockets.length).toBeGreaterThan(0);
      expect(relay.open()).toEqual([]);
    });
  });

  test("switching accounts closes the old link before the new one opens", async () => {
    await withCloud(async (rpc, context, _gateway, relay) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "first@example.com",
      });
      await context.cloud.hold();
      expect(relay.open().map((socket) => socket.token)).toEqual([
        `${TOKEN}-first@example.com`,
      ]);
      await Promise.all([
        rpc.cloudSignIn({
          gatewayUrl: "http://127.0.0.1:9090",
          email: "second@example.com",
        }),
        rpc.cloudSignIn({
          gatewayUrl: "http://127.0.0.1:9090",
          email: "third@example.com",
        }),
      ]);
      expect(relay.open().map((socket) => socket.token)).toEqual([
        `${TOKEN}-third@example.com`,
      ]);
      await rpc.cloudSignOut({});
      expect(relay.open()).toEqual([]);
    });
  });

  test("a token the Keychain keeps makes sign-out an error, still signed in", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const gateway = new FakeGateway();
      const vault = memoryVault();
      const context = await createApplicationContext({
        env: { ...process.env, DAEDALUS_HOME: home },
        tmux: new NoTmux(),
        cloud: {
          fetch: gateway.fetch,
          account: new CloudAccount(home, {
            ...vault,
            remove: async () => {
              throw new Error("User interaction is not allowed.");
            },
          }),
        },
      });
      try {
        const rpc = createDesktopRequestHandlers(context);
        await rpc.cloudSignIn({
          gatewayUrl: "http://localhost:8080",
          email: "dev@example.com",
        });
        const out = await rpc.cloudSignOut({});
        expect(!out.ok && out.error.message).toBe(
          "The cloud token could not be removed from the Keychain: User interaction is not allowed.",
        );
        const state = await rpc.cloudState({});
        expect(state.ok && state.data.signedIn).toBe(true);
      } finally {
        context.close();
      }
    });
  });

  test("the app acts only on cloud workspaces linked to a local one", async () => {
    await withCloud(async (rpc, _context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const stray = "00000000-0000-4000-8000-000000000001";
      gateway.workspaces.set(stray, {
        workspaceId: stray,
        name: "Elsewhere",
        status: "running",
        reason: null,
        runnerOnline: true,
        runnerKey: RUNNER_KEY,
        createdAt: new Date().toISOString(),
      });
      for (const response of [
        await rpc.cloudWorkspaceSleep({ workspace: stray }),
        await rpc.cloudWorkspaceWake({ workspace: stray }),
        await rpc.cloudWorkspaceDelete({ workspace: stray, force: true }),
      ])
        expect(response.ok).toBe(false);
      expect(gateway.calls.some((call) => call.includes(stray))).toBe(false);
    });
  });

  test("in the app, a host waits for the held link instead of opening its own", async () => {
    await withCloud(async (rpc, context, _gateway, relay) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
      const host = context.hosts.find(cloudHostId(cloudId))!;
      const holding = context.cloud.hold();
      // The runner never answers here, so this only reports it unreachable.
      const probed = host.probe();
      expect(await holding).toBe(true);
      expect(typeof (await probed)).toBe("string");
      expect(relay.sockets).toHaveLength(1);
    });
  });
});

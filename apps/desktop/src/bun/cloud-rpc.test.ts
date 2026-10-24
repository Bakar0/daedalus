import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  CloudAccount,
  CLOUD_SLEEP_REASON,
  cloudHostId,
  CLOUD_COLLECTED_NOTICE,
  COLLECTED_CONFIRM_MS,
  CLOUD_COLLECTED_REASON,
  CLOUD_UNLINKED_MESSAGE,
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
import { claudeStatePath } from "../../../../packages/core/src/services/folder-trust";
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

  readonly files = new Map<string, Uint8Array>();
  /** Claude conversations by id: the sessions here had turns. */
  readonly conversations = new Set<string>();
  /** Every command fails, as a runner that lost its volume would. */
  broken = false;
  async run(command: { executable: string; args: string[] }) {
    if (this.broken)
      return { exitCode: 1, stdout: "", stderr: "no such volume" };
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
    return undefined;
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
    return [...this.sessions];
  }
  async capture() {
    return "Claude Code v2.1.251\nshift+tab to cycle";
  }
  async sendKeys() {}
  readonly sent: string[] = [];
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
  /** Refuse a create with this QUOTA message, as the gateway does. */
  quota: string | undefined;
  /** At most this many workspaces, as the gateway's own limit. */
  limit = Number.POSITIVE_INFINITY;
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
    if (url.pathname === "/v1/workspaces" && method === "POST" && this.quota)
      return json(429, { error: { code: "QUOTA", message: this.quota } });
    if (
      url.pathname === "/v1/workspaces" &&
      method === "POST" &&
      this.workspaces.size >= this.limit
    )
      return json(429, {
        error: {
          code: "QUOTA",
          message: `You may have at most ${this.limit} workspaces`,
        },
      });
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
  options: { runnerWaitMs?: number } = {},
): Promise<void> {
  await withTemporaryDaedalusHome(async (home) => {
    const gateway = new FakeGateway();
    const relay = new FakeRelay();
    clock.now = Date.now();
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
        now: () => clock.now,
        ...options,
      },
    });
    try {
      await run(createDesktopRequestHandlers(context), context, gateway, relay);
    } finally {
      context.close();
    }
  });
}

/** The cloud service's clock, which a test moves on. */
const clock = { now: Date.now() };

/** The workspace lives in the cloud: its sessions run there. */
const inCloud = (
  context: Awaited<ReturnType<typeof createApplicationContext>>,
  workspaceId: string,
) =>
  context.repositories.setWorkspacePlace(workspaceId, {
    place: "cloud",
    notice: null,
  });

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
          createdAt: expect.any(String),
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

  test("a session in a workspace in the cloud needs a sign-in and its copy, and only Claude runs there", async () => {
    await withCloud(async (rpc, context, gateway) => {
      const workspace = await context.workspaces.create({ name: "Pods" });
      inCloud(context, workspace.id);
      const signedOut = await rpc.agentSpawn({
        workspace: workspace.id,
      });
      expect(!signedOut.ok && signedOut.error.message).toBe(
        "Sign in to a cloud gateway in Settings › Cloud to run sessions in the cloud",
      );
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const codex = await rpc.agentSpawn({
        workspace: workspace.id,
        provider: "codex",
      });
      expect(!codex.ok && codex.error.message).toBe(
        "Only Claude runs in the cloud; move the workspace home to this Mac to start Codex",
      );
      expect(
        gateway.calls.filter((call) => call === "POST /v1/workspaces"),
      ).toHaveLength(1);
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
      inCloud(context, workspace.id);
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
      const host = new FakeCloudHost(cloudHostId(cloudId));
      context.hosts.register(host);

      const spawned = await rpc.agentSpawn({
        workspace: workspace.id,
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

  test("waking a workspace from its menu resumes the sessions its sleep ended", async () => {
    await withCloud(async (rpc, context) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      inCloud(context, workspace.id);
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
      const host = new FakeCloudHost(cloudHostId(cloudId));
      context.hosts.register(host);
      const first = await rpc.agentSpawn({
        workspace: workspace.id,
      });
      const second = await rpc.agentSpawn({
        workspace: workspace.id,
      });
      if (!first.ok || !second.ok) throw new Error("spawn failed");

      await rpc.cloudWorkspaceSleep({ workspace: workspace.id });
      host.sessions.clear();
      const woken = await rpc.cloudWorkspaceWake({ workspace: workspace.id });
      expect(woken.ok).toBe(true);
      for (const id of [first.data.id, second.data.id])
        expect((await context.agents.get(id)).status).toBe("running");
      expect(host.launches).toHaveLength(4);
      expect(
        host.launches.slice(2).every((l) => l.args.includes("--resume")),
      ).toBe(true);
    });
  });

  test("opening a session after its workspace woke resumes it", async () => {
    await withCloud(async (rpc, context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      inCloud(context, workspace.id);
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
      const host = new FakeCloudHost(cloudHostId(cloudId));
      context.hosts.register(host);
      const spawned = await rpc.agentSpawn({
        workspace: workspace.id,
      });
      if (!spawned.ok) throw new Error("spawn failed");

      await rpc.cloudWorkspaceSleep({ workspace: workspace.id });
      host.sessions.clear();
      // Woken by something that resumes nothing, as the CLI does.
      await context.cloud.wake(workspace.id);
      expect(gateway.workspaces.get(cloudId)!.status).toBe("running");
      expect((await context.agents.get(spawned.data.id)).status).toBe("lost");

      const opened = await rpc.cloudSessionWake({ sessionId: spawned.data.id });
      expect(opened.ok && opened.data.status).toBe("running");
      expect(host.launches.at(-1)!.args).toContain("--resume");
      // A second open while it runs leaves it as it is.
      const again = await rpc.cloudSessionWake({ sessionId: spawned.data.id });
      expect(again.ok && again.data.status).toBe("running");
      expect(host.launches).toHaveLength(2);
    });
  });

  test("a message to a session asleep in the cloud wakes and resumes it first", async () => {
    await withCloud(async (rpc, context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      inCloud(context, workspace.id);
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
      const host = new FakeCloudHost(cloudHostId(cloudId));
      context.hosts.register(host);
      const spawned = await rpc.agentSpawn({
        workspace: workspace.id,
      });
      if (!spawned.ok) throw new Error("spawn failed");

      await rpc.cloudWorkspaceSleep({ workspace: workspace.id });
      host.sessions.clear();
      const out = await rpc.agentSend({ id: spawned.data.id, text: "hello" });
      expect(out.ok).toBe(true);
      expect(gateway.workspaces.get(cloudId)!.status).toBe("running");
      expect((await context.agents.get(spawned.data.id)).status).toBe(
        "running",
      );
      expect(host.launches.at(-1)!.args).toContain("--resume");
      expect(host.sent).toEqual(["hello"]);
    });
  });

  test("a session in the cloud archives there, unasked", async () => {
    await withCloud(async (rpc, context) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      inCloud(context, workspace.id);
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
      context.hosts.register(new FakeCloudHost(cloudHostId(cloudId)));
      const spawned = await rpc.agentSpawn({
        workspace: workspace.id,
      });
      if (!spawned.ok) throw new Error("spawn failed");

      const archived = await rpc.agentArchive({ id: spawned.data.id });
      expect(archived.ok && archived.data.status).toBe("archived");
      const session = await context.agents.get(spawned.data.id);
      expect(session.archivedAt).not.toBeNull();
      expect(session.hostId).toBe(cloudHostId(cloudId));
    });
  });

  test("archiving a workspace brings it home first, then deletes its cloud copy", async () => {
    await withCloud(async (rpc, context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      inCloud(context, workspace.id);
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
      const host = new FakeCloudHost(cloudHostId(cloudId));
      context.hosts.register(host);
      const spawned = await rpc.agentSpawn({
        workspace: workspace.id,
      });
      if (!spawned.ok) throw new Error("spawn failed");

      // Its copy cannot come home: nothing is archived or deleted.
      host.broken = true;
      const refused = await rpc.workspaceArchive({ reference: workspace.id });
      expect(!refused.ok && refused.error.message).toMatch(
        /^Pods could not come home from the cloud, so it is not archived: /,
      );
      expect(gateway.workspaces.has(cloudId)).toBe(true);
      expect(
        (await context.workspaces.get(workspace.id)).archivedAt,
      ).toBeNull();

      // Home again with a copy left over (its delete failed): archiving
      // deletes it.
      context.repositories.setWorkspacePlace(workspace.id, {
        place: "mac",
        notice: null,
      });
      const archived = await rpc.workspaceArchive({ reference: workspace.id });
      expect(archived.ok && archived.data.status).toBe("archived");
      expect(gateway.workspaces.has(cloudId)).toBe(false);
      expect(
        context.repositories.cloudWorkspaceId(workspace.id),
      ).toBeUndefined();
      // Restored, it is local; the next cloud session makes a new copy.
      await rpc.workspaceRestore({ reference: workspace.id });
      expect(
        context.repositories.cloudWorkspaceId(workspace.id),
      ).toBeUndefined();
      const made = await context.cloud.create(workspace.id);
      expect(made.workspaceId).not.toBe(cloudId);
    });
  });

  test("copies this Mac links that no workspace lives in go at the limit, and only those", async () => {
    await withCloud(async (rpc, context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const copyOf = async (name: string) => {
        const workspace = await context.workspaces.create({ name });
        await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
        return {
          workspace,
          cloudId: context.repositories.cloudWorkspaceId(workspace.id)!,
        };
      };
      const inTheCloud = await copyOf("In the cloud");
      inCloud(context, inTheCloud.workspace.id);
      const onTheWay = await copyOf("On its way");
      context.cloud.keepWhile((id) => id === onTheWay.workspace.id);
      const home = await copyOf("Home");
      const archived = await copyOf("Archived");
      await context.workspaces.archive(archived.workspace.id);
      // A copy this Mac does not link, as another Mac's would be: kept.
      const unknown = crypto.randomUUID();
      gateway.workspaces.set(unknown, {
        ...gateway.workspaces.get(home.cloudId)!,
        workspaceId: unknown,
      });
      gateway.limit = 5;

      const next = await context.workspaces.create({ name: "Next" });
      const made = await context.cloud.create(next.id);
      expect([...gateway.workspaces.keys()].sort()).toEqual(
        [
          inTheCloud.cloudId,
          onTheWay.cloudId,
          unknown,
          made.workspaceId,
        ].sort(),
      );
      expect(
        context.repositories.cloudWorkspaceId(home.workspace.id),
      ).toBeUndefined();
      expect(
        context.repositories.cloudWorkspaceId(inTheCloud.workspace.id),
      ).toBe(inTheCloud.cloudId);

      // Still over the limit with nothing to clean: the gateway's answer.
      inCloud(context, next.id);
      gateway.limit = 4;
      const last = await context.workspaces.create({ name: "Last" });
      await expect(context.cloud.create(last.id)).rejects.toMatchObject({
        details: { gatewayCode: "QUOTA" },
      });
      expect(gateway.workspaces.size).toBe(4);
    });
  });

  test("deleting a workspace deletes a cloud copy it still has", async () => {
    await withCloud(async (rpc, context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
      // Archived before archiving removed cloud copies.
      await context.workspaces.archive(workspace.id);
      const deleted = await rpc.workspaceDelete({ reference: workspace.id });
      expect(deleted.ok).toBe(true);
      expect(gateway.workspaces.has(cloudId)).toBe(false);
    });
  });

  test("a cloud copy the gateway no longer has deletes as gone", async () => {
    await withCloud(async (rpc, context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
      gateway.workspaces.delete(cloudId);
      const archived = await rpc.workspaceArchive({ reference: workspace.id });
      expect(archived.ok && archived.data.status).toBe("archived");
      expect(
        context.repositories.cloudWorkspaceId(workspace.id),
      ).toBeUndefined();
    });
  });

  test("a routine run due for a session asleep in the cloud wakes and resumes it", async () => {
    await withCloud(async (rpc, context) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      inCloud(context, workspace.id);
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
      const host = new FakeCloudHost(cloudHostId(cloudId));
      context.hosts.register(host);
      const spawned = await rpc.agentSpawn({
        workspace: workspace.id,
      });
      if (!spawned.ok) throw new Error("spawn failed");
      // Routines are granted on this Mac; a session keeps them when it
      // moves to the cloud.
      context.repositories.setAgentPlace(spawned.data.id, {
        hostId: null,
        workingDirectory: workspace.path,
      });
      const ability = context.abilities.grant(spawned.data.id, "routines", {
        live: false,
      });
      context.repositories.setAgentPlace(spawned.data.id, {
        hostId: host.id,
        workingDirectory: ".",
      });
      context.routines.add(ability, {
        text: "---\nname: ci-health\nschedule: every 10m\n---\nCheck CI.",
      });
      context.routineDelivery.runNow(ability, "ci-health");

      await rpc.cloudWorkspaceSleep({ workspace: workspace.id });
      host.sessions.clear();
      const launches = host.launches.length;
      await context.routineDelivery.tick({
        contextPercent: () => 10,
        activity: () => undefined,
      });
      // The wake runs beside the tick.
      for (let waited = 0; waited < 5_000; waited += 50) {
        if ((await context.agents.get(spawned.data.id)).status === "running")
          break;
        await Bun.sleep(50);
      }
      expect((await context.agents.get(spawned.data.id)).status).toBe(
        "running",
      );
      expect(host.launches).toHaveLength(launches + 1);
      expect(host.launches.at(-1)!.args).toContain("--resume");
    });
  });

  test("a sleep that did not happen: the session is taken back as it runs, not relaunched", async () => {
    await withCloud(async (rpc, context) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      inCloud(context, workspace.id);
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
      const host = new FakeCloudHost(cloudHostId(cloudId));
      context.hosts.register(host);
      const spawned = await rpc.agentSpawn({
        workspace: workspace.id,
      });
      if (!spawned.ok) throw new Error("spawn failed");
      // Read as asleep, but the gateway refused the sleep: the pod and its
      // Claude still run.
      const session = await context.agents.get(spawned.data.id);
      context.repositories.updateAgent({
        ...session,
        status: "lost",
        lostReason: CLOUD_SLEEP_REASON,
        endedAt: new Date().toISOString(),
      });

      const sent = await rpc.agentSend({ id: session.id, text: "still here?" });
      expect(sent.ok).toBe(true);
      expect((await context.agents.get(session.id)).status).toBe("running");
      expect(host.launches).toHaveLength(1);
      expect(host.sent).toEqual(["still here?"]);
    });
  });

  test("a cloud workspace whose copy this account does not link falls back at once, and no copy is made", async () => {
    await withCloud(async (rpc, context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const stranded = async (name: string) => {
        const workspace = await context.workspaces.create({ name });
        inCloud(context, workspace.id);
        await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
        const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
        context.hosts.register(new FakeCloudHost(cloudHostId(cloudId)));
        const spawned = await rpc.agentSpawn({ workspace: workspace.id });
        if (!spawned.ok) throw new Error("spawn failed");
        // Deleted as a leftover: no copy, no link, the place still cloud.
        gateway.workspaces.delete(cloudId);
        context.repositories.unlinkCloudWorkspace(cloudId);
        return { workspace, session: spawned.data };
      };

      // Starting a session: no copy is made for it.
      const a = await stranded("Spawned");
      const creates = gateway.calls.filter(
        (call) => call === "POST /v1/workspaces",
      ).length;
      const refused = await rpc.agentSpawn({ workspace: a.workspace.id });
      expect(!refused.ok && refused.error.message).toBe(CLOUD_UNLINKED_MESSAGE);
      expect(
        gateway.calls.filter((call) => call === "POST /v1/workspaces"),
      ).toHaveLength(creates);
      const back = await context.workspaces.get(a.workspace.id);
      expect(back.place).toBeUndefined();
      expect(back.cloudNotice).toBe(CLOUD_COLLECTED_NOTICE);
      expect(await context.agents.get(a.session.id)).toMatchObject({
        status: "lost",
        lostReason: CLOUD_COLLECTED_REASON,
        hostId: null,
        workingDirectory: join(a.workspace.path, a.session.workingDirectory),
      });
      // Now a workspace of this Mac: a session starts here.
      const local = await rpc.agentSpawn({
        workspace: a.workspace.id,
        terminal: true,
      });
      expect(local.ok && local.data.hostId).toBeNull();

      // Moving home and archiving work as for a local workspace.
      const b = await stranded("Moved");
      const moved = await rpc.workspaceMove({
        reference: b.workspace.id,
        to: "mac",
      });
      expect(moved.ok && moved.data.status).toBe("moved");
      expect((await context.workspaces.get(b.workspace.id)).place).toBe(
        undefined,
      );
      const c = await stranded("Archived");
      const archived = await rpc.workspaceArchive({
        reference: c.workspace.id,
      });
      expect(archived.ok && archived.data.status).toBe("archived");

      // At start, every such workspace falls back.
      const d = await stranded("At start");
      expect(await context.cloud.fallBackUnlinked()).toEqual([d.workspace.id]);

      // Signed out, nothing is decided.
      const e = await stranded("Signed out");
      await rpc.cloudSignOut({});
      expect(await context.cloud.fallBackUnlinked()).toEqual([]);
      expect((await context.workspaces.get(e.workspace.id)).place).toBe(
        "cloud",
      );
    });
  });

  test("a workspace whose copy the gateway collected comes back to this Mac with a notice", async () => {
    await withCloud(async (rpc, context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      inCloud(context, workspace.id);
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
      const host = new FakeCloudHost(cloudHostId(cloudId));
      context.hosts.register(host);
      const spawned = await rpc.agentSpawn({
        workspace: workspace.id,
      });
      if (!spawned.ok) throw new Error("spawn failed");
      await rpc.cloudWorkspaceSleep({ workspace: workspace.id });
      // 30 days asleep: the gateway's collection deleted it.
      gateway.workspaces.delete(cloudId);

      // One answer is not enough: the link stays, the workspace with it.
      expect((await rpc.cloudState({})).ok).toBe(true);
      expect(context.repositories.cloudWorkspaceId(workspace.id)).toBe(cloudId);
      expect((await context.workspaces.get(workspace.id)).place).toBe("cloud");
      clock.now += COLLECTED_CONFIRM_MS - 60_000;
      await rpc.cloudState({});
      expect(context.repositories.cloudWorkspaceId(workspace.id)).toBe(cloudId);

      // Gone again an hour after it was first missed.
      clock.now += 60_000;
      const state = await rpc.cloudState({});
      expect(state.ok && state.data.workspaces).toEqual([]);
      expect(
        context.repositories.cloudWorkspaceId(workspace.id),
      ).toBeUndefined();
      expect(await context.agents.get(spawned.data.id)).toMatchObject({
        status: "lost",
        lostReason: CLOUD_COLLECTED_REASON,
        hostId: null,
        workingDirectory: join(workspace.path, spawned.data.workingDirectory),
      });
      const back = await context.workspaces.get(workspace.id);
      expect(back.place).toBeUndefined();
      expect(back.cloudNotice).toBe(CLOUD_COLLECTED_NOTICE);
      await rpc.workspaceNoticeDismiss({ reference: workspace.id });
      expect(
        (await context.workspaces.get(workspace.id)).cloudNotice,
      ).toBeUndefined();
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
      inCloud(context, workspace.id);
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const first = context.repositories.cloudWorkspaceId(workspace.id)!;
      const host = new FakeCloudHost(cloudHostId(first));
      context.hosts.register(host);
      const spawned = await rpc.agentSpawn({
        workspace: workspace.id,
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

  test("a sign-in page from a cloud session waits for the click, and opens once", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const gateway = new FakeGateway();
      const context = await createApplicationContext({
        env: { ...process.env, DAEDALUS_HOME: home },
        tmux: new NoTmux(),
        cloud: {
          fetch: gateway.fetch,
          account: new CloudAccount(home, memoryVault()),
          identity: async () => ({
            id: "mac-1",
            publicKey: "mac-public",
            secretKey: "mac-secret",
          }),
        },
      });
      const opened: string[] = [];
      try {
        const rpc = createDesktopRequestHandlers(context, {
          openExternal: (url) => {
            opened.push(url);
            return true;
          },
        });
        await rpc.cloudSignIn({
          gatewayUrl: "http://localhost:8080",
          email: "dev@example.com",
        });
        const workspace = await context.workspaces.create({ name: "Pods" });
        inCloud(context, workspace.id);
        await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
        const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
        const host = new FakeCloudHost(cloudHostId(cloudId));
        context.hosts.register(host);
        const session = await rpc.agentSpawn({
          workspace: workspace.id,
        });
        if (!session.ok) throw new Error(session.error.message);
        const url =
          "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A42431%2Fcallback&state=st8&code_challenge=ch";

        const refused = context.cloud.offerSignIn(
          host.id,
          session.data.id,
          "https://evil.test/cai/oauth/authorize",
        );
        expect(refused.exitCode).toBe(77);
        expect(
          context.cloud.offerSignIn(host.id, session.data.id, url).exitCode,
        ).toBe(0);

        const snapshot = await rpc.snapshot({});
        if (!snapshot.ok) throw new Error(snapshot.error.message);
        expect(snapshot.data.cloudSignIns).toEqual([
          expect.objectContaining({
            sessionId: session.data.id,
            host: "claude.com",
            kind: "claude",
          }),
        ]);
        expect(JSON.stringify(snapshot.data.cloudSignIns)).not.toContain("st8");

        const requestId = snapshot.data.cloudSignIns![0]!.requestId!;
        const open = await rpc.cloudSignInOpen({ requestId });
        expect(open).toEqual({
          ok: true,
          data: { host: "claude.com", paste: true },
        });
        expect(opened).toHaveLength(1);
        expect(new URL(opened[0]!).searchParams.get("redirect_uri")).toBe(
          "https://platform.claude.com/oauth/code/callback",
        );
        const again = await rpc.cloudSignInOpen({ requestId });
        expect(again.ok).toBe(false);
        expect(opened).toHaveLength(1);
      } finally {
        context.close();
      }
    });
  });

  test("Run in cloud refused by a quota says so in plain words", async () => {
    await withCloud(async (rpc, context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      // What the user's create got back from Kubernetes on kind.
      gateway.quota =
        'Creating PersistentVolumeClaim ws-1-state: persistentvolumeclaims "ws-1-state" is forbidden: exceeded quota: workspaces, requested: persistentvolumeclaims=1, used: persistentvolumeclaims=6, limited: persistentvolumeclaims=6';
      const refused = await rpc.cloudWorkspaceCreate({
        workspace: workspace.id,
      });
      expect(!refused.ok && refused.error.message).toBe(
        "Your cloud workspaces use all the storage volumes the gateway allows you (6). Delete a cloud workspace, or ask the gateway's administrator to raise the limit.",
      );
      // The gateway's own limit reads well as it is.
      gateway.quota = "You may have at most 5 workspaces";
      const limit = await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      expect(!limit.ok && limit.error.message).toBe(
        "You may have at most 5 workspaces",
      );
      expect(
        context.repositories.cloudWorkspaceId(workspace.id),
      ).toBeUndefined();
    });
  });

  test("the first cloud session makes the cloud workspace, and a sleeping one is woken", async () => {
    await withCloud(async (rpc, context, gateway) => {
      await expect(context.cloud.prepareForSession("anything")).rejects.toThrow(
        "Sign in to a cloud gateway in Settings › Cloud",
      );
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      const phases: string[] = [];
      context.cloud.onPreparingChange(() =>
        phases.push(context.cloud.preparing()[0]?.phase ?? "done"),
      );

      // Two sessions at once share one preparation.
      const [first, second] = await Promise.all([
        context.cloud.prepareForSession(workspace.id),
        context.cloud.prepareForSession(workspace.id),
      ]);
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
      expect(first).toBe(`ws:${cloudId}`);
      expect(second).toBe(first);
      expect(phases).toEqual(["creating", "starting", "done"]);
      expect(
        gateway.calls.filter((call) => call === "POST /v1/workspaces"),
      ).toHaveLength(1);

      await rpc.cloudWorkspaceSleep({ workspace: workspace.id });
      phases.length = 0;
      expect(await context.cloud.prepareForSession(workspace.id)).toBe(first);
      expect(phases).toEqual(["waking", "starting", "done"]);
      expect(gateway.workspaces.get(cloudId)?.status).toBe("running");

      // Already running: nothing to do but check.
      phases.length = 0;
      await context.cloud.prepareForSession(workspace.id);
      expect(phases).toEqual(["starting", "done"]);
    });
  });

  test("a failed cloud workspace says why instead of waiting", async () => {
    await withCloud(async (rpc, context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
      gateway.workspaces.get(cloudId)!.status = "failed";
      gateway.workspaces.get(cloudId)!.reason = "The image could not be pulled";
      await expect(
        context.cloud.prepareForSession(workspace.id),
      ).rejects.toThrow("The image could not be pulled");
      expect(context.cloud.preparing()).toEqual([]);
    });
  });

  test("the MCP list gives the window names and hosts, never a URL", async () => {
    await withCloud(async (rpc, context) => {
      const statePath = claudeStatePath(context.config);
      const before = await Bun.file(statePath)
        .text()
        .catch(() => undefined);
      await Bun.write(
        statePath,
        JSON.stringify({
          mcpServers: {
            zapier: {
              type: "sse",
              url: "https://actions.zapier.com/mcp/zk-SECRET-key/sse",
            },
          },
        }),
      );
      const listed = await rpc.cloudMcpServers({});
      expect(listed).toEqual({
        ok: true,
        data: {
          servers: [{ name: "zapier", host: "actions.zapier.com", on: false }],
          leftOut: [],
        },
      });
      const on = await rpc.cloudMcpServerSet({ name: "zapier", on: true });
      expect(on.ok && on.data.servers[0]?.on).toBe(true);
      expect(JSON.stringify([listed, on])).not.toContain("zk-SECRET");
      // The test home's ~/.claude.json is shared by the whole run.
      if (before === undefined) await unlink(statePath).catch(() => {});
      else await Bun.write(statePath, before);
    });
  });

  test("a process that opened its own link does not wait for a runner the gateway says is asleep", async () => {
    // The app's start-up sweep runs before the app holds the link: it met
    // each asleep runner's wait in turn.
    await withCloud(
      async (rpc, context, gateway) => {
        await rpc.cloudSignIn({
          gatewayUrl: "http://localhost:8080",
          email: "dev@example.com",
        });
        const workspace = await context.workspaces.create({ name: "Pods" });
        await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
        const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
        gateway.workspaces.get(cloudId)!.status = "sleeping";
        gateway.workspaces.get(cloudId)!.runnerOnline = false;
        const host = context.hosts.find(cloudHostId(cloudId))!;
        const started = Date.now();
        // Unavailable either way; what matters is how long saying so takes.
        expect(await host.probe()).toBeDefined();
        // Far under the minute this run would wait.
        expect(Date.now() - started).toBeLessThan(30_000);
      },
      { runnerWaitMs: 60_000 },
    );
  }, 90_000);

  test("in the app, a runner that is not linked costs a snapshot nothing", async () => {
    await withCloud(async (rpc, context, gateway) => {
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "dev@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
      // Asleep, so its runner never links; the app holds the link.
      gateway.workspaces.get(cloudId)!.status = "sleeping";
      gateway.workspaces.get(cloudId)!.runnerOnline = false;
      await context.cloud.hold();
      const host = context.hosts.find(cloudHostId(cloudId))!;
      let started = Date.now();
      await expect(host.listLive()).rejects.toThrow("not connected");
      expect(Date.now() - started).toBeLessThan(2_000);
      started = Date.now();
      const snapshot = await rpc.snapshot({});
      expect(snapshot.ok).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });
});

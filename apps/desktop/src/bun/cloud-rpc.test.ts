import { describe, expect, test } from "vitest";
import {
  CloudAccount,
  createApplicationContext,
  type ApplicationContext,
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
      return json(200, { user: { id: "u1", email }, token: TOKEN });
    }
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${TOKEN}` || this.refuse)
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
  ) => Promise<void>,
): Promise<void> {
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
    try {
      await run(createDesktopRequestHandlers(context), context, gateway);
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
});

import { expect, test } from "vitest";
import {
  CloudAccount,
  createApplicationContext,
  type TokenVault,
} from "@daedalus/core";
import type { TmuxClient } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { createDesktopRequestHandlers } from "./rpc";

/**
 * Review finding R-1 (artifacts/cloud-sessions/cloud-ui-review.md): signing
 * in to another gateway keeps the old account's cloud workspace links, and
 * Run in cloud then hands the old cloud id to the new gateway.
 */

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

/** Two gateways, told apart by port, each with its own token and workspaces. */
const requests: Array<{
  origin: string;
  method: string;
  path: string;
  body?: string;
}> = [];
const fakeFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = init?.body === undefined ? undefined : String(init.body);
  requests.push({ origin: url.origin, method, path: url.pathname, body });
  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (url.pathname === "/v1/dev/login") {
    const { email } = JSON.parse(body!) as { email: string };
    return json(200, {
      user: { id: `user-${url.port}`, email },
      token: `token-${url.port}`,
    });
  }
  if (url.pathname === "/v1/workspaces" && method === "GET")
    return json(200, { workspaces: [] });
  if (url.pathname === "/v1/workspaces" && method === "POST") {
    const request = JSON.parse(body!) as { workspaceId: string; name: string };
    return json(201, {
      workspaceId: request.workspaceId,
      name: request.name,
      status: "running",
      reason: null,
      runnerOnline: true,
      runnerKey: `runner-${url.port}`,
      createdAt: new Date().toISOString(),
    });
  }
  return json(404, { error: { code: "NOT_FOUND", message: "No such" } });
}) as typeof fetch;

test("R-1: another gateway does not inherit the old account's cloud workspace links", async () => {
  await withTemporaryDaedalusHome(async (home) => {
    const context = await createApplicationContext({
      env: { ...process.env, DAEDALUS_HOME: home },
      tmux: new NoTmux(),
      cloud: {
        fetch: fakeFetch,
        account: new CloudAccount(home, memoryVault()),
        identity: async () => ({
          id: "mac-1",
          publicKey: "mac-public",
          secretKey: "mac-secret",
        }),
      },
    });
    try {
      const rpc = createDesktopRequestHandlers(context);
      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:8080",
        email: "alice@example.com",
      });
      const workspace = await context.workspaces.create({ name: "Pods" });
      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const aliceCloudId = context.repositories.cloudWorkspaceId(workspace.id);
      expect(aliceCloudId).toBeDefined();

      await rpc.cloudSignIn({
        gatewayUrl: "http://localhost:9090",
        email: "bob@example.com",
      });
      // The old account's link should be gone with the old account.
      expect(
        context.repositories.cloudWorkspaceId(workspace.id),
      ).toBeUndefined();

      await rpc.cloudWorkspaceCreate({ workspace: workspace.id });
      const toNewGateway = requests.filter(
        (request) => request.origin === "http://localhost:9090",
      );
      expect(
        toNewGateway.some((request) => request.body?.includes(aliceCloudId!)),
      ).toBe(false);
    } finally {
      context.close();
    }
  });
});

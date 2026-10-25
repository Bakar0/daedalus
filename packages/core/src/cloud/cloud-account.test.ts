import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { RunnerMethod } from "@daedalus/remote-protocol";
import { BrokerTransport, brokerAvailable, serveBroker } from "./broker";
import { CloudAccount, type TokenVault } from "./cloud-account";
import { GatewayClient } from "./gateway-client";
import type { RunnerTransport } from "./link";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});
// Short, because a Unix socket path has to fit in 104 bytes.
async function newHome(): Promise<string> {
  const home = await mkdtemp("/tmp/dc-");
  homes.push(home);
  return home;
}

const memoryVault = (): TokenVault & { token?: string } => {
  const vault: TokenVault & { token?: string } = {
    read: async () => vault.token,
    write: async (token) => {
      vault.token = token;
    },
    remove: async () => {
      delete vault.token;
    },
  };
  return vault;
};

const user = { id: "alice", email: "alice@example.com" };

describe("cloud account", () => {
  test("keeps the token in the vault and the rest in a private file", async () => {
    const home = await newHome();
    const vault = memoryVault();
    const account = new CloudAccount(home, vault);
    await account.save({ gatewayUrl: "http://g:8080", user, token: "t1" });
    expect(vault.token).toBe("t1");
    const file = join(home, "cloud", "account.json");
    expect(await Bun.file(file).text()).not.toContain("t1");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await account.signIn()).toEqual({
      gatewayUrl: "http://g:8080",
      user,
      token: "t1",
    });
  });

  test("pins a runner key once and refuses a different one", async () => {
    const account = new CloudAccount(await newHome(), memoryVault());
    await account.save({ gatewayUrl: "http://g:8080", user, token: "t" });
    await account.pin("w1", "key-a");
    await account.pin("w1", "key-a");
    await expect(account.pin("w1", "key-b")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await account.pinned("w1")).toBe("key-a");
    // Signing in again as the same user keeps the pins; another user does not.
    await account.save({ gatewayUrl: "http://g:8080", user, token: "t2" });
    expect(await account.pinned("w1")).toBe("key-a");
    await account.save({
      gatewayUrl: "http://g:8080",
      user: { id: "bob", email: "bob@example.com" },
      token: "t3",
    });
    expect(await account.pinned("w1")).toBeUndefined();
  });
});

describe("gateway client", () => {
  test("remembers when a workspace was first missing, until it is found", async () => {
    const account = new CloudAccount(await newHome(), memoryVault());
    await account.save({ gatewayUrl: "http://g:8080", user, token: "t" });
    expect(await account.missingSince("w1", 1_000)).toBe(1_000);
    expect(await account.missingSince("w1", 5_000)).toBe(1_000);
    await account.found("w1");
    expect(await account.missingSince("w1", 9_000)).toBe(9_000);
  });

  test("sends the bearer token and reads gateway errors", async () => {
    const seen: Array<{
      url: string;
      auth: string | null;
      redirect: RequestRedirect | undefined;
    }> = [];
    const client = new GatewayClient("https://g:8443/ignored", "tok", (async (
      url: URL,
      init: RequestInit,
    ) => {
      seen.push({
        url: String(url),
        auth: new Headers(init.headers).get("authorization"),
        redirect: init.redirect,
      });
      return Response.json(
        { error: { code: "NOT_FOUND", message: "No such workspace" } },
        { status: 404 },
      );
    }) as unknown as typeof fetch);
    await expect(client.getWorkspace("w1")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "No such workspace",
    });
    expect(seen).toEqual([
      {
        url: "https://g:8443/v1/workspaces/w1",
        auth: "Bearer tok",
        redirect: "error",
      },
    ]);
    expect(client.connectUrl("m1")).toBe("wss://g:8443/v1/connect?macId=m1");
  });

  test("takes https, and http only to this machine", () => {
    for (const address of [
      "file:///etc",
      "http://gateway.example.com",
      "http://10.0.0.5:8080",
      "http://localhost.evil.com",
      "not a url",
    ])
      expect(() => new GatewayClient(address)).toThrow();
    for (const address of [
      "https://gateway.example.com",
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://[::1]:8080",
    ])
      expect(() => new GatewayClient(address)).not.toThrow();
  });
});

describe("broker", () => {
  test("serves runner methods to another process over a private socket", async () => {
    const home = await newHome();
    const calls: Array<{ method: RunnerMethod; params: unknown }> = [];
    const transport: RunnerTransport = {
      unavailable: async (workspaceId) =>
        workspaceId === "asleep" ? "asleep" : undefined,
      request: async (_workspaceId, method, params) => {
        calls.push({ method, params });
        if (method === "host.stop") throw new Error("no such session");
        return ["s1"] as never;
      },
    };
    expect(await brokerAvailable(home)).toBe(false);
    const stop = await serveBroker(home, transport);
    try {
      const socket = join(home, "cloud", "broker.sock");
      expect((await stat(socket)).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, "cloud"))).mode & 0o777).toBe(0o700);
      expect(await brokerAvailable(home)).toBe(true);
      const client = new BrokerTransport(home);
      expect(await client.unavailable("asleep")).toBe("asleep");
      expect(await client.unavailable("w1")).toBeUndefined();
      expect(await client.request("w1", "host.listLive", null)).toEqual(["s1"]);
      await expect(
        client.request("w1", "host.stop", { session: "x" }),
      ).rejects.toThrow("no such session");
      await expect(
        client.request("w1", "daedal.call" as RunnerMethod, null as never),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      expect(calls.map((call) => call.method)).toEqual([
        "host.listLive",
        "host.stop",
      ]);
    } finally {
      await stop();
    }
    expect(await brokerAvailable(home)).toBe(false);
  });

  test("a request and a reply larger than one socket write arrive whole", async () => {
    const home = await newHome();
    // Characters of two and three bytes, so chunks split them.
    const sent = "é".repeat(2 * 1024 * 1024);
    const stored = "€".repeat(3 * 1024 * 1024);
    let received: unknown;
    const transport: RunnerTransport = {
      unavailable: async () => undefined,
      request: async (_workspace, method, params) => {
        if (method === "fs.write") received = params;
        return (method === "fs.read" ? { base64: stored } : null) as never;
      },
    };
    const stop = await serveBroker(home, transport);
    try {
      const client = new BrokerTransport(home);
      await client.request("w1", "fs.write", {
        files: [{ path: "a", base64: sent }],
      });
      expect(
        (received as { files: { base64: string }[] }).files[0]!.base64 === sent,
      ).toBe(true);
      const read = await client.request("w1", "fs.read", { path: "a" });
      expect(read?.base64.length).toBe(stored.length);
      expect(read?.base64 === stored).toBe(true);
    } finally {
      await stop();
    }
  });
});

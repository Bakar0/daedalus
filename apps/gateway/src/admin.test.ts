import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRelayFrame } from "@daedalus/remote-protocol";
import {
  BootstrapAuth,
  createAdmin,
  SIGN_IN_FAILURES_PER_MINUTE,
  type AdminOverview,
} from "./admin";
import { adminClient } from "./admin/client";
import { loadConfig, type AdminConfig, type GatewayConfig } from "./config";
import { Controller } from "./controller";
import { FakeKube } from "./fake-kube";
import { Relay } from "./relay";
import { ACTIVITY_WRITE_MS, createGateway } from "./server";
import { sha256, Store } from "./store";

const TENANT = [
  { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "runner" } },
];
const ADMIN_TOKEN = "a".repeat(20) + "-admin-token-for-tests";
const VIEWER_TOKEN = "v".repeat(20) + "-viewer-token-for-tests";
const WS_A = "0f8e2c1a-7b3d-4e5f-9a6b-1c2d3e4f5a6b";
const WS_B = "11111111-2222-4333-8444-555555555555";
const MAC = "macAAAAAAAAAAAAAAAAAAA";
const key = (fill: number) => Buffer.alloc(32, fill).toString("base64url");

let dir: string;
let kube: FakeKube;
let store: Store;
let relay: Relay;
let config: GatewayConfig & { admin: AdminConfig };
let servers: ReturnType<typeof Bun.serve>[];
let base: string;
let runnerBase: string;
let adminBase: string;
let printed: string[];
let clock: number;
const sockets: WebSocket[] = [];

function start(env: Record<string, string> = {}) {
  const loaded = loadConfig({
    DAEDALUS_GATEWAY_DEV_LOGIN: "true",
    DAEDALUS_GATEWAY_INTERNAL_URL: "http://daedalus-gateway.daedalus:8081",
    DAEDALUS_GATEWAY_NAMESPACE: "daedalus",
    DAEDALUS_GATEWAY_ADMIN_PORT: "8082",
    DAEDALUS_GATEWAY_ADMIN_HOSTS: "admin.example.com",
    DAEDALUS_GATEWAY_OPENCOST_URL: "https://opencost.example.com",
    ...env,
  });
  config = loaded as GatewayConfig & { admin: AdminConfig };
  config.dbPath = join(dir, "gateway.sqlite");
  store = new Store(config.dbPath);
  relay = new Relay();
  const controller = new Controller(kube, config, TENANT, async () => {});
  const gateway = createGateway({
    config,
    store,
    controller,
    relay,
    log: () => {},
  });
  const admin = createAdmin({
    config,
    store,
    controller,
    relay,
    workspaces: gateway.workspaces,
    auth: new BootstrapAuth({ admin: ADMIN_TOKEN, viewer: VIEWER_TOKEN }),
    log: () => {},
    print: (line) => printed.push(line),
    now: () => clock,
  });
  servers = [
    Bun.serve({ ...gateway.public, port: 0 }),
    Bun.serve({ ...gateway.runner, port: 0 }),
    Bun.serve({ ...admin, port: 0 }),
  ];
  base = `http://localhost:${servers[0]!.port}`;
  runnerBase = `http://localhost:${servers[1]!.port}`;
  adminBase = `http://localhost:${servers[2]!.port}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gateway-admin-test-"));
  kube = new FakeKube();
  printed = [];
  clock = Date.now();
  start();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers) await server.stop(true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function devLogin(email: string) {
  const response = await fetch(`${base}/v1/dev/login`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  return (await response.json()) as { user: { id: string }; token: string };
}

async function createWorkspace(token: string, workspaceId = WS_A) {
  const response = await fetch(`${base}/v1/workspaces`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspaceId,
      name: "My <b>workspace</b>",
      macId: MAC,
      macKey: key(1),
    }),
  });
  return response.status;
}

interface AdminSession {
  cookie: string;
  csrf: string;
  role: string;
}

async function signIn(token = ADMIN_TOKEN): Promise<AdminSession> {
  const response = await fetch(`${adminBase}/admin/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { csrf: string; role: string };
  const cookie = response.headers.get("Set-Cookie")!.split(";")[0]!;
  return { cookie, csrf: body.csrf, role: body.role };
}

async function call(
  session: AdminSession | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${adminBase}/admin/api/${path}`, {
    method,
    headers: {
      ...(session ? { Cookie: session.cookie } : {}),
      ...(method !== "GET"
        ? {
            "Content-Type": "application/json",
            ...(session ? { "X-Daedalus-CSRF": session.csrf } : {}),
          }
        : {}),
      ...headers,
    },
    ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: (text ? JSON.parse(text) : {}) as Record<string, unknown> & {
      error?: { code: string; message: string };
    },
  };
}

const overview = async (session: AdminSession) =>
  (await call(session, "GET", "overview")).json as unknown as AdminOverview;

const audits = () =>
  printed.map((line) => JSON.parse(line) as Record<string, string>);

describe("listener", () => {
  test("is off unless its port is set", () => {
    const off = loadConfig({
      DAEDALUS_GATEWAY_INTERNAL_URL: "http://gateway:8081",
      DAEDALUS_GATEWAY_NAMESPACE: "daedalus",
    });
    expect(off.admin).toBeNull();
    expect(config.admin.host).toBe("127.0.0.1");
    expect(() =>
      loadConfig({
        DAEDALUS_GATEWAY_INTERNAL_URL: "http://gateway:8081",
        DAEDALUS_GATEWAY_NAMESPACE: "daedalus",
        DAEDALUS_GATEWAY_ADMIN_PORT: "8080",
      }),
    ).toThrow("must differ");
    expect(() =>
      loadConfig({
        DAEDALUS_GATEWAY_INTERNAL_URL: "http://gateway:8081",
        DAEDALUS_GATEWAY_NAMESPACE: "daedalus",
        DAEDALUS_GATEWAY_ADMIN_PORT: "8082",
        DAEDALUS_GATEWAY_OPENCOST_URL: "javascript:alert(1)",
      }),
    ).toThrow("http(s)");
  });

  test("the public and runner listeners have no admin routes", async () => {
    const session = await signIn();
    for (const at of [base, runnerBase])
      for (const path of [
        "/admin/",
        "/admin/api/overview",
        "/admin/admin.js",
      ]) {
        const response = await fetch(`${at}${path}`, {
          headers: {
            Cookie: session.cookie,
            Authorization: `Bearer ${ADMIN_TOKEN}`,
          },
        });
        expect([401, 404]).toContain(response.status);
        expect(await response.text()).not.toContain("Daedalus admin");
      }
  });

  test("serves the page, its script and its style with strict headers", async () => {
    for (const [path, type] of [
      ["/admin/", "text/html"],
      ["/admin/admin.js", "text/javascript"],
      ["/admin/admin.css", "text/css"],
    ] as const) {
      const response = await fetch(`${adminBase}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toStartWith(type);
      const csp = response.headers.get("Content-Security-Policy")!;
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    const html = await (await fetch(`${adminBase}/admin/`)).text();
    expect(html).not.toMatch(/<script>|\sstyle=|\son[a-z]+=/);
  });

  test("the served script is the client, runs on its own, and uses no innerHTML", async () => {
    const script = await (await fetch(`${adminBase}/admin/admin.js`)).text();
    expect(script).toStartWith("(");
    expect(script).not.toContain("innerHTML");
    expect(script).not.toContain("insertAdjacentHTML");
    expect(script).toContain(adminClient.name);
    // It parses as a script, with no import or export.
    expect(() => new Function(script)).not.toThrow();
  });

  test("refuses unknown Host headers, as against DNS rebinding", async () => {
    const response = await fetch(`${adminBase}/admin/api/session`, {
      headers: { Host: "evil.example.net" },
    });
    expect(response.status).toBe(421);
    for (const host of ["127.0.0.1:9999", "localhost", "admin.example.com"]) {
      const allowed = await fetch(`${adminBase}/admin/api/session`, {
        headers: { Host: host },
      });
      expect(allowed.status).toBe(401);
    }
  });
});

describe("sign-in", () => {
  test("the admin token signs in with a strict cookie; a session works", async () => {
    const response = await fetch(`${adminBase}/admin/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("Set-Cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/admin");
    // Loopback over http: no Secure, or the browser would drop it.
    expect(cookie).not.toContain("Secure");
    const body = (await response.json()) as Record<string, string>;
    expect(body.role).toBe("admin");
    expect(body.subject).toBe("bootstrap-admin");
    expect(JSON.stringify(body)).not.toContain(ADMIN_TOKEN);
    const id = cookie.split(";")[0]!.split("=")[1]!;
    const session = await call(
      { cookie: `daedalus_admin=${id}`, csrf: body.csrf!, role: "admin" },
      "GET",
      "session",
    );
    expect(session.status).toBe(200);
    expect(session.json.role).toBe("admin");
  });

  test("off loopback the cookie is Secure, and plain http is refused", async () => {
    const refused = await fetch(`${adminBase}/admin/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "admin.example.com",
      },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    expect(refused.status).toBe(403);
    const proxied = await fetch(`${adminBase}/admin/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "admin.example.com",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get("Set-Cookie")).toContain("Secure");
  });

  test("wrong, short and user tokens are refused and audited without the token", async () => {
    const { token: userToken } = await devLogin("someone@example.com");
    for (const token of ["wrong", ADMIN_TOKEN + "x", userToken, ""]) {
      const response = await fetch(`${adminBase}/admin/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }
    const refused = audits().filter((entry) => entry.result === "refused");
    expect(refused).toHaveLength(4);
    expect(printed.join("\n")).not.toContain(userToken);
    // A user token as a bearer means nothing here either.
    const bearer = await fetch(`${adminBase}/admin/api/overview`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(bearer.status).toBe(401);
  });

  test("tokens under 32 characters, or the same for both roles, are refused at start", () => {
    expect(() => new BootstrapAuth({ admin: "short" })).toThrow("32");
    expect(
      () => new BootstrapAuth({ admin: ADMIN_TOKEN, viewer: ADMIN_TOKEN }),
    ).toThrow("differ");
  });

  test("reads the tokens from the mounted Secret", () => {
    const secret = join(dir, "secret");
    rmSync(secret, { recursive: true, force: true });
    require("node:fs").mkdirSync(secret);
    expect(() => BootstrapAuth.fromDir(secret)).toThrow("admin-token");
    writeFileSync(join(secret, "admin-token"), `${ADMIN_TOKEN}\n`);
    const auth = BootstrapAuth.fromDir(secret);
    expect(auth.signIn({ token: ADMIN_TOKEN })?.role).toBe("admin");
    expect(auth.signIn({ token: VIEWER_TOKEN })).toBeNull();
  });

  test(`after ${SIGN_IN_FAILURES_PER_MINUTE} failures a minute, sign-in answers 429`, async () => {
    for (let i = 0; i < SIGN_IN_FAILURES_PER_MINUTE; i++) {
      const response = await call(null, "POST", "login", { token: "nope" });
      expect(response.status).toBe(401);
    }
    const blocked = await call(null, "POST", "login", { token: ADMIN_TOKEN });
    expect(blocked.status).toBe(429);
    clock += 61_000;
    expect(
      (await call(null, "POST", "login", { token: ADMIN_TOKEN })).status,
    ).toBe(200);
  });

  test("sessions expire, and sign-out ends one", async () => {
    const session = await signIn();
    expect((await call(session, "GET", "session")).status).toBe(200);
    expect((await call(session, "POST", "logout")).status).toBe(200);
    expect((await call(session, "GET", "session")).status).toBe(401);
    const later = await signIn();
    clock += config.admin.sessionMs;
    expect((await call(later, "GET", "overview")).status).toBe(401);
  });
});

describe("CSRF", () => {
  test("writes need the CSRF header, JSON, and the page's own origin", async () => {
    const { user, token } = await devLogin("u@example.com");
    expect(await createWorkspace(token)).toBe(201);
    const session = await signIn();
    const path = `users/${user.id}/workspaces/${WS_A}/sleep`;
    const noHeader = await call(
      session,
      "POST",
      path,
      {},
      { "X-Daedalus-CSRF": "" },
    );
    expect(noHeader.status).toBe(403);
    const wrong = await call(
      session,
      "POST",
      path,
      {},
      {
        "X-Daedalus-CSRF": "x".repeat(43),
      },
    );
    expect(wrong.status).toBe(403);
    const form = await fetch(`${adminBase}/admin/api/${path}`, {
      method: "POST",
      headers: {
        Cookie: session.cookie,
        "X-Daedalus-CSRF": session.csrf,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "a=b",
    });
    expect(form.status).toBe(415);
    const foreign = await call(
      session,
      "POST",
      path,
      {},
      {
        Origin: "https://evil.example.net",
      },
    );
    expect(foreign.status).toBe(403);
    const crossSite = await call(
      session,
      "POST",
      path,
      {},
      {
        "Sec-Fetch-Site": "cross-site",
      },
    );
    expect(crossSite.status).toBe(403);
    expect(store.workspace(user.id, WS_A)!.sleeping).toBe(false);
    const same = await call(
      session,
      "POST",
      path,
      {},
      {
        Origin: adminBase,
        "Sec-Fetch-Site": "same-origin",
      },
    );
    expect(same.status).toBe(200);
    expect(store.workspace(user.id, WS_A)!.sleeping).toBe(true);
  });

  test("sign-in from another site is refused", async () => {
    const response = await call(
      null,
      "POST",
      "login",
      { token: ADMIN_TOKEN },
      {
        Origin: "https://evil.example.net",
      },
    );
    expect(response.status).toBe(403);
  });
});

describe("overview", () => {
  test("lists users and workspaces with what the page shows, and no key or token", async () => {
    const a = await devLogin("a@example.com");
    const b = await devLogin("b@example.com");
    await devLogin("nobody@example.com");
    expect(await createWorkspace(a.token, WS_A)).toBe(201);
    expect(await createWorkspace(b.token, WS_B)).toBe(201);
    const session = await signIn();
    await call(session, "POST", `users/${b.user.id}/workspaces/${WS_B}/sleep`);
    const runnerKey = key(7);
    // The runner pins its key, which the page must never show.
    store.pinRunnerKey(a.user.id, WS_A, runnerKey);

    // An hour on: 29 days and 23 hours are left, shown rounded up.
    clock += 3_600_000;
    const result = await call(session, "GET", "overview");
    expect(result.status).toBe(200);
    const view = result.json as unknown as AdminOverview;
    expect(view.summary.users).toBe(3);
    expect(view.summary.workspaces).toBe(2);
    expect(view.summary.byStatus.sleeping).toBe(1);
    // A is awake with no runner connected yet.
    expect(view.summary.byStatus.starting).toBe(1);
    // 20Gi + 1Gi per workspace, read from the PVCs.
    expect(view.summary.diskBytes).toBe(2 * 21 * 2 ** 30);
    expect(view.summary.cpuRequested).toBe(1);
    expect(view.summary.memoryRequestedBytes).toBe(2 * 2 ** 30);
    expect(view.opencostUrl).toBe("https://opencost.example.com");
    expect(view.settings.asleepDays).toBe(30);

    const userA = view.users.find((user) => user.email === "a@example.com")!;
    expect(userA.limit).toBe(5);
    expect(userA.limitOverride).toBeNull();
    const awake = userA.workspaces[0]!;
    expect(awake.name).toBe("My <b>workspace</b>");
    expect(awake.status).toBe("starting");
    expect(awake.createdAt).toBeString();
    expect(awake.lastActiveAt).toBe(awake.createdAt);
    expect(awake.sleptAt).toBeNull();
    expect(awake.daysUntilCollection).toBeNull();
    expect(awake.disk.map((volume) => volume.size).sort()).toEqual([
      "1Gi",
      "20Gi",
    ]);
    expect(awake.resources).toEqual({
      cpu: { request: "1", limit: "2" },
      memory: { request: "2Gi", limit: "4Gi" },
    });
    const asleep = view.users.find((user) => user.email === "b@example.com")!
      .workspaces[0]!;
    expect(asleep.status).toBe("sleeping");
    expect(asleep.sleptAt).toBeString();
    expect(asleep.daysUntilCollection).toBe(30);
    expect(asleep.resources).toBeNull();
    expect(
      view.users.find((user) => user.email === "nobody@example.com")!
        .workspaces,
    ).toEqual([]);

    // Nothing secret anywhere in the answer.
    const row = store.workspace(a.user.id, WS_A)!;
    for (const secret of [
      a.token,
      b.token,
      sha256(a.token),
      runnerKey,
      row.macKey,
      row.macId,
      ADMIN_TOKEN,
      session.cookie.split("=")[1]!,
      session.csrf,
    ])
      expect(result.text).not.toContain(secret);
    for (const name of ["runnerKey", "macKey", "macId", "token", "hash"])
      expect(result.text).not.toContain(`"${name}"`);
  });

  test("a failed pod shows its reason, and days until collection count down", async () => {
    const { user, token } = await devLogin("u@example.com");
    expect(await createWorkspace(token)).toBe(201);
    const pod = kube.pod(`u-${user.id}`, `ws-${WS_A}`)!;
    pod.status = {
      phase: "Pending",
      containerStatuses: [
        {
          state: {
            waiting: { reason: "ImagePullBackOff", message: "no such image" },
          },
        },
      ],
    };
    const session = await signIn();
    let view = await overview(session);
    expect(view.users[0]!.workspaces[0]!.status).toBe("failed");
    expect(view.users[0]!.workspaces[0]!.reason).toContain("ImagePullBackOff");

    store.setSleeping(user.id, WS_A, true, new Date(clock - 29.5 * 86_400_000));
    view = await overview(session);
    expect(view.users[0]!.workspaces[0]!.daysUntilCollection).toBe(0);
  });

  test("an unreadable cluster marks the user, and the page still answers", async () => {
    const { user, token } = await devLogin("u@example.com");
    expect(await createWorkspace(token)).toBe(201);
    const original = kube.request.bind(kube);
    kube.request = async (method, path, body) =>
      path.includes("labelSelector=daedalus.dev%2Fworkspace")
        ? { status: 500, body: { message: "etcd is down" } }
        : original(method, path, body);
    const session = await signIn();
    const view = await overview(session);
    expect(view.users[0]!.id).toBe(user.id);
    expect(view.users[0]!.error).toContain("could not be read");
    expect(view.users[0]!.workspaces[0]!.status).toBe("unknown");
  });

  test("a viewer reads everything", async () => {
    const { token } = await devLogin("u@example.com");
    expect(await createWorkspace(token)).toBe(201);
    const viewer = await signIn(VIEWER_TOKEN);
    expect(viewer.role).toBe("viewer");
    expect((await overview(viewer)).summary.workspaces).toBe(1);
    expect((await call(viewer, "GET", "audit")).status).toBe(200);
  });
});

describe("actions", () => {
  test("a viewer may not sleep, wake, delete or set a limit; each try is audited", async () => {
    const { user, token } = await devLogin("u@example.com");
    expect(await createWorkspace(token)).toBe(201);
    const viewer = await signIn(VIEWER_TOKEN);
    const path = `users/${user.id}/workspaces/${WS_A}`;
    for (const [method, route, body] of [
      ["POST", `${path}/sleep`, {}],
      ["POST", `${path}/wake`, {}],
      ["DELETE", path, { confirm: WS_A }],
      ["PUT", `users/${user.id}/limit`, { maxWorkspaces: 9 }],
    ] as const) {
      const response = await call(viewer, method, route, body);
      expect(response.status).toBe(403);
    }
    expect(store.workspace(user.id, WS_A)!.sleeping).toBe(false);
    expect(store.maxWorkspaces(user.id)).toBeNull();
    expect(
      audits().filter((entry) => entry.result === "forbidden"),
    ).toHaveLength(4);
  });

  test("sleep and wake take the user's paths: token gone, then a new one", async () => {
    const { user, token } = await devLogin("u@example.com");
    expect(await createWorkspace(token)).toBe(201);
    const session = await signIn();
    const path = `users/${user.id}/workspaces/${WS_A}`;
    const tokenPath = `/api/v1/namespaces/u-${user.id}/secrets/ws-${WS_A}-runner`;
    const first = (
      kube.objects.get(tokenPath) as { stringData: { token: string } }
    ).stringData.token;

    const slept = await call(session, "POST", `${path}/sleep`);
    expect(slept.status).toBe(200);
    expect(slept.text).not.toContain("runnerKey");
    expect(kube.pod(`u-${user.id}`, `ws-${WS_A}`)).toBeUndefined();
    expect(kube.objects.has(tokenPath)).toBe(false);
    expect(store.tokenOwner(first)).toBeNull();
    const sleptAt = store.workspace(user.id, WS_A)!.sleptAt;
    // Asleep already: refused, so the collection clock does not restart.
    clock += 1000;
    expect((await call(session, "POST", `${path}/sleep`)).status).toBe(409);
    expect(store.workspace(user.id, WS_A)!.sleptAt).toBe(sleptAt);

    const woken = await call(session, "POST", `${path}/wake`);
    expect(woken.status).toBe(200);
    expect(kube.pod(`u-${user.id}`, `ws-${WS_A}`)).toBeDefined();
    const second = (
      kube.objects.get(tokenPath) as { stringData: { token: string } }
    ).stringData.token;
    expect(second).not.toBe(first);
    expect(store.workspace(user.id, WS_A)!.sleeping).toBe(false);

    const actions = audits().filter((entry) => entry.action !== "sign-in");
    expect(actions.map((entry) => [entry.action, entry.result])).toEqual([
      ["sleep", "ok"],
      ["sleep", "failed"],
      ["wake", "ok"],
    ]);
    expect(actions[0]!.subject).toBe("bootstrap-admin");
    expect(actions[0]!.session).toMatch(/^[0-9a-f]{8}$/);
    expect(actions[0]!.target).toBe(`${user.id}/${WS_A}`);
    expect(store.auditLog(10)[0]!.action).toBe("wake");
  });

  test("delete needs the id typed back, then removes everything", async () => {
    const { user, token } = await devLogin("u@example.com");
    expect(await createWorkspace(token)).toBe(201);
    const session = await signIn();
    const path = `users/${user.id}/workspaces/${WS_A}`;
    for (const body of [{}, { confirm: "yes" }, { confirm: WS_B }]) {
      const response = await call(session, "DELETE", path, body);
      expect(response.status).toBe(400);
    }
    expect(store.workspace(user.id, WS_A)).not.toBeNull();
    const deleted = await call(session, "DELETE", path, { confirm: WS_A });
    expect(deleted.status).toBe(200);
    expect(store.workspace(user.id, WS_A)).toBeNull();
    // The user's last workspace: the namespace goes with it.
    expect(
      kube.paths().filter((path) => path.includes(`u-${user.id}`)),
    ).toEqual([]);
    const user2 = await fetch(`${base}/v1/workspaces/${WS_A}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(user2.status).toBe(404);
  });

  test("the wrong user id or a malformed id is not found", async () => {
    const a = await devLogin("a@example.com");
    const b = await devLogin("b@example.com");
    expect(await createWorkspace(a.token)).toBe(201);
    const session = await signIn();
    for (const path of [
      `users/${b.user.id}/workspaces/${WS_A}/sleep`,
      `users/${a.user.id}/workspaces/not-a-uuid/sleep`,
      `users/..%2F..%2Fx/workspaces/${WS_A}/sleep`,
    ]) {
      const response = await call(session, "POST", path);
      expect(response.status).toBe(404);
    }
    expect(store.workspace(a.user.id, WS_A)!.sleeping).toBe(false);
  });

  test("a limit override is what create enforces, and null clears it", async () => {
    const { user, token } = await devLogin("u@example.com");
    const session = await signIn();
    const set = await call(session, "PUT", `users/${user.id}/limit`, {
      maxWorkspaces: 1,
    });
    expect(set.status).toBe(200);
    expect(set.json).toEqual({ limit: 1, limitOverride: 1 });
    expect(await createWorkspace(token, WS_A)).toBe(201);
    expect(await createWorkspace(token, WS_B)).toBe(429);
    const view = await overview(session);
    expect(view.users[0]!.limit).toBe(1);
    expect(view.users[0]!.limitOverride).toBe(1);

    for (const maxWorkspaces of [-1, 1.5, 101, "3"]) {
      const bad = await call(session, "PUT", `users/${user.id}/limit`, {
        maxWorkspaces,
      });
      expect(bad.status).toBe(400);
    }
    expect(
      (
        await call(session, "PUT", `users/nosuchuser/limit`, {
          maxWorkspaces: 2,
        })
      ).status,
    ).toBe(404);
    const cleared = await call(session, "PUT", `users/${user.id}/limit`, {
      maxWorkspaces: null,
    });
    expect(cleared.json).toEqual({ limit: 5, limitOverride: null });
    expect(await createWorkspace(token, WS_B)).toBe(201);
    const changes = audits().filter((entry) => entry.action === "set-limit");
    expect(changes[0]!.detail).toBe("default -> 1");
    expect(changes.at(-1)!.detail).toBe("1 -> default");
  });

  test("the audit keeps the newest 1000 entries", () => {
    for (let i = 0; i < 1005; i++)
      store.audit({
        at: new Date(clock + i).toISOString(),
        subject: "s",
        session: "",
        address: "",
        action: `a${i}`,
        target: "",
        result: "ok",
        detail: "",
      });
    const log = store.auditLog(2000);
    expect(log).toHaveLength(1000);
    expect(log[0]!.action).toBe("a1004");
    expect(log.at(-1)!.action).toBe("a5");
  });
});

describe("last active", () => {
  test("relay traffic updates it, at most once a minute", async () => {
    const { user, token } = await devLogin("u@example.com");
    expect(await createWorkspace(token)).toBe(201);
    const secret = kube.objects.get(
      `/api/v1/namespaces/u-${user.id}/secrets/ws-${WS_A}-runner`,
    ) as { stringData: { token: string } };
    const open = (url: string, bearer: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(url, {
          headers: { Authorization: `Bearer ${bearer}` },
        } as unknown as string[]);
        sockets.push(socket);
        socket.binaryType = "arraybuffer";
        socket.onopen = () => resolve(socket);
        socket.onerror = reject;
      });
    const runner = await open(
      `${runnerBase.replace("http", "ws")}/v1/connect?runnerKey=${key(9)}`,
      secret.stringData.token,
    );
    const received: unknown[] = [];
    runner.onmessage = (event) => received.push(event.data);
    const mac = await open(
      `${base.replace("http", "ws")}/v1/connect?macId=${MAC}`,
      token,
    );
    const before = store.workspace(user.id, WS_A)!.lastActiveAt;
    // Wait so the written time is later than the create time.
    await Bun.sleep(5);
    mac.send(encodeRelayFrame(`ws:${WS_A}`, new Uint8Array([1, 2, 3])));
    for (
      let i = 0;
      i < 50 && !received.some((m) => m instanceof ArrayBuffer);
      i++
    )
      await Bun.sleep(10);
    const after = store.workspace(user.id, WS_A)!.lastActiveAt;
    expect(after).not.toBe(before);
    expect(Date.parse(after!)).toBeGreaterThan(Date.parse(before!));
    // A second frame within the minute writes nothing.
    mac.send(encodeRelayFrame(`ws:${WS_A}`, new Uint8Array([4])));
    await Bun.sleep(50);
    expect(store.workspace(user.id, WS_A)!.lastActiveAt).toBe(after);
    expect(ACTIVITY_WRITE_MS).toBe(60_000);
  });
});

test("a database from before the admin page gets its columns", () => {
  const path = join(dir, "old.sqlite");
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const old = new Database(path, { create: true });
  old.run(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE workspaces (user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
      mac_id TEXT NOT NULL, mac_key TEXT NOT NULL, cpu TEXT, memory TEXT, runner_key TEXT,
      sleeping INTEGER NOT NULL DEFAULT 0, slept_at TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, workspace_id));
    INSERT INTO users VALUES ('abc', 'old@example.com', '2026-01-01T00:00:00Z');
    INSERT INTO workspaces (user_id, workspace_id, name, mac_id, mac_key, created_at)
      VALUES ('abc', '${WS_A}', 'old', 'm', 'k', '2026-01-01T00:00:00Z');`);
  old.close();
  const upgraded = new Store(path);
  expect(upgraded.allUsers()[0]!.maxWorkspaces).toBeNull();
  expect(upgraded.workspace("abc", WS_A)!.lastActiveAt).toBeNull();
  expect(upgraded.setMaxWorkspaces("abc", 2)).toBe(true);
  expect(upgraded.maxWorkspaces("abc")).toBe(2);
  upgraded.close();
});

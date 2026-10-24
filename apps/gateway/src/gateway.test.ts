import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeRelayFrame,
  encodeRelayFrame,
  RUNNER_ENV,
  RUNNER_PATHS,
  type CloudWorkspace,
} from "@daedalus/remote-protocol";
import { loadConfig, type GatewayConfig } from "./config";
import { Controller } from "./controller";
import { FakeKube } from "./fake-kube";
import { Relay } from "./relay";
import { createGateway } from "./server";
import { sha256, Store } from "./store";

const TENANT = [
  { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "runner" } },
  {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "tenant" },
    spec: { podSelector: {}, policyTypes: ["Ingress"] },
  },
  {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: { name: "tenant" },
    spec: { hard: { pods: "10" } },
  },
];

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64url");
const WS_A = "0f8e2c1a-7b3d-4e5f-9a6b-1c2d3e4f5a6b";
const WS_B = "11111111-2222-4333-8444-555555555555";
const MAC_A = "macAAAAAAAAAAAAAAAAAAA";
const MAC_B = "macBBBBBBBBBBBBBBBBBBB";

let dir: string;
let kube: FakeKube;
let store: Store;
let config: GatewayConfig;
let server: ReturnType<typeof Bun.serve>;
let runnerServer: ReturnType<typeof Bun.serve>;
let base: string;
/** The runner listener, which only the in-cluster Service exposes. */
let runnerBase: string;
let logs: string[];
let collect: ReturnType<typeof createGateway>["collect"];
/** The controller's backoff waits, which pass at once here. */
let waits: number[];
const sockets: WebSocket[] = [];

function start(overrides: Record<string, string> = {}) {
  config = loadConfig({
    DAEDALUS_GATEWAY_DEV_LOGIN: "true",
    DAEDALUS_GATEWAY_INTERNAL_URL: "http://daedalus-gateway.daedalus:8080",
    DAEDALUS_GATEWAY_NAMESPACE: "daedalus",
    DAEDALUS_RUNNER_IMAGE: "daedalus-runner:dev",
    DAEDALUS_WORKSPACE_STORAGE_CLASS: "standard",
    ...overrides,
  });
  config.dbPath = join(dir, "gateway.sqlite");
  store = new Store(config.dbPath);
  const gateway = createGateway({
    config,
    store,
    controller: new Controller(kube, config, TENANT, async (ms) => {
      waits.push(ms);
    }),
    relay: new Relay(),
    log: (message) => logs.push(message),
  });
  collect = gateway.collect;
  server = Bun.serve({ ...gateway.public, port: 0 });
  runnerServer = Bun.serve({ ...gateway.runner, port: 0 });
  base = `http://localhost:${server.port}`;
  runnerBase = `http://localhost:${runnerServer.port}`;
}

async function stop() {
  await server.stop(true);
  await runnerServer.stop(true);
  store.close();
}

/** Runner tokens go to the runner listener, everything else to the public. */
const listenerFor = (token: string | undefined) =>
  token && store.tokenOwner(token)?.kind === "runner" ? runnerBase : base;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gateway-test-"));
  kube = new FakeKube();
  logs = [];
  waits = [];
  start();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

async function api(
  token: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  at = listenerFor(token),
): Promise<{ status: number; json: ApiBody }> {
  const response = await fetch(`${at}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: (text ? JSON.parse(text) : {}) as ApiBody,
  };
}

/** Any of the gateway's response bodies, read loosely by the assertions. */
type ApiBody = Partial<CloudWorkspace> & {
  error?: { code: string; message: string };
  workspaces?: CloudWorkspace[];
  id?: string;
  email?: string;
};

/** The parts of a pod the assertions read. */
interface TestPod {
  metadata: {
    labels: Record<string, string>;
    annotations: Record<string, string>;
    ownerReferences?: Record<string, unknown>[];
  };
  spec: {
    runtimeClassName?: string;
    serviceAccountName: string;
    automountServiceAccountToken: boolean;
    shareProcessNamespace: boolean;
    securityContext: Record<string, unknown>;
    volumes: {
      name: string;
      persistentVolumeClaim?: { claimName: string };
      secret?: { secretName: string; defaultMode?: number; items?: unknown[] };
      emptyDir?: unknown;
    }[];
    containers: {
      name: string;
      image: string;
      command: string[];
      securityContext: Record<string, unknown>;
      resources: unknown;
      env: { name: string; value?: string; valueFrom?: unknown }[];
      volumeMounts: { name: string; mountPath: string; readOnly?: boolean }[];
    }[];
  };
}

const testPod = (userId: string, workspaceId: string) =>
  kube.pod(`u-${userId}`, `ws-${workspaceId}`) as unknown as TestPod;

async function login(email: string) {
  const response = await fetch(`${base}/v1/dev/login`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  return (await response.json()) as {
    user: { id: string; email: string };
    token: string;
  };
}

const createBody = (workspaceId = WS_A, macId = MAC_A) => ({
  workspaceId,
  name: "My workspace",
  macId,
  macKey: key(1),
});

/** The runner token the controller put in the workspace's Secret. */
function runnerToken(userId: string, workspaceId: string): string {
  const secret = kube.objects.get(
    `/api/v1/namespaces/u-${userId}/secrets/ws-${workspaceId}-runner`,
  ) as { stringData: { token: string } };
  return secret.stringData.token;
}

/** A WebSocket with its messages queued, so a test can await the next. */
async function connect(token: string, query: string, at = listenerFor(token)) {
  const queue: (string | Uint8Array)[] = [];
  const waiters: ((value: string | Uint8Array) => void)[] = [];
  const socket = new WebSocket(
    `${at.replace("http", "ws")}/v1/connect?${query}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    } as unknown as string[],
  );
  socket.binaryType = "arraybuffer";
  sockets.push(socket);
  let closed: { code: number } | null = null;
  socket.addEventListener("message", (event) => {
    const data =
      typeof event.data === "string"
        ? event.data
        : new Uint8Array(event.data as ArrayBuffer);
    const waiter = waiters.shift();
    if (waiter) waiter(data);
    else queue.push(data);
  });
  socket.addEventListener("close", (event) => {
    closed = { code: event.code };
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () =>
      reject(new Error("WebSocket failed")),
    );
  });
  return {
    socket,
    closed: () => closed,
    next(timeoutMs = 1000): Promise<string | Uint8Array> {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("No message")),
          timeoutMs,
        );
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
    /** Resolves true when nothing arrives within the time. */
    async silent(ms = 150): Promise<boolean> {
      if (queue.length) return false;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          resolve(true);
        }, ms);
        const waiter = (value: string | Uint8Array) => {
          clearTimeout(timer);
          queue.unshift(value);
          resolve(false);
        };
        waiters.push(waiter);
      });
    },
  };
}

const bytes = (text: string) => new TextEncoder().encode(text);
const peer = (deviceId: string, online: boolean) =>
  JSON.stringify({ relay: "peer", deviceId, online });

describe("dev login and tokens", () => {
  test("is off unless configured", async () => {
    await stop();
    start({ DAEDALUS_GATEWAY_DEV_LOGIN: "false" });
    const { status, json } = await api(undefined, "POST", "/v1/dev/login", {
      email: "a@example.com",
    });
    expect(status).toBe(404);
    expect(json.error?.code).toBe("NOT_FOUND");
  });

  test("signs in, keeps the same user per email, and stores only hashes", async () => {
    const first = await login("Ada@Example.com");
    const second = await login("ada@example.com");
    expect(first.user.id).toMatch(/^[a-z0-9]{1,20}$/);
    expect(second.user.id).toBe(first.user.id);
    expect(second.token).not.toBe(first.token);
    expect((await api(first.token, "GET", "/v1/me")).json).toEqual({
      id: first.user.id,
      email: "ada@example.com",
    });
    const raw = await Bun.file(config.dbPath).arrayBuffer();
    const text = Buffer.from(raw).toString("latin1");
    expect(text.includes(first.token)).toBe(false);
    expect(store.tokenOwner(first.token)).toEqual({
      kind: "user",
      userId: first.user.id,
    });
    expect(sha256(first.token)).toHaveLength(64);
  });

  test("refuses missing and unknown tokens", async () => {
    expect((await api(undefined, "GET", "/v1/me")).status).toBe(401);
    const { status, json } = await api("nope", "GET", "/v1/workspaces");
    expect(status).toBe(401);
    expect(json.error?.code).toBe("UNAUTHORIZED");
  });

  test("validates the email", async () => {
    const { status, json } = await api(undefined, "POST", "/v1/dev/login", {
      email: "not an email",
    });
    expect(status).toBe(400);
    expect(json.error?.code).toBe("VALIDATION");
  });

  test("health needs no token", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});

describe("controller", () => {
  test("creates the namespace, its RoleBinding first, then the rest", async () => {
    const { user, token } = await login("a@example.com");
    const { status, json } = await api(token, "POST", "/v1/workspaces", {
      ...createBody(WS_A.toUpperCase()),
    });
    expect(status).toBe(201);
    expect(json).toMatchObject({
      workspaceId: WS_A,
      name: "My workspace",
      status: "starting",
      reason: null,
      runnerOnline: false,
      runnerKey: null,
    } satisfies Partial<CloudWorkspace>);

    const ns = `u-${user.id}`;
    expect(kube.calls).toEqual([
      "POST /api/v1/namespaces",
      `POST /apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings`,
      `POST /api/v1/namespaces/${ns}/serviceaccounts`,
      `POST /apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies`,
      `POST /api/v1/namespaces/${ns}/resourcequotas`,
      `POST /api/v1/namespaces/${ns}/persistentvolumeclaims`,
      `POST /api/v1/namespaces/${ns}/persistentvolumeclaims`,
      `DELETE /api/v1/namespaces/${ns}/secrets/ws-${WS_A}-runner`,
      `POST /api/v1/namespaces/${ns}/secrets`,
      `GET /api/v1/namespaces/${ns}/persistentvolumeclaims/ws-${WS_A}`,
      `POST /api/v1/namespaces/${ns}/pods`,
      `GET /api/v1/namespaces/${ns}/pods/ws-${WS_A}`,
    ]);
    // H-2: Pod Security "restricted" is enforced in every tenant namespace.
    expect(kube.objects.get(`/api/v1/namespaces/${ns}`)).toMatchObject({
      metadata: {
        labels: {
          "daedalus.dev/user": user.id,
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/enforce-version": "v1.30",
        },
      },
    });
    expect(
      kube.objects.get(
        `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/daedalus-gateway`,
      ),
    ).toMatchObject({
      roleRef: { kind: "ClusterRole", name: "daedalus-tenant-admin" },
      subjects: [
        {
          kind: "ServiceAccount",
          name: "daedalus-gateway",
          namespace: "daedalus",
        },
      ],
    });
    expect(
      kube.objects.get(`/api/v1/namespaces/${ns}/serviceaccounts/runner`),
    ).toMatchObject({ metadata: { namespace: ns } });
    expect(
      kube.objects.get(
        `/api/v1/namespaces/${ns}/persistentvolumeclaims/ws-${WS_A}`,
      ),
    ).toMatchObject({
      spec: {
        storageClassName: "standard",
        resources: { requests: { storage: "20Gi" } },
      },
    });
    expect(
      kube.objects.get(
        `/api/v1/namespaces/${ns}/persistentvolumeclaims/ws-${WS_A}-state`,
      ),
    ).toMatchObject({
      spec: {
        storageClassName: "standard",
        resources: { requests: { storage: "1Gi" } },
      },
    });
    // The Secret holds the token; the database only its hash.
    const token2 = runnerToken(user.id, WS_A);
    expect(store.tokenOwner(token2)).toEqual({
      kind: "runner",
      userId: user.id,
      workspaceId: WS_A,
    });
  });

  test("builds the pod artifacts/cloud-sessions/h1-pod-spec.md describes", async () => {
    await stop();
    start({ DAEDALUS_WORKSPACE_RUNTIME_CLASS: "gvisor" });
    const { user, token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", {
      ...createBody(),
      resources: { cpu: "3", memory: "6Gi" },
    });
    const pod = testPod(user.id, WS_A);
    expect(pod.metadata.labels).toEqual({
      "daedalus.dev/user": user.id,
      "daedalus.dev/workspace": WS_A,
    });
    expect(pod.spec.runtimeClassName).toBe("gvisor");
    // The runner reaches the session's socket through "shared" in gVisor.
    expect(pod.metadata.annotations).toEqual({
      "kubectl.kubernetes.io/default-container": "session",
      "dev.gvisor.spec.mount.shared.share": "pod",
      "dev.gvisor.spec.mount.shared.type": "tmpfs",
      "dev.gvisor.spec.mount.shared.options": "rw,rprivate",
    });
    expect(pod.spec.serviceAccountName).toBe("runner");
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.shareProcessNamespace).toBe(false);
    expect(pod.spec.securityContext).toEqual({
      runAsNonRoot: true,
      fsGroup: 2000,
      fsGroupChangePolicy: "OnRootMismatch",
      seccompProfile: { type: "RuntimeDefault" },
    });
    const [runner, session] = pod.spec.containers;
    expect(pod.spec.containers.map((c) => c.name)).toEqual([
      "runner",
      "session",
    ]);
    for (const [container, uid, script] of [
      [runner!, 1000, "runner.js"],
      [session!, 1001, "sessiond.js"],
    ] as const) {
      expect(container.image).toBe("daedalus-runner:dev");
      expect(container.command).toEqual(["bun", `/opt/daedalus/${script}`]);
      expect(container.securityContext).toEqual({
        runAsNonRoot: true,
        runAsUser: uid,
        runAsGroup: uid,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
        seccompProfile: { type: "RuntimeDefault" },
      });
    }
    // The user's size is the session's; the runner's is fixed and small.
    expect(session!.resources).toEqual({
      requests: { cpu: "3", memory: "6Gi", "ephemeral-storage": "1Gi" },
      limits: { cpu: "3", memory: "6Gi", "ephemeral-storage": "4Gi" },
    });
    expect(runner!.resources).toEqual({
      requests: { cpu: "50m", memory: "64Mi", "ephemeral-storage": "64Mi" },
      limits: { cpu: "500m", memory: "256Mi", "ephemeral-storage": "256Mi" },
    });
    // Nothing secret in either environment: the token is a file.
    expect(runner!.env).toEqual([
      {
        name: RUNNER_ENV.gatewayUrl,
        value: "http://daedalus-gateway.daedalus:8080",
      },
      { name: RUNNER_ENV.workspaceId, value: WS_A },
      { name: RUNNER_ENV.macId, value: MAC_A },
      { name: RUNNER_ENV.macKey, value: key(1) },
      { name: RUNNER_ENV.idleMinutes, value: "15" },
    ]);
    expect(session!.env).toEqual([]);
    expect(pod.spec.volumes).toEqual([
      { name: "workspace", persistentVolumeClaim: { claimName: `ws-${WS_A}` } },
      {
        name: "state",
        persistentVolumeClaim: { claimName: `ws-${WS_A}-state` },
      },
      {
        name: "token",
        secret: {
          secretName: `ws-${WS_A}-runner`,
          defaultMode: 0o440,
          items: [{ key: "token", path: "token" }],
        },
      },
      { name: "shared", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } },
      { name: "cache", emptyDir: { sizeLimit: "2Gi" } },
      { name: "runner-tmp", emptyDir: { sizeLimit: "64Mi" } },
      { name: "session-tmp", emptyDir: { sizeLimit: "1Gi" } },
    ]);
  });

  // H-1 in artifacts/cloud-sessions/security-review.md: agent code took the
  // runner token and identity key because they shared a container and uid.
  // This is the mount table of h1-pod-spec.md, per container.
  test("only the runner container mounts the token and state; only the session mounts the workspace", async () => {
    const { user, token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody());
    const pod = testPod(user.id, WS_A);
    const volumes = new Map(
      pod.spec.volumes.map((volume) => [volume.name, volume]),
    );
    /** Each container's mounts as path -> what backs it. */
    const mounts = (name: string) =>
      Object.fromEntries(
        pod.spec.containers
          .find((container) => container.name === name)!
          .volumeMounts.map((mount) => {
            const volume = volumes.get(mount.name)!;
            const source =
              volume.persistentVolumeClaim?.claimName ??
              (volume.secret
                ? `secret ${volume.secret.secretName}`
                : undefined) ??
              `emptyDir ${mount.name}`;
            return [
              mount.mountPath,
              mount.readOnly ? `${source} (read-only)` : source,
            ];
          }),
      );
    expect(mounts("runner")).toEqual({
      [RUNNER_PATHS.state]: `ws-${WS_A}-state`,
      "/run/daedalus-token": `secret ws-${WS_A}-runner (read-only)`,
      [RUNNER_PATHS.runtime]: "emptyDir shared",
      "/tmp": "emptyDir runner-tmp",
    });
    expect(mounts("session")).toEqual({
      [RUNNER_PATHS.workspace]: `ws-${WS_A}`,
      [RUNNER_PATHS.cache]: "emptyDir cache",
      [RUNNER_PATHS.runtime]: "emptyDir shared",
      "/tmp": "emptyDir session-tmp",
    });
    expect(RUNNER_PATHS.token).toBe("/run/daedalus-token/token");
    expect(RUNNER_PATHS.shimSocket.startsWith(`${RUNNER_PATHS.runtime}/`)).toBe(
      true,
    );
    expect(
      RUNNER_PATHS.sessionSocket.startsWith(`${RUNNER_PATHS.runtime}/`),
    ).toBe(true);
  });

  test("uses the chart's default resources", async () => {
    const { user, token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody());
    const pod = testPod(user.id, WS_A);
    expect(pod.spec.runtimeClassName).toBeUndefined();
    expect(Object.keys(pod.metadata.annotations)).toEqual([
      "kubectl.kubernetes.io/default-container",
    ]);
    expect(pod.spec.containers[1]!.resources).toEqual({
      requests: { cpu: "1", memory: "2Gi", "ephemeral-storage": "1Gi" },
      limits: { cpu: "2", memory: "4Gi", "ephemeral-storage": "4Gi" },
    });
  });

  test("validates the request", async () => {
    const { token } = await login("a@example.com");
    for (const body of [
      { ...createBody(), workspaceId: "not-a-uuid" },
      { ...createBody(), macId: "x" },
      { ...createBody(), macKey: "short" },
      { ...createBody(), name: "" },
      { ...createBody(), resources: { cpu: "lots" } },
      { ...createBody(), resources: { cpu: "0" } },
      { ...createBody(), resources: { memory: "0Gi" } },
      { ...createBody(), resources: { cpu: "5" } },
      { ...createBody(), resources: { memory: "9Gi" } },
    ]) {
      const { status, json } = await api(token, "POST", "/v1/workspaces", body);
      expect(status).toBe(400);
      expect(json.error?.code).toBe("VALIDATION");
    }
    expect(kube.calls).toEqual([]);
  });

  test("refuses a second workspace with the same id", async () => {
    const { token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody());
    const { status, json } = await api(
      token,
      "POST",
      "/v1/workspaces",
      createBody(),
    );
    expect(status).toBe(409);
    expect(json.error?.code).toBe("CONFLICT");
  });

  test("waits for a new RoleBinding to take effect before giving up", async () => {
    const { user, token } = await login("a@example.com");
    kube.bindingLag = 3;
    const created = await api(token, "POST", "/v1/workspaces", createBody());
    expect(created.status).toBe(201);
    expect(waits).toEqual([500, 1000, 1500]);
    const ns = `u-${user.id}`;
    expect(
      kube.calls.filter(
        (call) => call === `POST /api/v1/namespaces/${ns}/serviceaccounts`,
      ),
    ).toHaveLength(4);
  });

  test("a binding that never takes effect fails after five tries", async () => {
    const { token } = await login("a@example.com");
    kube.bindingLag = 100;
    const { status, json } = await api(
      token,
      "POST",
      "/v1/workspaces",
      createBody(),
    );
    expect(status).toBe(500);
    expect(json.error?.message).toBe("The cluster refused the request");
    expect(logs.join("\n")).toContain(
      "ServiceAccount: serviceaccounts is forbidden",
    );
    expect(waits).toEqual([500, 1000, 1500, 2000]);
    expect(
      kube.calls.filter((call) => call.endsWith("/serviceaccounts")),
    ).toHaveLength(5);
  });

  test("turns a quota refusal into QUOTA and leaves nothing behind", async () => {
    const { user, token } = await login("a@example.com");
    kube.podQuota = 0;
    const { status, json } = await api(
      token,
      "POST",
      "/v1/workspaces",
      createBody(),
    );
    expect(status).toBe(429);
    expect(json.error?.code).toBe("QUOTA");
    expect(json.error?.message).toContain("exceeded quota");
    expect((await api(token, "GET", "/v1/workspaces")).json.workspaces).toEqual(
      [],
    );
    const ns = `u-${user.id}`;
    expect(kube.paths().filter((path) => path.includes(`ws-${WS_A}`))).toEqual(
      [],
    );
    expect(store.workspace(user.id, WS_A)).toBeNull();
    expect(kube.objects.has(`/api/v1/namespaces/${ns}`)).toBe(true);
  });

  test("sleep keeps both volumes and ends the token; wake brings the pod back with a new one", async () => {
    const { user, token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody());
    const ns = `u-${user.id}`;
    const first = runnerToken(user.id, WS_A);

    const slept = await api(token, "POST", `/v1/workspaces/${WS_A}/sleep`);
    expect(slept.status).toBe(200);
    expect(slept.json.status).toBe("sleeping");
    expect(kube.pod(ns, `ws-${WS_A}`)).toBeUndefined();
    for (const name of [`ws-${WS_A}`, `ws-${WS_A}-state`])
      expect(
        kube.objects.has(
          `/api/v1/namespaces/${ns}/persistentvolumeclaims/${name}`,
        ),
      ).toBe(true);
    // H-1 fix 3: no runner token exists while the workspace sleeps.
    expect(
      kube.objects.has(`/api/v1/namespaces/${ns}/secrets/ws-${WS_A}-runner`),
    ).toBe(false);
    expect(store.tokenOwner(first)).toBeNull();
    expect(
      (
        await api(
          first,
          "GET",
          `/v1/connect?runnerKey=${key(7)}`,
          undefined,
          runnerBase,
        )
      ).status,
    ).toBe(401);
    expect(
      (await api(token, "GET", `/v1/workspaces/${WS_A}`)).json.status,
    ).toBe("sleeping");

    const woke = await api(token, "POST", `/v1/workspaces/${WS_A}/wake`);
    expect(woke.status).toBe(200);
    expect(woke.json.status).toBe("starting");
    expect(kube.pod(ns, `ws-${WS_A}`)).toBeDefined();
    const second = runnerToken(user.id, WS_A);
    expect(second).not.toBe(first);
    expect(store.tokenOwner(second)).toEqual({
      kind: "runner",
      userId: user.id,
      workspaceId: WS_A,
    });
  });

  test("the pod is owned by its workspace volume, through sleep and wake, and goes with it", async () => {
    const { user, token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody());
    const ns = `u-${user.id}`;
    const volume = `/api/v1/namespaces/${ns}/persistentvolumeclaims/ws-${WS_A}`;
    const uid = (kube.objects.get(volume)!.metadata as { uid: string }).uid;
    const owners = [
      {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        name: `ws-${WS_A}`,
        uid,
      },
    ];
    // Not a controller and not blockOwnerDeletion: no rights on the PVC.
    expect(testPod(user.id, WS_A).metadata.ownerReferences).toEqual(owners);

    // The token Secret is replaced on wake; the pod must not go with it.
    await api(token, "POST", `/v1/workspaces/${WS_A}/sleep`);
    await api(token, "POST", `/v1/workspaces/${WS_A}/wake`);
    expect(testPod(user.id, WS_A).metadata.ownerReferences).toEqual(owners);
    await api(token, "POST", `/v1/workspaces/${WS_A}/wake`);
    expect(testPod(user.id, WS_A)).toBeDefined();

    await kube.request("DELETE", volume);
    expect(kube.pod(ns, `ws-${WS_A}`)).toBeUndefined();
  });

  test("a wake with the workspace volume gone fails and starts no pod", async () => {
    const { user, token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody());
    const ns = `u-${user.id}`;
    await api(token, "POST", `/v1/workspaces/${WS_A}/sleep`);
    await kube.request(
      "DELETE",
      `/api/v1/namespaces/${ns}/persistentvolumeclaims/ws-${WS_A}`,
    );
    const woke = await api(token, "POST", `/v1/workspaces/${WS_A}/wake`);
    expect(woke.status).toBe(500);
    expect(kube.pod(ns, `ws-${WS_A}`)).toBeUndefined();
  });

  test("replacing a failed pod also replaces the token and drops the old runner", async () => {
    const { user, token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody());
    const first = runnerToken(user.id, WS_A);
    const runner = await connect(first, `runnerKey=${key(7)}`);
    kube.pod(`u-${user.id}`, `ws-${WS_A}`)!.status = { phase: "Failed" };
    expect(
      (await api(token, "POST", `/v1/workspaces/${WS_A}/wake`)).status,
    ).toBe(200);
    await Bun.sleep(50);
    expect(runner.closed()?.code).toBe(4403);
    expect(store.tokenOwner(first)).toBeNull();
    expect(runnerToken(user.id, WS_A)).not.toBe(first);
  });

  test("a user may have at most the configured number of workspaces", async () => {
    await stop();
    start({ DAEDALUS_GATEWAY_MAX_WORKSPACES: "1" });
    const { token } = await login("a@example.com");
    expect(
      (await api(token, "POST", "/v1/workspaces", createBody(WS_A))).status,
    ).toBe(201);
    const second = await api(token, "POST", "/v1/workspaces", createBody(WS_B));
    expect(second.status).toBe(429);
    expect(second.json.error?.code).toBe("QUOTA");
  });

  test("wake while the old pod is still stopping is CONFLICT, then works", async () => {
    const { token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody());
    kube.slowPodDeletes = true;
    await api(token, "POST", `/v1/workspaces/${WS_A}/sleep`);
    const early = await api(token, "POST", `/v1/workspaces/${WS_A}/wake`);
    expect(early.status).toBe(409);
    expect(
      (await api(token, "GET", `/v1/workspaces/${WS_A}`)).json.status,
    ).toBe("sleeping");
    kube.finishDeletes();
    expect(
      (await api(token, "POST", `/v1/workspaces/${WS_A}/wake`)).status,
    ).toBe(200);
  });

  test("a pod that cannot pull its image is failed with the reason", async () => {
    const { user, token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody());
    const pod = kube.pod(`u-${user.id}`, `ws-${WS_A}`)!;
    pod.status = {
      phase: "Pending",
      containerStatuses: [
        {
          state: {
            waiting: { reason: "ImagePullBackOff", message: "image not found" },
          },
        },
      ],
    };
    const { json } = await api(token, "GET", `/v1/workspaces/${WS_A}`);
    expect(json.status).toBe("failed");
    expect(json.reason).toBe("ImagePullBackOff: image not found");
    // Wake replaces it.
    expect(
      (await api(token, "POST", `/v1/workspaces/${WS_A}/wake`)).json.status,
    ).toBe("starting");
  });

  test("delete removes pod, volume and token, and the namespace with the last one", async () => {
    const { user, token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody(WS_A));
    await api(token, "POST", "/v1/workspaces", createBody(WS_B));
    const runner = runnerToken(user.id, WS_A);
    const ns = `u-${user.id}`;

    expect((await api(token, "DELETE", `/v1/workspaces/${WS_A}`)).status).toBe(
      204,
    );
    expect(kube.paths().filter((path) => path.includes(WS_A))).toEqual([]);
    expect(kube.objects.has(`/api/v1/namespaces/${ns}`)).toBe(true);
    expect(store.tokenOwner(runner)).toBeNull();
    expect((await api(token, "GET", `/v1/workspaces/${WS_A}`)).status).toBe(
      404,
    );

    expect((await api(token, "DELETE", `/v1/workspaces/${WS_B}`)).status).toBe(
      204,
    );
    expect(kube.objects.has(`/api/v1/namespaces/${ns}`)).toBe(false);
  });

  test("creating in a namespace still being deleted is CONFLICT", async () => {
    const { user, token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody(WS_A));
    kube.terminate(`u-${user.id}`);
    const { status } = await api(
      token,
      "POST",
      "/v1/workspaces",
      createBody(WS_B),
    );
    expect(status).toBe(409);
  });
});

describe("runner tokens", () => {
  async function setup() {
    const { user, token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody(WS_A));
    await api(token, "POST", "/v1/workspaces", createBody(WS_B));
    return { user, token, runner: runnerToken(user.id, WS_A) };
  }

  test("pin the first key and refuse a different one", async () => {
    const { token, runner } = await setup();
    const first = await connect(runner, `runnerKey=${key(7)}`);
    first.socket.close();
    const { json } = await api(token, "GET", `/v1/workspaces/${WS_A}`);
    expect(json.runnerKey).toBe(key(7));

    const other = await api(runner, "GET", `/v1/connect?runnerKey=${key(8)}`);
    expect(other.status).toBe(409);
    expect(other.json.error?.code).toBe("CONFLICT");
    const missing = await api(runner, "GET", "/v1/connect");
    expect(missing.status).toBe(400);
    // The same key again is fine.
    const again = await connect(runner, `runnerKey=${key(7)}`);
    expect(again.socket.readyState).toBe(WebSocket.OPEN);
  });

  test("may sleep only their own workspace, and use no other route", async () => {
    const { runner } = await setup();
    expect(
      (await api(runner, "POST", `/v1/workspaces/${WS_B}/sleep`)).status,
    ).toBe(404);
    for (const [method, path] of [
      ["GET", "/v1/me"],
      ["GET", "/v1/workspaces"],
      ["GET", `/v1/workspaces/${WS_A}`],
      ["POST", `/v1/workspaces/${WS_A}/wake`],
      ["DELETE", `/v1/workspaces/${WS_A}`],
      ["POST", "/v1/workspaces"],
    ] as const)
      expect(
        (
          await api(
            runner,
            method,
            path,
            method === "POST" ? createBody() : undefined,
          )
        ).status,
      ).toBe(401);
    const slept = await api(runner, "POST", `/v1/workspaces/${WS_A}/sleep`);
    expect(slept.status).toBe(200);
    expect(slept.json.status).toBe("sleeping");
  });

  test("a user token cannot join as a runner or without a Mac id", async () => {
    const { token } = await setup();
    expect(
      (await api(token, "GET", `/v1/connect?runnerKey=${key(7)}`)).status,
    ).toBe(400);
  });
});

describe("listeners", () => {
  // H-1 fix 2: a runner token taken out of a pod is useless from outside the
  // cluster, because only the in-cluster runner listener accepts it.
  test("runner tokens work only on the runner listener", async () => {
    const { user, token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody());
    const runner = runnerToken(user.id, WS_A);
    for (const [method, path] of [
      ["GET", `/v1/connect?runnerKey=${key(7)}`],
      ["POST", `/v1/workspaces/${WS_A}/sleep`],
    ] as const) {
      const outside = await api(runner, method, path, undefined, base);
      expect(outside.status).toBe(401);
    }
    expect(store.workspace(user.id, WS_A)?.runnerKey).toBeNull();
    const inside = await connect(runner, `runnerKey=${key(7)}`, runnerBase);
    expect(inside.socket.readyState).toBe(WebSocket.OPEN);
  });

  test("user tokens and dev login do not work on the runner listener", async () => {
    const { token } = await login("a@example.com");
    for (const [method, path] of [
      ["GET", "/v1/me"],
      ["GET", "/v1/workspaces"],
      ["GET", `/v1/connect?macId=${MAC_A}`],
    ] as const)
      expect(
        (await api(token, method, path, undefined, runnerBase)).status,
      ).toBe(401);
    const login2 = await api(
      undefined,
      "POST",
      "/v1/dev/login",
      { email: "b@example.com" },
      runnerBase,
    );
    expect(login2.status).toBe(401);
    expect((await fetch(`${runnerBase}/health`)).status).toBe(200);
  });
});

describe("relay", () => {
  test("carries frames between a Mac and its runner with rewritten ids", async () => {
    const { user, token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody());
    const mac = await connect(token, `macId=${MAC_A}`);
    const runner = await connect(
      runnerToken(user.id, WS_A),
      `runnerKey=${key(7)}`,
    );

    // Each learns the other is online.
    expect(await mac.next()).toBe(peer(`ws:${WS_A}`, true));
    expect(await runner.next()).toBe(peer(`mac:${MAC_A}`, true));

    runner.socket.send(encodeRelayFrame("", bytes("hello mac")));
    const atMac = decodeRelayFrame((await mac.next()) as Uint8Array);
    expect(atMac.deviceId).toBe(`ws:${WS_A}`);
    expect(new TextDecoder().decode(atMac.payload)).toBe("hello mac");

    mac.socket.send(encodeRelayFrame(`ws:${WS_A}`, bytes("hello runner")));
    const atRunner = decodeRelayFrame((await runner.next()) as Uint8Array);
    expect(atRunner.deviceId).toBe(`mac:${MAC_A}`);
    expect(new TextDecoder().decode(atRunner.payload)).toBe("hello runner");

    // A runner connected means a running workspace.
    const { json } = await api(token, "GET", `/v1/workspaces/${WS_A}`);
    expect(json).toMatchObject({ status: "running", runnerOnline: true });

    mac.socket.close();
    expect(await runner.next()).toBe(peer(`mac:${MAC_A}`, false));
  });

  test("tells a Mac that joins later which runners are online", async () => {
    const { user, token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody());
    const runner = await connect(
      runnerToken(user.id, WS_A),
      `runnerKey=${key(7)}`,
    );
    const mac = await connect(token, `macId=${MAC_A}`);
    expect(await mac.next()).toBe(peer(`ws:${WS_A}`, true));
    expect(await runner.next()).toBe(peer(`mac:${MAC_A}`, true));
    runner.socket.close();
    expect(await mac.next()).toBe(peer(`ws:${WS_A}`, false));
  });

  test("a second connection from a Mac replaces the first", async () => {
    const { token } = await login("a@example.com");
    const first = await connect(token, `macId=${MAC_A}`);
    await connect(token, `macId=${MAC_A}`);
    expect(await first.next()).toBe(JSON.stringify({ relay: "replaced" }));
    await Bun.sleep(50);
    expect(first.closed()?.code).toBe(4000);
  });

  test("a user may connect at most 10 Macs at once", async () => {
    const { token } = await login("a@example.com");
    const macs = Array.from(
      { length: 10 },
      (_, index) => `mac${String(index).padStart(2, "0")}AAAAAAAAAAAAAAAAA`,
    );
    for (const macId of macs) await connect(token, `macId=${macId}`);
    const eleventh = await api(token, "GET", `/v1/connect?macId=${MAC_B}`);
    expect(eleventh.status).toBe(429);
    expect(eleventh.json.error?.code).toBe("QUOTA");
    // A Mac already connected may still reconnect.
    await connect(token, `macId=${macs[0]}`);
  });

  test("Macs cannot reach Macs and runners cannot reach runners", async () => {
    const { user, token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody(WS_A));
    await api(token, "POST", "/v1/workspaces", createBody(WS_B));
    const mac = await connect(token, `macId=${MAC_A}`);
    const otherMac = await connect(token, `macId=${MAC_B}`);
    const runnerA = await connect(
      runnerToken(user.id, WS_A),
      `runnerKey=${key(7)}`,
    );
    const runnerB = await connect(
      runnerToken(user.id, WS_B),
      `runnerKey=${key(8)}`,
    );
    // Drain the online notices.
    await Bun.sleep(100);
    for (const client of [mac, otherMac, runnerA, runnerB])
      while (!(await client.silent(20))) await client.next();

    mac.socket.send(encodeRelayFrame(`mac:${MAC_B}`, bytes("x")));
    runnerA.socket.send(encodeRelayFrame(`ws:${WS_B}`, bytes("x")));
    expect(await otherMac.silent()).toBe(true);
    expect(await runnerB.silent()).toBe(true);
  });

  test("deleting a workspace disconnects its runner", async () => {
    const { user, token } = await login("a@example.com");
    await api(token, "POST", "/v1/workspaces", createBody());
    const runner = await connect(
      runnerToken(user.id, WS_A),
      `runnerKey=${key(7)}`,
    );
    await api(token, "DELETE", `/v1/workspaces/${WS_A}`);
    await Bun.sleep(50);
    expect(runner.closed()?.code).toBe(4403);
  });
});

describe("isolation between users", () => {
  test("user B cannot list, read, wake, sleep, delete or connect to A's workspace", async () => {
    const a = await login("a@example.com");
    const b = await login("b@example.com");
    expect(a.user.id).not.toBe(b.user.id);
    await api(a.token, "POST", "/v1/workspaces", createBody(WS_A, MAC_A));

    expect((await api(b.token, "GET", "/v1/workspaces")).json).toEqual({
      workspaces: [],
    });
    for (const [method, path] of [
      ["GET", `/v1/workspaces/${WS_A}`],
      ["POST", `/v1/workspaces/${WS_A}/wake`],
      ["POST", `/v1/workspaces/${WS_A}/sleep`],
      ["DELETE", `/v1/workspaces/${WS_A}`],
    ] as const) {
      const { status, json } = await api(b.token, method, path);
      expect(status).toBe(404);
      expect(json.error?.code).toBe("NOT_FOUND");
    }
    // Nothing of A's changed.
    const own = await api(a.token, "GET", `/v1/workspaces/${WS_A}`);
    expect(own.json.status).toBe("starting");
    expect(kube.pod(`u-${a.user.id}`, `ws-${WS_A}`)).toBeDefined();

    // B's Mac, even claiming A's Mac id, is in B's room: it hears nothing of
    // A's runner and its frames to it go nowhere.
    const runnerA = await connect(
      runnerToken(a.user.id, WS_A),
      `runnerKey=${key(7)}`,
    );
    const macB = await connect(b.token, `macId=${MAC_A}`);
    expect(await macB.silent()).toBe(true);
    expect(await runnerA.silent()).toBe(true);
    macB.socket.send(encodeRelayFrame(`ws:${WS_A}`, bytes("let me in")));
    expect(await runnerA.silent()).toBe(true);
    runnerA.socket.send(encodeRelayFrame(`mac:${MAC_A}`, bytes("for A only")));
    expect(await macB.silent()).toBe(true);

    // B may make a workspace with the same id; it is B's own, elsewhere.
    const mine = await api(
      b.token,
      "POST",
      "/v1/workspaces",
      createBody(WS_A, MAC_B),
    );
    expect(mine.status).toBe(201);
    expect(kube.pod(`u-${b.user.id}`, `ws-${WS_A}`)).toBeDefined();
    expect(runnerToken(b.user.id, WS_A)).not.toBe(runnerToken(a.user.id, WS_A));
    await api(b.token, "DELETE", `/v1/workspaces/${WS_A}`);
    expect(kube.pod(`u-${a.user.id}`, `ws-${WS_A}`)).toBeDefined();
  });
});

describe("collection", () => {
  const DAY = 86_400_000;
  const later = (ms: number) => new Date(Date.now() + ms);

  async function asleep(email: string, workspaceId = WS_A) {
    const { token, user } = await login(email);
    await api(token, "POST", "/v1/workspaces", createBody(workspaceId));
    await api(token, "POST", `/v1/workspaces/${workspaceId}/sleep`);
    return { token, userId: user.id };
  }

  test("a workspace asleep 30 days is deleted with its namespace; an awake one never", async () => {
    const { token, userId } = await asleep("a@example.com");
    const awake = await login("b@example.com");
    await api(awake.token, "POST", "/v1/workspaces", createBody(WS_B));
    const listed = await api(token, "GET", `/v1/workspaces/${WS_A}`);
    expect(listed.json.sleptAt).toBeString();
    // The retired disposable mark is no route.
    expect(
      (
        await api(token, "POST", `/v1/workspaces/${WS_A}/disposable`, {
          disposable: true,
        })
      ).status,
    ).toBe(404);

    expect(await collect(later(29 * DAY))).toEqual({
      workspaces: [],
      namespaces: [],
    });
    expect(await collect(later(31 * DAY))).toEqual({
      workspaces: [WS_A],
      namespaces: [],
    });
    expect((await api(token, "GET", `/v1/workspaces/${WS_A}`)).status).toBe(
      404,
    );
    expect(kube.paths().some((path) => path.includes(`u-${userId}`))).toBe(
      false,
    );
    // The awake one is untouched, however long.
    expect(
      (await api(awake.token, "GET", `/v1/workspaces/${WS_B}`)).status,
    ).toBe(200);
  });

  test("an empty user namespace goes; one not named for its label stays", async () => {
    const { token, userId } = await asleep("a@example.com");
    await api(token, "DELETE", `/v1/workspaces/${WS_A}`);
    // As a delete that failed half-way leaves it.
    kube.objects.set(`/api/v1/namespaces/u-${userId}`, {
      metadata: {
        name: `u-${userId}`,
        labels: { "daedalus.dev/user": userId },
      },
    });
    // Labelled, but not the gateway's name for that user.
    kube.objects.set("/api/v1/namespaces/team-tools", {
      metadata: { name: "team-tools", labels: { "daedalus.dev/user": userId } },
    });
    kube.objects.set("/api/v1/namespaces/u-unlabelled", {
      metadata: { name: "u-unlabelled" },
    });
    expect(await collect()).toEqual({
      workspaces: [],
      namespaces: [`u-${userId}`],
    });
    expect(kube.paths()).toContain("/api/v1/namespaces/team-tools");
    expect(kube.paths()).toContain("/api/v1/namespaces/u-unlabelled");
  });

  test("a rule set to 0 is off, and a failed delete is retried next pass", async () => {
    await stop();
    start({ DAEDALUS_WORKSPACE_ASLEEP_DAYS: "0" });
    await asleep("a@example.com");
    expect((await collect(later(365 * DAY))).workspaces).toEqual([]);

    await stop();
    start();
    const request = kube.request.bind(kube);
    let refuse = true;
    kube.request = async (method, path, body) =>
      refuse && method === "DELETE" && path.includes("/pods/")
        ? { status: 500, body: { message: "etcd is down" } }
        : request(method, path, body);
    expect((await collect(later(31 * DAY))).workspaces).toEqual([]);
    expect(logs.some((line) => line.includes("Collecting workspace"))).toBe(
      true,
    );
    refuse = false;
    expect((await collect(later(31 * DAY))).workspaces).toEqual([WS_A]);
  });
});

test("a database from before collection gets its columns, asleep ones from now", async () => {
  await stop();
  const { Database } = await import("bun:sqlite");
  rmSync(join(dir, "gateway.sqlite"), { force: true });
  const old = new Database(join(dir, "gateway.sqlite"), { create: true });
  old.run(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE workspaces (user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
  mac_id TEXT NOT NULL, mac_key TEXT NOT NULL, cpu TEXT, memory TEXT, runner_key TEXT,
  sleeping INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY (user_id, workspace_id));
INSERT INTO users VALUES ('u1', 'a@example.com', '2026-01-01');
INSERT INTO workspaces VALUES ('u1', '${WS_A}', 'A', '${MAC_A}', 'k', NULL, NULL, NULL, 1, '2026-01-01');`);
  old.close();
  const before = Date.now();
  start();
  const [row] = store.allWorkspaces();
  expect(Date.parse(row!.sleptAt!)).toBeGreaterThanOrEqual(before - 1_000);
});

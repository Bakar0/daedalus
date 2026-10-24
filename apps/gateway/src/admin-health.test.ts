import { describe, expect, test } from "bun:test";
import {
  buildHealth,
  PENDING_MS,
  UNBOUND_MS,
  type HealthInput,
  type HealthUser,
} from "./admin-health";
import {
  nodeHealth,
  podHealth,
  type NodeHealth,
  type PodHealth,
  type WorkspaceUsage,
} from "./controller";
import { Logbook, redact } from "./logbook";
import type { WorkspaceRow } from "./store";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const WS = "0f8e2c1a-7b3d-4e5f-9a6b-1c2d3e4f5a6b";
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const node = (overrides: Partial<NodeHealth> = {}): NodeHealth => ({
  name: "node-1",
  ready: true,
  readyMessage: null,
  unschedulable: false,
  allocatable: { cpu: 8, memory: 16 * 2 ** 30, ephemeral: 100 * 2 ** 30 },
  runtimeHandlers: ["runc", "runsc"],
  ...overrides,
});

const row = (overrides: Partial<WorkspaceRow> = {}): WorkspaceRow => ({
  userId: "user1",
  workspaceId: WS,
  name: "app",
  macId: "m",
  macKey: "k",
  cpu: null,
  memory: null,
  runnerKey: null,
  sleeping: false,
  sleptAt: null,
  lastActiveAt: null,
  createdAt: ago(3_600_000),
  ...overrides,
});

const pod = (overrides: Partial<PodHealth> = {}): PodHealth => ({
  name: `ws-${WS}`,
  node: "node-1",
  phase: "Running",
  createdAt: ago(3_600_000),
  unscheduled: null,
  waiting: [],
  restarts: 0,
  requests: { cpu: 1, memory: 2 * 2 ** 30, ephemeral: 2 ** 30 },
  ...overrides,
});

const usage = (
  overrides: Partial<WorkspaceUsage> = {},
): Map<string, WorkspaceUsage> =>
  new Map([
    [
      WS,
      {
        pod: null,
        podHealth: pod(),
        disk: [
          {
            name: `ws-${WS}`,
            size: "20Gi",
            phase: "Bound",
            createdAt: ago(3_600_000),
          },
        ],
        ...overrides,
      },
    ],
  ]);

const user = (overrides: Partial<HealthUser> = {}): HealthUser => ({
  id: "user1",
  email: "a@example.com",
  rows: [row()],
  usage: usage(),
  quotas: [
    {
      name: "tenant",
      hard: { "requests.storage": "110Gi", persistentvolumeclaims: "10" },
      used: { "requests.storage": "21Gi", persistentvolumeclaims: "2" },
    },
  ],
  ...overrides,
});

const input = (overrides: Partial<HealthInput> = {}): HealthInput => ({
  now: NOW,
  nodes: [node()],
  nodesError: null,
  users: [user()],
  runtimeClass: "gvisor",
  runtimeHandler: "runsc",
  metrics: { available: false, reason: "metrics-server is not installed" },
  startedAt: NOW - 3_600_000,
  relay: { macs: 1, runners: 1 },
  collectMs: 3_600_000,
  lastCollection: {
    at: ago(600_000),
    workspaces: 0,
    namespaces: 0,
    failures: 0,
  },
  log: [],
  ...overrides,
});

const messages = (health: ReturnType<typeof buildHealth>) =>
  health.problems.map((item) => `${item.severity}: ${item.message}`);

describe("health", () => {
  test("a healthy cluster has no problems, and sums what workspace pods request per node", () => {
    const health = buildHealth(input());
    expect(health.ok).toBe(true);
    expect(health.problems).toEqual([]);
    expect(health.nodes![0]!.runtime).toBe(true);
    expect(health.nodes![0]!.requested.cpu).toBe(1);
    expect(health.nodes![0]!.workspacePods).toBe(1);
    expect(health.quotas[0]!.storage).toEqual({
      used: 21 * 2 ** 30,
      hard: 110 * 2 ** 30,
    });
    expect(health.gateway.uptimeSeconds).toBe(3600);
    expect(health.gateway.macs).toBe(1);
    expect(health.metrics.available).toBe(false);
  });

  test("nodes: not ready, cordoned, full, and without the runtime", () => {
    const health = buildHealth(
      input({
        nodes: [
          node({ ready: false, readyMessage: "kubelet stopped posting" }),
          node({ name: "node-2", unschedulable: true }),
          node({ name: "node-3", runtimeHandlers: ["runc"] }),
        ],
        users: [
          user({
            usage: usage({
              podHealth: pod({
                requests: { cpu: 7.5, memory: 2 ** 30, ephemeral: 0 },
              }),
            }),
          }),
        ],
      }),
    );
    expect(health.ok).toBe(false);
    expect(messages(health)).toEqual([
      "error: node-1 is not ready: kubelet stopped posting",
      "warning: Workspace pods on node-1 request 94% of its CPU",
      "warning: node-2 is cordoned",
      "warning: node-3 has no runsc runtime; workspace pods placed there fail",
    ]);
    expect(health.nodes![2]!.runtime).toBe(false);
  });

  test("no node with the runtime is an error; nodes that do not report handlers are unknown", () => {
    expect(
      messages(
        buildHealth(input({ nodes: [node({ runtimeHandlers: ["runc"] })] })),
      ),
    ).toEqual([
      "error: No node offers the runsc runtime, so workspace pods cannot start",
    ]);
    const unknown = buildHealth(
      input({ nodes: [node({ runtimeHandlers: null })] }),
    );
    expect(unknown.ok).toBe(true);
    expect(unknown.nodes![0]!.runtime).toBeNull();
    // With no runtime class there is nothing to check.
    const plain = buildHealth(
      input({ runtimeClass: "", nodes: [node({ runtimeHandlers: ["runc"] })] }),
    );
    expect(plain.ok).toBe(true);
    expect(plain.nodes![0]!.runtime).toBeNull();
  });

  test("an unreadable node list is an error", () => {
    const health = buildHealth(input({ nodes: null, nodesError: "forbidden" }));
    expect(messages(health)).toEqual([
      "error: Could not list the nodes: forbidden",
    ]);
  });

  test("pods: pending past two minutes with the scheduler's reason, crash loops, failed", () => {
    const pending = (podPart: Partial<PodHealth>) =>
      buildHealth(
        input({ users: [user({ usage: usage({ podHealth: pod(podPart) }) })] }),
      );
    // Pending a minute is normal.
    expect(
      pending({ phase: "Pending", createdAt: ago(60_000), node: null }).ok,
    ).toBe(true);
    const unschedulable = pending({
      phase: "Pending",
      createdAt: ago(PENDING_MS),
      node: null,
      unscheduled:
        "Unschedulable: 0/1 nodes are available: 1 Insufficient cpu.",
    });
    expect(unschedulable.pods[0]).toMatchObject({
      kind: "pending",
      workspace: "app",
      email: "a@example.com",
    });
    expect(messages(unschedulable)).toEqual([
      "error: app (a@example.com): Unschedulable: 0/1 nodes are available: 1 Insufficient cpu.",
    ]);
    const attaching = pending({
      phase: "Pending",
      createdAt: ago(PENDING_MS),
      waiting: [
        { container: "session", reason: "ContainerCreating", message: "" },
      ],
    });
    expect(attaching.pods[0]!.detail).toBe("session: ContainerCreating");
    const crashing = pending({
      waiting: [
        {
          container: "runner",
          reason: "CrashLoopBackOff",
          message: "back-off",
        },
      ],
      restarts: 7,
    });
    expect(messages(crashing)).toEqual([
      "error: app (a@example.com): runner: CrashLoopBackOff, 7 restarts",
    ]);
    const restarting = pending({ restarts: 4 });
    expect(messages(restarting)).toEqual([
      "warning: app (a@example.com): 4 restarts",
    ]);
    expect(pending({ phase: "Failed" }).pods[0]!.kind).toBe("failed");
  });

  test("volumes not bound after five minutes, and a quota nearly used up", () => {
    const health = buildHealth(
      input({
        users: [
          user({
            usage: usage({
              disk: [
                {
                  name: `ws-${WS}`,
                  size: "20Gi",
                  phase: "Pending",
                  createdAt: ago(UNBOUND_MS),
                },
                {
                  name: `ws-${WS}-state`,
                  size: "1Gi",
                  phase: "Pending",
                  createdAt: ago(60_000),
                },
              ],
            }),
            quotas: [
              {
                name: "tenant",
                hard: {
                  "requests.storage": "20Gi",
                  persistentvolumeclaims: "10",
                },
                used: {
                  "requests.storage": "19Gi",
                  persistentvolumeclaims: "2",
                },
              },
            ],
          }),
        ],
      }),
    );
    expect(health.volumes.map((volume) => volume.volume)).toEqual([`ws-${WS}`]);
    expect(messages(health)).toEqual([
      `error: ws-${WS} (a@example.com) is Pending, not Bound`,
      "warning: a@example.com uses 95% of their storage quota",
    ]);
  });

  test("a user whose pods could not be read is an error", () => {
    const health = buildHealth(input({ users: [user({ usage: null })] }));
    expect(messages(health)).toEqual([
      "error: Could not read a@example.com's pods and volumes",
    ]);
  });

  test("gateway: collection failures, a stalled collection, recent errors", () => {
    const health = buildHealth(
      input({
        startedAt: NOW - 10 * 3_600_000,
        lastCollection: {
          at: ago(3 * 3_600_000),
          workspaces: 1,
          namespaces: 0,
          failures: 2,
        },
        log: [
          { at: ago(60_000), message: "Request failed: the API refused" },
          { at: ago(30 * 60_000), message: "Collecting x failed: old" },
          { at: ago(60_000), message: "Collected workspace y" },
        ],
      }),
    );
    expect(messages(health)).toEqual([
      "warning: The last collection pass had 2 failures",
      `warning: Collection has not run since ${ago(3 * 3_600_000)}`,
      "warning: 1 gateway error in the last 15 minutes",
    ]);
    // Just started: a missing pass is not yet a problem.
    expect(
      buildHealth(
        input({
          startedAt: NOW - 60_000,
          lastCollection: null,
        }),
      ).ok,
    ).toBe(true);
  });
});

describe("cluster objects", () => {
  test("podHealth reads scheduling, waiting containers, restarts and requests", () => {
    const health = podHealth({
      metadata: { name: "ws-x", creationTimestamp: "2026-10-24T11:00:00Z" },
      spec: {
        nodeName: "node-1",
        containers: [
          { resources: { requests: { cpu: "50m", memory: "64Mi" } } },
          {
            resources: {
              requests: { cpu: "1", memory: "2Gi", "ephemeral-storage": "1Gi" },
            },
          },
        ],
      },
      status: {
        phase: "Pending",
        conditions: [
          {
            type: "PodScheduled",
            status: "False",
            reason: "Unschedulable",
            message: "0/1 nodes are available",
          },
        ],
        containerStatuses: [
          {
            name: "runner",
            restartCount: 2,
            state: { waiting: { reason: "CrashLoopBackOff", message: "boom" } },
          },
          { name: "session", restartCount: 1, state: { running: {} } },
        ],
      },
    });
    expect(health).toEqual({
      name: "ws-x",
      node: "node-1",
      phase: "Pending",
      createdAt: "2026-10-24T11:00:00Z",
      unscheduled: "Unschedulable: 0/1 nodes are available",
      waiting: [
        { container: "runner", reason: "CrashLoopBackOff", message: "boom" },
      ],
      restarts: 3,
      requests: {
        cpu: 1.05,
        memory: 64 * 2 ** 20 + 2 * 2 ** 30,
        ephemeral: 2 ** 30,
      },
    });
  });

  test("nodeHealth reads readiness, cordon, allocatable and runtime handlers", () => {
    expect(
      nodeHealth({
        metadata: { name: "n" },
        spec: { unschedulable: true },
        status: {
          conditions: [
            { type: "Ready", status: "False", message: "PLEG is not healthy" },
          ],
          allocatable: {
            cpu: "4",
            memory: "8Gi",
            "ephemeral-storage": "474095688Ki",
          },
          runtimeHandlers: [{ name: "runc" }, { name: "" }, { name: "runsc" }],
        },
      }),
    ).toEqual({
      name: "n",
      ready: false,
      readyMessage: "PLEG is not healthy",
      unschedulable: true,
      allocatable: { cpu: 4, memory: 8 * 2 ** 30, ephemeral: 474095688 * 1024 },
      runtimeHandlers: ["runc", "runsc"],
    });
    expect(
      nodeHealth({ metadata: { name: "old" }, status: {} }).runtimeHandlers,
    ).toBeNull();
  });
});

describe("logbook", () => {
  test("keeps the newest 50 lines, newest first, and redacts token-like text", () => {
    const printed: string[] = [];
    let clock = NOW;
    const book = new Logbook(
      (line) => printed.push(line),
      () => clock,
    );
    for (let i = 0; i < 55; i++) {
      book.log(`line ${i}`);
      clock += 1000;
    }
    expect(printed).toHaveLength(55);
    const lines = book.lines();
    expect(lines).toHaveLength(50);
    expect(lines[0]!.message).toBe("line 54");
    expect(lines.at(-1)!.message).toBe("line 5");
  });

  test("redact hides tokens but keeps workspace ids and object names", () => {
    const token = "HJAZC2bcUl_j9YQSUYu-h4S3KccCTohe9PKeLuwOhK8";
    expect(redact(`Bearer ${token} refused`)).toBe("Bearer [redacted] refused");
    expect(redact(`ws-${WS}-state is Pending`)).toBe(
      `ws-${WS}-state is Pending`,
    );
    expect(redact(`Collected workspace ${WS}`)).toBe(
      `Collected workspace ${WS}`,
    );
    expect(redact("short words stay")).toBe("short words stay");
  });
});

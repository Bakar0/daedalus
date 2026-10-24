import type {
  NodeHealth,
  PodHealth,
  QuotaHealth,
  WorkspaceUsage,
} from "./controller";
import type { LogLine } from "./logbook";
import { parseQuantity } from "./quantity";
import type { CollectionRecord } from "./server";
import type { WorkspaceRow } from "./store";

/**
 * The admin page's health section, worked out from what the overview read:
 * nodes, the workspace pods and volumes the gateway can see, each user's
 * quota, and the gateway's own state. Pure, so the rules are tested
 * without a cluster.
 *
 * The gateway sees only its tenant namespaces, so a node's "requested" is
 * what workspace pods request there, not the node's whole load.
 */

export type ProblemArea = "nodes" | "pods" | "volumes" | "quota" | "gateway";

export interface HealthProblem {
  severity: "error" | "warning";
  area: ProblemArea;
  message: string;
}

export interface NodeView {
  name: string;
  ready: boolean;
  readyMessage: string | null;
  unschedulable: boolean;
  /** Whether the node offers the runtime handler; null when it does not say. */
  runtime: boolean | null;
  allocatable: { cpu: number; memory: number; ephemeral: number };
  /** Summed over the workspace pods on the node. */
  requested: { cpu: number; memory: number; ephemeral: number };
  workspacePods: number;
}

export interface PodProblem {
  userId: string;
  email: string;
  workspaceId: string;
  workspace: string;
  pod: string;
  kind: "pending" | "crashing" | "failed";
  detail: string;
}

export interface VolumeProblem {
  userId: string;
  email: string;
  workspaceId: string;
  volume: string;
  phase: string;
}

export interface QuotaView {
  userId: string;
  email: string;
  storage: { used: number; hard: number } | null;
  volumes: { used: number; hard: number } | null;
  pods: { used: number; hard: number } | null;
}

export interface AdminHealth {
  ok: boolean;
  problems: HealthProblem[];
  nodes: NodeView[] | null;
  nodesError: string | null;
  runtimeClass: string;
  runtimeHandler: string;
  pods: PodProblem[];
  volumes: VolumeProblem[];
  quotas: QuotaView[];
  metrics: { available: boolean; reason: string | null };
  gateway: {
    startedAt: string;
    uptimeSeconds: number;
    macs: number;
    runners: number;
    collectMinutes: number;
    lastCollection: CollectionRecord | null;
  };
  recentLog: LogLine[];
}

export interface HealthUser {
  id: string;
  email: string;
  rows: WorkspaceRow[];
  usage: Map<string, WorkspaceUsage> | null;
  quotas: QuotaHealth[] | null;
}

export interface HealthInput {
  now: number;
  nodes: NodeHealth[] | null;
  nodesError: string | null;
  users: HealthUser[];
  runtimeClass: string;
  runtimeHandler: string;
  metrics: { available: boolean; reason: string | null };
  startedAt: number;
  relay: { macs: number; runners: number };
  collectMs: number;
  lastCollection: CollectionRecord | null;
  log: LogLine[];
}

/** A pod pending this long has a problem worth showing. */
export const PENDING_MS = 2 * 60_000;
/** A volume not bound after this long has a problem. */
export const UNBOUND_MS = 5 * 60_000;
/** Restarts that count as a crash loop in the making. */
export const RESTARTS_WARN = 3;
/** Share of a node or quota in use that earns a warning. */
export const FULL = 0.9;
/** Gateway errors this recent turn the badge red. */
export const RECENT_ERROR_MS = 15 * 60_000;

/** Waiting reasons that mean a container is crashing or cannot start. */
const CRASHING = new Set([
  "CrashLoopBackOff",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
]);
const IMAGE = new Set(["ErrImagePull", "ImagePullBackOff", "InvalidImageName"]);

const age = (now: number, iso: string | null) =>
  iso ? now - Date.parse(iso) : 0;

const pair = (quota: QuotaHealth[], key: string) => {
  for (const item of quota) {
    const hard = item.hard[key];
    if (hard === undefined) continue;
    return {
      used: parseQuantity(item.used[key] ?? "0") ?? 0,
      hard: parseQuantity(hard) ?? 0,
    };
  }
  return null;
};

const percent = (part: number, whole: number) =>
  `${Math.round((part / whole) * 100)}%`;

function podProblem(
  pod: PodHealth,
  now: number,
): Pick<PodProblem, "kind" | "detail"> | null {
  if (pod.phase === "Failed")
    return { kind: "failed", detail: "The pod failed" };
  const crashing = pod.waiting.find((item) => CRASHING.has(item.reason));
  if (crashing)
    return {
      kind: "crashing",
      detail: `${crashing.container}: ${crashing.reason}${pod.restarts ? `, ${pod.restarts} restarts` : ""}`,
    };
  const image = pod.waiting.find((item) => IMAGE.has(item.reason));
  if (image)
    return {
      kind: "pending",
      detail: `${image.container}: ${image.reason}${image.message ? `: ${image.message}` : ""}`,
    };
  if (pod.phase === "Pending" && age(now, pod.createdAt) >= PENDING_MS) {
    if (pod.unscheduled) return { kind: "pending", detail: pod.unscheduled };
    const waiting = pod.waiting[0];
    return {
      kind: "pending",
      detail: waiting
        ? `${waiting.container}: ${waiting.reason}${waiting.message ? `: ${waiting.message}` : ""}`
        : "Pending; the volumes may still be attaching",
    };
  }
  if (pod.restarts >= RESTARTS_WARN)
    return { kind: "crashing", detail: `${pod.restarts} restarts` };
  return null;
}

export function buildHealth(input: HealthInput): AdminHealth {
  const { now } = input;
  const problems: HealthProblem[] = [];
  const problem = (
    severity: HealthProblem["severity"],
    area: ProblemArea,
    message: string,
  ) => problems.push({ severity, area, message });

  // Workspace pods and volumes, and what they request per node.
  const pods: PodProblem[] = [];
  const volumes: VolumeProblem[] = [];
  const quotas: QuotaView[] = [];
  const perNode = new Map<string, NodeView["requested"] & { pods: number }>();
  for (const user of input.users) {
    if (!user.usage && user.rows.length)
      problem(
        "error",
        "pods",
        `Could not read ${user.email}'s pods and volumes`,
      );
    for (const row of user.rows) {
      const usage = user.usage?.get(row.workspaceId);
      const pod = usage?.podHealth;
      if (pod) {
        if (pod.node) {
          const sum = perNode.get(pod.node) ?? {
            cpu: 0,
            memory: 0,
            ephemeral: 0,
            pods: 0,
          };
          sum.cpu += pod.requests.cpu;
          sum.memory += pod.requests.memory;
          sum.ephemeral += pod.requests.ephemeral;
          sum.pods += 1;
          perNode.set(pod.node, sum);
        }
        const found = podProblem(pod, now);
        if (found) {
          pods.push({
            userId: user.id,
            email: user.email,
            workspaceId: row.workspaceId,
            workspace: row.name,
            pod: pod.name,
            ...found,
          });
          problem(
            found.kind === "crashing" && !pod.waiting.length
              ? "warning"
              : "error",
            "pods",
            `${row.name} (${user.email}): ${found.detail}`,
          );
        }
      }
      for (const volume of usage?.disk ?? [])
        if (
          volume.phase !== "Bound" &&
          age(now, volume.createdAt) >= UNBOUND_MS
        ) {
          volumes.push({
            userId: user.id,
            email: user.email,
            workspaceId: row.workspaceId,
            volume: volume.name,
            phase: volume.phase,
          });
          problem(
            "error",
            "volumes",
            `${volume.name} (${user.email}) is ${volume.phase}, not Bound`,
          );
        }
    }
    if (user.quotas) {
      const view: QuotaView = {
        userId: user.id,
        email: user.email,
        storage: pair(user.quotas, "requests.storage"),
        volumes: pair(user.quotas, "persistentvolumeclaims"),
        pods: pair(user.quotas, "pods"),
      };
      quotas.push(view);
      for (const [label, value] of [
        ["storage", view.storage],
        ["volume count", view.volumes],
        ["pod count", view.pods],
      ] as const)
        if (value && value.hard > 0 && value.used >= value.hard * FULL)
          problem(
            "warning",
            "quota",
            `${user.email} uses ${percent(value.used, value.hard)} of their ${label} quota`,
          );
    }
  }

  // Nodes.
  let nodes: NodeView[] | null = null;
  if (input.nodes) {
    nodes = input.nodes.map((node) => {
      const sum = perNode.get(node.name);
      const runtime =
        node.runtimeHandlers === null
          ? null
          : node.runtimeHandlers.includes(input.runtimeHandler);
      return {
        name: node.name,
        ready: node.ready,
        readyMessage: node.readyMessage,
        unschedulable: node.unschedulable,
        runtime: input.runtimeClass ? runtime : null,
        allocatable: node.allocatable,
        requested: {
          cpu: sum?.cpu ?? 0,
          memory: sum?.memory ?? 0,
          ephemeral: sum?.ephemeral ?? 0,
        },
        workspacePods: sum?.pods ?? 0,
      };
    });
    if (!nodes.length) problem("error", "nodes", "The cluster has no nodes");
    for (const node of nodes) {
      if (!node.ready)
        problem(
          "error",
          "nodes",
          `${node.name} is not ready: ${node.readyMessage ?? "no reason given"}`,
        );
      if (node.unschedulable)
        problem("warning", "nodes", `${node.name} is cordoned`);
      for (const [label, used, total] of [
        ["CPU", node.requested.cpu, node.allocatable.cpu],
        ["memory", node.requested.memory, node.allocatable.memory],
        ["disk", node.requested.ephemeral, node.allocatable.ephemeral],
      ] as const)
        if (total > 0 && used >= total * FULL)
          problem(
            "warning",
            "nodes",
            `Workspace pods on ${node.name} request ${percent(used, total)} of its ${label}`,
          );
    }
    if (input.runtimeClass) {
      const offering = nodes.filter((node) => node.runtime === true);
      const unknown = nodes.every((node) => node.runtime === null);
      if (!unknown && !offering.length)
        problem(
          "error",
          "nodes",
          `No node offers the ${input.runtimeHandler} runtime, so workspace pods cannot start`,
        );
      else
        for (const node of nodes)
          if (node.runtime === false && node.ready && !node.unschedulable)
            problem(
              "warning",
              "nodes",
              `${node.name} has no ${input.runtimeHandler} runtime; workspace pods placed there fail`,
            );
    }
  } else
    problem(
      "error",
      "nodes",
      `Could not list the nodes: ${input.nodesError ?? "unknown error"}`,
    );

  // The gateway itself.
  const last = input.lastCollection;
  if (last && last.failures > 0)
    problem(
      "warning",
      "gateway",
      `The last collection pass had ${last.failures} failure${last.failures === 1 ? "" : "s"}`,
    );
  const uptime = now - input.startedAt;
  if (
    last &&
    now - Date.parse(last.at) > 2 * input.collectMs + 5 * 60_000 &&
    uptime > 2 * input.collectMs
  )
    problem("warning", "gateway", `Collection has not run since ${last.at}`);
  const recentErrors = input.log.filter(
    (line) =>
      now - Date.parse(line.at) <= RECENT_ERROR_MS &&
      /\bfail(ed|s)?\b|error/i.test(line.message),
  );
  if (recentErrors.length)
    problem(
      "warning",
      "gateway",
      `${recentErrors.length} gateway error${recentErrors.length === 1 ? "" : "s"} in the last 15 minutes`,
    );

  return {
    ok: problems.length === 0,
    problems,
    nodes,
    nodesError: input.nodesError,
    runtimeClass: input.runtimeClass,
    runtimeHandler: input.runtimeHandler,
    pods,
    volumes,
    quotas,
    metrics: input.metrics,
    gateway: {
      startedAt: new Date(input.startedAt).toISOString(),
      uptimeSeconds: Math.max(0, Math.round(uptime / 1000)),
      macs: input.relay.macs,
      runners: input.relay.runners,
      collectMinutes: input.collectMs / 60_000,
      lastCollection: last,
    },
    recentLog: input.log,
  };
}

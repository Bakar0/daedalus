import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RUNNER_ENV,
  RUNNER_PATHS,
  type CloudWorkspaceStatus,
} from "@daedalus/remote-protocol";
import type { GatewayConfig } from "./config";
import { KubeError, type KubeApi, type KubeObject } from "./kube";
import type { WorkspaceRow } from "./store";

/**
 * Creates and deletes what a workspace runs on, as TEAM.md "Pod" lays out:
 * per user a namespace `u-<userId>` with the chart's tenant objects, and per
 * workspace a Secret holding the runner token, a PVC and a pod.
 *
 * The gateway may only create namespaces and RoleBindings cluster-wide. So
 * the first thing it puts in a new namespace is a RoleBinding that gives
 * itself the `daedalus-tenant-admin` ClusterRole there, and only then the
 * rest, which that binding is what allows.
 */

const USER_LABEL = "daedalus.dev/user";
const WORKSPACE_LABEL = "daedalus.dev/workspace";
const TENANT_ROLE = "daedalus-tenant-admin";
const ROLE_BINDING = "daedalus-gateway";

export const namespaceFor = (userId: string) => `u-${userId}`;
export const podName = (workspaceId: string) => `ws-${workspaceId}`;
export const pvcName = (workspaceId: string) => `ws-${workspaceId}`;
export const secretName = (workspaceId: string) => `ws-${workspaceId}-runner`;

const core = (namespace: string, plural: string) =>
  `/api/v1/namespaces/${namespace}/${plural}`;

/** Where objects of a kind live in a namespace, for the kinds we create. */
const COLLECTIONS: Record<string, (namespace: string) => string> = {
  ServiceAccount: (ns) => core(ns, "serviceaccounts"),
  ResourceQuota: (ns) => core(ns, "resourcequotas"),
  NetworkPolicy: (ns) =>
    `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies`,
};

/**
 * The chart's tenant objects, one YAML document per file. They carry no
 * namespace; the controller sets it for each user.
 */
export function loadTenantObjects(dir: string): KubeObject[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
  } catch {
    throw new Error(`Cannot read tenant objects from ${dir}`);
  }
  return files.sort().map((name) => {
    const object = Bun.YAML.parse(readFileSync(join(dir, name), "utf8"));
    if (!isObject(object) || typeof object.kind !== "string")
      throw new Error(`${name} is not a Kubernetes object`);
    if (!COLLECTIONS[object.kind])
      throw new Error(`${name}: the gateway does not create ${object.kind}`);
    return object;
  });
}

const isObject = (value: unknown): value is KubeObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads a nested field of an untyped Kubernetes object. */
function field(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof key === "number")
      current = Array.isArray(current) ? current[key] : undefined;
    else current = isObject(current) ? current[key] : undefined;
  }
  return current;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/** Waiting reasons that will not fix themselves. */
const STUCK = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "CrashLoopBackOff",
  "CreateContainerConfigError",
  "CreateContainerError",
]);

/** A pod as the workspace status needs it. */
export interface PodState {
  phase: string;
  /** Set when the pod cannot get going without someone changing something. */
  failure: string | null;
  terminating: boolean;
}

export function podState(pod: KubeObject): PodState {
  const phase = text(field(pod, "status", "phase")) ?? "Pending";
  const terminating = field(pod, "metadata", "deletionTimestamp") !== undefined;
  const waiting = field(
    pod,
    "status",
    "containerStatuses",
    0,
    "state",
    "waiting",
  );
  const waitingReason = text(field(waiting, "reason"));
  let failure: string | null = null;
  if (waitingReason && STUCK.has(waitingReason))
    failure = [waitingReason, text(field(waiting, "message"))]
      .filter(Boolean)
      .join(": ");
  else if (phase === "Failed" || phase === "Succeeded")
    failure =
      text(field(pod, "status", "message")) ??
      text(field(pod, "status", "reason")) ??
      `The workspace pod stopped (${phase})`;
  return { phase, failure, terminating };
}

/** The contract's status from what the database and Kubernetes say. */
export function workspaceStatus(
  row: WorkspaceRow,
  pod: PodState | null,
  runnerOnline: boolean,
): { status: CloudWorkspaceStatus; reason: string | null } {
  if (row.sleeping) return { status: "sleeping", reason: null };
  if (!pod)
    return {
      status: "failed",
      reason: "The workspace pod is gone; wake the workspace to start it again",
    };
  if (pod.failure) return { status: "failed", reason: pod.failure };
  if (pod.phase === "Running" && runnerOnline && !pod.terminating)
    return { status: "running", reason: null };
  return { status: "starting", reason: null };
}

export class Controller {
  constructor(
    private readonly kube: KubeApi,
    private readonly config: GatewayConfig,
    private readonly tenant: KubeObject[],
  ) {}

  /** POSTs; with `existing: "ok"`, "already exists" counts as done. */
  async #create(
    path: string,
    body: KubeObject,
    what: string,
    existing: "ok" | "error" = "ok",
  ): Promise<void> {
    const response = await this.kube.request("POST", path, body);
    if (response.status === 409 && existing === "ok") return;
    if (response.status >= 300) throw KubeError.from(response, what);
  }

  /** DELETEs, treating "not found" as done. */
  async #delete(path: string, what: string): Promise<void> {
    const response = await this.kube.request("DELETE", path);
    if (response.status === 404) return;
    if (response.status >= 300) throw KubeError.from(response, what);
  }

  /** The user's namespace, its RoleBinding first, then the tenant objects. */
  async ensureTenant(userId: string): Promise<void> {
    const namespace = namespaceFor(userId);
    await this.#create(
      "/api/v1/namespaces",
      {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: namespace, labels: { [USER_LABEL]: userId } },
      },
      "Creating the user's namespace",
    );
    await this.#create(
      `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`,
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: {
          name: ROLE_BINDING,
          namespace,
          labels: { [USER_LABEL]: userId },
        },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: TENANT_ROLE,
        },
        subjects: [
          {
            kind: "ServiceAccount",
            name: this.config.serviceAccount,
            namespace: this.config.namespace,
          },
        ],
      },
      "Granting the gateway access to the user's namespace",
    );
    for (const object of this.tenant) {
      const kind = String(object.kind);
      const metadata = isObject(object.metadata) ? object.metadata : {};
      const labels = isObject(metadata.labels) ? metadata.labels : {};
      await this.#create(
        COLLECTIONS[kind]!(namespace),
        {
          ...object,
          metadata: {
            ...metadata,
            namespace,
            labels: { ...labels, [USER_LABEL]: userId },
          },
        },
        `Creating the user's ${kind}`,
      );
    }
  }

  /** Removes the user's namespace and everything left in it. */
  async deleteTenant(userId: string): Promise<void> {
    await this.#delete(
      `/api/v1/namespaces/${namespaceFor(userId)}`,
      "Deleting the user's namespace",
    );
  }

  /**
   * The Secret and PVC that outlive the pod through sleep. Either existing
   * already is an error: an old Secret would hold a token the database no
   * longer knows, and an old volume another workspace's files.
   */
  async createStorage(row: WorkspaceRow, runnerToken: string): Promise<void> {
    const namespace = namespaceFor(row.userId);
    const labels = this.#labels(row);
    await this.#create(
      core(namespace, "secrets"),
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: secretName(row.workspaceId), namespace, labels },
        type: "Opaque",
        stringData: { token: runnerToken },
      },
      "Creating the runner token",
      "error",
    );
    const { storageClass, storageSize } = this.config.workspace;
    await this.#create(
      core(namespace, "persistentvolumeclaims"),
      {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: { name: pvcName(row.workspaceId), namespace, labels },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: storageSize } },
          ...(storageClass ? { storageClassName: storageClass } : {}),
        },
      },
      "Creating the workspace volume",
      "error",
    );
  }

  /** Creates the pod. A 409 means the last one is still going away. */
  async startPod(row: WorkspaceRow): Promise<void> {
    await this.#create(
      core(namespaceFor(row.userId), "pods"),
      this.podSpec(row),
      "Starting the workspace pod",
      "error",
    );
  }

  async stopPod(row: WorkspaceRow): Promise<void> {
    await this.#delete(
      `${core(namespaceFor(row.userId), "pods")}/${podName(row.workspaceId)}`,
      "Stopping the workspace pod",
    );
  }

  /** Removes the pod, the volume and the token Secret. */
  async deleteWorkspace(row: WorkspaceRow): Promise<void> {
    const namespace = namespaceFor(row.userId);
    await this.stopPod(row);
    await this.#delete(
      `${core(namespace, "persistentvolumeclaims")}/${pvcName(row.workspaceId)}`,
      "Deleting the workspace volume",
    );
    await this.#delete(
      `${core(namespace, "secrets")}/${secretName(row.workspaceId)}`,
      "Deleting the runner token",
    );
  }

  /** The workspace's pod, or null when there is none. */
  async pod(row: WorkspaceRow): Promise<PodState | null> {
    const response = await this.kube.request(
      "GET",
      `${core(namespaceFor(row.userId), "pods")}/${podName(row.workspaceId)}`,
    );
    if (response.status === 404) return null;
    if (response.status >= 300)
      throw KubeError.from(response, "Reading the workspace pod");
    return podState(response.body);
  }

  #labels(row: WorkspaceRow): Record<string, string> {
    return { [USER_LABEL]: row.userId, [WORKSPACE_LABEL]: row.workspaceId };
  }

  podSpec(row: WorkspaceRow): KubeObject {
    const { workspace, runner } = this.config;
    const requests = {
      cpu: row.cpu ?? workspace.requests.cpu,
      memory: row.memory ?? workspace.requests.memory,
    };
    // A size the user asked for is both the request and the limit.
    const limits = {
      cpu: row.cpu ?? workspace.limits.cpu,
      memory: row.memory ?? workspace.limits.memory,
    };
    const value = (name: string, value: string) => ({ name, value });
    return {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName(row.workspaceId),
        namespace: namespaceFor(row.userId),
        labels: this.#labels(row),
      },
      spec: {
        serviceAccountName: "runner",
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        restartPolicy: "Always",
        terminationGracePeriodSeconds: 10,
        ...(workspace.runtimeClass
          ? { runtimeClassName: workspace.runtimeClass }
          : {}),
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "runner",
            image: runner.image,
            imagePullPolicy: runner.pullPolicy,
            env: [
              value(RUNNER_ENV.gatewayUrl, this.config.internalUrl),
              {
                name: RUNNER_ENV.runnerToken,
                valueFrom: {
                  secretKeyRef: {
                    name: secretName(row.workspaceId),
                    key: "token",
                  },
                },
              },
              value(RUNNER_ENV.workspaceId, row.workspaceId),
              value(RUNNER_ENV.macId, row.macId),
              value(RUNNER_ENV.macKey, row.macKey),
              value(RUNNER_ENV.idleMinutes, workspace.idleMinutes),
            ],
            resources: { requests, limits },
            volumeMounts: [
              { name: "workspace", mountPath: RUNNER_PATHS.workspace },
              { name: "cache", mountPath: RUNNER_PATHS.cache },
              // The shim's Unix socket; S3 Files volumes cannot hold one.
              { name: "runtime", mountPath: RUNNER_PATHS.runtime },
            ],
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
              seccompProfile: { type: "RuntimeDefault" },
            },
          },
        ],
        volumes: [
          {
            name: "workspace",
            persistentVolumeClaim: { claimName: pvcName(row.workspaceId) },
          },
          { name: "cache", emptyDir: {} },
          {
            name: "runtime",
            emptyDir: { medium: "Memory", sizeLimit: "16Mi" },
          },
        ],
      },
    };
  }
}

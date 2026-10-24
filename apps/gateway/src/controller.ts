import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RUNNER_ENV,
  RUNNER_PATHS,
  RUNNER_POD_GROUP,
  type CloudWorkspaceStatus,
} from "@daedalus/remote-protocol";
import type { GatewayConfig } from "./config";
import { KubeError, type KubeApi, type KubeObject } from "./kube";
import type { WorkspaceRow } from "./store";

/**
 * Creates and deletes what a workspace runs on, as TEAM.md "Pod" lays out:
 * per user a namespace `u-<userId>` with the chart's tenant objects, and per
 * workspace two PVCs (the workspace, and the runner's state), a Secret
 * holding the runner token while the workspace is awake, and a pod.
 *
 * The pod has two containers (artifacts/cloud-sessions/h1-pod-spec.md).
 * `session` (uid 1001) runs sessiond, tmux and everything the agents start.
 * `runner` (uid 1000) holds the relay link, the token and the identity key,
 * on volumes the session container does not mount, so agent code cannot
 * take them.
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
/** Pod Security level and version every tenant namespace enforces. */
const POD_SECURITY = { level: "restricted", version: "v1.30" } as const;

export const namespaceFor = (userId: string) => `u-${userId}`;
/** A user id, as the store makes them (the contract allows 20). */
const USER_ID = /^[a-z0-9]{1,20}$/;
export const podName = (workspaceId: string) => `ws-${workspaceId}`;
export const pvcName = (workspaceId: string) => `ws-${workspaceId}`;
export const statePvcName = (workspaceId: string) => `ws-${workspaceId}-state`;
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

/** A workspace's pod and volumes, as the admin page shows them. */
export interface WorkspaceUsage {
  pod: PodState | null;
  disk: { name: string; size: string }[];
}

export interface PodResources {
  cpu: { request: string; limit: string };
  memory: { request: string; limit: string };
}

/**
 * How long to wait before each retry of the first object after a new
 * RoleBinding: five tries over five seconds. The API server can refuse with
 * 403 until its authorizer has seen the binding, which kind showed right
 * after a namespace was made.
 */
const BINDING_RETRY_MS = [500, 1000, 1500, 2000] as const;

/**
 * gVisor gives each container its own view of a plain emptyDir, so the
 * session's socket in "shared" is not there for the runner. These mount
 * hints make "shared" one tmpfs inside the pod's sandbox. Runtimes other
 * than runsc ignore them; containerd passes them on only when its runsc
 * runtime lists dev.gvisor.* in pod_annotations.
 */
export const GVISOR_SHARED_MOUNT = {
  "dev.gvisor.spec.mount.shared.share": "pod",
  "dev.gvisor.spec.mount.shared.type": "tmpfs",
  "dev.gvisor.spec.mount.shared.options": "rw,rprivate",
} as const;

export class Controller {
  constructor(
    private readonly kube: KubeApi,
    private readonly config: GatewayConfig,
    private readonly tenant: KubeObject[],
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      Bun.sleep(ms),
  ) {}

  /** POSTs; with `existing: "ok"`, "already exists" counts as done. */
  async #create(
    path: string,
    body: KubeObject,
    what: string,
    existing: "ok" | "error" = "ok",
    retryForbidden = false,
  ): Promise<void> {
    let response = await this.kube.request("POST", path, body);
    if (retryForbidden)
      for (const ms of BINDING_RETRY_MS) {
        if (response.status !== 403) break;
        await this.wait(ms);
        response = await this.kube.request("POST", path, body);
      }
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
    const podSecurity: Record<string, string> = {};
    for (const mode of ["enforce", "warn", "audit"]) {
      podSecurity[`pod-security.kubernetes.io/${mode}`] = POD_SECURITY.level;
      podSecurity[`pod-security.kubernetes.io/${mode}-version`] =
        POD_SECURITY.version;
    }
    await this.#create(
      "/api/v1/namespaces",
      {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: namespace,
          labels: { [USER_LABEL]: userId, ...podSecurity },
        },
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
    for (const [index, object] of this.tenant.entries()) {
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
        "ok",
        // Only the first needs to wait for the binding to take effect.
        index === 0,
      );
    }
  }

  /**
   * The users whose namespace this gateway made: labelled with their id and
   * named for it, `u-<userId>`. Any other namespace is not the gateway's to
   * touch, whatever its name.
   */
  async tenants(): Promise<string[]> {
    const response = await this.kube.request(
      "GET",
      `/api/v1/namespaces?labelSelector=${encodeURIComponent(USER_LABEL)}`,
    );
    if (response.status >= 300)
      throw KubeError.from(response, "Listing the users' namespaces");
    const items =
      isObject(response.body) && Array.isArray(response.body.items)
        ? response.body.items
        : [];
    const users: string[] = [];
    for (const item of items) {
      const metadata =
        isObject(item) && isObject(item.metadata) ? item.metadata : {};
      const labels = isObject(metadata.labels) ? metadata.labels : {};
      const userId = labels[USER_LABEL];
      if (
        typeof userId === "string" &&
        USER_ID.test(userId) &&
        metadata.name === namespaceFor(userId)
      )
        users.push(userId);
    }
    return users;
  }

  /** Removes the user's namespace and everything left in it. */
  async deleteTenant(userId: string): Promise<void> {
    await this.#delete(
      `/api/v1/namespaces/${namespaceFor(userId)}`,
      "Deleting the user's namespace",
    );
  }

  /**
   * The two PVCs that outlive the pod through sleep. Either existing already
   * is an error: an old volume would hold another workspace's files or key.
   */
  async createVolumes(row: WorkspaceRow): Promise<void> {
    const namespace = namespaceFor(row.userId);
    const { storageClass, storageSize, stateSize } = this.config.workspace;
    for (const [name, size, what] of [
      [pvcName(row.workspaceId), storageSize, "Creating the workspace volume"],
      [statePvcName(row.workspaceId), stateSize, "Creating the runner volume"],
    ] as const)
      await this.#create(
        core(namespace, "persistentvolumeclaims"),
        {
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: { name, namespace, labels: this.#labels(row) },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: size } },
            ...(storageClass ? { storageClassName: storageClass } : {}),
          },
        },
        what,
        "error",
      );
  }

  /**
   * Writes the runner token Secret, replacing any earlier one. There is no
   * update right, so replacing is delete and create.
   */
  async writeToken(row: WorkspaceRow, runnerToken: string): Promise<void> {
    const namespace = namespaceFor(row.userId);
    await this.deleteToken(row);
    await this.#create(
      core(namespace, "secrets"),
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: secretName(row.workspaceId),
          namespace,
          labels: this.#labels(row),
        },
        type: "Opaque",
        stringData: { token: runnerToken },
      },
      "Writing the runner token",
      "error",
    );
  }

  async deleteToken(row: WorkspaceRow): Promise<void> {
    await this.#delete(
      `${core(namespaceFor(row.userId), "secrets")}/${secretName(row.workspaceId)}`,
      "Deleting the runner token",
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

  /** Removes the pod, both volumes and the token Secret. */
  async deleteWorkspace(row: WorkspaceRow): Promise<void> {
    const namespace = namespaceFor(row.userId);
    await this.stopPod(row);
    for (const name of [
      pvcName(row.workspaceId),
      statePvcName(row.workspaceId),
    ])
      await this.#delete(
        `${core(namespace, "persistentvolumeclaims")}/${name}`,
        "Deleting a workspace volume",
      );
    await this.deleteToken(row);
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

  /**
   * The user's workspace pods and PVCs, by workspace id, in two list calls,
   * for the admin page. A PVC's size is what it requests.
   */
  async usage(userId: string): Promise<Map<string, WorkspaceUsage>> {
    const namespace = namespaceFor(userId);
    const selector = `?labelSelector=${encodeURIComponent(WORKSPACE_LABEL)}`;
    const list = async (plural: string, what: string) => {
      const response = await this.kube.request(
        "GET",
        `${core(namespace, plural)}${selector}`,
      );
      if (response.status === 404) return [];
      if (response.status >= 300) throw KubeError.from(response, what);
      return isObject(response.body) && Array.isArray(response.body.items)
        ? (response.body.items as unknown[])
        : [];
    };
    const usage = new Map<string, WorkspaceUsage>();
    const entry = (item: unknown) => {
      const id = field(item, "metadata", "labels", WORKSPACE_LABEL);
      if (typeof id !== "string") return undefined;
      let found = usage.get(id);
      if (!found) {
        found = { pod: null, disk: [] };
        usage.set(id, found);
      }
      return found;
    };
    for (const item of await list("pods", "Listing the user's pods")) {
      const found = entry(item);
      if (found && isObject(item)) found.pod = podState(item);
    }
    for (const item of await list(
      "persistentvolumeclaims",
      "Listing the user's volumes",
    )) {
      const found = entry(item);
      const name = text(field(item, "metadata", "name"));
      const size = text(
        field(item, "spec", "resources", "requests", "storage"),
      );
      if (found && name && size) found.disk.push({ name, size });
    }
    return usage;
  }

  /** The session container's CPU and memory, as `podSpec` sets them. */
  resources(row: WorkspaceRow): PodResources {
    const { workspace } = this.config;
    // A size the user asked for is both the request and the limit.
    return {
      cpu: {
        request: row.cpu ?? workspace.requests.cpu,
        limit: row.cpu ?? workspace.limits.cpu,
      },
      memory: {
        request: row.memory ?? workspace.requests.memory,
        limit: row.memory ?? workspace.limits.memory,
      },
    };
  }

  #labels(row: WorkspaceRow): Record<string, string> {
    return { [USER_LABEL]: row.userId, [WORKSPACE_LABEL]: row.workspaceId };
  }

  podSpec(row: WorkspaceRow): KubeObject {
    const { workspace, runner } = this.config;
    const { cpu, memory } = this.resources(row);
    const value = (name: string, value: string) => ({ name, value });
    const container = (
      name: string,
      uid: number,
      script: string,
    ): KubeObject => ({
      name,
      image: runner.image,
      imagePullPolicy: runner.pullPolicy,
      command: ["bun", `/opt/daedalus/${script}`],
      securityContext: {
        runAsNonRoot: true,
        runAsUser: uid,
        runAsGroup: uid,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
        seccompProfile: { type: "RuntimeDefault" },
      },
    });
    const mount = (name: string, mountPath: string, readOnly = false) => ({
      name,
      mountPath,
      ...(readOnly ? { readOnly } : {}),
    });
    const tokenDir = RUNNER_PATHS.token.slice(
      0,
      RUNNER_PATHS.token.lastIndexOf("/"),
    );
    const tokenFile = RUNNER_PATHS.token.slice(tokenDir.length + 1);
    return {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName(row.workspaceId),
        namespace: namespaceFor(row.userId),
        labels: this.#labels(row),
        annotations: {
          "kubectl.kubernetes.io/default-container": "session",
          ...(workspace.runtimeClass ? GVISOR_SHARED_MOUNT : {}),
        },
      },
      spec: {
        serviceAccountName: "runner",
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        shareProcessNamespace: false,
        restartPolicy: "Always",
        terminationGracePeriodSeconds: 10,
        ...(workspace.runtimeClass
          ? { runtimeClassName: workspace.runtimeClass }
          : {}),
        securityContext: {
          runAsNonRoot: true,
          fsGroup: RUNNER_POD_GROUP,
          fsGroupChangePolicy: "OnRootMismatch",
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            ...container("runner", 1000, "runner.js"),
            // Nothing secret: the token is a file on its own volume.
            env: [
              value(RUNNER_ENV.gatewayUrl, this.config.internalUrl),
              value(RUNNER_ENV.workspaceId, row.workspaceId),
              value(RUNNER_ENV.macId, row.macId),
              value(RUNNER_ENV.macKey, row.macKey),
              value(RUNNER_ENV.idleMinutes, workspace.idleMinutes),
            ],
            resources: {
              requests: {
                cpu: "50m",
                memory: "64Mi",
                "ephemeral-storage": "64Mi",
              },
              limits: {
                cpu: "500m",
                memory: "256Mi",
                "ephemeral-storage": "256Mi",
              },
            },
            volumeMounts: [
              mount("state", RUNNER_PATHS.state),
              mount("token", tokenDir, true),
              mount("shared", RUNNER_PATHS.runtime),
              mount("runner-tmp", "/tmp"),
            ],
          },
          {
            ...container("session", 1001, "sessiond.js"),
            env: [],
            resources: {
              requests: {
                cpu: cpu.request,
                memory: memory.request,
                "ephemeral-storage": workspace.ephemeral.request,
              },
              limits: {
                cpu: cpu.limit,
                memory: memory.limit,
                "ephemeral-storage": workspace.ephemeral.limit,
              },
            },
            volumeMounts: [
              mount("workspace", RUNNER_PATHS.workspace),
              mount("cache", RUNNER_PATHS.cache),
              mount("shared", RUNNER_PATHS.runtime),
              mount("session-tmp", "/tmp"),
            ],
          },
        ],
        volumes: [
          {
            name: "workspace",
            persistentVolumeClaim: { claimName: pvcName(row.workspaceId) },
          },
          {
            name: "state",
            persistentVolumeClaim: { claimName: statePvcName(row.workspaceId) },
          },
          {
            name: "token",
            secret: {
              secretName: secretName(row.workspaceId),
              defaultMode: 0o440,
              items: [{ key: "token", path: tokenFile }],
            },
          },
          { name: "shared", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } },
          { name: "cache", emptyDir: { sizeLimit: workspace.cacheSize } },
          { name: "runner-tmp", emptyDir: { sizeLimit: "64Mi" } },
          { name: "session-tmp", emptyDir: { sizeLimit: workspace.tmpSize } },
        ],
      },
    };
  }
}

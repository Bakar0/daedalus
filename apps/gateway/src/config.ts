import { parseQuantity } from "./quantity";

/**
 * The gateway's settings, all from its environment. The Helm chart sets
 * these from its values (see TEAM.md "Helm values"); the names are agreed
 * with the chart and recorded there.
 */
export interface GatewayConfig {
  /** The public listener: Macs and users. */
  port: number;
  /**
   * The runner listener, reachable only inside the cluster: runner tokens
   * work here and nowhere else.
   */
  runnerPort: number;
  /** SQLite file on the gateway's volume. */
  dbPath: string;
  /** Whether POST /v1/dev/login is served. */
  devLogin: boolean;
  /** How Macs reach the gateway; informational for now. */
  publicUrl: string;
  /** The in-cluster URL of the runner listener, given to runner pods. */
  internalUrl: string;
  /** Where the gateway runs, for the RoleBinding it puts in each tenant. */
  namespace: string;
  serviceAccount: string;
  /** Workspaces one user may have at once. */
  maxWorkspaces: number;
  runner: { image: string; pullPolicy: string };
  workspace: {
    storageClass: string;
    storageSize: string;
    /** The runner's own volume, for its identity key and event queue. */
    stateSize: string;
    requests: { cpu: string; memory: string };
    limits: { cpu: string; memory: string };
    /** The most a user may ask for. */
    max: { cpu: number; memory: number };
    /** The session container's ephemeral storage. */
    ephemeral: { request: string; limit: string };
    cacheSize: string;
    tmpSize: string;
    runtimeClass: string;
    idleMinutes: string;
  };
  /** Directory holding the chart's `daedalus-tenant` ConfigMap files. */
  tenantDir: string;
  /** How long a workspace may stay asleep before it is deleted; 0 never. */
  retention: { asleepMs: number };
  /** How often collection runs. */
  collectMs: number;
  /** The admin page's listener; null when it is off (the default). */
  admin: AdminConfig | null;
}

export interface AdminConfig {
  port: number;
  /** 127.0.0.1 unless the chart exposes it through its own Service. */
  host: string;
  /** Host header values accepted besides localhost, as `name` or `name:port`. */
  hosts: string[];
  /**
   * Addresses of TLS proxies whose X-Forwarded-Proto is believed; from
   * anyone else the header is ignored.
   */
  trustedProxies: string[];
  /** The mounted Secret: `admin-token`, and `viewer-token` if any. */
  tokenDir: string;
  sessionMs: number;
  /** A link on the page when set; http or https only. */
  opencostUrl: string;
}

export function loadConfig(env: Record<string, string | undefined>) {
  const get = (name: string, fallback = "") => env[name]?.trim() || fallback;
  const port = (name: string, fallback: string) => {
    const value = Number(get(name, fallback));
    if (!Number.isInteger(value) || value < 0 || value > 65535)
      throw new Error(`${name} is not a port number`);
    return value;
  };
  const quantity = (name: string, fallback: string) => {
    const value = parseQuantity(get(name, fallback));
    if (value === null || value <= 0)
      throw new Error(`${name} is not a positive quantity`);
    return value;
  };
  const amount = (name: string, fallback: string, unitMs: number) => {
    const value = Number(get(name, fallback));
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`${name} is not a number of at least 0`);
    return Math.round(value * unitMs);
  };
  const maxWorkspaces = Number(get("DAEDALUS_GATEWAY_MAX_WORKSPACES", "5"));
  if (!Number.isInteger(maxWorkspaces) || maxWorkspaces < 1)
    throw new Error("DAEDALUS_GATEWAY_MAX_WORKSPACES is not a count");
  const config: GatewayConfig = {
    port: port("DAEDALUS_GATEWAY_PORT", "8080"),
    runnerPort: port("DAEDALUS_GATEWAY_RUNNER_PORT", "8081"),
    dbPath: get("DAEDALUS_GATEWAY_DB", "/data/gateway.sqlite"),
    devLogin: get("DAEDALUS_GATEWAY_DEV_LOGIN") === "true",
    publicUrl: get("DAEDALUS_GATEWAY_PUBLIC_URL"),
    internalUrl: get("DAEDALUS_GATEWAY_INTERNAL_URL"),
    namespace: get("DAEDALUS_GATEWAY_NAMESPACE"),
    serviceAccount: get("DAEDALUS_GATEWAY_SERVICE_ACCOUNT", "daedalus-gateway"),
    maxWorkspaces,
    runner: {
      image: get("DAEDALUS_RUNNER_IMAGE", "daedalus-runner:dev"),
      pullPolicy: get("DAEDALUS_RUNNER_IMAGE_PULL_POLICY", "IfNotPresent"),
    },
    workspace: {
      storageClass: get("DAEDALUS_WORKSPACE_STORAGE_CLASS"),
      storageSize: get("DAEDALUS_WORKSPACE_STORAGE_SIZE", "20Gi"),
      stateSize: get("DAEDALUS_WORKSPACE_STATE_SIZE", "1Gi"),
      requests: {
        cpu: get("DAEDALUS_WORKSPACE_CPU_REQUEST", "1"),
        memory: get("DAEDALUS_WORKSPACE_MEMORY_REQUEST", "2Gi"),
      },
      limits: {
        cpu: get("DAEDALUS_WORKSPACE_CPU_LIMIT", "2"),
        memory: get("DAEDALUS_WORKSPACE_MEMORY_LIMIT", "4Gi"),
      },
      max: {
        cpu: quantity("DAEDALUS_WORKSPACE_CPU_MAX", "4"),
        memory: quantity("DAEDALUS_WORKSPACE_MEMORY_MAX", "8Gi"),
      },
      ephemeral: {
        request: get("DAEDALUS_WORKSPACE_EPHEMERAL_REQUEST", "1Gi"),
        limit: get("DAEDALUS_WORKSPACE_EPHEMERAL_LIMIT", "4Gi"),
      },
      cacheSize: get("DAEDALUS_WORKSPACE_CACHE_SIZE", "2Gi"),
      tmpSize: get("DAEDALUS_WORKSPACE_TMP_SIZE", "1Gi"),
      runtimeClass: get("DAEDALUS_WORKSPACE_RUNTIME_CLASS"),
      idleMinutes: get("DAEDALUS_WORKSPACE_IDLE_MINUTES", "15"),
    },
    tenantDir: get("DAEDALUS_TENANT_DIR", "/etc/daedalus/tenant"),
    retention: {
      asleepMs: amount("DAEDALUS_WORKSPACE_ASLEEP_DAYS", "30", 86_400_000),
    },
    collectMs: Math.max(
      1_000,
      amount("DAEDALUS_GATEWAY_COLLECT_SECONDS", "3600", 1_000),
    ),
    admin: null,
  };
  const adminPort = port("DAEDALUS_GATEWAY_ADMIN_PORT", "0");
  if (adminPort !== 0) {
    const opencostUrl = get("DAEDALUS_GATEWAY_OPENCOST_URL");
    if (opencostUrl && !/^https?:\/\/[^\s]+$/i.test(opencostUrl))
      throw new Error("DAEDALUS_GATEWAY_OPENCOST_URL is not an http(s) URL");
    const sessionMs = amount(
      "DAEDALUS_GATEWAY_ADMIN_SESSION_HOURS",
      "8",
      3_600_000,
    );
    if (sessionMs <= 0)
      throw new Error("DAEDALUS_GATEWAY_ADMIN_SESSION_HOURS must be above 0");
    config.admin = {
      port: adminPort,
      host: get("DAEDALUS_GATEWAY_ADMIN_HOST", "127.0.0.1"),
      hosts: get("DAEDALUS_GATEWAY_ADMIN_HOSTS")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
      trustedProxies: get("DAEDALUS_GATEWAY_ADMIN_TRUSTED_PROXIES")
        .split(",")
        .map((address) => address.trim().toLowerCase())
        .filter(Boolean),
      tokenDir: get("DAEDALUS_GATEWAY_ADMIN_TOKEN_DIR", "/etc/daedalus/admin"),
      sessionMs,
      opencostUrl,
    };
    if (adminPort === config.port || adminPort === config.runnerPort)
      throw new Error("The admin port must differ from the other two");
  }
  if (config.port === config.runnerPort && config.port !== 0)
    throw new Error("The public and runner ports must differ");
  if (!config.internalUrl)
    throw new Error("DAEDALUS_GATEWAY_INTERNAL_URL is not set");
  if (!config.namespace)
    throw new Error("DAEDALUS_GATEWAY_NAMESPACE is not set");
  return config;
}

/**
 * The gateway's settings, all from its environment. The Helm chart sets
 * these from its values (see TEAM.md "Helm values"); the names are agreed
 * with the chart and recorded there.
 */
export interface GatewayConfig {
  port: number;
  /** SQLite file on the gateway's volume. */
  dbPath: string;
  /** Whether POST /v1/dev/login is served. */
  devLogin: boolean;
  /** How Macs reach the gateway; informational for now. */
  publicUrl: string;
  /** The in-cluster Service URL a runner pod connects to. */
  internalUrl: string;
  /** Where the gateway runs, for the RoleBinding it puts in each tenant. */
  namespace: string;
  serviceAccount: string;
  runner: { image: string; pullPolicy: string };
  workspace: {
    storageClass: string;
    storageSize: string;
    requests: { cpu: string; memory: string };
    limits: { cpu: string; memory: string };
    runtimeClass: string;
    idleMinutes: string;
  };
  /** Directory holding the chart's `daedalus-tenant` ConfigMap files. */
  tenantDir: string;
}

export function loadConfig(env: Record<string, string | undefined>) {
  const get = (name: string, fallback = "") => env[name]?.trim() || fallback;
  const port = Number(get("DAEDALUS_GATEWAY_PORT", "8080"));
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("DAEDALUS_GATEWAY_PORT is not a port number");
  const config: GatewayConfig = {
    port,
    dbPath: get("DAEDALUS_GATEWAY_DB", "/data/gateway.sqlite"),
    devLogin: get("DAEDALUS_GATEWAY_DEV_LOGIN") === "true",
    publicUrl: get("DAEDALUS_GATEWAY_PUBLIC_URL"),
    internalUrl: get("DAEDALUS_GATEWAY_INTERNAL_URL"),
    namespace: get("DAEDALUS_GATEWAY_NAMESPACE"),
    serviceAccount: get("DAEDALUS_GATEWAY_SERVICE_ACCOUNT", "daedalus-gateway"),
    runner: {
      image: get("DAEDALUS_RUNNER_IMAGE", "daedalus-runner:dev"),
      pullPolicy: get("DAEDALUS_RUNNER_IMAGE_PULL_POLICY", "IfNotPresent"),
    },
    workspace: {
      storageClass: get("DAEDALUS_WORKSPACE_STORAGE_CLASS"),
      storageSize: get("DAEDALUS_WORKSPACE_STORAGE_SIZE", "20Gi"),
      requests: {
        cpu: get("DAEDALUS_WORKSPACE_CPU_REQUEST", "1"),
        memory: get("DAEDALUS_WORKSPACE_MEMORY_REQUEST", "2Gi"),
      },
      limits: {
        cpu: get("DAEDALUS_WORKSPACE_CPU_LIMIT", "2"),
        memory: get("DAEDALUS_WORKSPACE_MEMORY_LIMIT", "4Gi"),
      },
      runtimeClass: get("DAEDALUS_WORKSPACE_RUNTIME_CLASS"),
      idleMinutes: get("DAEDALUS_WORKSPACE_IDLE_MINUTES", "30"),
    },
    tenantDir: get("DAEDALUS_TENANT_DIR", "/etc/daedalus/tenant"),
  };
  if (!config.internalUrl)
    throw new Error("DAEDALUS_GATEWAY_INTERNAL_URL is not set");
  if (!config.namespace)
    throw new Error("DAEDALUS_GATEWAY_NAMESPACE is not set");
  return config;
}

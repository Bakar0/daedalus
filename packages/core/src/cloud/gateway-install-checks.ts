import type {
  GatewayCheckDto,
  GatewayDryRunDto,
  GatewayImagesDto,
  KubeContextDto,
} from "@daedalus/protocol";

/**
 * The pure half of the gateway install
 * (artifacts/cloud-sessions/gateway-install-api.md): reading what kubectl
 * and helm print into checks, and checking what the window sends. Nothing
 * here runs a command.
 */

export const RELEASE_NAME = "daedalus";
export const DEFAULT_NAMESPACE = "daedalus";
export const ADMIN_SECRET = "daedalus-admin";
export const GATEWAY_SERVICE = `${RELEASE_NAME}-gateway`;
export const MIN_KUBERNETES_MINOR = 30;

/** jsonpath for the kubeconfig's contexts: name and cluster, nothing else. */
export const CONTEXTS_JSONPATH =
  '{range .contexts[*]}{.name}{"\\t"}{.context.cluster}{"\\n"}{end}';
/** jsonpath for the kubeconfig's clusters: name and server URL only. */
export const CLUSTERS_JSONPATH =
  '{range .clusters[*]}{.name}{"\\t"}{.cluster.server}{"\\n"}{end}';
/**
 * jsonpath for each cluster's CA, read with `--raw` because without it
 * kubectl prints DATA+OMITTED. A CA is public; the query selects nothing
 * under users, so no credential is printed.
 */
export const CLUSTER_CAS_JSONPATH =
  '{range .clusters[*]}{.name}{"\\t"}{.cluster.certificate-authority-data}{"\\t"}{.cluster.certificate-authority}{"\\n"}{end}';

/** A context with what the install binds its checks to. */
export interface KubeContextTarget {
  name: string;
  server: string;
  /** sha256 of the cluster's CA data or file path; "" when there is none. */
  caFingerprint: string;
}

/** The contexts with server and CA fingerprint, from the three listings. */
export function parseContextTargets(
  contexts: string,
  clusters: string,
  cas: string,
  hash: (data: string, file: string) => string,
): KubeContextTarget[] {
  const servers = new Map<string, string>();
  for (const line of clusters.split("\n")) {
    const [name, server] = line.split("\t");
    if (name && server) servers.set(name, server.trim());
  }
  const fingerprints = new Map<string, string>();
  for (const line of cas.split("\n")) {
    const [name, data, file] = line.split("\t");
    if (name && (data || file))
      fingerprints.set(name, hash(data ?? "", file ?? ""));
  }
  const seen = new Set<string>();
  const result: KubeContextTarget[] = [];
  for (const line of contexts.split("\n")) {
    const [name, cluster] = line.split("\t");
    if (!name || !validContextName(name) || seen.has(name)) continue;
    seen.add(name);
    result.push({
      name,
      server: servers.get(cluster ?? "") ?? "",
      caFingerprint: fingerprints.get(cluster ?? "") ?? "",
    });
  }
  return result;
}

/** The host of a server URL, or "" when it is not one. */
export function serverHost(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return "";
  }
}

/**
 * Contexts from the two jsonpath listings, in kubeconfig order. A context
 * whose name could be taken for a flag, or holds a control character, is
 * left out: it would not survive being passed back as `--context=<name>`.
 */
export function parseContexts(
  contexts: string,
  clusters: string,
): KubeContextDto[] {
  const servers = new Map<string, string>();
  for (const line of clusters.split("\n")) {
    const [name, server] = line.split("\t");
    if (name && server) servers.set(name, server.trim());
  }
  const seen = new Set<string>();
  const result: KubeContextDto[] = [];
  for (const line of contexts.split("\n")) {
    const [name, cluster] = line.split("\t");
    if (!name || !validContextName(name) || seen.has(name)) continue;
    seen.add(name);
    result.push({
      name,
      serverHost: serverHost(servers.get(cluster ?? "") ?? ""),
    });
  }
  return result;
}

export function validContextName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return (
    name.length > 0 && !name.startsWith("-") && !/[\u0000-\u001f]/.test(name)
  );
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const REGISTRY = /^[a-z0-9]([a-z0-9._:/-]{0,250}[a-z0-9])?$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export function validNamespace(namespace: string): boolean {
  return DNS_LABEL.test(namespace);
}

/** Namespaces the install never uses: Kubernetes' own and the egress check's. */
export function reservedNamespace(namespace: string): boolean {
  return (
    namespace === "default" ||
    namespace.startsWith("kube-") ||
    namespace.startsWith("daedalus-egress-")
  );
}

export const POD_SECURITY_LABEL = "pod-security.kubernetes.io/enforce";

/**
 * Whether the namespace is new, holds this chart's release (the only kind of
 * existing namespace the install takes), or is someone else's.
 */
export type NamespaceState =
  | { kind: "new" }
  | { kind: "release"; podSecurity: string | null }
  | { kind: "taken" }
  | { kind: "unknown" };

export function namespaceCheck(
  namespace: string,
  state: NamespaceState,
): GatewayCheckDto {
  switch (state.kind) {
    case "new":
      return {
        id: "namespace",
        status: "pass",
        label: `New namespace ${namespace}`,
      };
    case "release":
      return {
        id: "namespace",
        status: "pass",
        label: `Namespace ${namespace} holds this gateway`,
      };
    case "taken":
      return {
        id: "namespace",
        status: "fail",
        label: `Namespace ${namespace} already exists`,
        detail:
          "It holds no Daedalus gateway, and the install would change its Pod Security label. Choose a new namespace.",
      };
    case "unknown":
      return {
        id: "namespace",
        status: "fail",
        label: `Could not tell what namespace ${namespace} holds`,
        detail:
          "The helm releases could not be listed. Choose a new namespace.",
      };
  }
}

/**
 * The few values of an installed release the app looks at, read from
 * `helm get values -o json`. Nothing else of that output is kept: it can hold
 * whatever an operator passed.
 */
export interface InstalledValues {
  devLogin: boolean;
  publicUrl: string;
  images: GatewayImagesDto | null;
  storageClass: string;
}

export function parseInstalledValues(json: string): InstalledValues {
  let values: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object")
      values = parsed as Record<string, unknown>;
  } catch {
    // An unreadable answer reads as the chart's defaults.
  }
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const gateway = object(values.gateway);
  const gatewayImage = object(object(values.image).gateway);
  const repository = text(gatewayImage.repository);
  const tag = text(gatewayImage.tag);
  const registry = repository.endsWith("/daedalus-gateway")
    ? repository.slice(0, -"/daedalus-gateway".length)
    : "";
  const images = registry && tag ? { registry, tag } : null;
  return {
    devLogin: gateway.devLogin === true,
    publicUrl: text(gateway.publicUrl),
    images: images && validImages(images) ? images : null,
    storageClass: text(object(gateway.storage).storageClass),
  };
}

/** Whether a gateway URL is this Mac's own port-forward. */
export function loopbackPort(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")
      return null;
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

export function validStorageClass(name: string): boolean {
  return DNS_SUBDOMAIN.test(name);
}

export function validImages(images: GatewayImagesDto): boolean {
  return REGISTRY.test(images.registry) && TAG.test(images.tag);
}

export function imageRefs(images: GatewayImagesDto): {
  gateway: string;
  runner: string;
} {
  const registry = images.registry.replace(/\/+$/, "");
  return {
    gateway: `${registry}/daedalus-gateway:${images.tag}`,
    runner: `${registry}/daedalus-runner:${images.tag}`,
  };
}

export const MIN_HELM = { major: 3, minor: 14 };

/** `helm version --short`, such as "v3.19.0+g3d8990f". */
export function helmCheck(short: string | null): GatewayCheckDto {
  const match = /v(\d+)\.(\d+)/.exec(short ?? "");
  if (!match)
    return {
      id: "helm",
      status: "fail",
      label: "Could not tell the helm version",
      detail: `The install needs helm ${MIN_HELM.major}.${MIN_HELM.minor} or later (brew upgrade helm).`,
    };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const ok =
    major > MIN_HELM.major ||
    (major === MIN_HELM.major && minor >= MIN_HELM.minor);
  return ok
    ? { id: "helm", status: "pass", label: `helm ${major}.${minor}` }
    : {
        id: "helm",
        status: "fail",
        label: `helm ${major}.${minor} is too old`,
        detail: `Upgrades keep the installed values with --reset-then-reuse-values, which needs helm ${MIN_HELM.major}.${MIN_HELM.minor} or later (brew upgrade helm).`,
      };
}

/** `kubectl version -o json`'s server version, as major and minor. */
export function parseServerVersion(
  json: string,
): { major: number; minor: number; text: string } | null {
  try {
    const parsed = JSON.parse(json) as {
      serverVersion?: { major?: string; minor?: string; gitVersion?: string };
    };
    const major = Number.parseInt(parsed.serverVersion?.major ?? "", 10);
    // EKS reports minors like "30+".
    const minor = Number.parseInt(parsed.serverVersion?.minor ?? "", 10);
    if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
    return { major, minor, text: `${major}.${minor}` };
  } catch {
    return null;
  }
}

export function versionCheck(json: string): GatewayCheckDto {
  const version = parseServerVersion(json);
  if (!version)
    return {
      id: "version",
      status: "unknown",
      label: "Kubernetes version unknown",
    };
  const ok =
    version.major > 1 ||
    (version.major === 1 && version.minor >= MIN_KUBERNETES_MINOR);
  return ok
    ? { id: "version", status: "pass", label: `Kubernetes ${version.text}` }
    : {
        id: "version",
        status: "fail",
        label: `Kubernetes ${version.text}`,
        detail: `The gateway needs Kubernetes 1.${MIN_KUBERNETES_MINOR} or later (ValidatingAdmissionPolicy).`,
      };
}

/** What the chart and the install create, for `kubectl auth can-i`. */
export interface Permission {
  verb: string;
  resource: string;
  namespaced: boolean;
}

export function installPermissions(namespaceExists: boolean): Permission[] {
  const cluster = (verb: string, resource: string): Permission => ({
    verb,
    resource,
    namespaced: false,
  });
  const inNamespace = (resource: string): Permission => ({
    verb: "create",
    resource,
    namespaced: true,
  });
  return [
    namespaceExists
      ? cluster("patch", "namespaces")
      : cluster("create", "namespaces"),
    cluster("create", "clusterroles.rbac.authorization.k8s.io"),
    cluster("create", "clusterrolebindings.rbac.authorization.k8s.io"),
    cluster("create", "runtimeclasses.node.k8s.io"),
    cluster(
      "create",
      "validatingadmissionpolicies.admissionregistration.k8s.io",
    ),
    cluster(
      "create",
      "validatingadmissionpolicybindings.admissionregistration.k8s.io",
    ),
    inNamespace("deployments.apps"),
    inNamespace("services"),
    inNamespace("serviceaccounts"),
    inNamespace("configmaps"),
    inNamespace("persistentvolumeclaims"),
    inNamespace("networkpolicies.networking.k8s.io"),
    inNamespace("secrets"),
  ];
}

export function permissionsCheck(
  results: { permission: Permission; allowed: boolean | null }[],
): GatewayCheckDto {
  const missing = results.filter((result) => result.allowed === false);
  const unknown = results.filter((result) => result.allowed === null);
  if (missing.length > 0)
    return {
      id: "permissions",
      status: "fail",
      label: "Missing permissions",
      detail: missing
        .map(({ permission }) => `${permission.verb} ${permission.resource}`)
        .join("\n"),
    };
  if (unknown.length > 0)
    return {
      id: "permissions",
      status: "unknown",
      label: "Some permissions could not be checked",
      detail: unknown
        .map(({ permission }) => `${permission.verb} ${permission.resource}`)
        .join("\n"),
    };
  return {
    id: "permissions",
    status: "pass",
    label: "You can create everything the chart needs",
  };
}

/** `kubectl auth can-i`: "yes" exits 0, "no" exits 1; anything else is unknown. */
export function canIAnswer(exitCode: number, stdout: string): boolean | null {
  const answer = stdout.trim().split("\n").pop()?.trim();
  if (answer === "yes") return true;
  if (answer === "no" || (exitCode === 1 && answer === "")) return false;
  return null;
}

/** Lines of `<name>\t<is-default-class annotation>`. */
export function storageClassCheck(
  listing: string,
  wanted: string | undefined,
): GatewayCheckDto {
  const classes = listing
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([name]) => !!name)
    .map(([name, flag]) => ({ name: name!, default: flag?.trim() === "true" }));
  const names = classes.map((entry) => entry.name);
  if (wanted)
    return names.includes(wanted)
      ? {
          id: "storageClass",
          status: "pass",
          label: `StorageClass ${wanted}`,
        }
      : {
          id: "storageClass",
          status: "fail",
          label: `No StorageClass named ${wanted}`,
          detail: names.length
            ? `The cluster has: ${names.join(", ")}`
            : "The cluster has none.",
        };
  const fallback = classes.find((entry) => entry.default);
  if (fallback)
    return {
      id: "storageClass",
      status: "pass",
      label: `Default StorageClass ${fallback.name}`,
    };
  return {
    id: "storageClass",
    status: "fail",
    label: "No default StorageClass",
    detail: names.length
      ? `Choose one for the gateway's and the workspaces' volumes: ${names.join(", ")}`
      : "The cluster has no StorageClass, so volumes cannot be made.",
  };
}

/** Lines of `<node>\t<runtime handler names separated by spaces>`. */
export function gvisorCheck(
  listing: string,
  handler = "runsc",
): GatewayCheckDto {
  const nodes = listing
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([name]) => !!name)
    .map(([name, handlers]) => ({
      name: name!,
      handlers: (handlers ?? "").split(/\s+/).filter(Boolean),
    }));
  const reporting = nodes.filter((node) => node.handlers.length > 0);
  const offering = reporting.filter((node) => node.handlers.includes(handler));
  if (offering.length > 0)
    return {
      id: "gvisor",
      status: "pass",
      label: `gVisor on ${offering.length} of ${nodes.length} node${nodes.length === 1 ? "" : "s"}`,
    };
  if (reporting.length > 0)
    return {
      id: "gvisor",
      status: "fail",
      label: "No node offers gVisor (runsc)",
      detail:
        "Workspaces run sandboxed in gVisor. Install runsc on the nodes (deploy/README.md; deploy/kind/gvisor.sh on kind).",
    };
  return {
    id: "gvisor",
    status: "unknown",
    label: "Could not tell whether nodes offer gVisor",
    detail:
      "No node reports its runtime handlers. Workspace pods start only on nodes with runsc.",
  };
}

/**
 * Lines of `<daemonset>\t<container images>`. A NetworkPolicy object is
 * accepted by every cluster; only the network plugin enforces it, so this
 * looks for one known to.
 */
/**
 * EKS: the VPC CNI enforces NetworkPolicy only with its node agent running
 * with `--enable-network-policy=true`. Lines of `<container>\t<args JSON>`
 * from the aws-node DaemonSet; null when there is no aws-node.
 */
export function vpcCniPolicy(containers: string | null): boolean | null {
  if (containers === null) return null;
  const agent = containers
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([name]) => name === "aws-eks-nodeagent");
  if (!agent) return false;
  return /--enable-network-policy=true/.test(agent[1] ?? "");
}

export function networkPolicyCheck(
  listing: string | null,
  vpcCni: boolean | null = null,
): GatewayCheckDto {
  if (vpcCni === true)
    return {
      id: "networkPolicy",
      status: "pass",
      label: "NetworkPolicy enforced by the VPC CNI",
    };
  if (vpcCni === false)
    return {
      id: "networkPolicy",
      status: "fail",
      label: "The VPC CNI does not enforce NetworkPolicy",
      detail:
        'Without it workspaces reach the instance metadata and the VPC. Turn it on in the vpc-cni add-on: configuration values {"enableNetworkPolicy": "true"} (deploy/eks/README.md).',
    };
  const unknown: GatewayCheckDto = {
    id: "networkPolicy",
    status: "unknown",
    label: "NetworkPolicy enforcement unknown",
    detail:
      "Workspaces are kept apart by NetworkPolicy. Make sure the cluster's network plugin enforces it (on EKS: the VPC CNI with network policy turned on).",
  };
  if (listing === null) return unknown;
  const known: [RegExp, string][] = [
    [/calico\/node|calico-node/, "Calico"],
    [/cilium/, "Cilium"],
    [/antrea/, "Antrea"],
    [/kube-router/, "kube-router"],
    [/weave-npc/, "Weave Net"],
    [/kindnetd/, "kindnet"],
  ];
  for (const [pattern, name] of known)
    if (pattern.test(listing))
      return {
        id: "networkPolicy",
        status: "pass",
        label: `NetworkPolicy enforced by ${name}`,
      };
  return unknown;
}

export interface HelmRelease {
  name: string;
  namespace: string;
  revision: number;
  chart: string;
  status: string;
}

/** `helm list -o json`. */
export function parseReleases(json: string): HelmRelease[] {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => ({
      name: String(entry.name ?? ""),
      namespace: String(entry.namespace ?? ""),
      revision: Number.parseInt(String(entry.revision ?? "0"), 10) || 0,
      chart: String(entry.chart ?? ""),
      status: String(entry.status ?? ""),
    }));
  } catch {
    return [];
  }
}

const isDaedalusChart = (release: HelmRelease) =>
  /^daedalus-\d/.test(release.chart);

export function releaseCheck(
  releases: HelmRelease[],
  namespace: string,
): { check: GatewayCheckDto; release: HelmRelease | null } {
  const here = releases.find(
    (release) =>
      release.namespace === namespace && release.name === RELEASE_NAME,
  );
  const elsewhere = releases.find(
    (release) => isDaedalusChart(release) && release !== here,
  );
  if (elsewhere)
    return {
      release: here ?? null,
      check: {
        id: "release",
        status: "fail",
        label: `A Daedalus gateway is already in namespace ${elsewhere.namespace}`,
        detail: `Release ${elsewhere.name}. The chart's cluster-wide objects allow one gateway per cluster; install into ${elsewhere.namespace} to upgrade it.`,
      },
    };
  if (here && !isDaedalusChart(here))
    return {
      release: here,
      check: {
        id: "release",
        status: "fail",
        label: `Release ${RELEASE_NAME} in ${namespace} is another chart (${here.chart})`,
      },
    };
  if (here)
    return {
      release: here,
      check: {
        id: "release",
        status: here.status === "deployed" ? "pass" : "warn",
        label: `Upgrades the gateway installed here (revision ${here.revision})`,
        ...(here.status === "deployed"
          ? {}
          : { detail: `Its last change is ${here.status}.` }),
      },
    };
  return {
    release: null,
    check: { id: "release", status: "pass", label: "No gateway installed yet" },
  };
}

export function imagesCheck(
  context: string,
  images: GatewayImagesDto | undefined,
): GatewayCheckDto {
  if (images) {
    const refs = imageRefs(images);
    return {
      id: "images",
      status: "unknown",
      label: `Images from ${images.registry}, tag ${images.tag}`,
      detail: `The cluster must be able to pull ${refs.gateway} and ${refs.runner} (deploy/eks/README.md, pushing the images).`,
    };
  }
  if (context.startsWith("kind-"))
    return {
      id: "images",
      status: "unknown",
      label: "Images daedalus-gateway:dev and daedalus-runner:dev",
      detail: "They must already be loaded into the kind nodes.",
    };
  return {
    id: "images",
    status: "fail",
    label: "Image registry needed",
    detail:
      "Enter the registry and tag the cluster pulls the Daedalus images from (deploy/eks/README.md, pushing the images).",
  };
}

const CLUSTER_KINDS = new Set([
  "Namespace",
  "ClusterRole",
  "ClusterRoleBinding",
  "RuntimeClass",
  "ValidatingAdmissionPolicy",
  "ValidatingAdmissionPolicyBinding",
  "StorageClass",
  "PriorityClass",
  "CustomResourceDefinition",
]);

/**
 * The objects in helm's dry-run output (its HOOKS and MANIFEST sections)
 * and its NOTES. Reads only top-level `kind` and `metadata` name and
 * namespace, so it needs no YAML parser.
 */
export function parseDryRun(
  output: string,
  namespace: string,
): Pick<GatewayDryRunDto, "objects" | "notes"> {
  const notesAt = output.search(/^NOTES:$/m);
  const body = notesAt < 0 ? output : output.slice(0, notesAt);
  const notes = notesAt < 0 ? "" : output.slice(notesAt + 7).trim();
  const objects: GatewayDryRunDto["objects"] = [];
  for (const document of body.split(/^---\s*$/m)) {
    const kind = /^kind:\s*(\S+)\s*$/m.exec(document)?.[1];
    if (!kind) continue;
    const metadata =
      /^metadata:\s*\n((?:[ ]+.*\n?|\s*\n)*)/m.exec(document)?.[1] ?? "";
    const name = /^ {2}name:\s*"?([^"\s]+)"?\s*$/m.exec(metadata)?.[1];
    if (!name) continue;
    const explicit = /^ {2}namespace:\s*"?([^"\s]+)"?\s*$/m.exec(metadata)?.[1];
    objects.push({
      kind,
      name,
      namespace: CLUSTER_KINDS.has(kind) ? null : (explicit ?? namespace),
    });
  }
  return { objects, notes };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** A command's output as log lines: no colour codes, no blank lines, capped. */
export function logLines(text: string, max = 20): string[] {
  return text
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-max)
    .map((line) => (line.length > 300 ? `${line.slice(0, 297)}...` : line));
}

/** The last useful lines of a failed command, for the user. */
export function failureText(stderr: string, stdout = ""): string {
  const lines = logLines(stderr || stdout, 6);
  return lines.join("\n") || "The command failed without saying why";
}

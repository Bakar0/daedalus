import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loginShellPath,
  runCommand,
  writeKeychainPassword,
  type CommandOptions,
  type CommandResult,
} from "@daedalus/platform";
import type {
  GatewayCheckDto,
  GatewayDryRunDto,
  GatewayInstallDto,
  GatewayInstallTargetInput,
  GatewayPreflightDto,
  GatewayToolDto,
  GatewayToolsDto,
  KubeContextDto,
} from "@daedalus/protocol";
import { DaedalusError } from "../errors";
import {
  ADMIN_SECRET,
  canIAnswer,
  CLUSTER_CAS_JSONPATH,
  CLUSTERS_JSONPATH,
  CONTEXTS_JSONPATH,
  DEFAULT_NAMESPACE,
  failureText,
  GATEWAY_SERVICE,
  gvisorCheck,
  helmCheck,
  imageRefs,
  imagesCheck,
  installPermissions,
  loopbackPort,
  logLines,
  namespaceCheck,
  networkPolicyCheck,
  parseContexts,
  parseContextTargets,
  parseInstalledValues,
  POD_SECURITY_LABEL,
  reservedNamespace,
  vpcCniPolicy,
  type InstalledValues,
  type KubeContextTarget,
  type NamespaceState,
  parseDryRun,
  parseReleases,
  permissionsCheck,
  RELEASE_NAME,
  releaseCheck,
  storageClassCheck,
  validContextName,
  validImages,
  validNamespace,
  validStorageClass,
  versionCheck,
} from "./gateway-install-checks";

/**
 * Installing the Daedalus gateway onto a Kubernetes cluster from the app
 * (artifacts/cloud-sessions/gateway-install-api.md).
 *
 * The rules this class keeps, whatever the window asks:
 * - the kubeconfig is read through jsonpath for names and server URLs only;
 * - every kubectl call carries `--context=` and every helm call
 *   `--kube-context=`, so the kubeconfig's current-context is never used,
 *   and nothing here changes it;
 * - nothing is written to a user's cluster unless the same input passed a
 *   preflight and a dry run in this run, and the user typed the context name;
 * - the local cluster has its own kubeconfig file, so `kind` never touches
 *   the user's.
 */

export const LOCAL_CLUSTER = "daedalus-local";
export const LOCAL_CONTEXT = `kind-${LOCAL_CLUSTER}`;
const LOCAL_NODE_PORT = 30080;
const LOCAL_IMAGE_TAG = "local";
const KIND_NODE_IMAGE = "kindest/node:v1.33.1";
const CHECK_VALID_MS = 15 * 60_000;
const MAX_LOG = 200;
const REQUEST_TIMEOUT = "--request-timeout=20s";
const KEYCHAIN_SERVICE = "dev.daedalus.gateway-admin";

type Tool = GatewayToolDto["name"];

const HINTS: Record<Tool, string> = {
  kubectl: "brew install kubectl",
  helm: "brew install helm",
  kind: "brew install kind",
  docker: "Install Docker Desktop (or OrbStack, or Colima) and start it",
};

/** Where kubectl and helm point: a context, and for the local cluster its file. */
interface Target {
  context: string;
  kubeconfig?: string;
}

interface ResolvedInput {
  context: string;
  /** What the context pointed at when read; part of the checks' key. */
  server: string;
  caFingerprint: string;
  namespace: string;
  storageClass?: string;
  images?: { registry: string; tag: string };
}

interface PreflightRecord {
  at: number;
  ready: boolean;
  acknowledge: "networkPolicy"[];
  state: NamespaceState;
  installed: InstalledValues | null;
}

type StartInput = GatewayInstallTargetInput & {
  dryRunId: string;
  confirm: string;
  email: string;
  publicUrl?: string;
  devLogin?: boolean;
  acknowledgeDevLogin?: boolean;
  acknowledgeNetworkPolicy?: boolean;
};

/** The label the egress check puts on its namespaces; it deletes only those. */
const EGRESS_LABEL = "daedalus.dev/egress-check";
const FORWARD_CHECK_MS = 30_000;

/** One egress check's two namespaces, named for its run. */
function egressNamespaces(id: string): { probe: string; control: string } {
  return {
    probe: `daedalus-egress-check-${id}`,
    control: `daedalus-egress-control-${id}`,
  };
}

/** Shown in the dry run: the egress check's namespaces, made and removed after the install. */
function egressObjects(id: string): GatewayDryRunDto["objects"] {
  const names = egressNamespaces(id);
  return [
    {
      kind: "Namespace",
      name: names.probe,
      namespace: null,
      note: `temporary: the egress check after the install, with the workspaces' NetworkPolicy and one pod; label ${EGRESS_LABEL}=${id}; deleted after`,
    },
    {
      kind: "Namespace",
      name: names.control,
      namespace: null,
      note: `temporary: the egress check's control pod; label ${EGRESS_LABEL}=${id}; deleted after`,
    },
  ];
}

/** Prints "open" or "blocked" for host and port (from egress-check.sh). */
const PROBE_SCRIPT = `const [host, port] = [process.argv[1], Number(process.argv[2])];
const done = (r) => { console.log(r); process.exit(0); };
setTimeout(() => done("blocked"), 3000);
Bun.connect({ hostname: host, port, socket: { open() { done("open") }, data() {} } }).catch(() => done("blocked"));`;

function egressPod(image: string): unknown {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "probe" },
    spec: {
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "probe",
          image,
          imagePullPolicy: "IfNotPresent",
          command: ["sleep", "600"],
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
          resources: {
            requests: { cpu: "50m", memory: "64Mi" },
            limits: { cpu: "500m", memory: "256Mi" },
          },
        },
      ],
    },
  };
}

/** The port-forward the app keeps for a gateway only this Mac reaches. */
export interface PortForwardRecord {
  context: string;
  namespace: string;
  port: number;
  gatewayUrl: string;
  /**
   * Whether the Cloud sign-in has used this gateway. Until then the forward
   * stays: a sign-in that failed at the end of an install leaves the gateway
   * reachable for the next try. After it, signing out or in elsewhere ends it.
   */
  signedIn?: boolean;
}

export interface ForwardProcess {
  exited: Promise<unknown>;
  kill(): void;
}

export interface GatewayInstallerOptions {
  /** The app's home; the local kubeconfig and the port-forward record go under `cloud/`. */
  home: string;
  chartDirectory: string;
  kindDirectory: string;
  /** A Daedalus checkout with the gateway and runner Dockerfiles, when there is one. */
  sourceRoot?: string;
  signIn(gatewayUrl: string, email: string): Promise<unknown>;
  /** The gateway the Cloud sign-in uses now, to know whether to keep a port-forward. */
  signedInGateway?(): Promise<string | null>;
  run?: (
    executable: string,
    args: string[],
    options?: CommandOptions,
  ) => Promise<CommandResult>;
  spawn?: (argv: string[], env: Record<string, string>) => ForwardProcess;
  /** The PATH the user's terminal has. */
  path?: () => Promise<string | undefined>;
  which?: (name: string, path: string) => string | null;
  saveAdminToken?: (account: string, token: string) => Promise<void>;
  fetch?: typeof fetch;
  freePort?: () => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * The context flags go before a `--`: after it they would be the remote
 * command's arguments (`kubectl exec ... -- bun ...`), and kubectl would
 * fall back to the kubeconfig's current-context.
 */
export function withTargetFlags(args: string[], flags: string[]): string[] {
  const end = args.indexOf("--");
  return end < 0
    ? [...args, ...flags]
    : [...args.slice(0, end), ...flags, ...args.slice(end)];
}

function key(input: ResolvedInput): string {
  return JSON.stringify([
    input.context,
    input.server,
    input.caFingerprint,
    input.namespace,
    input.storageClass ?? "",
    input.images?.registry ?? "",
    input.images?.tag ?? "",
  ]);
}

export class GatewayInstaller {
  #current: GatewayInstallDto | undefined;
  readonly #preflights = new Map<string, PreflightRecord>();
  readonly #dryRuns = new Map<
    string,
    { key: string; at: number; preflight: PreflightRecord; egressId: string }
  >();
  #adminToken: { token: string; secret: string; namespace: string } | undefined;
  #forward: { record: PortForwardRecord; stop(): void } | undefined;
  #closed = false;

  readonly #listeners = new Set<() => void>();

  constructor(private readonly options: GatewayInstallerOptions) {}

  /** Called on every phase and log line; returns the way to stop. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  current(): GatewayInstallDto | undefined {
    return this.#current
      ? { ...this.#current, log: [...this.#current.log] }
      : undefined;
  }

  get #now(): number {
    return (this.options.now ?? Date.now)();
  }

  get #cloudDirectory(): string {
    return join(this.options.home, "cloud");
  }

  get localKubeconfig(): string {
    return join(this.#cloudDirectory, `kind-${LOCAL_CLUSTER}.kubeconfig`);
  }

  get #forwardFile(): string {
    return join(this.#cloudDirectory, "gateway-port-forward.json");
  }

  async #env(
    extra: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const path =
      (await (this.options.path ?? loginShellPath)()) ?? process.env.PATH ?? "";
    return { PATH: path, ...extra };
  }

  async #which(tool: Tool): Promise<string | null> {
    const { PATH } = await this.#env();
    const which =
      this.options.which ??
      ((name: string, path: string) => Bun.which(name, { PATH: path }));
    return which(tool, PATH ?? "");
  }

  async #exec(
    tool: Tool,
    args: string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    const executable = await this.#which(tool);
    if (!executable)
      throw new DaedalusError(
        "DEPENDENCY",
        `${tool} is not installed: ${HINTS[tool]}`,
      );
    const run = this.options.run ?? runCommand;
    return run(executable, args, {
      timeoutMs: 60_000,
      ...options,
      env: { ...options.env, ...(await this.#env()) },
    });
  }

  #kubectl(
    target: Target,
    args: string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    return this.#exec(
      "kubectl",
      withTargetFlags(args, [
        `--context=${target.context}`,
        ...(target.kubeconfig ? [`--kubeconfig=${target.kubeconfig}`] : []),
      ]),
      options,
    );
  }

  #helm(
    target: Target,
    args: string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    return this.#exec(
      "helm",
      withTargetFlags(args, [
        `--kube-context=${target.context}`,
        ...(target.kubeconfig ? [`--kubeconfig=${target.kubeconfig}`] : []),
      ]),
      options,
    );
  }

  // ---- contexts and tools -------------------------------------------------

  async tools(): Promise<GatewayToolsDto> {
    const tools: GatewayToolDto[] = [];
    for (const name of ["kubectl", "helm", "kind", "docker"] as const) {
      const found = (await this.#which(name)) !== null;
      const tool: GatewayToolDto = { name, found };
      if (!found) tool.hint = HINTS[name];
      if (name === "docker" && found) {
        const info = await this.#exec(
          "docker",
          ["info", "--format", "{{.ServerVersion}}"],
          { timeoutMs: 10_000 },
        ).catch(() => null);
        tool.running = info?.exitCode === 0;
        if (!tool.running) tool.hint = "Start Docker";
      }
      tools.push(tool);
    }
    const contexts = tools[0]?.found ? await this.contexts() : [];
    return { contexts, tools };
  }

  async #configView(jsonpath: string, raw = false): Promise<string> {
    const result = await this.#exec(
      "kubectl",
      [
        "config",
        "view",
        ...(raw ? ["--raw"] : []),
        "-o",
        `jsonpath=${jsonpath}`,
      ],
      { timeoutMs: 10_000 },
    );
    return result.exitCode === 0 ? result.stdout : "";
  }

  /** Context names and server hosts; never a credential, never current-context. */
  async contexts(): Promise<KubeContextDto[]> {
    return parseContexts(
      await this.#configView(CONTEXTS_JSONPATH),
      await this.#configView(CLUSTERS_JSONPATH),
    );
  }

  /** The contexts with the server URL and CA fingerprint the checks are bound to. */
  async #contextTargets(): Promise<KubeContextTarget[]> {
    return parseContextTargets(
      await this.#configView(CONTEXTS_JSONPATH),
      await this.#configView(CLUSTERS_JSONPATH),
      await this.#configView(CLUSTER_CAS_JSONPATH, true),
      // The CA's bytes: the data itself, or the file a path names.
      (data, file) => {
        const sha = createHash("sha256");
        if (data) return sha.update(Buffer.from(data, "base64")).digest("hex");
        try {
          return sha.update(readFileSync(file)).digest("hex");
        } catch {
          return sha.update(`unreadable:${file}`).digest("hex");
        }
      },
    );
  }

  async #resolve(input: GatewayInstallTargetInput): Promise<ResolvedInput> {
    const context = input.context;
    if (typeof context !== "string" || !validContextName(context))
      throw new DaedalusError("VALIDATION", "Choose a context");
    if (context === LOCAL_CONTEXT)
      throw new DaedalusError(
        "VALIDATION",
        "The local cluster is installed with Try it locally",
      );
    const namespace = input.namespace?.trim() || DEFAULT_NAMESPACE;
    if (!validNamespace(namespace))
      throw new DaedalusError(
        "VALIDATION",
        "A namespace is lowercase letters, digits and dashes",
      );
    if (reservedNamespace(namespace))
      throw new DaedalusError(
        "VALIDATION",
        `Namespace ${namespace} is not for the gateway: choose a new one, such as daedalus`,
      );
    const known = (await this.#contextTargets()).find(
      (entry) => entry.name === context,
    );
    if (!known)
      throw new DaedalusError(
        "NOT_FOUND",
        `There is no context ${context} in the kubeconfig`,
      );
    const resolved: ResolvedInput = {
      context,
      namespace,
      server: known.server,
      caFingerprint: known.caFingerprint,
    };
    const storageClass = input.storageClass?.trim();
    if (storageClass) {
      if (!validStorageClass(storageClass))
        throw new DaedalusError(
          "VALIDATION",
          "That is not a StorageClass name",
        );
      resolved.storageClass = storageClass;
    }
    if (input.images && (input.images.registry || input.images.tag)) {
      const images = {
        registry: input.images.registry.trim(),
        tag: input.images.tag.trim(),
      };
      if (!validImages(images))
        throw new DaedalusError(
          "VALIDATION",
          "The registry is a host and path such as 123456789012.dkr.ecr.eu-west-1.amazonaws.com/daedalus, the tag a word such as 0.32.0",
        );
      resolved.images = images;
    }
    return resolved;
  }

  // ---- preflight ---------------------------------------------------------

  async preflight(
    input: GatewayInstallTargetInput,
  ): Promise<GatewayPreflightDto> {
    const resolved = await this.#resolve(input);
    const target: Target = { context: resolved.context };
    const { namespace } = resolved;

    const version = await this.#kubectl(target, [
      "version",
      "-o",
      "json",
      REQUEST_TIMEOUT,
    ]);
    if (version.exitCode !== 0 && !version.stdout.includes("serverVersion"))
      throw new DaedalusError(
        "DEPENDENCY",
        `The cluster did not answer: ${failureText(version.stderr)}`,
      );

    const helmVersion = await this.#helmVersion();
    const podSecurity = await this.#namespaceLabel(target, namespace);
    const namespaceExists = podSecurity !== undefined;

    const permissions = await Promise.all(
      installPermissions(namespaceExists).map(async (permission) => {
        const result = await this.#kubectl(target, [
          "auth",
          "can-i",
          permission.verb,
          permission.resource,
          ...(permission.namespaced ? ["-n", namespace] : []),
          REQUEST_TIMEOUT,
        ]).catch(() => null);
        return {
          permission,
          allowed: result ? canIAnswer(result.exitCode, result.stdout) : null,
        };
      }),
    );

    const listing = async (args: string[]) => {
      const result = await this.#kubectl(target, [...args, REQUEST_TIMEOUT]);
      return result.exitCode === 0 ? result.stdout : null;
    };
    const storage = await listing([
      "get",
      "storageclasses",
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.annotations.storageclass\\.kubernetes\\.io/is-default-class}{"\\n"}{end}',
    ]);
    const nodes = await listing([
      "get",
      "nodes",
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.status.runtimeHandlers[*].name}{"\\n"}{end}',
    ]);
    const daemonsets = await listing([
      "get",
      "daemonsets",
      "--all-namespaces",
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.spec.template.spec.containers[*].image}{"\\n"}{end}',
    ]);
    // EKS: aws-node carries the network policy agent either way; only its
    // flag says whether it enforces.
    const vpcCni =
      daemonsets !== null && /^aws-node\t/m.test(daemonsets)
        ? vpcCniPolicy(
            await listing([
              "get",
              "daemonset",
              "aws-node",
              "-n",
              "kube-system",
              "-o",
              'jsonpath={range .spec.template.spec.containers[*]}{.name}{"\\t"}{.args}{"\\n"}{end}',
            ]),
          )
        : null;

    let releases = await this.#helm(target, [
      "list",
      "--all-namespaces",
      "-o",
      "json",
    ]);
    if (releases.exitCode !== 0)
      releases = await this.#helm(target, [
        "list",
        "-n",
        namespace,
        "-o",
        "json",
      ]);
    const listed = releases.exitCode === 0;
    const { check: release, release: existing } = releaseCheck(
      listed ? parseReleases(releases.stdout) : [],
      namespace,
    );
    const holdsRelease =
      existing !== null && /^daedalus-\d/.test(existing.chart);
    const state: NamespaceState = !namespaceExists
      ? { kind: "new" }
      : holdsRelease
        ? { kind: "release", podSecurity }
        : listed
          ? { kind: "taken" }
          : { kind: "unknown" };
    const installed = holdsRelease
      ? await this.#installedValues(target, namespace)
      : null;

    const network = networkPolicyCheck(daemonsets, vpcCni);
    const releaseRead: GatewayCheckDto | null =
      holdsRelease && !installed
        ? {
            id: "release",
            status: "fail",
            label: "Could not read the installed gateway's settings",
            detail:
              "helm get values failed, so an upgrade could not keep them.",
          }
        : null;
    const checks: GatewayCheckDto[] = [
      versionCheck(version.stdout),
      helmCheck(helmVersion),
      permissionsCheck(permissions),
      namespaceCheck(namespace, state),
      storage === null
        ? {
            id: "storageClass",
            status: "unknown",
            label: "Could not list StorageClasses",
          }
        : storageClassCheck(storage, resolved.storageClass),
      nodes === null
        ? { id: "gvisor", status: "unknown", label: "Could not list nodes" }
        : gvisorCheck(nodes),
      network,
      releaseRead ??
        (listed
          ? release
          : {
              id: "release",
              status: "unknown",
              label: "Could not list helm releases",
              detail: failureText(releases.stderr),
            }),
      imagesCheck(
        resolved.context,
        resolved.images ?? installed?.images ?? undefined,
      ),
    ];
    const ready = checks.every((check) => check.status !== "fail");
    const acknowledge: "networkPolicy"[] =
      network.status === "unknown" ? ["networkPolicy"] : [];
    this.#preflights.set(key(resolved), {
      at: this.#now,
      ready,
      acknowledge,
      state,
      installed,
    });
    return {
      context: resolved.context,
      namespace,
      checks,
      ready,
      acknowledge,
      release:
        existing && installed
          ? {
              namespace: existing.namespace,
              revision: existing.revision,
              chartVersion: existing.chart.replace(/^daedalus-/, ""),
              ...installed,
            }
          : null,
    };
  }

  async #helmVersion(): Promise<string | null> {
    const result = await this.#exec("helm", ["version", "--short"], {
      timeoutMs: 10_000,
    }).catch(() => null);
    return result?.exitCode === 0 ? result.stdout.trim() : null;
  }

  /**
   * The namespace's Pod Security enforce label: undefined when there is no
   * such namespace, null when it has none.
   */
  async #namespaceLabel(
    target: Target,
    namespace: string,
  ): Promise<string | null | undefined> {
    const result = await this.#kubectl(target, [
      "get",
      "namespace",
      namespace,
      "-o",
      "jsonpath={.metadata.labels}",
      REQUEST_TIMEOUT,
    ]);
    if (result.exitCode !== 0) return undefined;
    try {
      const labels = JSON.parse(result.stdout || "{}") as Record<
        string,
        unknown
      >;
      const value = labels[POD_SECURITY_LABEL];
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Named values of the installed release; the raw output stays here. Null
   * when helm cannot read them: guessing the chart's defaults would turn dev
   * login or a public address off behind the user's back.
   */
  async #installedValues(
    target: Target,
    namespace: string,
  ): Promise<InstalledValues | null> {
    const result = await this.#helm(target, [
      "get",
      "values",
      RELEASE_NAME,
      "-n",
      namespace,
      "-o",
      "json",
    ]);
    // Never logged or shown: it can hold whatever an operator passed.
    return result.exitCode === 0 ? parseInstalledValues(result.stdout) : null;
  }

  // ---- dry run -----------------------------------------------------------

  async dryRun(input: GatewayInstallTargetInput): Promise<GatewayDryRunDto> {
    const resolved = await this.#resolve(input);
    const preflight = this.#preflights.get(key(resolved));
    if (!preflight || this.#now - preflight.at > CHECK_VALID_MS)
      throw new DaedalusError("CONFLICT", "Run the checks first");
    if (!preflight.ready)
      throw new DaedalusError(
        "CONFLICT",
        "The checks found something to fix first",
      );
    const target: Target = { context: resolved.context };
    const upgrade = preflight.state.kind === "release";
    const values = await this.#writeValues(
      upgrade
        ? this.#upgradeValues(resolved, {})
        : this.#newValues(resolved, { devLogin: true, publicUrl: "" }),
    );
    try {
      const result = await this.#helm(
        target,
        [
          "upgrade",
          "--install",
          RELEASE_NAME,
          this.options.chartDirectory,
          "--namespace",
          resolved.namespace,
          ...(upgrade ? ["--reset-then-reuse-values"] : []),
          "--dry-run=server",
          "-f",
          values.file,
        ],
        { timeoutMs: 120_000 },
      );
      if (result.exitCode !== 0)
        throw new DaedalusError(
          "VALIDATION",
          `The dry run failed: ${failureText(result.stderr, result.stdout)}`,
        );
      const parsed = parseDryRun(result.stdout, resolved.namespace);
      const dryRunId = crypto.randomUUID();
      const egressId = randomBytes(3).toString("hex");
      this.#dryRuns.set(dryRunId, {
        key: key(resolved),
        at: this.#now,
        preflight,
        egressId,
      });
      const warnings = logLines(result.stderr).join("\n");
      return {
        context: resolved.context,
        namespace: resolved.namespace,
        dryRunId,
        upgrade,
        objects: [
          ...this.#ownObjects(resolved.namespace, preflight.state),
          ...parsed.objects,
          ...egressObjects(egressId),
        ],
        notes: [warnings, parsed.notes].filter(Boolean).join("\n\n"),
      };
    } finally {
      await values.remove();
    }
  }

  /** What the install itself makes or changes besides the chart. */
  #ownObjects(
    namespace: string,
    state: NamespaceState,
  ): GatewayDryRunDto["objects"] {
    const label = `${POD_SECURITY_LABEL}=restricted`;
    if (state.kind === "new")
      return [
        {
          kind: "Namespace",
          name: namespace,
          namespace: null,
          note: `new; label ${label}`,
        },
        {
          kind: "Secret",
          name: ADMIN_SECRET,
          namespace,
          note: "new; the admin page's token",
        },
      ];
    if (state.kind === "release" && state.podSecurity !== "restricted")
      return [
        {
          kind: "Namespace",
          name: namespace,
          namespace: null,
          note: `label ${label} (now ${state.podSecurity ?? "none"})`,
        },
      ];
    return [];
  }

  /** Values for a new install: everything the app needs. */
  #newValues(
    input: ResolvedInput,
    gateway: { devLogin: boolean; publicUrl: string },
  ): unknown {
    return {
      gateway: {
        ...gateway,
        ...(input.storageClass
          ? { storage: { storageClass: input.storageClass } }
          : {}),
      },
      ...(input.storageClass
        ? { workspace: { storageClass: input.storageClass } }
        : {}),
      admin: { enabled: true, bootstrap: { existingSecret: ADMIN_SECRET } },
      ...this.#imageValues(input),
    };
  }

  /**
   * Values for an upgrade, laid over the installed ones with
   * `--reset-then-reuse-values`: only what the user changed.
   */
  #upgradeValues(
    input: ResolvedInput,
    gateway: { devLogin?: boolean; publicUrl?: string },
  ): unknown {
    const gatewayValues = {
      ...gateway,
      ...(input.storageClass
        ? { storage: { storageClass: input.storageClass } }
        : {}),
    };
    return {
      ...(Object.keys(gatewayValues).length ? { gateway: gatewayValues } : {}),
      ...(input.storageClass
        ? { workspace: { storageClass: input.storageClass } }
        : {}),
      ...this.#imageValues(input),
    };
  }

  #imageValues(input: ResolvedInput): Record<string, unknown> {
    if (!input.images) return {};
    const refs = imageRefs(input.images);
    const repository = (ref: string) => ref.slice(0, ref.lastIndexOf(":"));
    return {
      image: {
        gateway: {
          repository: repository(refs.gateway),
          tag: input.images.tag,
        },
        runner: { repository: repository(refs.runner), tag: input.images.tag },
      },
    };
  }

  async #writeValues(
    values: unknown,
  ): Promise<{ file: string; remove(): Promise<void> }> {
    const directory = join(this.#cloudDirectory, "install");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `values-${crypto.randomUUID()}.json`);
    // JSON is YAML, so helm reads it as a values file.
    await writeFile(file, JSON.stringify(values, null, 2), { mode: 0o600 });
    return { file, remove: () => rm(file, { force: true }) };
  }

  // ---- install -----------------------------------------------------------

  #busy(): boolean {
    const phase = this.#current?.phase;
    return phase !== undefined && phase !== "done" && phase !== "failed";
  }

  #begin(target: GatewayInstallDto["target"]): GatewayInstallDto {
    if (this.#busy())
      throw new DaedalusError("CONFLICT", "An install is already running");
    this.#adminToken = undefined;
    this.#current = { target, phase: "checking", log: [] };
    this.#notify();
    return this.current()!;
  }

  #phase(phase: GatewayInstallDto["phase"], line?: string): void {
    if (!this.#current) return;
    this.#current.phase = phase;
    if (line) this.#append([line]);
    else this.#notify();
  }

  #append(lines: string[]): void {
    if (!this.#current || lines.length === 0) return;
    this.#current.log.push(...lines);
    if (this.#current.log.length > MAX_LOG)
      this.#current.log.splice(0, this.#current.log.length - MAX_LOG);
    this.#notify();
  }

  #fail(error: unknown): void {
    if (!this.#current) return;
    const message = error instanceof Error ? error.message : String(error);
    this.#current.phase = "failed";
    this.#current.message = message;
    this.options.log?.("gateway install failed", { message });
    this.#notify();
  }

  dismiss(): void {
    if (this.#busy())
      throw new DaedalusError("CONFLICT", "The install is still running");
    this.#current = undefined;
    this.#adminToken = undefined;
    this.#notify();
  }

  /** The admin token the Keychain refused, once. */
  adminToken(): { token: string; secret: string; namespace: string } | null {
    const token = this.#adminToken ?? null;
    this.#adminToken = undefined;
    if (this.#current?.adminTokenWaiting) {
      delete this.#current.adminTokenWaiting;
      this.#notify();
    }
    return token;
  }

  async start(input: StartInput): Promise<GatewayInstallDto> {
    const resolved = await this.#resolve(input);
    if (input.confirm !== resolved.context)
      throw new DaedalusError(
        "VALIDATION",
        "Type the context name exactly to confirm",
      );
    const dryRun = this.#dryRuns.get(input.dryRunId);
    if (
      !dryRun ||
      dryRun.key !== key(resolved) ||
      this.#now - dryRun.at > CHECK_VALID_MS
    )
      throw new DaedalusError(
        "CONFLICT",
        "Run the checks and the dry run again for these settings",
      );
    const { preflight } = dryRun;
    if (
      preflight.acknowledge.includes("networkPolicy") &&
      input.acknowledgeNetworkPolicy !== true
    )
      throw new DaedalusError(
        "VALIDATION",
        "Whether this cluster enforces NetworkPolicy is unknown; without it workspaces reach other pods and the instance metadata. Acknowledge it to go on",
      );
    const email = this.#email(input.email);
    const typedUrl = input.publicUrl?.trim()
      ? this.#publicUrl(input.publicUrl)
      : undefined;
    const installed = preflight.installed;
    const devLogin =
      typeof input.devLogin === "boolean"
        ? input.devLogin
        : (installed?.devLogin ?? true);
    const installedUrl = installed?.publicUrl ?? "";
    const publicUrl =
      typedUrl ??
      (installedUrl && loopbackPort(installedUrl) === null
        ? installedUrl
        : undefined);
    if (!devLogin && !publicUrl)
      throw new DaedalusError(
        "VALIDATION",
        "With dev login off the gateway has no sign-in yet, and without a public address only this Mac reaches it: keep dev login on, or give the gateway's public address",
      );
    const turnedOn = devLogin && !(installed?.devLogin ?? false);
    if (
      devLogin &&
      publicUrl &&
      (typedUrl !== undefined || turnedOn) &&
      input.acknowledgeDevLogin !== true
    )
      throw new DaedalusError(
        "VALIDATION",
        "Anyone who can reach this gateway can sign in as any email until company sign-in is set up; acknowledge it to go on",
      );
    // The namespace must still be what the dry run saw.
    const now = await this.#namespaceLabel(
      { context: resolved.context },
      resolved.namespace,
    );
    if (preflight.state.kind === "new" && now !== undefined)
      throw new DaedalusError(
        "CONFLICT",
        `Namespace ${resolved.namespace} was made since the checks; run them again`,
      );
    if (preflight.state.kind === "release" && now === undefined)
      throw new DaedalusError(
        "CONFLICT",
        `Namespace ${resolved.namespace} is gone since the checks; run them again`,
      );
    this.#dryRuns.delete(input.dryRunId);
    const started = this.#begin({
      kind: "cluster",
      context: resolved.context,
      namespace: resolved.namespace,
    });
    void this.#installCluster(resolved, preflight, dryRun.egressId, {
      email,
      devLogin,
      publicUrl,
      setDevLogin: typeof input.devLogin === "boolean",
      setPublicUrl: typedUrl !== undefined,
    }).catch((error) => this.#fail(error));
    return started;
  }

  #email(email: string): string {
    const trimmed = email?.trim() ?? "";
    if (!/^[^\s@]+@[^\s@]+$/.test(trimmed))
      throw new DaedalusError("VALIDATION", "Enter the email to sign in with");
    return trimmed;
  }

  #publicUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new DaedalusError("VALIDATION", "The gateway URL is not a URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new DaedalusError(
        "VALIDATION",
        "The gateway URL starts with https://",
      );
    return url.origin;
  }

  async #installCluster(
    input: ResolvedInput,
    preflight: PreflightRecord,
    egressId: string,
    choice: {
      email: string;
      devLogin: boolean;
      publicUrl: string | undefined;
      setDevLogin: boolean;
      setPublicUrl: boolean;
    },
  ): Promise<void> {
    const target: Target = { context: input.context };
    const upgrade = preflight.state.kind === "release";
    // Without a public URL only this Mac reaches the gateway. An upgrade
    // keeps the port the app (or an earlier install) already forwards.
    const kept = this.#forward?.record ?? (await this.#readForward());
    const port = choice.publicUrl
      ? null
      : (loopbackPort(preflight.installed?.publicUrl ?? "") ??
        (kept?.context === input.context && kept.namespace === input.namespace
          ? kept.port
          : await this.#freePort()));
    const gatewayUrl = choice.publicUrl ?? `http://127.0.0.1:${port}`;
    this.#phase(
      "installing",
      `${upgrade ? "Upgrading" : "Installing"} into ${input.namespace} on ${input.context}`,
    );
    await this.#prepareNamespace(target, input.namespace, preflight.state);
    if (!upgrade) await this.#adminSecret(target, input.namespace);
    const publicUrlChanged =
      choice.setPublicUrl ||
      (port !== null && preflight.installed?.publicUrl !== gatewayUrl);
    await this.#helmInstall(
      target,
      input.namespace,
      [
        upgrade
          ? this.#upgradeValues(input, {
              ...(choice.setDevLogin ? { devLogin: choice.devLogin } : {}),
              ...(publicUrlChanged ? { publicUrl: gatewayUrl } : {}),
            })
          : this.#newValues(input, {
              devLogin: choice.devLogin,
              publicUrl: gatewayUrl,
            }),
      ],
      [],
      upgrade,
    );
    await this.#waitForGateway(target, input.namespace);
    if (port !== null) {
      const record: PortForwardRecord = {
        context: input.context,
        namespace: input.namespace,
        port,
        gatewayUrl,
      };
      await this.#saveForward(record);
      this.#keepForward(record);
      this.#append([
        `Port-forward on 127.0.0.1:${port}; only this Mac can reach it`,
      ]);
    } else {
      await this.#clearForward();
    }
    await this.#egress(
      target,
      input.namespace,
      this.#runnerImage(input, preflight),
      egressId,
    );
    if (choice.devLogin)
      await this.#signIn(gatewayUrl, choice.email, port !== null);
    else this.#finish(gatewayUrl, port !== null, false);
  }

  #runnerImage(input: ResolvedInput, preflight: PreflightRecord): string {
    const images = input.images ?? preflight.installed?.images;
    return images ? imageRefs(images).runner : "daedalus-runner:dev";
  }

  /**
   * A new namespace is created with the Pod Security label; one holding this
   * release gets the label only when it differs. No other namespace gets
   * here: the preflight refuses it and `start` checks again.
   */
  async #prepareNamespace(
    target: Target,
    namespace: string,
    state: NamespaceState,
  ): Promise<void> {
    if (state.kind === "new") {
      const created = await this.#kubectl(target, ["create", "-f", "-"], {
        stdin: JSON.stringify({
          apiVersion: "v1",
          kind: "Namespace",
          metadata: {
            name: namespace,
            labels: { [POD_SECURITY_LABEL]: "restricted" },
          },
        }),
      });
      if (created.exitCode !== 0)
        throw new Error(
          `Could not create namespace ${namespace}: ${failureText(created.stderr)}`,
        );
      this.#append(logLines(created.stdout));
      return;
    }
    if (state.kind !== "release")
      throw new Error(`Namespace ${namespace} is not one the install may use`);
    if (state.podSecurity === "restricted") return;
    const labelled = await this.#kubectl(target, [
      "label",
      "namespace",
      namespace,
      `${POD_SECURITY_LABEL}=restricted`,
      "--overwrite",
    ]);
    if (labelled.exitCode !== 0)
      throw new Error(
        `Could not label namespace ${namespace}: ${failureText(labelled.stderr)}`,
      );
    this.#append(logLines(labelled.stdout));
  }

  /** The admin page's Secret, unless there is one; the token never in an argument. */
  async #adminSecret(target: Target, namespace: string): Promise<void> {
    const existing = await this.#kubectl(target, [
      "get",
      "secret",
      ADMIN_SECRET,
      "-n",
      namespace,
      "-o",
      "name",
    ]);
    if (existing.exitCode === 0) {
      this.#append([`Secret ${ADMIN_SECRET} already there; kept`]);
      return;
    }
    const token = randomBytes(36).toString("base64url");
    // `create`, not `apply`: apply would copy the token into an annotation.
    const created = await this.#kubectl(target, ["create", "-f", "-"], {
      stdin: JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: ADMIN_SECRET, namespace },
        type: "Opaque",
        stringData: { "admin-token": token },
      }),
    });
    if (created.exitCode !== 0)
      throw new Error(
        `Could not create the admin Secret: ${failureText(created.stderr)}`,
      );
    const save =
      this.options.saveAdminToken ??
      ((account: string, value: string) =>
        writeKeychainPassword(KEYCHAIN_SERVICE, account, value));
    const account = `${target.context}/${namespace}`;
    const kept = await save(account, token).then(
      () => true,
      (error: unknown) => {
        // The error's words only: never the token.
        this.options.log?.("admin token not kept in the Keychain", {
          message: error instanceof Error ? error.message : "unknown",
        });
        return false;
      },
    );
    if (kept) {
      this.#append([
        `Secret ${ADMIN_SECRET} created; its admin token is in the Keychain (${KEYCHAIN_SERVICE}, ${account})`,
      ]);
      return;
    }
    this.#adminToken = { token, secret: ADMIN_SECRET, namespace };
    if (this.#current) this.#current.adminTokenWaiting = true;
    this.#append([
      `Secret ${ADMIN_SECRET} created; the Keychain did not take its admin token. Show it once from here and keep it; it is also in the Secret.`,
    ]);
  }

  async #helmInstall(
    target: Target,
    namespace: string,
    values: unknown[],
    valueFiles: string[] = [],
    reuseValues = false,
  ): Promise<void> {
    const written = await Promise.all(
      values.map((value) => this.#writeValues(value)),
    );
    try {
      const result = await this.#helm(
        target,
        [
          "upgrade",
          "--install",
          RELEASE_NAME,
          this.options.chartDirectory,
          "--namespace",
          namespace,
          ...(reuseValues ? ["--reset-then-reuse-values"] : []),
          ...valueFiles.flatMap((file) => ["-f", file]),
          ...written.flatMap((file) => ["-f", file.file]),
        ],
        { timeoutMs: 300_000 },
      );
      if (result.exitCode !== 0)
        throw new Error(
          `helm failed: ${failureText(result.stderr, result.stdout)}`,
        );
      this.#append(
        logLines(result.stdout).filter((line) =>
          /^(Release|NAME|STATUS|REVISION|NAMESPACE)/.test(line),
        ),
      );
    } finally {
      await Promise.all(written.map((file) => file.remove()));
    }
  }

  async #waitForGateway(target: Target, namespace: string): Promise<void> {
    this.#phase("waiting", "Waiting for the gateway to start");
    const result = await this.#kubectl(
      target,
      [
        "rollout",
        "status",
        `deployment/${GATEWAY_SERVICE}`,
        "-n",
        namespace,
        "--timeout=300s",
      ],
      { timeoutMs: 320_000 },
    );
    if (result.exitCode !== 0)
      throw new Error(
        `The gateway did not start: ${failureText(result.stderr, result.stdout)}`,
      );
    this.#append(logLines(result.stdout, 3));
  }

  // ---- egress check ------------------------------------------------------

  /**
   * deploy/kind/egress-check.sh, from the app: a probe pod in a temporary
   * namespace with the workspaces' NetworkPolicy and the tenant label, and a
   * control pod in one without, try the same targets. A block counts only
   * when the control pod gets through. Both namespaces go afterwards.
   */
  async #egress(
    target: Target,
    namespace: string,
    image: string,
    id: string,
  ): Promise<void> {
    this.#append(["Checking what a workspace can reach"]);
    try {
      this.#setEgress(await this.#runEgress(target, namespace, image, id));
    } catch (error) {
      this.#append([
        `The egress check did not run: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    } finally {
      // By its label only, so nothing it did not make goes.
      await this.#kubectl(target, [
        "delete",
        "namespace",
        "-l",
        `${EGRESS_LABEL}=${id}`,
        "--wait=false",
      ]).catch(() => undefined);
    }
  }

  #setEgress(results: NonNullable<GatewayInstallDto["egress"]>): void {
    if (!this.#current) return;
    this.#current.egress = results;
    this.#append(
      results.map(
        (result) =>
          `${result.target}: ${result.got}, want ${result.want} (${result.result})`,
      ),
    );
    if (
      results.some(
        (result) => result.result === "fail" && result.want === "blocked",
      )
    )
      this.#append([
        "A workspace reaches something the NetworkPolicy should block; check the network plugin enforces NetworkPolicy",
      ]);
    if (
      results.some(
        (result) => result.result === "fail" && result.want === "open",
      )
    )
      this.#append([
        "A workspace cannot reach the gateway's runner Service; check the gateway's NetworkPolicy and Service",
      ]);
    if (results.some((result) => result.result === "warn"))
      this.#append([
        "A workspace cannot reach the internet from this cluster; sessions that need it will fail",
      ]);
  }

  async #runEgress(
    target: Target,
    namespace: string,
    image: string,
    id: string,
  ): Promise<NonNullable<GatewayInstallDto["egress"]>> {
    const names = egressNamespaces(id);
    const policy = await this.#kubectl(target, [
      "get",
      "configmap",
      "daedalus-tenant",
      "-n",
      namespace,
      "-o",
      "jsonpath={.data.networkpolicy\\.yaml}",
    ]);
    if (policy.exitCode !== 0 || !policy.stdout.trim())
      throw new Error("the workspaces' NetworkPolicy could not be read");
    const gatewayIp = await this.#kubectl(target, [
      "get",
      "pods",
      "-n",
      namespace,
      "-l",
      "app.kubernetes.io/component=gateway",
      "-o",
      "jsonpath={.items[0].status.podIP}",
    ]);
    const namespaces = await this.#kubectl(target, ["create", "-f", "-"], {
      stdin: JSON.stringify({
        apiVersion: "v1",
        kind: "List",
        items: [
          {
            apiVersion: "v1",
            kind: "Namespace",
            // The tenant label is what lets the runner port in.
            metadata: {
              name: names.probe,
              labels: {
                "daedalus.dev/user": "egress-check",
                [EGRESS_LABEL]: id,
              },
            },
          },
          {
            apiVersion: "v1",
            kind: "Namespace",
            metadata: { name: names.control, labels: { [EGRESS_LABEL]: id } },
          },
        ],
      }),
    });
    if (namespaces.exitCode !== 0)
      throw new Error(failureText(namespaces.stderr));
    const applied = await this.#kubectl(
      target,
      ["apply", "-n", names.probe, "-f", "-"],
      { stdin: policy.stdout },
    );
    if (applied.exitCode !== 0) throw new Error(failureText(applied.stderr));
    for (const ns of [names.probe, names.control]) {
      const pod = await this.#kubectl(target, ["create", "-n", ns, "-f", "-"], {
        stdin: JSON.stringify(egressPod(image)),
      });
      if (pod.exitCode !== 0) throw new Error(failureText(pod.stderr));
    }
    for (const ns of [names.probe, names.control]) {
      const ready = await this.#kubectl(
        target,
        [
          "wait",
          "-n",
          ns,
          "--for=condition=Ready",
          "pod/probe",
          "--timeout=120s",
        ],
        { timeoutMs: 130_000 },
      );
      if (ready.exitCode !== 0)
        throw new Error(
          `the probe pod did not start: ${failureText(ready.stderr)}`,
        );
    }
    const probe = async (ns: string, host: string, port: number) => {
      const result = await this.#kubectl(
        target,
        [
          "exec",
          "-n",
          ns,
          "probe",
          "--",
          "bun",
          "-e",
          PROBE_SCRIPT,
          host,
          String(port),
        ],
        { timeoutMs: 20_000 },
      );
      return result.stdout.trim().split("\n").pop() === "open"
        ? ("open" as const)
        : ("blocked" as const);
    };
    const targets: [string, number, "open" | "blocked"][] = [
      ["169.254.169.254", 80, "blocked"],
      ...(gatewayIp.stdout.trim()
        ? [
            [gatewayIp.stdout.trim(), 8080, "blocked"] as [
              string,
              number,
              "blocked",
            ],
          ]
        : []),
      [`${GATEWAY_SERVICE}-runners.${namespace}.svc`, 8081, "open"],
      ["1.1.1.1", 443, "open"],
    ];
    const results: NonNullable<GatewayInstallDto["egress"]> = [];
    for (const [host, port, want] of targets) {
      const got = await probe(names.probe, host, port);
      let result: "pass" | "fail" | "unproven" | "warn" =
        got === want ? "pass" : "fail";
      // A cluster without internet egress is a choice, not a leak.
      if (result === "fail" && host === "1.1.1.1") result = "warn";
      if (want === "blocked" && got === "blocked") {
        const control = await probe(names.control, host, port);
        if (control !== "open") result = "unproven";
      }
      results.push({ target: `${host}:${port}`, want, got, result });
    }
    return results;
  }

  async #signIn(
    gatewayUrl: string,
    email: string,
    portForward: boolean,
  ): Promise<void> {
    this.#phase("signing-in", `Signing in to ${gatewayUrl} as ${email}`);
    await this.#health(gatewayUrl);
    await this.options.signIn(gatewayUrl, email);
    const forward = this.#forward?.record;
    if (forward?.gatewayUrl === gatewayUrl) {
      forward.signedIn = true;
      await this.#saveForward(forward);
    }
    this.#finish(gatewayUrl, portForward, true);
  }

  #finish(gatewayUrl: string, portForward: boolean, signedIn: boolean): void {
    if (!this.#current) return;
    this.#current.gatewayUrl = gatewayUrl;
    if (portForward) this.#current.portForward = true;
    this.#current.signedIn = signedIn;
    this.#phase(
      "done",
      signedIn
        ? "Signed in"
        : "Installed. Dev login is off on this gateway, so the app did not sign in",
    );
  }

  async #health(gatewayUrl: string): Promise<void> {
    const fetcher = this.options.fetch ?? fetch;
    const sleep = this.options.sleep ?? Bun.sleep;
    let last = "";
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetcher(`${gatewayUrl}/health`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (response.ok) return;
        last = `HTTP ${response.status}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await sleep(1_000);
    }
    throw new Error(`The gateway at ${gatewayUrl} did not answer: ${last}`);
  }

  async #freePort(): Promise<number> {
    if (this.options.freePort) return this.options.freePort();
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const port = server.port;
    server.stop(true);
    return port;
  }

  // ---- port-forward ------------------------------------------------------

  async #saveForward(record: PortForwardRecord): Promise<void> {
    await mkdir(this.#cloudDirectory, { recursive: true, mode: 0o700 });
    await writeFile(this.#forwardFile, JSON.stringify(record, null, 2), {
      mode: 0o600,
    });
  }

  async #readForward(): Promise<PortForwardRecord | undefined> {
    let record: PortForwardRecord;
    try {
      record = JSON.parse(
        await readFile(this.#forwardFile, "utf8"),
      ) as PortForwardRecord;
    } catch {
      return undefined;
    }
    return validContextName(record.context) &&
      validNamespace(record.namespace) &&
      Number.isInteger(record.port) &&
      typeof record.gatewayUrl === "string"
      ? record
      : undefined;
  }

  async #clearForward(reason?: string): Promise<void> {
    if (reason && this.#forward)
      this.options.log?.("gateway port-forward stopped", { reason });
    this.#forward?.stop();
    this.#forward = undefined;
    await rm(this.#forwardFile, { force: true });
  }

  /**
   * At app start: brings back the port-forward of the last install, when the
   * Cloud sign-in still uses that gateway.
   */
  async resume(): Promise<void> {
    const record = await this.#readForward();
    if (!record) return;
    if (!(await this.#stillWanted(record))) {
      await this.#clearForward("not signed in to it");
      return;
    }
    this.#keepForward(record);
  }

  async #stillWanted(record: PortForwardRecord): Promise<boolean> {
    const signedIn = await this.options.signedInGateway?.();
    if (signedIn === undefined || signedIn === record.gatewayUrl) return true;
    // Signed in to another gateway: this one is not the app's any more.
    if (signedIn !== null) return false;
    // Signed out: the end only for a forward a sign-in had used.
    return record.signedIn !== true;
  }

  /**
   * Stops the port-forward when the Cloud sign-in no longer uses its
   * gateway: after a sign-out or a sign-in elsewhere. The RPC calls it after
   * either, and the forward checks on its own every half minute.
   */
  async checkForward(): Promise<void> {
    const forward = this.#forward;
    if (!forward || this.#busy()) return;
    if (!(await this.#stillWanted(forward.record)))
      await this.#clearForward("signed out or signed in elsewhere");
  }

  #keepForward(record: PortForwardRecord): void {
    this.#forward?.stop();
    let stopped = false;
    let child: ForwardProcess | undefined;
    const watch = setInterval(() => void this.checkForward(), FORWARD_CHECK_MS);
    (watch as { unref?: () => void }).unref?.();
    const loop = async () => {
      while (!stopped && !this.#closed) {
        const executable = await this.#which("kubectl");
        if (!executable) return;
        const argv = [
          executable,
          "port-forward",
          "--address=127.0.0.1",
          "-n",
          record.namespace,
          `service/${GATEWAY_SERVICE}`,
          `${record.port}:8080`,
          `--context=${record.context}`,
        ];
        const env = {
          ...(process.env as Record<string, string>),
          ...(await this.#env()),
        };
        const spawn =
          this.options.spawn ??
          ((args: string[], environment: Record<string, string>) =>
            Bun.spawn(args, {
              env: environment,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }));
        child = spawn(argv, env);
        await child.exited;
        if (stopped || this.#closed) return;
        // The release removed, or the sign-in moved on: stop for good.
        const service = await this.#kubectl({ context: record.context }, [
          "get",
          "service",
          GATEWAY_SERVICE,
          "-n",
          record.namespace,
          "-o",
          "name",
          REQUEST_TIMEOUT,
        ]).catch(() => null);
        if (service && /NotFound|not found/.test(service.stderr)) {
          await this.#clearForward("the gateway is gone");
          return;
        }
        if (!this.#busy() && !(await this.#stillWanted(record))) {
          await this.#clearForward("signed out or signed in elsewhere");
          return;
        }
        this.options.log?.("gateway port-forward ended; restarting", {
          context: record.context,
        });
        await (this.options.sleep ?? Bun.sleep)(5_000);
      }
    };
    void loop();
    this.#forward = {
      record,
      stop: () => {
        stopped = true;
        clearInterval(watch);
        child?.kill();
      },
    };
  }

  /** The port-forward being kept, for tests and the snapshot. */
  forwarding(): PortForwardRecord | undefined {
    return this.#forward?.record;
  }

  close(): void {
    this.#closed = true;
    this.#forward?.stop();
    this.#forward = undefined;
  }

  // ---- try it locally ----------------------------------------------------

  async local(input: { email: string }): Promise<GatewayInstallDto> {
    const email = this.#email(input.email);
    const started = this.#begin({ kind: "local" });
    void this.#installLocal(email).catch((error) => this.#fail(error));
    return started;
  }

  async #installLocal(email: string): Promise<void> {
    const { tools } = await this.tools();
    const missing = tools.filter(
      (tool) => !tool.found || (tool.name === "docker" && !tool.running),
    );
    if (missing.length > 0)
      throw new Error(
        missing.map((tool) => `${tool.name}: ${tool.hint}`).join("\n"),
      );
    const helm = helmCheck(await this.#helmVersion());
    if (helm.status === "fail") throw new Error(helm.detail ?? helm.label);
    const kubeconfig = this.localKubeconfig;
    const target: Target = { context: LOCAL_CONTEXT, kubeconfig };

    this.#phase("cluster", `Preparing kind cluster ${LOCAL_CLUSTER}`);
    const port = await this.#localCluster(kubeconfig);
    const gatewayUrl = `http://127.0.0.1:${port}`;

    this.#phase("gvisor", "Installing gVisor in the kind node");
    const script = join(this.options.kindDirectory, "gvisor.sh");
    const run = this.options.run ?? runCommand;
    const gvisorResult = await run("/bin/bash", [script], {
      env: await this.#env({
        KIND_CLUSTER: LOCAL_CLUSTER,
        KUBECONFIG: kubeconfig,
      }),
      timeoutMs: 600_000,
    });
    if (gvisorResult.exitCode !== 0)
      throw new Error(
        `gVisor did not install: ${failureText(gvisorResult.stderr, gvisorResult.stdout)}`,
      );
    this.#append(logLines(gvisorResult.stdout, 5));

    this.#phase("images", "Preparing the gateway and runner images");
    for (const name of ["gateway", "runner"] as const)
      await this.#localImage(name);

    this.#phase("installing", "Installing the gateway");
    // The local cluster is the app's own: its namespace is new or holds
    // the release from an earlier Try it locally.
    const podSecurity = await this.#namespaceLabel(target, DEFAULT_NAMESPACE);
    await this.#prepareNamespace(
      target,
      DEFAULT_NAMESPACE,
      podSecurity === undefined
        ? { kind: "new" }
        : { kind: "release", podSecurity },
    );
    await this.#adminSecret(target, DEFAULT_NAMESPACE);
    await this.#helmInstall(
      target,
      DEFAULT_NAMESPACE,
      [
        {
          gateway: {
            devLogin: true,
            publicUrl: gatewayUrl,
            service: { type: "NodePort", nodePort: LOCAL_NODE_PORT },
          },
          image: {
            gateway: { repository: "daedalus-gateway", tag: LOCAL_IMAGE_TAG },
            runner: { repository: "daedalus-runner", tag: LOCAL_IMAGE_TAG },
          },
          admin: { enabled: true, bootstrap: { existingSecret: ADMIN_SECRET } },
        },
      ],
      [join(this.options.kindDirectory, "values.yaml")],
    );
    await this.#waitForGateway(target, DEFAULT_NAMESPACE);
    await this.#clearForward();
    await this.#egress(
      target,
      DEFAULT_NAMESPACE,
      `daedalus-runner:${LOCAL_IMAGE_TAG}`,
      randomBytes(3).toString("hex"),
    );
    await this.#signIn(gatewayUrl, email, false);
  }

  /** Creates the kind cluster or reuses it; the host port its gateway is on. */
  async #localCluster(kubeconfig: string): Promise<number> {
    await mkdir(this.#cloudDirectory, { recursive: true, mode: 0o700 });
    const clusters = await this.#exec("kind", ["get", "clusters"]);
    const exists = clusters.stdout
      .split("\n")
      .some((line) => line.trim() === LOCAL_CLUSTER);
    if (exists) {
      this.#append([`Reusing kind cluster ${LOCAL_CLUSTER}`]);
      const config = await this.#exec("kind", [
        "get",
        "kubeconfig",
        "--name",
        LOCAL_CLUSTER,
      ]);
      if (config.exitCode !== 0)
        throw new Error(
          `kind could not read the cluster: ${failureText(config.stderr)}`,
        );
      await writeFile(kubeconfig, config.stdout, { mode: 0o600 });
      await chmod(kubeconfig, 0o600);
      const mapped = await this.#exec("docker", [
        "port",
        `${LOCAL_CLUSTER}-control-plane`,
        `${LOCAL_NODE_PORT}/tcp`,
      ]);
      const port = Number.parseInt(
        /:(\d+)\s*$/m.exec(mapped.stdout)?.[1] ?? "",
        10,
      );
      if (!Number.isInteger(port))
        throw new Error(
          `Cluster ${LOCAL_CLUSTER} has no host port for the gateway; delete it with 'kind delete cluster --name ${LOCAL_CLUSTER}' and try again`,
        );
      return port;
    }
    const port = await this.#freePort();
    const config = [
      "kind: Cluster",
      "apiVersion: kind.x-k8s.io/v1alpha4",
      "nodes:",
      "  - role: control-plane",
      `    image: ${KIND_NODE_IMAGE}`,
      "    extraPortMappings:",
      `      - containerPort: ${LOCAL_NODE_PORT}`,
      `        hostPort: ${port}`,
      "        listenAddress: 127.0.0.1",
      "",
    ].join("\n");
    const file = join(
      this.#cloudDirectory,
      "install",
      `kind-${crypto.randomUUID()}.yaml`,
    );
    await mkdir(join(this.#cloudDirectory, "install"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(file, config, { mode: 0o600 });
    try {
      this.#append([
        `Creating kind cluster ${LOCAL_CLUSTER} (a few minutes the first time)`,
      ]);
      // --kubeconfig: kind writes this file instead of ~/.kube/config and
      // leaves the user's current-context alone.
      const created = await this.#exec(
        "kind",
        [
          "create",
          "cluster",
          "--name",
          LOCAL_CLUSTER,
          "--config",
          file,
          "--kubeconfig",
          kubeconfig,
        ],
        { timeoutMs: 600_000 },
      );
      if (created.exitCode !== 0)
        throw new Error(
          `kind could not create the cluster: ${failureText(created.stderr)}`,
        );
      // kind's closing lines name `kubectl config` commands for its own
      // file; they would read as a change to the user's kubeconfig.
      this.#append(
        logLines(created.stderr, 12)
          .filter((line) => /[✓✗]/.test(line))
          .map((line) => line.replace(/[^\x20-\x7e✓✗]/gu, "").trim()),
      );
    } finally {
      await rm(file, { force: true });
    }
    return port;
  }

  async #localImage(name: "gateway" | "runner"): Promise<void> {
    const image = `daedalus-${name}:${LOCAL_IMAGE_TAG}`;
    const source = this.options.sourceRoot;
    const dockerfile = source ? join(source, "apps", name, "Dockerfile") : null;
    if (source && dockerfile && existsSync(dockerfile)) {
      this.#append([`Building ${image} (several minutes the first time)`]);
      const built = await this.#exec(
        "docker",
        ["build", "-t", image, "-f", dockerfile, source],
        { timeoutMs: 1_800_000 },
      );
      if (built.exitCode !== 0)
        throw new Error(
          `Building ${image} failed: ${failureText(built.stderr)}`,
        );
    } else {
      const present = await this.#exec("docker", [
        "image",
        "inspect",
        image,
        "--format",
        "{{.Id}}",
      ]);
      if (present.exitCode !== 0)
        throw new Error(
          `There is no ${image} image in Docker and no Daedalus checkout to build it from. Build it in a checkout: docker build -t ${image} -f apps/${name}/Dockerfile .`,
        );
      this.#append([`Using ${image} from Docker`]);
    }
    const loaded = await this.#exec(
      "kind",
      ["load", "docker-image", image, "--name", LOCAL_CLUSTER],
      { timeoutMs: 600_000 },
    );
    if (loaded.exitCode !== 0)
      throw new Error(
        `Loading ${image} into kind failed: ${failureText(loaded.stderr)}`,
      );
    this.#append([`Loaded ${image} into ${LOCAL_CLUSTER}`]);
  }
}

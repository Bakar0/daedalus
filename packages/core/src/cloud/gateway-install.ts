import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
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
  CLUSTERS_JSONPATH,
  CONTEXTS_JSONPATH,
  DEFAULT_NAMESPACE,
  failureText,
  GATEWAY_SERVICE,
  gvisorCheck,
  imageRefs,
  imagesCheck,
  installPermissions,
  logLines,
  networkPolicyCheck,
  parseContexts,
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
  namespace: string;
  storageClass?: string;
  images?: { registry: string; tag: string };
}

/** The port-forward the app keeps for a gateway only this Mac reaches. */
export interface PortForwardRecord {
  context: string;
  namespace: string;
  port: number;
  gatewayUrl: string;
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

function key(input: ResolvedInput): string {
  return JSON.stringify([
    input.context,
    input.namespace,
    input.storageClass ?? "",
    input.images?.registry ?? "",
    input.images?.tag ?? "",
  ]);
}

export class GatewayInstaller {
  #current: GatewayInstallDto | undefined;
  readonly #preflights = new Map<string, { at: number; ready: boolean }>();
  readonly #dryRuns = new Map<string, { key: string; at: number }>();
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
      [
        ...args,
        `--context=${target.context}`,
        ...(target.kubeconfig ? [`--kubeconfig=${target.kubeconfig}`] : []),
      ],
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
      [
        ...args,
        `--kube-context=${target.context}`,
        ...(target.kubeconfig ? [`--kubeconfig=${target.kubeconfig}`] : []),
      ],
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

  /** Context names and server hosts; never a credential, never current-context. */
  async contexts(): Promise<KubeContextDto[]> {
    const read = async (jsonpath: string) => {
      const result = await this.#exec(
        "kubectl",
        ["config", "view", "-o", `jsonpath=${jsonpath}`],
        { timeoutMs: 10_000 },
      );
      return result.exitCode === 0 ? result.stdout : "";
    };
    return parseContexts(
      await read(CONTEXTS_JSONPATH),
      await read(CLUSTERS_JSONPATH),
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
    const known = await this.contexts();
    if (!known.some((entry) => entry.name === context))
      throw new DaedalusError(
        "NOT_FOUND",
        `There is no context ${context} in the kubeconfig`,
      );
    const namespace = input.namespace?.trim() || DEFAULT_NAMESPACE;
    if (!validNamespace(namespace))
      throw new DaedalusError(
        "VALIDATION",
        "A namespace is lowercase letters, digits and dashes",
      );
    const resolved: ResolvedInput = { context, namespace };
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

    const namespaceRead = await this.#kubectl(target, [
      "get",
      "namespace",
      namespace,
      "-o",
      "name",
      REQUEST_TIMEOUT,
    ]);
    const namespaceExists = namespaceRead.exitCode === 0;

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
    const { check: release, release: existing } = releaseCheck(
      releases.exitCode === 0 ? parseReleases(releases.stdout) : [],
      namespace,
    );

    const checks: GatewayCheckDto[] = [
      versionCheck(version.stdout),
      permissionsCheck(permissions),
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
      networkPolicyCheck(daemonsets),
      releases.exitCode === 0
        ? release
        : {
            id: "release",
            status: "unknown",
            label: "Could not list helm releases",
            detail: failureText(releases.stderr),
          },
      imagesCheck(resolved.context, resolved.images),
    ];
    const ready = checks.every((check) => check.status !== "fail");
    this.#preflights.set(key(resolved), { at: this.#now, ready });
    return {
      context: resolved.context,
      namespace,
      checks,
      ready,
      release: existing
        ? {
            namespace: existing.namespace,
            revision: existing.revision,
            chartVersion: existing.chart.replace(/^daedalus-/, ""),
          }
        : null,
    };
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
    const values = await this.#writeValues(this.#clusterValues(resolved, ""));
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
      const extra = await this.#ownObjects(target, resolved.namespace);
      const dryRunId = crypto.randomUUID();
      this.#dryRuns.set(dryRunId, { key: key(resolved), at: this.#now });
      const warnings = logLines(result.stderr).join("\n");
      return {
        context: resolved.context,
        namespace: resolved.namespace,
        dryRunId,
        upgrade: /has been upgraded|^REVISION: (?!1$)\d+$/m.test(result.stdout),
        objects: [...extra, ...parsed.objects],
        notes: [warnings, parsed.notes].filter(Boolean).join("\n\n"),
      };
    } finally {
      await values.remove();
    }
  }

  /** The namespace and admin Secret the install makes itself, when missing. */
  async #ownObjects(
    target: Target,
    namespace: string,
  ): Promise<GatewayDryRunDto["objects"]> {
    const objects: GatewayDryRunDto["objects"] = [];
    const ns = await this.#kubectl(target, [
      "get",
      "namespace",
      namespace,
      "-o",
      "name",
      REQUEST_TIMEOUT,
    ]);
    if (ns.exitCode !== 0)
      objects.push({ kind: "Namespace", name: namespace, namespace: null });
    const secret =
      ns.exitCode === 0
        ? await this.#kubectl(target, [
            "get",
            "secret",
            ADMIN_SECRET,
            "-n",
            namespace,
            "-o",
            "name",
            REQUEST_TIMEOUT,
          ])
        : null;
    if (!secret || secret.exitCode !== 0)
      objects.push({ kind: "Secret", name: ADMIN_SECRET, namespace });
    return objects;
  }

  #clusterValues(input: ResolvedInput, publicUrl: string): unknown {
    const refs = input.images ? imageRefs(input.images) : null;
    const repository = (ref: string) => ref.slice(0, ref.lastIndexOf(":"));
    return {
      gateway: {
        devLogin: true,
        publicUrl,
        ...(input.storageClass
          ? { storage: { storageClass: input.storageClass } }
          : {}),
      },
      ...(input.storageClass
        ? { workspace: { storageClass: input.storageClass } }
        : {}),
      admin: { enabled: true, bootstrap: { existingSecret: ADMIN_SECRET } },
      ...(refs && input.images
        ? {
            image: {
              gateway: {
                repository: repository(refs.gateway),
                tag: input.images.tag,
              },
              runner: {
                repository: repository(refs.runner),
                tag: input.images.tag,
              },
            },
          }
        : {}),
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
    this.#notify();
  }

  async start(
    input: GatewayInstallTargetInput & {
      dryRunId: string;
      confirm: string;
      email: string;
      publicUrl?: string;
      acknowledgeDevLogin?: boolean;
    },
  ): Promise<GatewayInstallDto> {
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
    const email = this.#email(input.email);
    let publicUrl: string | undefined;
    if (input.publicUrl?.trim()) {
      publicUrl = this.#publicUrl(input.publicUrl);
      if (input.acknowledgeDevLogin !== true)
        throw new DaedalusError(
          "VALIDATION",
          "Anyone who can reach this gateway can sign in as any email until company sign-in is set up; acknowledge it to go on",
        );
    }
    this.#dryRuns.delete(input.dryRunId);
    const started = this.#begin({
      kind: "cluster",
      context: resolved.context,
      namespace: resolved.namespace,
    });
    void this.#installCluster(resolved, email, publicUrl).catch((error) =>
      this.#fail(error),
    );
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
    email: string,
    publicUrl: string | undefined,
  ): Promise<void> {
    const target: Target = { context: input.context };
    // An upgrade keeps the port the app already forwards, so the saved
    // sign-in still points at it.
    const kept = this.#forward?.record ?? (await this.#readForward());
    const port = publicUrl
      ? null
      : kept?.context === input.context && kept.namespace === input.namespace
        ? kept.port
        : await this.#freePort();
    const gatewayUrl = publicUrl ?? `http://127.0.0.1:${port}`;
    this.#phase(
      "installing",
      `Installing into ${input.namespace} on ${input.context}`,
    );
    await this.#prepareNamespace(target, input.namespace);
    await this.#helmInstall(target, input.namespace, [
      this.#clusterValues(input, gatewayUrl),
    ]);
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
    await this.#signIn(gatewayUrl, email, port !== null);
  }

  async #prepareNamespace(target: Target, namespace: string): Promise<void> {
    const manifest = {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: namespace,
        labels: { "pod-security.kubernetes.io/enforce": "restricted" },
      },
    };
    const applied = await this.#kubectl(target, ["apply", "-f", "-"], {
      stdin: JSON.stringify(manifest),
    });
    if (applied.exitCode !== 0)
      throw new Error(
        `Could not prepare namespace ${namespace}: ${failureText(applied.stderr)}`,
      );
    this.#append(logLines(applied.stdout));

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
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: ADMIN_SECRET, namespace },
      type: "Opaque",
      stringData: { "admin-token": token },
    };
    // `create`, not `apply`: apply would copy the token into an annotation.
    // The token goes on standard input, never in an argument.
    const created = await this.#kubectl(target, ["create", "-f", "-"], {
      stdin: JSON.stringify(secret),
    });
    if (created.exitCode !== 0)
      throw new Error(
        `Could not create the admin Secret: ${failureText(created.stderr)}`,
      );
    const save =
      this.options.saveAdminToken ??
      ((account: string, value: string) =>
        writeKeychainPassword(KEYCHAIN_SERVICE, account, value));
    await save(`${target.context}/${namespace}`, token).catch((error) =>
      this.options.log?.("admin token not kept in the Keychain", {
        message: String(error),
      }),
    );
    this.#append([
      `Secret ${ADMIN_SECRET} created; its admin token is in the Keychain`,
    ]);
  }

  async #helmInstall(
    target: Target,
    namespace: string,
    values: unknown[],
    valueFiles: string[] = [],
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

  async #signIn(
    gatewayUrl: string,
    email: string,
    portForward: boolean,
  ): Promise<void> {
    this.#phase("signing-in", `Signing in to ${gatewayUrl} as ${email}`);
    await this.#health(gatewayUrl);
    await this.options.signIn(gatewayUrl, email);
    if (!this.#current) return;
    this.#current.gatewayUrl = gatewayUrl;
    if (portForward) this.#current.portForward = true;
    this.#phase("done", "Signed in");
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

  async #clearForward(): Promise<void> {
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
    const signedIn = await this.options.signedInGateway?.();
    if (signedIn !== undefined && signedIn !== record.gatewayUrl) return;
    this.#keepForward(record);
  }

  #keepForward(record: PortForwardRecord): void {
    this.#forward?.stop();
    let stopped = false;
    let child: ForwardProcess | undefined;
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
    await this.#prepareNamespace(target, DEFAULT_NAMESPACE);
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

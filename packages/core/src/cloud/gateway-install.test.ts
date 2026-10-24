import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CommandOptions, CommandResult } from "@daedalus/platform";
import { DaedalusError } from "../errors";
import {
  GatewayInstaller,
  LOCAL_CLUSTER,
  LOCAL_CONTEXT,
  type ForwardProcess,
} from "./gateway-install";
import {
  canIAnswer,
  gvisorCheck,
  networkPolicyCheck,
  parseContexts,
  parseDryRun,
  releaseCheck,
  storageClassCheck,
  versionCheck,
} from "./gateway-install-checks";

const CONTEXT = "arn:aws:eks:eu-west-1:000000000000:cluster/test";
const OTHER = "prod-eu";

interface Call {
  tool: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string | undefined>;
}

const ok = (stdout = "", stderr = ""): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr,
});
const no = (stderr = "", exitCode = 1, stdout = ""): CommandResult => ({
  exitCode,
  stdout,
  stderr,
});

const MANIFEST = `Release "daedalus" does not exist. Installing it now.
NAME: daedalus
NAMESPACE: daedalus
STATUS: pending-install
REVISION: 1
HOOKS:
MANIFEST:
---
# Source: daedalus/templates/serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: daedalus-gateway
  labels:
    app.kubernetes.io/name: daedalus
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: daedalus-gateway
rules: []
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: daedalus-gateway
  namespace: daedalus
spec:
  template:
    metadata:
      name: not-this
NOTES:
Daedalus gateway installed in namespace daedalus.
`;

function merge(base: object, over: object): object {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const old = result[key];
    result[key] =
      value && typeof value === "object" && old && typeof old === "object"
        ? merge(old, value)
        : value;
  }
  return result;
}

/**
 * A fake kubectl, helm, kind and docker. It answers like a healthy cluster
 * and records every call; `override` changes one answer.
 */
function fakeCluster() {
  const calls: Call[] = [];
  const state = {
    namespace: false,
    podSecurity: "restricted" as string | null,
    secret: false,
    kindCluster: false,
    releases: "[]",
    values: "{}",
    server: "https://ABC.gr7.eu-west-1.eks.amazonaws.com",
    service: true,
  };
  let override: (call: Call) => CommandResult | undefined = () => undefined;
  const run = async (
    executable: string,
    args: string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> => {
    const tool = executable.split("/").pop()!;
    const call: Call = {
      tool,
      args,
      ...(typeof options.stdin === "string" ? { stdin: options.stdin } : {}),
      ...(options.env ? { env: options.env } : {}),
    };
    calls.push(call);
    const custom = override(call);
    if (custom) return custom;
    const line = args.join(" ");
    if (tool === "kubectl") {
      if (line.startsWith("config view")) {
        if (line.includes(".contexts"))
          return ok(`${CONTEXT}\teks-test\n${OTHER}\tprod\n`);
        if (line.includes("certificate-authority"))
          return ok("eks-test\tLS0tCA==\t\nprod\t\t/etc/prod-ca.pem\n");
        return ok(
          `eks-test\t${state.server}\nprod\thttps://prod.example.com:6443/path\n`,
        );
      }
      if (line.startsWith("version"))
        return ok(
          JSON.stringify({ serverVersion: { major: "1", minor: "31+" } }),
        );
      if (line.startsWith("get namespace"))
        return state.namespace
          ? ok(
              JSON.stringify(
                state.podSecurity
                  ? { "pod-security.kubernetes.io/enforce": state.podSecurity }
                  : {},
              ),
            )
          : no('Error from server (NotFound): namespaces "daedalus" not found');
      if (line.startsWith("auth can-i")) return ok("yes\n");
      if (line.startsWith("get storageclasses")) return ok("gp3\ttrue\n");
      if (line.startsWith("get nodes")) return ok("node-1\trunsc runc\n");
      if (line.startsWith("get daemonsets"))
        return ok("calico-node\tcalico/node:v3\n");
      if (line.startsWith("get secret"))
        return state.secret ? ok("secret/daedalus-admin") : no("NotFound");
      if (line.startsWith("apply")) return ok("networkpolicy created");
      if (line.startsWith("create")) {
        const kind = (JSON.parse(call.stdin ?? "{}") as { kind?: string }).kind;
        if (kind === "Namespace") state.namespace = true;
        if (kind === "Secret") state.secret = true;
        return ok(`${kind?.toLowerCase()}/x created`);
      }
      if (line.startsWith("label")) return ok("namespace/daedalus labeled");
      if (line.startsWith("get configmap"))
        return ok("apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\n");
      if (line.startsWith("get pods")) return ok("10.244.0.5");
      if (line.startsWith("get service"))
        return state.service
          ? ok("service/daedalus-gateway")
          : no(
              'Error from server (NotFound): services "daedalus-gateway" not found',
            );
      if (line.startsWith("delete namespace")) return ok();
      if (line.startsWith("wait")) return ok("pod/probe condition met");
      if (line.startsWith("exec")) {
        const ns = args[2];
        const host = args[args.indexOf("-e") + 2];
        const open =
          ns === "daedalus-egress-control" ||
          !/^(169\.254|10\.)/.test(host ?? "");
        return ok(open ? "open\n" : "blocked\n");
      }
      if (line.startsWith("rollout status"))
        return ok('deployment "daedalus-gateway" successfully rolled out');
    }
    if (tool === "helm") {
      if (line.startsWith("list")) return ok(state.releases);
      if (line.startsWith("get values")) return ok(state.values);
      if (line.includes("--dry-run=server")) return ok(MANIFEST);
      if (line.startsWith("upgrade --install")) {
        // Like helm: the release now exists with these values, laid over
        // the old ones only with --reset-then-reuse-values.
        const files = args.flatMap((arg, index) =>
          args[index - 1] === "-f" && arg.endsWith(".json") ? [arg] : [],
        );
        const given = files.map(
          (file) => JSON.parse(readFileSync(file, "utf8")) as object,
        );
        const base = args.includes("--reset-then-reuse-values")
          ? (JSON.parse(state.values) as object)
          : {};
        state.values = JSON.stringify(given.reduce(merge, base));
        state.releases = JSON.stringify([
          {
            name: "daedalus",
            namespace: args[args.indexOf("--namespace") + 1],
            revision: "1",
            chart: "daedalus-0.1.0",
            status: "deployed",
          },
        ]);
        return ok('Release "daedalus" has been upgraded.\nSTATUS: deployed');
      }
    }
    if (tool === "kind") {
      if (line === "get clusters")
        return ok(state.kindCluster ? `${LOCAL_CLUSTER}\n` : "daedalus\n");
      if (line.startsWith("create cluster")) {
        state.kindCluster = true;
        return ok("", "Creating cluster ...");
      }
      if (line.startsWith("load docker-image")) return ok();
    }
    if (tool === "docker") {
      if (line.startsWith("info")) return ok("28.5.1");
      if (line.startsWith("image inspect")) return ok("sha256:abc");
    }
    if (tool === "bash") return ok("gVisor installed");
    return no(`unexpected ${tool} ${line}`);
  };
  return {
    calls,
    state,
    run,
    set override(value: (call: Call) => CommandResult | undefined) {
      override = value;
    },
  };
}

let home: string;
let cluster: ReturnType<typeof fakeCluster>;
let signIns: [string, string][];
let tokens: [string, string][];
let spawned: string[][];
let installer: GatewayInstaller;

function makeInstaller(
  overrides: Partial<ConstructorParameters<typeof GatewayInstaller>[0]> = {},
) {
  return new GatewayInstaller({
    home,
    chartDirectory: "/bundle/deploy/helm/daedalus",
    kindDirectory: "/bundle/deploy/kind",
    signIn: async (url, email) => void signIns.push([url, email]),
    signedInGateway: async () => null,
    run: cluster.run,
    spawn: (argv): ForwardProcess => {
      spawned.push(argv);
      return { exited: new Promise(() => {}), kill: () => {} };
    },
    path: async () => "/opt/homebrew/bin:/usr/bin",
    which: (name) => `/opt/homebrew/bin/${name}`,
    saveAdminToken: async (account, token) =>
      void tokens.push([account, token]),
    fetch: (async () => new Response("ok")) as unknown as typeof fetch,
    freePort: async () => 18123,
    sleep: async () => {},
    ...overrides,
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "gateway-install-"));
  cluster = fakeCluster();
  signIns = [];
  tokens = [];
  spawned = [];
  installer = makeInstaller();
});

afterEach(async () => {
  installer.close();
  await rm(home, { recursive: true, force: true });
});

async function settle(target = installer): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const phase = target.current()?.phase;
    if (phase === "done" || phase === "failed") return;
    await Bun.sleep(1);
  }
  throw new Error(`install did not finish: ${target.current()?.phase}`);
}

const WRITES =
  /^(apply|create|delete|label|annotate|patch|replace|edit|scale|config (use-context|set|unset|delete))/;

function clusterCalls(tool: "kubectl" | "helm") {
  return cluster.calls.filter(
    (call) =>
      call.tool === tool && !call.args.join(" ").startsWith("config view"),
  );
}

describe("contexts", () => {
  test("reads names and server hosts through jsonpath only", async () => {
    const { contexts, tools } = await installer.tools();
    expect(contexts).toEqual([
      { name: CONTEXT, serverHost: "abc.gr7.eu-west-1.eks.amazonaws.com" },
      { name: OTHER, serverHost: "prod.example.com:6443" },
    ]);
    expect(tools.map((tool) => [tool.name, tool.found])).toEqual([
      ["kubectl", true],
      ["helm", true],
      ["kind", true],
      ["docker", true],
    ]);
    const views = cluster.calls.filter((call) => call.args[0] === "config");
    expect(views.length).toBe(2);
    // The checks also read each cluster's CA, which needs --raw; that query
    // selects only certificate fields.
    await installer.preflight({ context: CONTEXT }).catch(() => undefined);
    const raw = cluster.calls.filter((call) => call.args.includes("--raw"));
    expect(raw.length).toBeGreaterThan(0);
    for (const call of raw)
      expect(call.args.at(-1)).toBe(
        'jsonpath={range .clusters[*]}{.name}{"\\t"}{.cluster.certificate-authority-data}{"\\t"}{.cluster.certificate-authority}{"\\n"}{end}',
      );
    for (const call of views) {
      expect(call.args.slice(0, 3)).toEqual(["config", "view", "-o"]);
      expect(call.args[3]).toMatch(/^jsonpath=\{range \.(contexts|clusters)/);
      expect(call.args.join(" ")).not.toMatch(
        /--raw|user|token|current-context/,
      );
    }
  });

  test("says what to install when a tool is missing", async () => {
    installer = makeInstaller({
      which: (name) =>
        name === "helm" || name === "kind" ? null : `/bin/${name}`,
    });
    const { tools } = await installer.tools();
    expect(tools.find((tool) => tool.name === "helm")).toEqual({
      name: "helm",
      found: false,
      hint: "brew install helm",
    });
    expect(tools.find((tool) => tool.name === "kind")?.hint).toBe(
      "brew install kind",
    );
  });

  test("a context that could be read as a flag is left out", () => {
    expect(
      parseContexts("-oops\tc\nfine\tc\nfine\tc\n", "c\thttps://h:1\n"),
    ).toEqual([{ name: "fine", serverHost: "h:1" }]);
  });
});

describe("preflight", () => {
  test("every call names the context and nothing is written", async () => {
    const preflight = await installer.preflight({ context: CONTEXT });
    // No image registry entered for a cluster that is not kind.
    expect(preflight.ready).toBe(false);
    expect(preflight.namespace).toBe("daedalus");
    expect(preflight.checks.map((check) => [check.id, check.status])).toEqual([
      ["version", "pass"],
      ["permissions", "pass"],
      ["namespace", "pass"],
      ["storageClass", "pass"],
      ["gvisor", "pass"],
      ["networkPolicy", "pass"],
      ["release", "pass"],
      ["images", "fail"],
    ]);
    for (const call of clusterCalls("kubectl")) {
      expect(call.args).toContain(`--context=${CONTEXT}`);
      expect(call.args.join(" ")).not.toMatch(WRITES);
    }
    for (const call of clusterCalls("helm"))
      expect(call.args).toContain(`--kube-context=${CONTEXT}`);
  });

  test("images entered: ready; the check names both references", async () => {
    const preflight = await installer.preflight({
      context: CONTEXT,
      images: {
        registry: "1.dkr.ecr.eu-west-1.amazonaws.com/d",
        tag: "0.32.0",
      },
    });
    expect(preflight.ready).toBe(true);
    const images = preflight.checks.find((check) => check.id === "images");
    expect(images?.status).toBe("unknown");
    expect(images?.detail).toContain(
      "1.dkr.ecr.eu-west-1.amazonaws.com/d/daedalus-runner:0.32.0",
    );
  });

  test("an unknown context is refused before any cluster call", async () => {
    await expect(installer.preflight({ context: "nope" })).rejects.toThrow(
      "There is no context nope",
    );
    expect(clusterCalls("kubectl")).toEqual([]);
  });

  test("a missing permission fails the preflight", async () => {
    cluster.override = (call) =>
      call.args.includes("clusterroles.rbac.authorization.k8s.io")
        ? no("", 1, "no\n")
        : undefined;
    const preflight = await installer.preflight({
      context: CONTEXT,
      images: { registry: "r.example.com/d", tag: "1" },
    });
    expect(preflight.ready).toBe(false);
    expect(
      preflight.checks.find((check) => check.id === "permissions")?.detail,
    ).toBe("create clusterroles.rbac.authorization.k8s.io");
  });

  test("an unreachable cluster is an error, not a list of failures", async () => {
    cluster.override = (call) =>
      call.args[0] === "version"
        ? no("Unable to connect to the server: dial tcp: i/o timeout")
        : undefined;
    await expect(installer.preflight({ context: CONTEXT })).rejects.toThrow(
      "The cluster did not answer: Unable to connect",
    );
  });
});

describe("dry run and start", () => {
  const input = {
    context: CONTEXT,
    images: { registry: "r.example.com/daedalus", tag: "0.32.0" },
  };

  test("the dry run needs a preflight for the same input", async () => {
    await expect(installer.dryRun(input)).rejects.toThrow(
      "Run the checks first",
    );
    await installer.preflight(input);
    await expect(
      installer.dryRun({ ...input, namespace: "other" }),
    ).rejects.toThrow("Run the checks first");
  });

  test("the dry run lists the chart's objects and the install's own", async () => {
    await installer.preflight(input);
    const dryRun = await installer.dryRun(input);
    expect(
      dryRun.objects.map(({ kind, name, namespace }) => [
        kind,
        name,
        namespace,
      ]),
    ).toEqual([
      ["Namespace", "daedalus", null],
      ["Secret", "daedalus-admin", "daedalus"],
      ["ServiceAccount", "daedalus-gateway", "daedalus"],
      ["ClusterRole", "daedalus-gateway", null],
      ["Deployment", "daedalus-gateway", "daedalus"],
      ["Namespace", "daedalus-egress-check", null],
      ["Namespace", "daedalus-egress-control", null],
    ]);
    expect(dryRun.objects[0]?.note).toBe(
      "new; label pod-security.kubernetes.io/enforce=restricted",
    );
    expect(dryRun.notes).toContain("Daedalus gateway installed");
    expect(dryRun.upgrade).toBe(false);
    const helm = clusterCalls("helm").find((call) =>
      call.args.includes("--dry-run=server"),
    )!;
    expect(helm.args).toContain(`--kube-context=${CONTEXT}`);
    // The values file is gone once the dry run is over.
    const file = helm.args[helm.args.indexOf("-f") + 1]!;
    await expect(stat(file)).rejects.toThrow();
    for (const call of clusterCalls("kubectl"))
      expect(call.args.join(" ")).not.toMatch(WRITES);
  });

  test("start refuses a wrong confirmation, a stale dry run and an unacknowledged public URL", async () => {
    await installer.preflight(input);
    const { dryRunId } = await installer.dryRun(input);
    const base = { ...input, dryRunId, email: "me@example.com" };
    await expect(
      installer.start({ ...base, confirm: "arn:aws:eks" }),
    ).rejects.toThrow("Type the context name exactly");
    await expect(
      installer.start({ ...base, dryRunId: "made-up", confirm: CONTEXT }),
    ).rejects.toThrow("Run the checks and the dry run again");
    await expect(
      installer.start({
        ...base,
        confirm: CONTEXT,
        images: { registry: "r.example.com/daedalus", tag: "other" },
      }),
    ).rejects.toThrow("Run the checks and the dry run again");
    await expect(
      installer.start({
        ...base,
        confirm: CONTEXT,
        publicUrl: "https://daedalus.example.com",
      }),
    ).rejects.toThrow("acknowledge");
    expect(cluster.calls.some((call) => WRITES.test(call.args.join(" ")))).toBe(
      false,
    );
  });

  test("install: namespace, Secret on stdin, helm, port-forward, sign-in", async () => {
    await installer.preflight(input);
    const { dryRunId } = await installer.dryRun(input);
    const started = await installer.start({
      ...input,
      dryRunId,
      confirm: CONTEXT,
      email: "me@example.com",
    });
    expect(started.target).toEqual({
      kind: "cluster",
      context: CONTEXT,
      namespace: "daedalus",
    });
    await settle();
    const done = installer.current()!;
    expect(done.message).toBeUndefined();
    expect(done.phase).toBe("done");
    expect(done.gatewayUrl).toBe("http://127.0.0.1:18123");
    expect(done.portForward).toBe(true);
    expect(signIns).toEqual([["http://127.0.0.1:18123", "me@example.com"]]);

    for (const call of clusterCalls("kubectl"))
      expect(call.args).toContain(`--context=${CONTEXT}`);
    for (const call of clusterCalls("helm"))
      expect(call.args).toContain(`--kube-context=${CONTEXT}`);

    const secret = cluster.calls.find((call) =>
      call.stdin?.includes('"kind":"Secret"'),
    )!;
    expect(secret.args).toEqual(["create", "-f", "-", `--context=${CONTEXT}`]);
    const token = tokens[0]![1];
    expect(tokens[0]![0]).toBe(`${CONTEXT}/daedalus`);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(secret.stdin).toContain(token);
    expect(
      cluster.calls.every((call) => !call.args.join(" ").includes(token)),
    ).toBe(true);
    expect(done.log.join("\n")).not.toContain(token);
    expect(done.log).toContain(
      `Secret daedalus-admin created; its admin token is in the Keychain (dev.daedalus.gateway-admin, ${CONTEXT}/daedalus)`,
    );
    expect(done.adminTokenWaiting).toBeUndefined();
    expect(installer.adminToken()).toBeNull();

    // The egress check ran and cleaned up after itself.
    expect(done.egress).toEqual([
      {
        target: "169.254.169.254:80",
        want: "blocked",
        got: "blocked",
        result: "pass",
      },
      {
        target: "10.244.0.5:8080",
        want: "blocked",
        got: "blocked",
        result: "pass",
      },
      {
        target: "daedalus-gateway-runners.daedalus.svc:8081",
        want: "open",
        got: "open",
        result: "pass",
      },
      { target: "1.1.1.1:443", want: "open", got: "open", result: "pass" },
    ]);
    expect(
      cluster.calls.filter(
        (call) =>
          call.args[0] === "delete" &&
          call.args.includes("daedalus-egress-check") &&
          call.args.includes("--wait=false"),
      ).length,
    ).toBe(1);

    const install = cluster.calls.find(
      (call) =>
        call.tool === "helm" &&
        call.args[0] === "upgrade" &&
        !call.args.includes("--dry-run=server"),
    )!;
    expect(install.args.slice(0, 4)).toEqual([
      "upgrade",
      "--install",
      "daedalus",
      "/bundle/deploy/helm/daedalus",
    ]);

    expect(spawned).toEqual([
      [
        "/opt/homebrew/bin/kubectl",
        "port-forward",
        "--address=127.0.0.1",
        "-n",
        "daedalus",
        "service/daedalus-gateway",
        "18123:8080",
        `--context=${CONTEXT}`,
      ],
    ]);
    const record = JSON.parse(
      await readFile(join(home, "cloud", "gateway-port-forward.json"), "utf8"),
    );
    expect(record).toEqual({
      context: CONTEXT,
      namespace: "daedalus",
      port: 18123,
      gatewayUrl: "http://127.0.0.1:18123",
    });
    // A dry run is good for one install.
    await expect(
      installer.start({
        ...input,
        dryRunId,
        confirm: CONTEXT,
        email: "me@example.com",
      }),
    ).rejects.toThrow("Run the checks and the dry run again");
  });

  test("a public URL with the acknowledgement: no port-forward", async () => {
    await installer.preflight(input);
    const { dryRunId } = await installer.dryRun(input);
    await installer.start({
      ...input,
      dryRunId,
      confirm: CONTEXT,
      email: "me@example.com",
      publicUrl: "https://daedalus.example.com/",
      acknowledgeDevLogin: true,
    });
    await settle();
    expect(installer.current()?.gatewayUrl).toBe(
      "https://daedalus.example.com",
    );
    expect(installer.current()?.portForward).toBeUndefined();
    expect(spawned).toEqual([]);
  });

  test("a failing helm ends in failed with helm's words", async () => {
    cluster.override = (call) =>
      call.tool === "helm" &&
      call.args[0] === "upgrade" &&
      !call.args.includes("--dry-run=server")
        ? no("Error: UPGRADE FAILED: timed out waiting for the condition")
        : undefined;
    await installer.preflight(input);
    const { dryRunId } = await installer.dryRun(input);
    await installer.start({
      ...input,
      dryRunId,
      confirm: CONTEXT,
      email: "a@b.c",
    });
    await settle();
    expect(installer.current()?.phase).toBe("failed");
    expect(installer.current()?.message).toContain("UPGRADE FAILED");
    expect(signIns).toEqual([]);
    installer.dismiss();
    expect(installer.current()).toBeUndefined();
  });

  test("an upgrade keeps the port it already forwards", async () => {
    const install = async (target: GatewayInstaller) => {
      await target.preflight(input);
      const { dryRunId } = await target.dryRun(input);
      await target.start({
        ...input,
        dryRunId,
        confirm: CONTEXT,
        email: "a@b.c",
      });
      await settle(target);
    };
    await install(installer);
    installer.close();
    installer = makeInstaller({ freePort: async () => 19999 });
    await install(installer);
    expect(installer.current()?.gatewayUrl).toBe("http://127.0.0.1:18123");
  });

  test("resume brings the port-forward back only for the signed-in gateway", async () => {
    await installer.preflight(input);
    const { dryRunId } = await installer.dryRun(input);
    await installer.start({
      ...input,
      dryRunId,
      confirm: CONTEXT,
      email: "a@b.c",
    });
    await settle();
    installer.close();
    spawned = [];
    const same = makeInstaller({
      signedInGateway: async () => "http://127.0.0.1:18123",
    });
    await same.resume();
    await Bun.sleep(5);
    expect(same.forwarding()?.port).toBe(18123);
    expect(spawned.length).toBe(1);
    same.close();
    // Signed in elsewhere: no forward, and the record goes.
    const other = makeInstaller({
      signedInGateway: async () => "https://else",
    });
    await other.resume();
    expect(other.forwarding()).toBeUndefined();
    await expect(
      stat(join(home, "cloud", "gateway-port-forward.json")),
    ).rejects.toThrow();
  });
});

describe("review fixes (cloud-ui-review.md, Gateway install)", () => {
  const input = {
    context: CONTEXT,
    images: { registry: "r.example.com/daedalus", tag: "0.32.0" },
  };
  const installed = (values: object, podSecurity: string | null = null) => {
    cluster.state.namespace = true;
    cluster.state.podSecurity = podSecurity;
    cluster.state.values = JSON.stringify(values);
    cluster.state.releases = JSON.stringify([
      {
        name: "daedalus",
        namespace: "daedalus",
        revision: "3",
        chart: "daedalus-0.1.0",
        status: "deployed",
      },
    ]);
  };
  const install = async (extra: object = {}) => {
    await installer.preflight(input);
    const { dryRunId } = await installer.dryRun(input);
    await installer.start({
      ...input,
      dryRunId,
      confirm: CONTEXT,
      email: "me@example.com",
      ...extra,
    });
    await settle();
    return installer.current()!;
  };
  const helmInstall = () =>
    cluster.calls.find(
      (call) =>
        call.tool === "helm" &&
        call.args[0] === "upgrade" &&
        !call.args.includes("--dry-run=server"),
    )!;

  test("G-1: Kubernetes' namespaces are refused before any cluster call", async () => {
    for (const namespace of ["kube-system", "default", "kube-public"])
      await expect(
        installer.preflight({ ...input, namespace }),
      ).rejects.toThrow(`Namespace ${namespace} is not for the gateway`);
    expect(clusterCalls("kubectl")).toEqual([]);
  });

  test("G-1: an existing namespace without this release fails the checks", async () => {
    cluster.state.namespace = true;
    const preflight = await installer.preflight({
      ...input,
      namespace: "team-apps",
    });
    expect(preflight.ready).toBe(false);
    expect(preflight.checks.find((check) => check.id === "namespace")).toEqual(
      expect.objectContaining({
        status: "fail",
        label: "Namespace team-apps already exists",
      }),
    );
    await expect(
      installer.dryRun({ ...input, namespace: "team-apps" }),
    ).rejects.toThrow("The checks found something to fix first");
  });

  test("G-1: a namespace made after the checks is refused at start", async () => {
    await installer.preflight(input);
    const { dryRunId } = await installer.dryRun(input);
    cluster.state.namespace = true;
    await expect(
      installer.start({ ...input, dryRunId, confirm: CONTEXT, email: "a@b.c" }),
    ).rejects.toThrow("was made since the checks");
  });

  test("G-1: the release's namespace is relabelled only when needed, and the preview says so", async () => {
    installed({ gateway: { devLogin: true } }, "baseline");
    await installer.preflight(input);
    const dryRun = await installer.dryRun(input);
    expect(dryRun.objects[0]).toEqual({
      kind: "Namespace",
      name: "daedalus",
      namespace: null,
      note: "label pod-security.kubernetes.io/enforce=restricted (now baseline)",
    });
    await installer.start({
      ...input,
      dryRunId: dryRun.dryRunId,
      confirm: CONTEXT,
      email: "a@b.c",
    });
    await settle();
    const label = cluster.calls.find((call) => call.args[0] === "label")!;
    expect(label.args).toEqual([
      "label",
      "namespace",
      "daedalus",
      "pod-security.kubernetes.io/enforce=restricted",
      "--overwrite",
      `--context=${CONTEXT}`,
    ]);
    expect(
      cluster.calls.some(
        (call) => call.args[0] === "apply" && call.stdin?.includes("Namespace"),
      ),
    ).toBe(false);
  });

  test("G-2: an upgrade keeps the installed values and sends only changes", async () => {
    installed(
      {
        gateway: { devLogin: false, publicUrl: "https://gw.example.com" },
        tenant: { blockedEgressCIDRs: ["10.0.0.0/8", "100.64.0.0/10"] },
        workspace: {
          runtimeClassScheduling: { nodeSelector: { gvisor: "yes" } },
        },
      },
      "restricted",
    );
    const preflight = await installer.preflight(input);
    expect(preflight.release).toEqual({
      namespace: "daedalus",
      revision: 3,
      chartVersion: "0.1.0",
      devLogin: false,
      publicUrl: "https://gw.example.com",
      images: null,
      storageClass: "",
    });
    const done = await install();
    expect(done.phase).toBe("done");
    expect(helmInstall().args).toContain("--reset-then-reuse-values");
    const values = JSON.parse(cluster.state.values);
    expect(values.tenant.blockedEgressCIDRs).toEqual([
      "10.0.0.0/8",
      "100.64.0.0/10",
    ]);
    expect(values.workspace.runtimeClassScheduling).toEqual({
      nodeSelector: { gvisor: "yes" },
    });
    expect(values.gateway).toEqual({
      devLogin: false,
      publicUrl: "https://gw.example.com",
    });
    expect(values.image.gateway.repository).toBe(
      "r.example.com/daedalus/daedalus-gateway",
    );
    // Dev login stayed off, so the app did not sign in; no Secret was made.
    expect(done.signedIn).toBe(false);
    expect(signIns).toEqual([]);
    expect(done.gatewayUrl).toBe("https://gw.example.com");
    expect(spawned).toEqual([]);
    expect(
      cluster.calls.some((call) => call.stdin?.includes('"kind":"Secret"')),
    ).toBe(false);
  });

  test("G-2: turning dev login on behind a public URL needs the acknowledgement", async () => {
    installed(
      { gateway: { devLogin: false, publicUrl: "https://gw.example.com" } },
      "restricted",
    );
    await installer.preflight(input);
    const { dryRunId } = await installer.dryRun(input);
    await expect(
      installer.start({
        ...input,
        dryRunId,
        confirm: CONTEXT,
        email: "a@b.c",
        devLogin: true,
      }),
    ).rejects.toThrow("acknowledge");
    await installer.start({
      ...input,
      dryRunId,
      confirm: CONTEXT,
      email: "a@b.c",
      devLogin: true,
      acknowledgeDevLogin: true,
    });
    await settle();
    expect(JSON.parse(cluster.state.values).gateway.devLogin).toBe(true);
    expect(signIns).toEqual([["https://gw.example.com", "a@b.c"]]);
  });

  test("G-3: a context moved to another cluster after the dry run is refused", async () => {
    await installer.preflight(input);
    const { dryRunId } = await installer.dryRun(input);
    cluster.state.server = "https://other.example.com";
    await expect(
      installer.start({ ...input, dryRunId, confirm: CONTEXT, email: "a@b.c" }),
    ).rejects.toThrow("Run the checks and the dry run again");
  });

  test("G-4: a refused Keychain write: said so, token once through its own request", async () => {
    installer = makeInstaller({
      saveAdminToken: async () => {
        throw new Error("The Keychain is locked");
      },
    });
    const done = await install();
    expect(done.phase).toBe("done");
    expect(done.adminTokenWaiting).toBe(true);
    expect(done.log.join("\n")).not.toContain("is in the Keychain");
    expect(done.log.join("\n")).toContain(
      "the Keychain did not take its admin token",
    );
    const secret = cluster.calls.find((call) =>
      call.stdin?.includes('"kind":"Secret"'),
    )!;
    const token = (
      JSON.parse(secret.stdin!) as { stringData: { "admin-token": string } }
    ).stringData["admin-token"];
    expect(JSON.stringify(installer.current())).not.toContain(token);
    expect(installer.adminToken()).toEqual({
      token,
      secret: "daedalus-admin",
      namespace: "daedalus",
    });
    expect(installer.adminToken()).toBeNull();
    expect(installer.current()?.adminTokenWaiting).toBeUndefined();
  });

  test("G-5: the port-forward stops on sign-out", async () => {
    let gateway: string | null = null;
    const killed: string[] = [];
    installer = makeInstaller({
      signedInGateway: async () => gateway,
      spawn: (argv) => {
        spawned.push(argv);
        return {
          exited: new Promise(() => {}),
          kill: () => void killed.push("x"),
        };
      },
      signIn: async (url) => void (gateway = url),
    });
    await install();
    await installer.checkForward();
    expect(installer.forwarding()?.port).toBe(18123);
    gateway = null;
    await installer.checkForward();
    expect(installer.forwarding()).toBeUndefined();
    expect(killed.length).toBe(1);
    await expect(
      stat(join(home, "cloud", "gateway-port-forward.json")),
    ).rejects.toThrow();
  });

  test("G-5: the port-forward stops for good when the gateway is gone", async () => {
    let end!: () => void;
    installer = makeInstaller({
      spawn: (argv) => {
        spawned.push(argv);
        return {
          exited: new Promise<void>((resolve) => (end = resolve)),
          kill: () => {},
        };
      },
    });
    await install();
    cluster.state.service = false;
    end();
    for (let i = 0; i < 50 && installer.forwarding(); i++) await Bun.sleep(1);
    expect(installer.forwarding()).toBeUndefined();
    expect(spawned.length).toBe(1);
  });

  test("G-6: the VPC CNI's flag decides; unknown needs the acknowledgement", async () => {
    const eks = (args: string) => (call: Call) => {
      const line = call.args.join(" ");
      if (line.startsWith("get daemonsets"))
        return ok("aws-node\tamazon-k8s-cni:v1 aws-network-policy-agent:v1\n");
      if (line.startsWith("get daemonset aws-node"))
        return ok(`aws-node\t[]\naws-eks-nodeagent\t${args}\n`);
      return undefined;
    };
    cluster.override = eks('["--enable-network-policy=true"]');
    let preflight = await installer.preflight(input);
    expect(
      preflight.checks.find((check) => check.id === "networkPolicy")?.status,
    ).toBe("pass");
    expect(preflight.acknowledge).toEqual([]);
    cluster.override = eks('["--enable-network-policy=false"]');
    preflight = await installer.preflight(input);
    expect(
      preflight.checks.find((check) => check.id === "networkPolicy")?.status,
    ).toBe("fail");
    expect(preflight.ready).toBe(false);

    cluster.override = (call) =>
      call.args[0] === "get" && call.args[1] === "daemonsets"
        ? ok("weird-cni\tsomething:v1\n")
        : undefined;
    preflight = await installer.preflight(input);
    expect(preflight.ready).toBe(true);
    expect(preflight.acknowledge).toEqual(["networkPolicy"]);
    const { dryRunId } = await installer.dryRun(input);
    await expect(
      installer.start({ ...input, dryRunId, confirm: CONTEXT, email: "a@b.c" }),
    ).rejects.toThrow("NetworkPolicy is unknown");
    await installer.start({
      ...input,
      dryRunId,
      confirm: CONTEXT,
      email: "a@b.c",
      acknowledgeNetworkPolicy: true,
    });
    await settle();
    expect(installer.current()?.phase).toBe("done");
  });

  test("G-6: a workspace that reaches the metadata address fails the egress check", async () => {
    cluster.override = (call) =>
      call.args[0] === "exec" ? ok("open\n") : undefined;
    const done = await install();
    expect(done.phase).toBe("done");
    expect(done.egress?.[0]).toEqual({
      target: "169.254.169.254:80",
      want: "blocked",
      got: "open",
      result: "fail",
    });
    expect(done.log.join("\n")).toContain("should block");
  });

  test("G-6: a block the control pod also meets is unproven", async () => {
    cluster.override = (call) =>
      call.args[0] === "exec" && call.args.includes("169.254.169.254")
        ? ok("blocked\n")
        : undefined;
    const done = await install();
    expect(done.egress?.[0]?.result).toBe("unproven");
  });
});

describe("try it locally", () => {
  test("own kubeconfig for every call, gVisor, images, install, sign-in", async () => {
    installer = makeInstaller({ sourceRoot: undefined });
    await installer.local({ email: "me@example.com" });
    await settle();
    const done = installer.current()!;
    expect(done.message).toBeUndefined();
    expect(done.phase).toBe("done");
    expect(done.gatewayUrl).toBe("http://127.0.0.1:18123");
    expect(signIns).toEqual([["http://127.0.0.1:18123", "me@example.com"]]);

    const kubeconfig = join(home, "cloud", `kind-${LOCAL_CLUSTER}.kubeconfig`);
    const create = cluster.calls.find(
      (call) => call.args[0] === "create" && call.tool === "kind",
    )!;
    expect(create.args).toContain("--kubeconfig");
    expect(create.args[create.args.indexOf("--kubeconfig") + 1]).toBe(
      kubeconfig,
    );
    for (const call of [...clusterCalls("kubectl"), ...clusterCalls("helm")]) {
      expect(call.args).toContain(`--kubeconfig=${kubeconfig}`);
      expect(
        call.args.includes(`--context=${LOCAL_CONTEXT}`) ||
          call.args.includes(`--kube-context=${LOCAL_CONTEXT}`),
      ).toBe(true);
    }
    const gvisor = cluster.calls.find((call) => call.tool === "bash")!;
    expect(gvisor.args).toEqual(["/bundle/deploy/kind/gvisor.sh"]);
    expect(gvisor.env?.KUBECONFIG).toBe(kubeconfig);
    expect(gvisor.env?.KIND_CLUSTER).toBe(LOCAL_CLUSTER);
    const loads = cluster.calls.filter((call) => call.args[0] === "load");
    expect(loads.map((call) => call.args[2])).toEqual([
      "daedalus-gateway:local",
      "daedalus-runner:local",
    ]);
    const helm = cluster.calls.find(
      (call) => call.tool === "helm" && call.args[0] === "upgrade",
    )!;
    expect(helm.args).toContain("/bundle/deploy/kind/values.yaml");
    expect(spawned).toEqual([]);
  });

  test("missing images and no checkout: says how to build them", async () => {
    cluster.override = (call) =>
      call.args[0] === "image" ? no("No such image") : undefined;
    await installer.local({ email: "me@example.com" });
    await settle();
    expect(installer.current()?.phase).toBe("failed");
    expect(installer.current()?.message).toContain(
      "docker build -t daedalus-gateway:local",
    );
  });

  test("Docker not running stops before anything", async () => {
    cluster.override = (call) =>
      call.tool === "docker" && call.args[0] === "info"
        ? no("Cannot connect to the Docker daemon")
        : undefined;
    await installer.local({ email: "me@example.com" });
    await settle();
    expect(installer.current()?.message).toBe("docker: Start Docker");
    expect(cluster.calls.some((call) => call.tool === "kind")).toBe(false);
  });

  test("one install at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    installer = makeInstaller({
      run: async (executable, args, options) => {
        if (args[0] === "get" && args[1] === "clusters") await gate;
        return cluster.run(executable, args, options);
      },
    });
    await installer.local({ email: "me@example.com" });
    await expect(installer.local({ email: "me@example.com" })).rejects.toThrow(
      DaedalusError,
    );
    expect(() => installer.dismiss()).toThrow("still running");
    release();
    await settle();
  });
});

describe("checks", () => {
  test("Kubernetes version", () => {
    expect(
      versionCheck(
        JSON.stringify({ serverVersion: { major: "1", minor: "29" } }),
      ).status,
    ).toBe("fail");
    expect(
      versionCheck(
        JSON.stringify({ serverVersion: { major: "1", minor: "30+" } }),
      ).label,
    ).toBe("Kubernetes 1.30");
  });

  test("can-i answers", () => {
    expect(canIAnswer(0, "yes\n")).toBe(true);
    expect(canIAnswer(1, "no\n")).toBe(false);
    expect(canIAnswer(1, "Warning: x\nno\n")).toBe(false);
    expect(canIAnswer(1, "error: forbidden")).toBe(null);
  });

  test("StorageClass", () => {
    expect(storageClassCheck("a\t\nb\ttrue\n", undefined).label).toBe(
      "Default StorageClass b",
    );
    expect(storageClassCheck("a\t\n", undefined).status).toBe("fail");
    expect(storageClassCheck("a\t\n", "a").status).toBe("pass");
    expect(storageClassCheck("a\t\n", "z").detail).toBe("The cluster has: a");
  });

  test("gVisor", () => {
    expect(gvisorCheck("n1\t runc\nn2\trunsc runc\n").label).toBe(
      "gVisor on 1 of 2 nodes",
    );
    expect(gvisorCheck("n1\t test-handler runc\n").status).toBe("fail");
    expect(gvisorCheck("n1\t\n").status).toBe("unknown");
  });

  test("NetworkPolicy", () => {
    expect(
      networkPolicyCheck("kindnet\tdocker.io/kindest/kindnetd:v1\n").label,
    ).toBe("NetworkPolicy enforced by kindnet");
    expect(networkPolicyCheck("aws-node\tamazon-k8s-cni:v1\n").status).toBe(
      "unknown",
    );
    expect(networkPolicyCheck(null).status).toBe("unknown");
  });

  test("a gateway in another namespace fails; one here upgrades", () => {
    const elsewhere = releaseCheck(
      [
        {
          name: "gw",
          namespace: "tools",
          revision: 3,
          chart: "daedalus-0.1.0",
          status: "deployed",
        },
      ],
      "daedalus",
    );
    expect(elsewhere.check.status).toBe("fail");
    const here = releaseCheck(
      [
        {
          name: "daedalus",
          namespace: "daedalus",
          revision: 4,
          chart: "daedalus-0.1.0",
          status: "deployed",
        },
      ],
      "daedalus",
    );
    expect(here.check.status).toBe("pass");
    expect(here.release?.revision).toBe(4);
  });

  test("dry-run output: nested names are not objects", () => {
    const parsed = parseDryRun(MANIFEST, "daedalus");
    expect(parsed.objects.map((object) => object.name)).not.toContain(
      "not-this",
    );
  });
});

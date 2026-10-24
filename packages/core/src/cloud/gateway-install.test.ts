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

/**
 * A fake kubectl, helm, kind and docker. It answers like a healthy cluster
 * and records every call; `override` changes one answer.
 */
function fakeCluster() {
  const calls: Call[] = [];
  const state = { namespace: false, secret: false, kindCluster: false };
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
        return ok(
          "eks-test\thttps://ABC.gr7.eu-west-1.eks.amazonaws.com\nprod\thttps://prod.example.com:6443/path\n",
        );
      }
      if (line.startsWith("version"))
        return ok(
          JSON.stringify({ serverVersion: { major: "1", minor: "31+" } }),
        );
      if (line.startsWith("get namespace"))
        return state.namespace
          ? ok("namespace/daedalus")
          : no('Error from server (NotFound): namespaces "daedalus" not found');
      if (line.startsWith("auth can-i")) return ok("yes\n");
      if (line.startsWith("get storageclasses")) return ok("gp3\ttrue\n");
      if (line.startsWith("get nodes")) return ok("node-1\trunsc runc\n");
      if (line.startsWith("get daemonsets"))
        return ok("calico-node\tcalico/node:v3\n");
      if (line.startsWith("get secret"))
        return state.secret ? ok("secret/daedalus-admin") : no("NotFound");
      if (line.startsWith("apply")) {
        state.namespace = true;
        return ok("namespace/daedalus created");
      }
      if (line.startsWith("create")) {
        state.secret = true;
        return ok("secret/daedalus-admin created");
      }
      if (line.startsWith("rollout status"))
        return ok('deployment "daedalus-gateway" successfully rolled out');
    }
    if (tool === "helm") {
      if (line.startsWith("list")) return ok("[]");
      if (line.includes("--dry-run=server")) return ok(MANIFEST);
      if (line.startsWith("upgrade --install"))
        return ok('Release "daedalus" has been upgraded.\nSTATUS: deployed');
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
    expect(dryRun.objects).toEqual([
      { kind: "Namespace", name: "daedalus", namespace: null },
      { kind: "Secret", name: "daedalus-admin", namespace: "daedalus" },
      {
        kind: "ServiceAccount",
        name: "daedalus-gateway",
        namespace: "daedalus",
      },
      { kind: "ClusterRole", name: "daedalus-gateway", namespace: null },
      { kind: "Deployment", name: "daedalus-gateway", namespace: "daedalus" },
    ]);
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

    const secret = cluster.calls.find((call) => call.args[0] === "create")!;
    expect(secret.args).toEqual(["create", "-f", "-", `--context=${CONTEXT}`]);
    const token = tokens[0]![1];
    expect(tokens[0]![0]).toBe(`${CONTEXT}/daedalus`);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(secret.stdin).toContain(token);
    expect(
      cluster.calls.every((call) => !call.args.join(" ").includes(token)),
    ).toBe(true);
    expect(done.log.join("\n")).not.toContain(token);

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
    const other = makeInstaller({
      signedInGateway: async () => "https://else",
    });
    await other.resume();
    expect(other.forwarding()).toBeUndefined();
    const same = makeInstaller({
      signedInGateway: async () => "http://127.0.0.1:18123",
    });
    await same.resume();
    await Bun.sleep(5);
    expect(same.forwarding()?.port).toBe(18123);
    expect(spawned.length).toBe(1);
    same.close();
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

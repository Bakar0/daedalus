import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CommandOptions, CommandResult } from "@daedalus/platform";
import { GatewayInstaller } from "./gateway-install";

/**
 * Review of the gateway install (artifacts/cloud-sessions/cloud-ui-review.md,
 * "Gateway install", G-1 to G-4). Each test fails until its finding is fixed.
 */

const CONTEXT = "prod-eks";
const IMAGES = { registry: "1.dkr.ecr.eu-west-1.amazonaws.com/d", tag: "1.0" };

const ok = (stdout = ""): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});
const no = (stderr = "NotFound"): CommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr,
});

const DRY_RUN = `NAME: daedalus
REVISION: 2
MANIFEST:
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: daedalus-gateway
`;

interface Call {
  tool: string;
  args: string[];
  stdin?: string;
}

/**
 * A cluster where kube-system and team-apps exist, and daedalus exists once
 * it holds a release. Adjusted by @install for the lead's G-1 rule: the
 * install takes a new namespace or the one holding its release, so the
 * earlier "every namespace exists" made every test here a refusal.
 */
function fakeCluster() {
  const calls: Call[] = [];
  const state = {
    server: "https://prod.example.com",
    releases: "[]",
  };
  const run = async (
    executable: string,
    args: string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> => {
    const tool = executable.split("/").pop()!;
    calls.push({
      tool,
      args,
      ...(typeof options.stdin === "string" ? { stdin: options.stdin } : {}),
    });
    const line = args.join(" ");
    if (tool === "kubectl") {
      if (line.startsWith("config view"))
        return line.includes(".contexts")
          ? ok(`${CONTEXT}\tprod\n`)
          : ok(`prod\t${state.server}\n`);
      if (line.startsWith("version"))
        return ok(
          JSON.stringify({ serverVersion: { major: "1", minor: "31" } }),
        );
      if (line.startsWith("get namespace")) {
        const name = args[2] ?? "";
        const exists =
          ["kube-system", "team-apps"].includes(name) ||
          (name === "daedalus" && state.releases !== "[]");
        // The release's namespace carries the label already, as the app's
        // own installs leave it.
        return exists
          ? ok(
              name === "daedalus"
                ? '{"pod-security.kubernetes.io/enforce":"restricted"}'
                : "{}",
            )
          : no();
      }
      if (line.startsWith("auth can-i")) return ok("yes\n");
      if (line.startsWith("get storageclasses")) return ok("gp3\ttrue\n");
      if (line.startsWith("get nodes")) return ok("node-1\trunsc runc\n");
      if (line.startsWith("get daemonsets"))
        return ok("calico-node\tcalico/node\n");
      if (line.startsWith("get secret")) return no();
      if (line.startsWith("apply")) return ok("namespace/x configured");
      if (line.startsWith("create")) return ok("secret/daedalus-admin created");
      if (line.startsWith("rollout status")) return ok("rolled out");
    }
    if (tool === "helm") {
      if (line === "version --short") return ok("v3.19.0");
      if (line.startsWith("list")) return ok(state.releases);
      // A release the app installed: dev login on. (Added by @install: a
      // release whose values helm cannot read now fails the checks.)
      if (line.startsWith("get values"))
        return ok('{"gateway":{"devLogin":true}}');
      if (line.includes("--dry-run=server")) return ok(DRY_RUN);
      if (line.startsWith("upgrade --install")) return ok("STATUS: deployed");
    }
    return no(`unexpected ${tool} ${line}`);
  };
  return { calls, state, run };
}

let home: string;
let cluster: ReturnType<typeof fakeCluster>;
let installer: GatewayInstaller;

function makeInstaller(
  overrides: Partial<ConstructorParameters<typeof GatewayInstaller>[0]> = {},
) {
  return new GatewayInstaller({
    home,
    chartDirectory: "/bundle/deploy/helm/daedalus",
    kindDirectory: "/bundle/deploy/kind",
    signIn: async () => {},
    signedInGateway: async () => null,
    run: cluster.run,
    spawn: () => ({ exited: new Promise(() => {}), kill: () => {} }),
    path: async () => "/usr/bin",
    which: (name) => `/usr/bin/${name}`,
    saveAdminToken: async () => {},
    fetch: (async () => new Response("ok")) as unknown as typeof fetch,
    freePort: async () => 18123,
    sleep: async () => {},
    ...overrides,
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "gateway-install-review-"));
  cluster = fakeCluster();
  installer = makeInstaller();
});

afterEach(async () => {
  installer.close();
  await rm(home, { recursive: true, force: true });
});

async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const phase = installer.current()?.phase;
    if (phase === "done" || phase === "failed") return;
    await Bun.sleep(1);
  }
  throw new Error(`install did not finish: ${installer.current()?.phase}`);
}

async function checkedAndPreviewed(namespace: string) {
  const target = { context: CONTEXT, namespace, images: IMAGES };
  const preflight = await installer.preflight(target);
  expect(preflight.ready).toBe(true);
  const dryRun = await installer.dryRun(target);
  return { target, dryRun };
}

describe("G-1: an existing namespace is relabelled without being shown", () => {
  test("kube-system is refused as the install namespace", async () => {
    const target = {
      context: CONTEXT,
      namespace: "kube-system",
      images: IMAGES,
    };
    const refused = async () => {
      await installer.preflight(target);
      const dryRun = await installer.dryRun(target);
      await installer.start({
        ...target,
        dryRunId: dryRun.dryRunId,
        confirm: CONTEXT,
        email: "me@example.com",
      });
      await settle();
    };
    await refused().catch(() => {});
    const relabel = cluster.calls.find(
      (call) =>
        call.tool === "kubectl" &&
        call.args[0] === "apply" &&
        call.stdin?.includes("pod-security.kubernetes.io/enforce"),
    );
    expect(relabel).toBeUndefined();
  });

  test("an existing namespace without this release is refused", async () => {
    const preflight = await installer.preflight({
      context: CONTEXT,
      namespace: "team-apps",
      images: IMAGES,
    });
    expect(preflight.ready).toBe(false);
  });

  test("the preview lists the namespace the install will change", async () => {
    const { dryRun } = await checkedAndPreviewed("team-new");
    expect(dryRun.objects).toContainEqual(
      expect.objectContaining({
        kind: "Namespace",
        name: "team-new",
        note: "new; label pod-security.kubernetes.io/enforce=restricted",
      }),
    );
  });
});

describe("G-2: an upgrade replaces the release's values", () => {
  test("upgrading an existing release keeps its values", async () => {
    cluster.state.releases = JSON.stringify([
      {
        name: "daedalus",
        namespace: "daedalus",
        revision: "3",
        chart: "daedalus-0.1.0",
        status: "deployed",
      },
    ]);
    const { target, dryRun } = await checkedAndPreviewed("daedalus");
    await installer.start({
      ...target,
      dryRunId: dryRun.dryRunId,
      confirm: CONTEXT,
      email: "me@example.com",
    });
    await settle();
    const upgrade = cluster.calls.find(
      (call) =>
        call.tool === "helm" &&
        call.args[0] === "upgrade" &&
        !call.args.some((arg) => arg.startsWith("--dry-run")),
    );
    expect(upgrade).toBeDefined();
    expect(
      upgrade!.args.some((arg) =>
        ["--reuse-values", "--reset-then-reuse-values"].includes(arg),
      ),
    ).toBe(true);
  });
});

describe("G-3: the context is bound by name only", () => {
  test("a context moved to another cluster after the dry run is refused", async () => {
    const { target, dryRun } = await checkedAndPreviewed("daedalus");
    cluster.state.server = "https://other-cluster.example.com";
    await expect(
      installer.start({
        ...target,
        dryRunId: dryRun.dryRunId,
        confirm: CONTEXT,
        email: "me@example.com",
      }),
    ).rejects.toThrow();
  });
});

describe("G-4: the log says the token is in the Keychain when it is not", () => {
  test("a refused Keychain write is not reported as kept", async () => {
    installer = makeInstaller({
      saveAdminToken: async () => {
        throw new Error("The Keychain is locked");
      },
    });
    const { target, dryRun } = await checkedAndPreviewed("daedalus");
    await installer.start({
      ...target,
      dryRunId: dryRun.dryRunId,
      confirm: CONTEXT,
      email: "me@example.com",
    });
    await settle();
    expect(installer.current()?.log.join("\n")).not.toContain(
      "its admin token is in the Keychain",
    );
  });
});

describe("G-8: dev login off loses its port-forward", () => {
  // Rewritten by @install for the lead's decision (2026-10-25): dev login
  // off without a public address is refused until company sign-in exists,
  // and the forward of the last install stays until a sign-in has used it.
  test("dev login off without a public address is refused", async () => {
    const { target, dryRun } = await checkedAndPreviewed("daedalus");
    await expect(
      installer.start({
        ...target,
        dryRunId: dryRun.dryRunId,
        confirm: CONTEXT,
        email: "me@example.com",
        devLogin: false,
      }),
    ).rejects.toThrow("With dev login off");
  });

  test("the forward of an install whose sign-in failed outlives the next check", async () => {
    installer = makeInstaller({
      signIn: async () => {
        throw new Error("the gateway refused the sign-in");
      },
    });
    const { target, dryRun } = await checkedAndPreviewed("daedalus");
    await installer.start({
      ...target,
      dryRunId: dryRun.dryRunId,
      confirm: CONTEXT,
      email: "me@example.com",
    });
    await settle();
    expect(installer.current()?.phase).toBe("failed");
    expect(installer.forwarding()?.port).toBe(18123);
    // What the 30-second watch and every sign-in or sign-out call.
    await installer.checkForward();
    expect(installer.forwarding()?.port).toBe(18123);
  });
});

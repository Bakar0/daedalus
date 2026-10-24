/**
 * The page the `scripts/cloud-*-ui-check.ts` checks drive.
 *
 * A fake host with a small cloud backend: sign-in, four workspaces (a plain
 * local one, one in the cloud and running, one in the cloud and asleep, one
 * in another cloud account) and a session in each. Query parameters pick the
 * start: `modal=settings|session`, `signedIn=0`, `holdSignIn=1`,
 * `holdWake=1`, `session=<id>` to open a session's view,
 * `archive=big` for a cloud workspace's archive that is refused, `wsmove=<phase>` for Cloud project moving home in that phase,
 * `moveAsk=busy|stopped|big|fail|limit` for a move that asks, is refused
 * or fails, `holdMove=1` to hold a move until `releaseMove()`, and
 * `notice=1` for Sleepy project back from its backup, `archived=1` for an
 * archived session under Plain local; for the gateway install,
 * `contexts=none`, `tools=missing`, `preflight=fail`, and `holdInstall=1` to
 * hold an install until `releaseInstall()`.
 *
 * Every call a click should make is recorded in `window.requests`. The
 * replies carry a token and a runner key the real host never sends, so the
 * checks can assert that the window does not show what it was handed.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentSessionDto,
  CloudStateDto,
  CloudWorkspaceDto,
  DesktopSnapshotDto,
  WorkspaceDto,
} from "@daedalus/protocol";
import { App } from "./App";
import type { DesktopClient } from "./client-types";
import "./styles.css";

const FIXTURE_TOKEN = "dtok-SECRET-5f3a9c";
const FIXTURE_RUNNER_KEY = "rkey-SECRET-77b1e0";

const query = new URLSearchParams(window.location.search);
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

declare global {
  interface Window {
    requests: Array<Record<string, unknown>>;
    cloudFixture: {
      releaseSignIn: () => void;
      releaseWake: () => void;
      releaseMove: () => void;
      releaseInstall: () => void;
      setCloudStatus: (
        workspaceId: string,
        status: CloudWorkspaceDto["status"],
      ) => void;
      signOutFromOutside: () => void;
    };
  }
}
window.requests = [];
const record = (name: string, params: unknown) =>
  window.requests.push({ [name]: params });

const workspace = (
  id: string,
  name: string,
  position: number,
): WorkspaceDto => ({
  id,
  slug: id,
  name,
  path: `/tmp/${id}`,
  createdAt: ago(9000),
  updatedAt: ago(10),
  archivedAt: null,
  available: true,
  position,
  startSetsInProgress: true,
  autoRebirthPercent: null,
  defaultProvider: "claude",
  defaultModel: null,
  accountModels: {},
  defaultClaudeAccount: null,
  defaultCodexAccount: null,
});

let sequence = 0;
const session = (
  id: string,
  workspaceId: string,
  overrides: Partial<AgentSessionDto> = {},
): AgentSessionDto => ({
  id,
  workspaceId,
  taskId: null,
  name: id,
  provider: "claude",
  kind: "agent",
  tmuxSession: `daedalus_${id}`,
  command: "claude",
  args: [],
  workingDirectory: `/tmp/${workspaceId}`,
  status: "running",
  exitCode: null,
  startedAt: ago(90),
  endedAt: null,
  providerSessionId: null,
  account: null,
  teamId: null,
  teamHandle: null,
  spawnedBy: null,
  archivedAt: null,
  resumeCount: 0,
  lostReason: null,
  rebirthRequestedAt: null,
  position: sequence++,
  pinnedAt: null,
  color: null,
  autoRebirthPercent: null,
  ...overrides,
});

// `workspaces=none`: nothing in the sidebar yet.
const noWorkspaces = query.get("workspaces") === "none";

const snapshot = {
  workspaces: [
    workspace("local-ws", "Plain local", 1),
    { ...workspace("cloud-ws", "Cloud project", 2), place: "cloud" },
    query.get("notice") === "1"
      ? {
          ...workspace("sleepy-ws", "Sleepy project", 3),
          cloudNotice:
            "Back on this Mac from its backup of 20 September: the cloud copy was deleted after 30 days asleep.",
        }
      : { ...workspace("sleepy-ws", "Sleepy project", 3), place: "cloud" },
    { ...workspace("other-ws", "Other account", 4), place: "cloud" },
  ].filter(() => !noWorkspaces),
  tasks: [],
  // A sign-in page the cloud Claude session asked to open. The URL never
  // reaches the window, only its host. `signin=claude|aws`, `paste=1` for
  // the paste-code form.
  // Cloud project on its way home, in the phase the query names.
  workspaceMoves: query.get("wsmove")
    ? [
        {
          workspaceId: "cloud-ws",
          to: "mac" as const,
          phase: query.get("wsmove") as "waiting",
          detail: "Waiting for 2 sessions to end their turns",
          ...(query.get("wsmove") === "failed"
            ? { message: "The pod did not answer." }
            : {}),
          ...(query.get("wsmove") === "moved"
            ? {
                notice:
                  "Back on this Mac. 2 files over the size cap stayed in the cloud copy.",
              }
            : {}),
        },
      ]
    : [],
  cloudSignIns: query.get("signin")
    ? [
        {
          requestId: "req-1",
          sessionId: "s-cloud",
          host:
            query.get("signin") === "aws"
              ? "d-9a672d87aa.awsapps.com"
              : "claude.com",
          kind: query.get("signin") === "aws" ? "aws" : "claude",
          phase: "waiting",
          expiresAt: now + 10 * 60_000,
        },
      ]
    : [],
  agents: [
    session("s-local", "local-ws"),
    session("s-cloud", "cloud-ws", { hostId: "ws:c-run" }),
    session("s-sleepy", "sleepy-ws", { hostId: "ws:c-sleep", status: "lost" }),
    session("s-other", "other-ws", { hostId: "ws:c-other", status: "lost" }),
    // `moveAsk=stopped`: an idle Codex session the cloud cannot run.
    ...(query.get("moveAsk") === "stopped"
      ? [
          session("s-codex", "local-ws", {
            name: "codex helper",
            provider: "codex",
            command: "codex",
          }),
        ]
      : []),
    // `archived=1`: an archived session under Plain local.
    ...(query.get("archived") === "1"
      ? [
          session("s-old", "local-ws", {
            archivedAt: ago(30),
            status: "exited",
          }),
        ]
      : []),
  ],
  terminals: [],
  repositories: [],
  worktrees: [],
  shipped: [],
  sessionTelemetry: [],
  providerUsage: [],
  sessionActivity: [],
  attention: [],
  toasts: [],
  abilities: [],
  teams: [],
  routines: [],
  routineReports: [],
  settings: {
    version: "0.7.0",
    channel: "dev",
    home: "/Users/someone/.daedalus-dev",
    workspaceRoot: "/Users/someone/.daedalus-dev/workspaces",
    databasePath: "/Users/someone/.daedalus-dev/state.db",
    repositoryRoot: "/Users/someone/.daedalus-dev/repos",
    tmuxAvailable: true,
    tmuxVersion: "3.7c",
    workspaceInstructionFilesEnabled: true,
    autoRestoreSessionsEnabled: true,
    trustSessionFoldersEnabled: true,
    autoRebirthPercent: null,
    focusMode: false,
    accounts: [
      {
        provider: "claude",
        account: "default",
        name: "Default",
        directory: "/Users/someone/.claude",
        createdAt: null,
        kind: "login",
      },
      {
        provider: "claude",
        account: "work-1a2b",
        name: "Work",
        directory: "/Users/someone/.daedalus-dev/accounts/claude/work-1a2b",
        createdAt: ago(5000),
        kind: "login",
      },
      {
        provider: "codex",
        account: "default",
        name: "Default",
        directory: "/Users/someone/.codex",
        createdAt: null,
        kind: "login",
      },
    ],
    providers: [
      { name: "claude", executable: "/usr/local/bin/claude", available: true },
      { name: "codex", executable: "/usr/local/bin/codex", available: true },
    ],
  },
} as unknown as DesktopSnapshotDto;

// The cloud backend.
const cloud = {
  signedIn: query.get("signedIn") !== "0",
  email: "dev@example.com",
  gatewayUrl: "http://127.0.0.1:8080",
  workspaces: [
    {
      workspaceId: "cloud-ws",
      cloudId: "c-run",
      status: "running",
      runnerOnline: true,
      reason: null,
      createdAt: "2026-10-20T10:00:00.000Z",
    },
    {
      workspaceId: "sleepy-ws",
      cloudId: "c-sleep",
      status: "sleeping",
      runnerOnline: false,
      reason: null,
      createdAt: "2026-10-21T10:00:00.000Z",
    },
  ] as CloudWorkspaceDto[],
};

const cloudState = () => {
  const state: CloudStateDto & Record<string, unknown> = cloud.signedIn
    ? {
        signedIn: true,
        gatewayUrl: cloud.gatewayUrl,
        email: cloud.email,
        connection: "online",
        error: null,
        workspaces: structuredClone(cloud.workspaces),
      }
    : {
        signedIn: false,
        gatewayUrl: null,
        email: null,
        connection: "signed-out",
        error: null,
        workspaces: [],
      };
  // What the real host never sends. The window must not show it.
  return { ...state, token: FIXTURE_TOKEN, runnerKey: FIXTURE_RUNNER_KEY };
};

const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (message: string) => ({
  ok: false as const,
  error: { code: "VALIDATION", message },
});

const listeners = new Set<() => void>();
// The user's remote MCP servers. The host keeps their URLs (one with a key in
// its path); the window gets name and host only, which the check asserts.
const mcp = {
  servers: [
    { name: "context7", host: "mcp.context7.com", on: false },
    { name: "zapier", host: "actions.zapier.com", on: false },
  ],
  urls: { zapier: "https://actions.zapier.com/mcp/zk-SECRET-key/sse" },
};
const mcpList = () => ({
  servers: mcp.servers.map((server) => ({ ...server })),
  leftOut: [{ name: "files", reason: "runs a command on this Mac" }],
});

const announce = () => {
  for (const listener of listeners) listener();
};
const gate = () => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const signInGate = gate();
const wakeGate = gate();
const moveGate = gate();
const installGate = gate();
window.cloudFixture = {
  releaseSignIn: signInGate.release,
  releaseWake: wakeGate.release,
  releaseMove: moveGate.release,
  releaseInstall: installGate.release,
  setCloudStatus: (workspaceId, status) => {
    const found = cloud.workspaces.find(
      (item) => item.workspaceId === workspaceId,
    );
    if (found) found.status = status;
    announce();
  },
  signOutFromOutside: () => {
    cloud.signedIn = false;
    announce();
  },
};

const withCloud = (workspaceId: string) =>
  cloud.workspaces.find((item) => item.workspaceId === workspaceId);

const client = {
  request: {
    snapshot: async () => ok(structuredClone(snapshot)),
    terminalEndpoint: async () =>
      ok({ endpoint: "ws://127.0.0.1:1/cloud-test" }),
    presencePublish: async () => ok({}),
    toastsAcknowledge: async () => ok({ acknowledged: 0 }),
    workspaceWatchSet: async () => ok({ watching: [] }),
    agentModels: async ({ provider }: { provider: "codex" | "claude" }) =>
      ok({
        provider,
        models: [
          { id: "opus", label: "Opus" },
          { id: "sonnet", label: "Sonnet" },
        ],
        source: "aliases",
      }),
    accountStatus: async () => ok([]),
    workspaceContentGet: async ({ workspace }: { workspace?: string }) =>
      ok({
        workspaceId: workspace ?? "local-ws",
        brief: "# Brief",
        journal: "# Journal",
        files: [],
        repositories: [],
        worktrees: [],
      }),
    skillList: async () => ok({ managed: [], discovered: [] }),
    appUpdateGet: async () => ok({ state: "none", currentVersion: "0.7.0" }),
    cloudState: async () => ok(cloudState()),
    cloudSignIn: async (params: { gatewayUrl: string; email: string }) => {
      record("cloudSignIn", params);
      if (query.get("holdSignIn") === "1") await signInGate.promise;
      if (params.email.startsWith("bad"))
        return fail("The gateway refused that email.");
      cloud.signedIn = true;
      cloud.email = params.email;
      cloud.gatewayUrl = params.gatewayUrl;
      return ok(cloudState());
    },
    cloudMcpServers: async () => ok(mcpList()),
    cloudMcpServerSet: async (params: { name: string; on: boolean }) => {
      record("cloudMcpServerSet", params);
      const server = mcp.servers.find((item) => item.name === params.name);
      if (server) server.on = params.on;
      return ok(mcpList());
    },
    cloudSignOut: async () => {
      record("cloudSignOut", {});
      cloud.signedIn = false;
      return ok(cloudState());
    },
    cloudWorkspaceCreate: async ({ workspace }: { workspace: string }) => {
      record("cloudWorkspaceCreate", { workspace });
      cloud.workspaces.push({
        workspaceId: workspace,
        cloudId: `c-new-${workspace}`,
        status: "running",
        runnerOnline: true,
        reason: null,
        createdAt: new Date().toISOString(),
      });
      return ok(cloudState());
    },
    cloudWorkspaceSleep: async ({ workspace }: { workspace: string }) => {
      record("cloudWorkspaceSleep", { workspace });
      const found = withCloud(workspace);
      if (found) found.status = "sleeping";
      return ok(cloudState());
    },
    cloudWorkspaceWake: async ({ workspace }: { workspace: string }) => {
      record("cloudWorkspaceWake", { workspace });
      const found = withCloud(workspace);
      if (found) found.status = "running";
      return ok(cloudState());
    },
    cloudWorkspaceDelete: async (params: {
      workspace: string;
      force: true;
    }) => {
      record("cloudWorkspaceDelete", params);
      cloud.workspaces = cloud.workspaces.filter(
        (item) => item.workspaceId !== params.workspace,
      );
      return ok(cloudState());
    },
    cloudSignInOpen: async ({ requestId }: { requestId: string }) => {
      record("cloudSignInOpen", { requestId });
      const offer = snapshot.cloudSignIns?.find(
        (item) => item.requestId === requestId,
      );
      const paste = query.get("paste") === "1";
      // Opened: the page moves on to the browser, or to pasting the code.
      snapshot.cloudSignIns = (snapshot.cloudSignIns ?? []).map((item) =>
        item.requestId === requestId
          ? {
              sessionId: item.sessionId,
              kind: item.kind,
              phase: paste ? ("pasting" as const) : ("browser" as const),
              ...(item.host ? { host: item.host } : {}),
              expiresAt: item.expiresAt,
            }
          : item,
      );
      announce();
      return ok({ host: offer?.host ?? "", paste });
    },
    cloudSignInDismiss: async ({
      requestId,
      sessionId,
    }: {
      requestId?: string;
      sessionId?: string;
    }) => {
      record("cloudSignInDismiss", { requestId, sessionId });
      snapshot.cloudSignIns = (snapshot.cloudSignIns ?? []).filter(
        (item) => item.requestId !== requestId && item.sessionId !== sessionId,
      );
      announce();
      return ok(null);
    },
    cloudSessionWake: async ({ sessionId }: { sessionId: string }) => {
      record("cloudSessionWake", { sessionId });
      if (query.get("holdWake") === "1") await wakeGate.promise;
      const found = snapshot.agents.find((item) => item.id === sessionId)!;
      const twin = withCloud(found.workspaceId);
      if (twin) twin.status = "running";
      found.status = "running";
      announce();
      return ok(structuredClone(found));
    },
    agentArchive: async (params: { id: string; force?: boolean }) => {
      record("agentArchive", params);
      const found = snapshot.agents.find((item) => item.id === params.id)!;
      found.archivedAt = new Date().toISOString();
      found.status = "exited";
      announce();
      return ok({
        status: "archived" as const,
        session: structuredClone(found),
      });
    },
    workspaceArchive: async (params: { reference: string }) => {
      record("workspaceArchive", params);
      const found = snapshot.workspaces.find(
        (item) => item.id === params.reference,
      )!;
      const asks = found.place === "cloud" ? query.get("archive") : null;
      if (asks === "big")
        return ok({
          status: "needsSmaller" as const,
          items: [
            {
              what: "repos/app",
              bytes: 1_610_612_736,
              maxBytes: 1_073_741_824,
            },
          ],
        });
      found.archivedAt = new Date().toISOString();
      delete found.place;
      announce();
      return ok({
        status: "archived" as const,
        workspace: structuredClone(found),
      });
    },
    agentStop: async (params: { id: string; force: boolean }) => {
      record("agentStop", params);
      const found = snapshot.agents.find((one) => one.id === params.id)!;
      found.status = "exited";
      announce();
      return ok(found);
    },
    workspaceMove: async (params: {
      reference: string;
      to: "cloud" | "mac";
      stopWorking?: boolean;
    }) => {
      record("workspaceMove", params);
      const found = snapshot.workspaces.find(
        (item) => item.id === params.reference,
      )!;
      const asks = query.get("moveAsk");
      if (asks === "busy" && !params.stopWorking)
        return ok({
          status: "busy" as const,
          sessions: [{ id: "s-local", name: "s-local" }],
        });
      const codex = snapshot.agents.find((one) => one.id === "s-codex");
      if (asks === "stopped" && codex?.status === "running")
        return ok({
          status: "needsStopped" as const,
          sessions: [{ id: "s-codex", name: "codex helper" }],
        });
      if (asks === "big")
        return ok({
          status: "needsSmaller" as const,
          items: [
            {
              what: "repos/app",
              bytes: 1_610_612_736,
              maxBytes: 1_073_741_824,
            },
          ],
        });
      if (asks === "fail") return fail("The gateway refused the move.");
      if (asks === "limit") return fail("You may have at most 3 workspaces");
      snapshot.workspaceMoves = [
        {
          workspaceId: found.id,
          to: params.to,
          phase: "copying",
          detail: "Copying repos/app",
        },
      ];
      announce();
      if (query.get("holdMove") === "1") await moveGate.promise;
      if (params.to === "cloud") {
        found.place = "cloud";
        if (!withCloud(found.id))
          cloud.workspaces.push({
            workspaceId: found.id,
            cloudId: `c-new-${found.id}`,
            status: "running",
            runnerOnline: true,
            reason: null,
            createdAt: new Date().toISOString(),
          });
      } else delete found.place;
      // A move ends with no notice; the card's picture says where it is.
      const notice: string | undefined = undefined;
      snapshot.workspaces = snapshot.workspaces.map((item) =>
        item.id === found.id ? { ...found } : item,
      );
      snapshot.workspaceMoves = [
        {
          workspaceId: found.id,
          to: params.to,
          phase: "moved",
          ...(notice ? { notice } : {}),
        },
      ];
      announce();
      return ok({
        status: "moved" as const,
        workspace: structuredClone(found),
        ...(notice ? { notice } : {}),
      });
    },
    workspaceMoveCancel: async (params: { reference: string }) => {
      record("workspaceMoveCancel", params);
      snapshot.workspaceMoves = [];
      announce();
      return ok(null);
    },
    workspaceMoveDismiss: async (params: { reference: string }) => {
      record("workspaceMoveDismiss", params);
      snapshot.workspaceMoves = [];
      announce();
      return ok(null);
    },
    workspaceNoticeDismiss: async (params: { reference: string }) => {
      record("workspaceNoticeDismiss", params);
      snapshot.workspaces = snapshot.workspaces.map((item) => {
        if (item.id !== params.reference) return item;
        const { cloudNotice: _read, ...rest } = item;
        return rest;
      });
      announce();
      return ok(null);
    },
    // A pod asleep is never woken by browsing its files.
    workspaceDirectoryList: async ({ workspace }: { workspace: string }) =>
      withCloud(workspace)?.status === "sleeping"
        ? fail("The cloud workspace is asleep; open a session to wake it")
        : ok([]),
    // A gateway install. Context names and hosts only; no credential, and a
    // kubeconfig path or token never comes over.
    gatewayInstallContexts: async () => {
      record("gatewayInstallContexts", {});
      return ok({
        contexts:
          query.get("contexts") === "none"
            ? []
            : [
                {
                  name: "arn:aws:eks:eu-west-1:123456789012:cluster/team",
                  serverHost: "ABCD1234.gr7.eu-west-1.eks.amazonaws.com",
                },
                { name: "kind-daedalus", serverHost: "127.0.0.1:52011" },
              ],
        tools: [
          { name: "kubectl", found: true },
          {
            name: "helm",
            found: query.get("tools") !== "missing",
            hint: "brew install helm",
          },
          { name: "kind", found: true },
          {
            name: "docker",
            found: true,
            running: query.get("tools") !== "missing",
          },
        ],
      });
    },
    gatewayInstallPreflight: async (params: Record<string, unknown>) => {
      record("gatewayInstallPreflight", params);
      const failing = query.get("preflight") === "fail";
      return ok({
        context: params.context,
        namespace: params.namespace ?? "daedalus",
        checks: [
          { id: "version", status: "pass", label: "Kubernetes 1.33" },
          {
            id: "permissions",
            status: failing ? "fail" : "pass",
            label: failing
              ? "Missing permissions"
              : "You can create everything the install needs",
            ...(failing
              ? { detail: "create clusterroles\ncreate namespaces\u001b[2J" }
              : {}),
          },
          { id: "gvisor", status: "warn", label: "No node offers gVisor" },
          {
            id: "images",
            status: "unknown",
            label: "The cluster must be able to pull the images",
          },
        ],
        ready: !failing,
        release: null,
      });
    },
    gatewayInstallDryRun: async (params: Record<string, unknown>) => {
      record("gatewayInstallDryRun", params);
      return ok({
        context: params.context,
        namespace: params.namespace ?? "daedalus",
        dryRunId: "dry-1",
        upgrade: false,
        objects: [
          { kind: "Namespace", name: "daedalus", namespace: null },
          {
            kind: "Deployment",
            name: "daedalus-gateway",
            namespace: "daedalus",
          },
          { kind: "Service", name: "daedalus-gateway", namespace: "daedalus" },
          { kind: "ClusterRole", name: "daedalus-tenant", namespace: null },
        ],
        notes: "Gateway installed.\nThis line has a control \u0007 char.",
      });
    },
    gatewayInstallStart: async (params: Record<string, unknown>) => {
      record("gatewayInstallStart", params);
      const target = {
        kind: "cluster" as const,
        context: String(params.context),
        namespace: String(params.namespace ?? "daedalus"),
      };
      snapshot.gatewayInstall = {
        target,
        phase: "installing",
        log: ["helm upgrade --install daedalus", "namespace/daedalus created"],
      };
      announce();
      void (async () => {
        if (query.get("holdInstall") === "1") await installGate.promise;
        snapshot.gatewayInstall = {
          target,
          phase: "done",
          log: [...snapshot.gatewayInstall!.log, "gateway ready"],
          gatewayUrl: "http://127.0.0.1:58080",
          portForward: !params.publicUrl,
        };
        cloud.signedIn = true;
        cloud.gatewayUrl = "http://127.0.0.1:58080";
        announce();
      })();
      return ok(structuredClone(snapshot.gatewayInstall));
    },
    gatewayInstallLocal: async (params: { email: string }) => {
      record("gatewayInstallLocal", params);
      snapshot.gatewayInstall = {
        target: { kind: "local" },
        phase: "cluster",
        log: ["Creating cluster daedalus-local"],
      };
      announce();
      return ok(structuredClone(snapshot.gatewayInstall));
    },
    gatewayInstallDismiss: async () => {
      record("gatewayInstallDismiss", {});
      delete snapshot.gatewayInstall;
      announce();
      return ok(null);
    },
    gatewayInstallGuideOpen: async () => {
      record("gatewayInstallGuideOpen", {});
      return ok({ opened: true });
    },
    terminalCreate: async (params: Record<string, unknown>) => {
      record("terminalCreate", params);
      return ok({
        id: `t-${window.requests.length}`,
        name: String(params.name ?? "terminal"),
        workingDirectory: "/tmp",
        status: "running",
      });
    },
    agentSpawn: async (params: Record<string, unknown>) => {
      record("agentSpawn", params);
      const created = session(
        `s-new-${window.requests.length}`,
        String(params.workspace),
        {
          provider: params.provider === "codex" ? "codex" : "claude",
          kind: params.terminal ? "terminal" : "agent",
          startedAt: new Date().toISOString(),
          // A workspace in the cloud starts every session in its pod.
          ...(snapshot.workspaces.find((item) => item.id === params.workspace)
            ?.place === "cloud"
            ? { hostId: `ws:${withCloud(String(params.workspace))?.cloudId}` }
            : {}),
        },
      );
      snapshot.agents.unshift(created);
      announce();
      return ok(created);
    },
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  subscribeCommands: () => () => undefined,
  subscribeWindowResize: () => () => undefined,
  subscribeFocusSession: () => () => undefined,
  subscribeQuitRequest: () => () => undefined,
  subscribeWorkspaceFiles: () => () => undefined,
} as unknown as DesktopClient;

const modal = query.get("modal");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App
      injectedClient={client}
      initialModal={modal === "settings" ? "settings" : undefined}
      initialSnapshot={snapshot}
    />
  </StrictMode>,
);

/**
 * The page the `scripts/cloud-*-ui-check.ts` checks drive.
 *
 * A fake host with a small cloud backend: sign-in, four workspaces (a plain
 * local one, one with a running cloud workspace, one asleep, one that belongs
 * to another cloud account) and a session in each. Query parameters pick the
 * start: `modal=settings|session`, `signedIn=0`, `holdSignIn=1`,
 * `holdWake=1`, `session=<id>` to open a session's view.
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

const snapshot = {
  workspaces: [
    workspace("local-ws", "Plain local", 1),
    workspace("cloud-ws", "Cloud project", 2),
    workspace("sleepy-ws", "Sleepy project", 3),
    workspace("other-ws", "Other account", 4),
  ],
  tasks: [],
  // A sign-in page the cloud Claude session asked to open. The URL never
  // reaches the window, only its host. `signin=claude|aws`, `paste=1` for
  // the paste-code form.
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
    // A shell in the running cloud workspace, for the first-run note's
    // negative case. Only with `extra=terminal`.
    ...(query.get("extra") === "terminal"
      ? [
          session("s-shell", "cloud-ws", {
            hostId: "ws:c-run",
            kind: "terminal",
            command: "bash",
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
    },
    {
      workspaceId: "sleepy-ws",
      cloudId: "c-sleep",
      status: "sleeping",
      runnerOnline: false,
      reason: null,
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
window.cloudFixture = {
  releaseSignIn: signInGate.release,
  releaseWake: wakeGate.release,
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
    agentSpawn: async (params: Record<string, unknown>) => {
      record("agentSpawn", params);
      const created = session(
        `s-new-${window.requests.length}`,
        String(params.workspace),
        {
          provider: params.provider === "codex" ? "codex" : "claude",
          kind: params.terminal ? "terminal" : "agent",
          startedAt: new Date().toISOString(),
          ...(params.cloud
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

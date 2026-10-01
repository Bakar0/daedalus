/**
 * The Residents section and the Resident page in plain Chromium.
 *
 * A stand-in host with one project workspace and one resident, Argus, whose
 * board holds two findings. Requests change the in-memory snapshot and
 * announce, as `mutate` does in `rpc.ts`, and every call is recorded on
 * `window.__residentCalls`.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentSessionDto,
  DesktopSnapshotDto,
  FindingDto,
  ResidentDetailDto,
  TaskDto,
  WorkspaceDto,
} from "@daedalus/protocol";
import { App } from "./App";
import type { DesktopClient } from "./client-types";
import "./styles.css";

declare global {
  interface Window {
    __residentCalls: Array<{ name: string; params: unknown }>;
  }
}
window.__residentCalls = [];

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const inMinutes = (minutes: number) =>
  new Date(now + minutes * 60_000).toISOString();

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
  autoHandoffPercent: null,
  defaultProvider: "claude",
  defaultModel: null,
});

const task = (
  number: number,
  title: string,
  overrides: Partial<TaskDto> = {},
): TaskDto => ({
  id: `argus-task-${number}`,
  workspaceId: "argus",
  number,
  title,
  description: `> Reported by Argus from routine \`ci-health\`.\n\n## Evidence\n\nexit 1`,
  status: "todo",
  priority: "normal",
  createdAt: ago(120),
  updatedAt: ago(30),
  completedAt: null,
  briefUpdatedAt: null,
  references: [],
  ...overrides,
});

const finding = (
  number: number,
  overrides: Partial<FindingDto> = {},
): FindingDto => ({
  id: `finding-${number}`,
  residentId: "resident-argus",
  routine: "ci-health",
  key: `ci-health:zenitysec/datalake-lab:main:CI:test-${number}`,
  sameAs: null,
  severity: "warn",
  title: `Finding ${number}`,
  url: "https://github.com/zenitysec/datalake-lab/actions/runs/1",
  taskId: `argus-task-${number}`,
  state: "open",
  verdict: null,
  openedAt: ago(120),
  lastSeenAt: ago(5),
  clearedAt: null,
  closedAt: null,
  reopenCount: 0,
  ...overrides,
});

const argusSession: AgentSessionDto = {
  id: "argus-session",
  workspaceId: "argus",
  taskId: null,
  name: "Argus",
  provider: "claude",
  kind: "agent",
  tmuxSession: "daedalus_argus",
  command: "claude",
  args: [],
  workingDirectory: "/tmp/residents/argus",
  status: "running",
  exitCode: null,
  startedAt: ago(300),
  endedAt: null,
  providerSessionId: null,
  archivedAt: null,
  resumeCount: 0,
  lostReason: null,
  handoffRequestedAt: null,
  position: 0,
};

const snapshot: DesktopSnapshotDto = {
  workspaces: [
    workspace("deadalus", "Daedalus", 1),
    workspace("argus", "Argus", 0),
  ],
  tasks: [
    task(1, "main red: test fails in datalake-lab", { priority: "high" }),
    task(2, "Services Deploy failed for api-key-authority"),
  ],
  agents: [argusSession],
  terminals: [],
  repositories: [],
  providerUsage: [],
  sessionTelemetry: [],
  sessionActivity: [],
  attention: [],
  worktrees: [],
  shipped: [],
  toasts: [],
  residents: [
    {
      id: "resident-argus",
      slug: "argus",
      name: "Argus",
      workspaceId: "argus",
      workspaceSlug: "argus",
      workspacePath: "/tmp/residents/argus",
      state: "on_duty",
      sessionId: "argus-session",
      sessionStatus: "running",
      lamp: "urgent",
      nextRunAt: inMinutes(7),
      runsInFlight: 1,
      runsQueued: 0,
      openFindings: 2,
      openFindingTasks: 2,
      routineErrors: 1,
      autoHandoffPercent: 60,
    },
  ],
  findings: [
    finding(1, { severity: "urgent", title: "main red" }),
    finding(2, {
      routine: "post-merge-watch",
      state: "cleared",
      clearedAt: ago(20),
      reopenCount: 1,
    }),
  ],
  settings: {
    version: "0.9.1",
    channel: "dev",
    home: "/tmp/daedalus-resident",
    workspaceRoot: "/tmp/daedalus-resident/workspaces",
    databasePath: "/tmp/daedalus-resident/state.db",
    repositoryRoot: "/tmp/daedalus-resident/repos",
    tmuxAvailable: true,
    tmuxVersion: "3.7c",
    workspaceInstructionFilesEnabled: true,
    autoRestoreSessionsEnabled: true,
    focusMode: false,
    providers: [{ name: "claude", executable: "claude", available: true }],
  },
};

const run = (
  id: number,
  routine: string,
  status: "queued" | "running" | "done" | "failed" | "skipped",
  outcome: "quiet" | "notified" | "task" | null,
  minutes: number,
  summary: string | null,
) => ({
  id,
  routine,
  status,
  queuedAt: ago(minutes),
  deliveredAt: ago(minutes),
  startedAt: status === "skipped" ? null : ago(minutes),
  finishedAt:
    status === "running" || status === "queued" ? null : ago(minutes - 1),
  outcome,
  summary,
  missedMs: id === 1 ? 4 * 3_600_000 : 0,
});

const detail: ResidentDetailDto = {
  routines: [
    {
      name: "ci-health",
      path: "/tmp/residents/argus/routines/ci-health.md",
      schedule: "every 30m",
      until: null,
      model: "sonnet",
      timeoutMs: 600_000,
      findings: "task",
      enabled: true,
      nextRunAt: inMinutes(7),
      lastRunAt: ago(23),
      consecutiveFailures: 0,
      lastRun: run(5, "ci-health", "done", "task", 23, "2 findings"),
    },
    {
      name: "slack-needs-me",
      path: "/tmp/residents/argus/routines/slack-needs-me.md",
      schedule: "every 30m",
      until: null,
      model: "haiku",
      timeoutMs: 600_000,
      findings: "notify",
      enabled: false,
      nextRunAt: null,
      lastRunAt: ago(60),
      consecutiveFailures: 2,
      lastRun: run(3, "slack-needs-me", "failed", null, 60, "Gateway down"),
    },
  ],
  errors: [
    {
      name: "broken",
      path: "/tmp/residents/argus/routines/broken.md",
      error:
        "Schedule 'sometimes' is not one of: every <n>m, cron \"<5 fields>\", at <date and time>",
    },
  ],
  runs: [
    run(6, "prod-health", "running", null, 1, null),
    run(5, "ci-health", "done", "task", 23, "2 findings"),
    run(4, "prod-health", "done", "quiet", 16, "Both services healthy"),
    run(3, "slack-needs-me", "failed", null, 60, "Gateway down"),
    run(
      2,
      "ci-health",
      "skipped",
      null,
      61,
      "Skipped: the previous run has not ended",
    ),
    run(1, "prod-health", "done", "quiet", 300, "Both services healthy"),
  ],
};

const listeners = new Set<() => void>();
const announce = () => {
  snapshot.workspaces[0]!.updatedAt = new Date().toISOString();
  for (const listener of listeners) listener();
};
const ok = <T,>(data: T) => ({ ok: true as const, data });
const record =
  <P, R>(name: string, handler: (params: P) => R) =>
  async (params: P) => {
    window.__residentCalls.push({ name, params });
    return handler(params);
  };

const client = {
  request: {
    snapshot: async () => ok(structuredClone(snapshot)),
    terminalEndpoint: async () =>
      ok({ endpoint: "ws://127.0.0.1:1/resident-test" }),
    presencePublish: async () => ok({}),
    toastsAcknowledge: async () => ok({ acknowledged: 0 }),
    workspaceWatchSet: async () => ok({ watching: [] }),
    agentModels: async () =>
      ok({ provider: "claude", models: [], source: "aliases" }),
    workspaceContentGet: async () =>
      ok({
        workspaceId: "argus",
        brief: "# Brief",
        journal: "# Journal",
        files: [],
        repositories: [],
        worktrees: [],
      }),
    taskTimeline: async ({ id }: { id: string }) =>
      ok({
        taskId: id,
        events: [],
        cost: { sessions: 0, models: [], running: false },
      }),
    residentDetail: record("residentDetail", () => ok(structuredClone(detail))),
    residentMemory: record("residentMemory", () =>
      ok([
        {
          source: "workspace",
          name: "SERVICES.md",
          path: "/tmp/residents/argus/SERVICES.md",
          content: "# Services\n\n## datalake-gateway\n\n- Evidence: 183 files",
          truncated: false,
        },
        {
          source: "memory",
          name: "MEMORY.md",
          path: "/tmp/claude/projects/argus/memory/MEMORY.md",
          content: "- [cx archive tier](cx.md) — logs only on archive",
          truncated: false,
        },
      ]),
    ),
    residentControl: record(
      "residentControl",
      (params: { reference: string; action: string }) => {
        const resident = snapshot.residents[0]!;
        resident.state =
          params.action === "pause"
            ? "paused"
            : params.action === "stop"
              ? "stopped"
              : "on_duty";
        announce();
        return ok({ state: resident.state });
      },
    ),
    routineSetEnabled: record(
      "routineSetEnabled",
      (params: { name: string; enabled: boolean }) => {
        const routine = detail.routines.find(
          (item) => item.name === params.name,
        )!;
        routine.enabled = params.enabled;
        announce();
        return ok({ name: params.name, enabled: params.enabled });
      },
    ),
    routineRunNow: record("routineRunNow", (params: { name: string }) =>
      ok(run(7, params.name, "queued", null, 0, null)),
    ),
    findingVerdict: record(
      "findingVerdict",
      (params: { id: string; verdict: "useful" | "noise" | null }) => {
        const target = snapshot.findings.find((item) => item.id === params.id)!;
        target.verdict = params.verdict;
        if (params.verdict === "noise") target.state = "closed";
        announce();
        return ok(target);
      },
    ),
    openExternal: record("openExternal", () => ok({ opened: true })),
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App
      injectedClient={client}
      initialSnapshot={structuredClone(snapshot)}
      initialWorkspaceView="board"
    />
  </StrictMode>,
);

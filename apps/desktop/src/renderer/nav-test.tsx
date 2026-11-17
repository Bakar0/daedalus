import { createRoot } from "react-dom/client";
import type {
  AgentSessionDto,
  DesktopSnapshotDto,
  TaskDto,
  WorkspaceDto,
  WorkspaceFileEntryDto,
} from "@daedalus/protocol";
import { App } from "./App";
import type { DesktopClient } from "./client-types";
import "./styles.css";

/**
 * A page for `scripts/nav-ui-check.ts`: the whole app over a fake client,
 * with Home, two workspaces, three sessions, a task and a few files, so the
 * check can move between every kind of place and press Go Back and Go
 * Forward. Requests the page does not stub never answer, so a view waiting
 * on one shows its loading state rather than throwing; their names are kept
 * in `window.navTest.unstubbed` for the check to print.
 */

const at = "2026-11-17T00:00:00.000Z";

const workspace = (
  id: string,
  name: string,
  position: number,
  extra: Partial<WorkspaceDto> = {},
): WorkspaceDto => ({
  id,
  slug: id,
  name,
  path: `/tmp/nav-test/${id}`,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  available: true,
  position,
  startSetsInProgress: true,
  autoRebirthPercent: null,
  defaultProvider: null,
  defaultModel: null,
  defaultClaudeAccount: null,
  defaultCodexAccount: null,
  accountModels: {},
  ...extra,
});

const session = (
  id: string,
  workspaceId: string,
  name: string,
  position: number,
): AgentSessionDto =>
  ({
    id,
    workspaceId,
    taskId: null,
    name,
    provider: "claude",
    kind: "agent",
    tmuxSession: `nav_${id}`,
    command: "claude",
    args: [],
    workingDirectory: `/tmp/nav-test/${workspaceId}`,
    status: "running",
    exitCode: null,
    startedAt: at,
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
    position,
    pinnedAt: null,
    color: null,
    autoRebirthPercent: null,
  }) as AgentSessionDto;

const task: TaskDto = {
  id: "task-a",
  workspaceId: "ws-a",
  number: 1,
  title: "Task in A",
  description: "A task to open.",
  status: "todo",
  priority: "normal",
  createdAt: at,
  updatedAt: at,
  completedAt: null,
  briefUpdatedAt: null,
};

const snapshot: DesktopSnapshotDto = {
  workspaces: [
    workspace("ws-a", "Alpha", 1),
    workspace("ws-b", "Beta", 2),
    workspace("ws-home", "Home", 3, { kind: "home" }),
  ],
  tasks: [task],
  agents: [
    session("s-a1", "ws-a", "Session A1", 1),
    session("s-a2", "ws-a", "Session A2", 2),
    session("s-b1", "ws-b", "Session B1", 3),
  ],
  terminals: [],
  repositories: [],
  providerUsage: [],
  sessionTelemetry: [],
  sessionActivity: [],
  attention: [],
  worktrees: [],
  shipped: [],
  toasts: [],
  abilities: [],
  teams: [],
  workflowRuns: [],
  unseenRoutineRuns: 0,
  settings: {
    version: "0.38.0",
    channel: "stable",
    home: "/tmp/nav-test/home",
    workspaceRoot: "/tmp/nav-test",
    databasePath: "/tmp/nav-test/state.db",
    repositoryRoot: "/tmp/nav-test/repos",
    tmuxAvailable: true,
    workspaceInstructionFilesEnabled: true,
    autoRestoreSessionsEnabled: true,
    trustSessionFoldersEnabled: true,
    autoRebirthPercent: null,
    focusMode: false,
    betaUpdatesEnabled: false,
    accounts: [],
    providers: [],
  },
} as unknown as DesktopSnapshotDto;

const fileEntry = (path: string): WorkspaceFileEntryDto => ({
  name: path.split("/").pop() ?? path,
  path,
  kind: "file",
  mutable: true,
});

const filesOf: Record<string, string[]> = {
  "ws-home": ["home-notes.md"],
  "ws-a": ["alpha-one.md", "alpha-two.md"],
  "ws-b": ["beta-one.md"],
};

const unstubbed = new Set<string>();

declare global {
  interface Window {
    navTest: { unstubbed: () => string[] };
  }
}
window.navTest = { unstubbed: () => [...unstubbed] };

const ok = <T,>(data: T) => Promise.resolve({ ok: true, data });

const stubs: Record<string, (params: never) => Promise<unknown>> = {
  snapshot: () => ok(snapshot),
  homeOpen: () => ok(snapshot.workspaces[2]),
  workspaceContentGet: ({ workspace: id }: { workspace: string }) =>
    ok({
      workspaceId: id,
      brief: "# Brief",
      journal: "# Journal",
      files: (filesOf[id] ?? []).map(fileEntry),
      repositories: [],
      worktrees: [],
    }),
  workspaceDirectoryList: ({ workspace: id }: { workspace: string }) =>
    ok((filesOf[id] ?? []).map(fileEntry)),
  workspaceFileRead: ({ path }: { path: string }) =>
    ok({
      name: path.split("/").pop() ?? path,
      path,
      content: `# ${path}\n`,
      format: "markdown",
    }),
  workspaceChanges: () => ok([]),
  planList: () => ok({ groups: [] }),
  terminalEndpoint: () => ok({ endpoint: "ws://127.0.0.1:1/nav-test" }),
  agentModels: ({ provider }: { provider: string }) =>
    ok({ provider, models: [], source: "aliases" }),
  presencePublish: () => ok({}),
  toastsAcknowledge: () => ok({ acknowledged: 0 }),
  workspaceWatchSet: () => ok({ watching: [] }),
  sessionFocus: () => ok({}),
};

const request = new Proxy(
  {},
  {
    get: (_target, name: string) =>
      stubs[name] ??
      (() => {
        unstubbed.add(name);
        return new Promise(() => undefined);
      }),
  },
);

const client = {
  request,
  subscribe: () => () => undefined,
  subscribeCommands: () => () => undefined,
  subscribeWindowResize: () => () => undefined,
  subscribeFocusSession: () => () => undefined,
  subscribeWorkspaceFiles: () => () => undefined,
  subscribeQuitRequest: () => () => undefined,
} as unknown as DesktopClient;

createRoot(document.getElementById("root")!).render(
  <App
    injectedClient={client}
    initialActiveAgentId="s-a1"
    initialPanelTab="files"
    initialSnapshot={snapshot}
    initialWorkspaceView="session"
  />,
);

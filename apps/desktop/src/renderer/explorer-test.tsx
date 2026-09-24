/**
 * A live workspace explorer, for `bun run test:explorer-ui`.
 *
 * Unlike `repo-test`, this page is mounted rather than rendered to a string:
 * everything the check is here to prove — a folder that stays open, a border
 * that drags, a tree that notices a file appearing — only exists once React is
 * running and state can survive a reload.
 *
 * The file half of the client is not stubbed. `?api=<port>` points at a bridge
 * the check script runs in front of a real `ApplicationContext`, a real
 * workspace directory and a real `fs.watch`, so a listing is a listing and a
 * change event is one the watcher actually produced. Stubbing that would have
 * left the coalescing, the debounce and the reconciliation all proven against
 * a fixture that agrees with them by construction.
 *
 * Repositories and working trees stay fabricated: the geometry assertions need
 * more rows than fit the section's default height, and producing them for real
 * would mean cloning.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type {
  DesktopSnapshotDto,
  WorkspaceContentDto,
  WorkspaceFileChangeDto,
} from "@daedalus/protocol";
import { App } from "./App";
import type { DesktopClient } from "./client-types";
import "./styles.css";

const api = new URLSearchParams(location.search).get("api");
const bridge = `http://127.0.0.1:${api}`;
const workspaceId =
  new URLSearchParams(location.search).get("workspace") ??
  "explorer-test-workspace";

const snapshot: DesktopSnapshotDto = {
  workspaces: [
    {
      id: workspaceId,
      slug: "explorer-test",
      name: "Explorer test",
      path: "/tmp/explorer-test",
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
      archivedAt: null,
      available: true,
      position: 1,
      startSetsInProgress: true,
      defaultProvider: null,
      defaultModel: null,
    },
  ],
  tasks: [],
  agents: [],
  terminals: [],
  repositories: [],
  providerUsage: [],
  sessionTelemetry: [],
  sessionActivity: [],
  attention: [],
  worktrees: [],
  toasts: [],
  settings: {
    version: "0.6.0",
    channel: "stable",
    home: "/tmp/daedalus-explorer-test",
    workspaceRoot: "/tmp/daedalus-explorer-test/workspaces",
    databasePath: "/tmp/daedalus-explorer-test/state.db",
    repositoryRoot: "/tmp/daedalus-explorer-test/repos",
    tmuxAvailable: true,
    workspaceInstructionFilesEnabled: true,
    autoRestoreSessionsEnabled: true,
    focusMode: false,
    providers: [],
  },
};

const repository = (id: string, name: string) => ({
  id,
  workspaceId,
  name,
  canonicalPath: `/code/${name}`,
  access: "write" as const,
  libraryRepositoryId: `library-${id}`,
  referencePath: `/tmp/explorer-test/repos/${name}`,
  baseBranch: "main",
  baseCommit: "1234567890abcdef1234567890abcdef12345678",
  fetchedAt: "2026-09-19T00:00:00.000Z",
  createdAt: "2026-09-19T00:00:00.000Z",
  status: "ready" as const,
  statusError: null,
  gitStatus: {
    state: "clean" as const,
    changedFiles: 0,
    ahead: 0,
    behind: 0,
  },
});

// Repositories and working trees, so the content has the shape of a real
// workspace's. The explorer itself no longer shows them (#27, they are on the
// board); the file tree lists their checkouts under `repos/` and `worktrees/`.
const fabricated = {
  repositories: [
    repository("r1", "daedalus"),
    repository("r2", "hive"),
    repository("r3", "zenity-app"),
  ],
  worktrees: [
    {
      sessionId: "s-1",
      repositoryId: "r1",
      path: "/tmp/explorer-test/worktrees/alpha/daedalus",
      branchName: "daedalus/explorer-test/alpha",
      createdAt: "2026-09-19T00:00:00.000Z",
      gitStatus: {
        state: "clean" as const,
        changedFiles: 0,
        ahead: 0,
        behind: 0,
      },
    },
    {
      sessionId: "s-2",
      repositoryId: "r2",
      path: "/tmp/explorer-test/worktrees/beta/hive",
      branchName: "hive/explorer-test/beta",
      createdAt: "2026-09-19T00:00:00.000Z",
      gitStatus: {
        state: "clean" as const,
        changedFiles: 0,
        ahead: 0,
        behind: 0,
      },
    },
  ],
};

const call = async (route: string, body: unknown) => {
  const response = await fetch(`${bridge}${route}`, {
    body: JSON.stringify(body ?? {}),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return (await response.json()) as { ok: boolean };
};

const fileListeners = new Set<
  (change: {
    workspaceId: string;
    changes: WorkspaceFileChangeDto[];
    overflow: boolean;
  }) => void
>();
/**
 * `dataChanged` listeners. These used to be stubbed away, and that is exactly
 * why a delete that succeeded and was immediately undone by the content
 * refetch went unnoticed: without the subscription the renderer never refetches
 * workspace content, so the regeneration that put the file back never ran.
 */
const dataListeners = new Set<() => void>();
const events = new WebSocket(`ws://127.0.0.1:${api}/events`);
events.addEventListener("message", (event) => {
  const payload = JSON.parse(String(event.data));
  if (payload.kind === "dataChanged") {
    for (const listener of dataListeners) listener();
    return;
  }
  for (const listener of fileListeners) listener(payload);
});

const client = {
  request: {
    snapshot: async () => ({ ok: true, data: snapshot }),
    workspaceContentGet: async () => {
      const content = (await call("/content", {})) as {
        ok: boolean;
        data: WorkspaceContentDto;
      };
      return {
        ok: true,
        data: { ...content.data, ...fabricated, workspaceId },
      };
    },
    workspaceDirectoryList: (params: { path?: string }) =>
      call("/list", params),
    workspaceFileRead: (params: { path: string }) => call("/read", params),
    workspaceFileWrite: (params: unknown) => call("/write", params),
    workspaceEntryCreate: (params: unknown) => call("/create", params),
    workspaceEntryRename: (params: unknown) => call("/rename", params),
    workspaceEntryMove: (params: unknown) => call("/move", params),
    workspaceEntryRemove: (params: unknown) => call("/remove", params),
    workspaceWatchSet: (params: unknown) => call("/watch", params),
    agentModels: async ({ provider }: { provider: "codex" | "claude" }) => ({
      ok: true,
      data: { provider, models: [], source: "aliases" },
    }),
    terminalEndpoint: async () => ({
      ok: true,
      data: { endpoint: "ws://127.0.0.1:1/explorer-test" },
    }),
    presencePublish: async () => ({ ok: true, data: {} }),
    toastsAcknowledge: async () => ({ ok: true, data: { acknowledged: 0 } }),
  },
  subscribe: (listener: () => void) => {
    dataListeners.add(listener);
    return () => dataListeners.delete(listener);
  },
  subscribeCommands: () => () => undefined,
  subscribeWindowResize: () => () => undefined,
  subscribeFocusSession: () => () => undefined,
  subscribeWorkspaceFiles: (
    listener: (change: {
      workspaceId: string;
      changes: WorkspaceFileChangeDto[];
      overflow: boolean;
    }) => void,
  ) => {
    fileListeners.add(listener);
    return () => fileListeners.delete(listener);
  },
  subscribeQuitRequest: () => () => undefined,
} as unknown as DesktopClient;

// The content is fetched before the first render for the same reason the real
// app passes one in: the explorer draws nothing without it, and a page that
// starts empty would make every `waitFor` in the check race the first paint.
const initial = (await client.request.workspaceContentGet({} as never)) as {
  data: WorkspaceContentDto;
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App
      injectedClient={client}
      initialSnapshot={snapshot}
      initialWorkspaceView="workspace"
      initialWorkspaceContent={initial.data}
    />
  </StrictMode>,
);

/**
 * A live workspace explorer, for `bun run test:explorer-ui`.
 *
 * Unlike `repo-test`, this page is mounted rather than rendered to a string:
 * everything the check is here to prove — a folder that stays open, a border
 * that drags — only exists once React is running and state can survive a
 * reload. The directory listings come from a stub rather than a real
 * workspace so the tree is the same on every run.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type {
  DesktopSnapshotDto,
  WorkspaceContentDto,
  WorkspaceFileEntryDto,
} from "@daedalus/protocol";
import { App } from "./App";
import type { DesktopClient } from "./client-types";
import "./styles.css";

const workspaceId = "explorer-test-workspace";

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

const directory = (path: string): WorkspaceFileEntryDto => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  kind: "directory",
});
const file = (path: string): WorkspaceFileEntryDto => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  kind: "file",
});

// Deep enough that restoring it proves parents come back before children.
const listings: Record<string, WorkspaceFileEntryDto[]> = {
  "": [
    directory("repos"),
    directory("worktrees"),
    file("BRIEF.md"),
    file("JOURNAL.md"),
  ],
  repos: [directory("repos/daedalus")],
  "repos/daedalus": [
    directory("repos/daedalus/packages"),
    file("repos/daedalus/README.md"),
  ],
  "repos/daedalus/packages": [
    file("repos/daedalus/packages/core.ts"),
    file("repos/daedalus/packages/protocol.ts"),
  ],
  worktrees: [directory("worktrees/alpha")],
  "worktrees/alpha": [file("worktrees/alpha/notes.md")],
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

// The repositories section needs more than fits its default height, so a drag
// that makes it taller is visible as more of the list rather than only as a
// number.
const content: WorkspaceContentDto = {
  workspaceId,
  brief: "# Brief",
  journal: "# Journal",
  files: listings[""]!,
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
      gitStatus: { state: "clean", changedFiles: 0, ahead: 0, behind: 0 },
    },
    {
      sessionId: "s-2",
      repositoryId: "r2",
      path: "/tmp/explorer-test/worktrees/beta/hive",
      branchName: "hive/explorer-test/beta",
      createdAt: "2026-09-19T00:00:00.000Z",
      gitStatus: { state: "clean", changedFiles: 0, ahead: 0, behind: 0 },
    },
  ],
};

const client = {
  request: {
    snapshot: async () => ({ ok: true, data: snapshot }),
    workspaceContentGet: async () => ({ ok: true, data: content }),
    workspaceDirectoryList: async ({ path }: { path?: string }) => {
      const listing = listings[path ?? ""];
      return listing
        ? { ok: true, data: listing }
        : {
            ok: false,
            error: { code: "NOT_FOUND", message: `No such directory: ${path}` },
          };
    },
    workspaceFileRead: async ({ path }: { path: string }) => ({
      ok: true,
      data: {
        name: path.slice(path.lastIndexOf("/") + 1),
        path,
        content: `Contents of ${path}`,
        format: path.endsWith(".md") ? "markdown" : "text",
      },
    }),
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
  subscribe: () => () => undefined,
  subscribeCommands: () => () => undefined,
  subscribeWindowResize: () => () => undefined,
  subscribeFocusSession: () => () => undefined,
  subscribeQuitRequest: () => () => undefined,
} as unknown as DesktopClient;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App
      injectedClient={client}
      initialSnapshot={snapshot}
      initialWorkspaceView="workspace"
      initialWorkspaceContent={content}
    />
  </StrictMode>,
);

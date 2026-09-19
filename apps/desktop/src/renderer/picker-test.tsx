/**
 * Mounts the repository picker on its own so a real browser can type at it.
 *
 * Keyboard behaviour cannot be proved by asserting markup: whether Space
 * toggles a row and Enter submits depends on what actually has focus and on
 * the platform's own handling, which only real key events exercise.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopSnapshotDto } from "@daedalus/protocol";
import { App } from "./App";
import type { DesktopClient } from "./client-types";
import "./styles.css";

const repository = (id: string, name: string) => ({
  id,
  name,
  remoteUrl: `git@github.com:example/${name}.git`,
  defaultBranch: "main",
  lastFetchedAt: "2026-09-18T00:00:00.000Z",
});

const snapshot = {
  workspaces: [
    {
      id: "picker-workspace",
      slug: "picker",
      name: "Picker",
      path: "/tmp/picker",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
      archivedAt: null,
      available: true,
      position: 1,
    },
  ],
  tasks: [],
  agents: [],
  terminals: [],
  sessionTelemetry: [],
  providerRateLimits: [],
  providerUsage: [],
  agentActivity: [],
  sessionAttention: [],
  toasts: [],
  presence: {
    appForeground: true,
    workspaceId: null,
    sessionId: null,
    idleSeconds: 0,
    focusMode: false,
  },
  repositories: [
    repository("r1", "alpha"),
    repository("r2", "beta"),
    repository("r3", "gamma"),
  ],
  providerModels: [],
  settings: {
    version: "0.3.0",
    channel: "stable",
    home: "/tmp/picker-home",
    workspaceRoot: "/tmp/picker-home/workspaces",
    databasePath: "/tmp/picker-home/state.db",
    repositoryRoot: "/tmp/picker-home/repos",
    tmuxAvailable: true,
    workspaceInstructionFilesEnabled: true,
    focusMode: false,
    providers: [],
  },
} as unknown as DesktopSnapshotDto;

// What the check reads back, rather than guessing from the DOM.
declare global {
  interface Window {
    pickerAttached: string[];
  }
}
window.pickerAttached = [];

const client = {
  request: {
    snapshot: async () => ({ ok: true, data: snapshot }),
    workspaceContentGet: async () => ({
      ok: true,
      data: {
        workspaceId: "picker-workspace",
        brief: "# Brief",
        journal: "# Journal",
        files: [],
        repositories: [],
        worktrees: [],
      },
    }),
    repositoryDiscovery: async () => ({
      ok: true,
      data: {
        githubCliAvailable: false,
        authenticated: false,
        repositories: [],
      },
    }),
    workspaceRepositoryAttach: async ({
      libraryRepositoryId,
    }: {
      libraryRepositoryId: string;
    }) => {
      window.pickerAttached.push(libraryRepositoryId);
      return { ok: true, data: { id: libraryRepositoryId } };
    },
    repositoryAddAndAttachStart: async ({
      remoteUrl,
    }: {
      remoteUrl: string;
    }) => {
      window.pickerAttached.push(remoteUrl);
      return { ok: true, data: { id: remoteUrl } };
    },
    // Asked for on mount. Without it the request throws inside a passive
    // effect and React tears the whole tree down, leaving a blank page for
    // anything driving it — which is exactly how this page first failed.
    agentModels: async ({ provider }: { provider: "codex" | "claude" }) => ({
      ok: true,
      data: { provider, models: [], source: "aliases" },
    }),
    terminalEndpoint: async () => ({
      ok: true,
      data: { endpoint: "ws://127.0.0.1:1/picker-test" },
    }),
    presencePublish: async () => ({ ok: true, data: {} }),
    toastsAcknowledge: async () => ({ ok: true, data: { acknowledged: 0 } }),
  },
  subscribe: () => () => undefined,
  subscribeCommands: () => () => undefined,
  subscribeWindowResize: () => () => undefined,
  subscribeFocusSession: () => () => undefined,
} as unknown as DesktopClient;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App
      injectedClient={client}
      initialSnapshot={snapshot}
      initialModal="repository"
      initialWorkspaceView="workspace"
    />
  </StrictMode>,
);

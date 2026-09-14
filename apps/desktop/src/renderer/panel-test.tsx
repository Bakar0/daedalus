import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopSnapshotDto } from "@daedalus/protocol";
import { App } from "./App";
import type { DesktopClient } from "./client-types";
import "./styles.css";

const snapshot: DesktopSnapshotDto = {
  workspaces: [
    {
      id: "panel-test-workspace",
      slug: "panel-test",
      name: "Panel test",
      path: "/tmp/panel-test",
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
      archivedAt: null,
      available: true,
    },
  ],
  tasks: [],
  agents: [
    {
      id: "panel-test-agent",
      workspaceId: "panel-test-workspace",
      taskId: null,
      name: "Agent terminal",
      provider: "claude",
      kind: "agent",
      tmuxSession: "panel_test_agent",
      command: "claude",
      args: [],
      workingDirectory: "/tmp/panel-test",
      status: "running",
      exitCode: null,
      startedAt: "2026-09-14T00:00:00.000Z",
      endedAt: null,
      providerSessionId: null,
      archivedAt: null,
      resumeCount: 0,
    },
  ],
  terminals: [],
  repositories: [],
  settings: {
    home: "/tmp/daedalus-panel-test",
    workspaceRoot: "/tmp/daedalus-panel-test/workspaces",
    databasePath: "/tmp/daedalus-panel-test/state.db",
    repositoryRoot: "/tmp/daedalus-panel-test/repos",
    tmuxAvailable: true,
    workspaceInstructionFilesEnabled: true,
    providers: [],
  },
};

const client = {
  request: {
    snapshot: async () => ({ ok: true, data: snapshot }),
  },
  subscribe: () => () => undefined,
  subscribeCommands: () => () => undefined,
  subscribeWindowResize: () => () => undefined,
} as unknown as DesktopClient;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App
      injectedClient={client}
      initialActiveAgentId="panel-test-agent"
      initialSnapshot={snapshot}
    />
  </StrictMode>,
);

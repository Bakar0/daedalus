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
      position: 1,
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
      position: 1,
    },
    {
      id: "panel-test-blocked",
      workspaceId: "panel-test-workspace",
      taskId: null,
      name: "Blocked agent",
      provider: "codex",
      kind: "agent",
      tmuxSession: "panel_test_blocked",
      command: "codex",
      args: [],
      workingDirectory: "/tmp/panel-test",
      status: "running",
      exitCode: null,
      startedAt: "2026-09-14T00:00:00.000Z",
      endedAt: null,
      providerSessionId: null,
      archivedAt: null,
      resumeCount: 0,
      position: 1,
    },
    // A third card, so a drag has somewhere to travel and the reorder check
    // can move one past two others rather than just swapping a pair.
    {
      id: "panel-test-third",
      workspaceId: "panel-test-workspace",
      taskId: null,
      name: "Third agent",
      provider: "claude",
      kind: "agent",
      tmuxSession: "panel_test_third",
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
      position: 3,
    },
  ],
  terminals: [],
  repositories: [],
  providerUsage: [
    {
      provider: "codex",
      windows: [
        { label: "5h", usedPercent: 28 },
        { label: "7d", usedPercent: 61 },
      ],
      observedAt: "2026-09-14T00:00:00.000Z",
    },
    {
      provider: "claude",
      windows: [
        { label: "5h", usedPercent: 34 },
        { label: "7d", usedPercent: 47 },
      ],
      observedAt: "2026-09-14T00:00:00.000Z",
    },
  ],
  sessionTelemetry: [
    {
      sessionId: "panel-test-agent",
      model: "claude-fable-5-1[1m]",
      context: {
        usedTokens: 61_036,
        totalTokens: 1_000_000,
        usedPercent: 6.1036,
      },
      observedAt: "2026-09-14T00:00:00.000Z",
    },
  ],
  sessionActivity: [
    {
      sessionId: "panel-test-agent",
      activity: "working",
      detail: "Editing agents.ts",
      since: "2026-09-14T00:00:00.000Z",
      observedAt: "2026-09-14T00:00:00.000Z",
      source: "hook",
    },
    {
      sessionId: "panel-test-blocked",
      activity: "needs_permission",
      detail: "Bash(git push)",
      since: "2026-09-14T00:00:00.000Z",
      observedAt: "2026-09-14T00:00:00.000Z",
      source: "hook",
    },
  ],
  attention: [
    {
      sessionId: "panel-test-blocked",
      workspaceId: "panel-test-workspace",
      reasons: [
        {
          id: "panel-test-reason-1",
          text: "Codex needs permission: Bash(git push)",
          raisedAt: "2026-09-14T00:00:00.000Z",
          source: "hook",
        },
        {
          id: "panel-test-reason-2",
          text: "Which branch should this land on?",
          raisedAt: "2026-09-14T00:01:00.000Z",
          source: "agent",
        },
      ],
      raisedAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:01:00.000Z",
    },
  ],
  toasts: [],
  settings: {
    version: "0.3.0",
    channel: "stable",
    home: "/tmp/daedalus-panel-test",
    workspaceRoot: "/tmp/daedalus-panel-test/workspaces",
    databasePath: "/tmp/daedalus-panel-test/state.db",
    repositoryRoot: "/tmp/daedalus-panel-test/repos",
    tmuxAvailable: true,
    workspaceInstructionFilesEnabled: true,
    focusMode: false,
    providers: [],
  },
};

// Reordering is the one interaction here that writes and reads back, so the
// page has to behave like the real adapter: the snapshot is mutable, and the
// write takes long enough for a round trip to be observable. A reorder that
// resolved instantly would hide exactly the flicker this page exists to catch.
let current = snapshot;
const REORDER_LATENCY_MS = 120;

const reordered = <T extends { id: string }>(items: T[], ids: string[]) => {
  const named = new Set(ids);
  const queue = [...ids];
  return items.map((item) => {
    if (!named.has(item.id)) return item;
    // Shifted once per named slot. Calling it inside the `find` predicate
    // instead would consume the queue on every comparison.
    const next = queue.shift();
    return items.find((candidate) => candidate.id === next) ?? item;
  });
};

const client = {
  request: {
    snapshot: async () => ({ ok: true, data: current }),
    workspaceReorder: async ({ references }: { references: string[] }) => {
      await new Promise((settle) => setTimeout(settle, REORDER_LATENCY_MS));
      current = {
        ...current,
        workspaces: reordered(current.workspaces, references),
      };
      return { ok: true, data: current.workspaces };
    },
    agentReorder: async ({ sessionIds }: { sessionIds: string[] }) => {
      await new Promise((settle) => setTimeout(settle, REORDER_LATENCY_MS));
      current = { ...current, agents: reordered(current.agents, sessionIds) };
      return { ok: true, data: current.agents };
    },
    agentModels: async ({ provider }: { provider: "codex" | "claude" }) => ({
      ok: true,
      data: { provider, models: [], source: "aliases" },
    }),
    // Stubbed because the renderer asks for it on mount: without it the
    // request throws inside a passive effect and React tears the whole tree
    // down, leaving the page blank for anything driving it.
    terminalEndpoint: async () => ({
      ok: true,
      data: { endpoint: "ws://127.0.0.1:1/panel-test" },
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
      initialActiveAgentId="panel-test-agent"
      initialSnapshot={snapshot}
    />
  </StrictMode>,
);

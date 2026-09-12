import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { DesktopSnapshotDto } from "@daedalus/protocol";
import { App, MarkdownPreview } from "./App";
import type { DesktopClient } from "./client-types";

const client = {
  request: {},
  subscribe: () => () => {},
} as unknown as DesktopClient;

const base: DesktopSnapshotDto = {
  workspaces: [],
  tasks: [],
  agents: [],
  settings: {
    home: "/tmp/daedalus-test",
    workspaceRoot: "/tmp/daedalus-test/workspaces",
    databasePath: "/tmp/daedalus-test/state.db",
    tmuxAvailable: false,
    providers: [
      { name: "codex", executable: "codex", available: false },
      { name: "claude", executable: "claude", available: true },
    ],
  },
};

describe("desktop application shell", () => {
  test("renders Board and Sessions as complete workspace modes", () => {
    const html = renderToStaticMarkup(
      <App injectedClient={client} initialSnapshot={base} />,
    );
    expect(html).toContain("Workspaces");
    expect(html).toContain("Board");
    expect(html).toContain("Sessions");
    expect(html).not.toContain("Activity");
    expect(html).toContain('aria-label="Workspace mode"');
    expect(html).toContain("mode-board");
    expect(html).not.toContain("No session selected");
    expect(html).toContain("No workspaces yet");
    expect(html).toContain('aria-label="Create workspace"');
  });

  test("renders workspace, task, and session lifecycle state", () => {
    const snapshot: DesktopSnapshotDto = {
      ...base,
      workspaces: [
        {
          id: "w1",
          slug: "demo",
          name: "Demo",
          path: "/tmp/demo",
          createdAt: "now",
          updatedAt: "now",
          archivedAt: null,
          available: true,
        },
      ],
      tasks: [
        {
          id: "t1",
          workspaceId: "w1",
          title: "Ship desktop",
          description:
            "## Acceptance criteria\n\n- [x] CRUD works\n- [ ] Visual QA\n\nRun `bun test`.",
          status: "in_progress",
          priority: "high",
          createdAt: "now",
          updatedAt: "now",
          completedAt: null,
        },
      ],
      agents: [
        {
          id: "agent-12345678",
          workspaceId: "w1",
          taskId: "t1",
          name: "Ship desktop",
          provider: "codex",
          kind: "agent",
          tmuxSession: "daedalus_agent",
          command: "codex",
          args: [],
          workingDirectory: "/tmp/demo",
          status: "running",
          exitCode: null,
          startedAt: "now",
          endedAt: null,
        },
      ],
      settings: {
        ...base.settings,
        tmuxAvailable: true,
        tmuxVersion: "tmux 3.7c",
      },
    };
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialSelectedTaskId="t1"
        initialSnapshot={snapshot}
      />,
    );
    expect(html).toContain("Demo");
    expect(html).toContain("Ship desktop");
    expect(html).toContain("in progress");
    expect(html).toContain("1 live");
    expect(html).toContain("+ Session");
    expect(html).toContain("Sessions");
    expect(html).toContain("Acceptance criteria");
    expect(html).toContain("Edit");
    expect(html).toContain("board-detail-column");
    expect(html).not.toContain("terminal-column");
    expect(html).not.toContain("Priority");
  });

  test("renders GitHub-flavored Markdown task briefs safely", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        source={
          "## Plan\n\n- [x] Ready\n\n| File | Change |\n| --- | --- |\n| app.ts | Update |"
        }
      />,
    );

    expect(html).toContain("<h2>Plan</h2>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<table>");
    expect(
      renderToStaticMarkup(
        <MarkdownPreview source={"<script>alert('nope')</script>"} />,
      ),
    ).not.toContain("<script>");
  });

  test("surfaces a registered workspace with a missing identity folder", () => {
    const snapshot: DesktopSnapshotDto = {
      ...base,
      workspaces: [
        {
          id: "missing",
          slug: "moved",
          name: "Moved workspace",
          path: "/tmp/moved",
          createdAt: "now",
          updatedAt: "now",
          archivedAt: null,
          available: false,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <App injectedClient={client} initialSnapshot={snapshot} />,
    );
    expect(html).toContain("Moved workspace");
    expect(html).toContain("folder missing");
  });

  test("renders an active terminal beside the Sessions view cards", () => {
    const running = {
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "w1",
      taskId: "t1",
      name: "Terminal task",
      provider: "codex" as const,
      kind: "agent" as const,
      tmuxSession: "daedalus_one",
      command: "codex",
      args: [],
      workingDirectory: "/tmp/demo",
      status: "running" as const,
      exitCode: null,
      startedAt: "now",
      endedAt: null,
    };
    const snapshot: DesktopSnapshotDto = {
      ...base,
      workspaces: [
        {
          id: "w1",
          slug: "demo",
          name: "Demo",
          path: "/tmp/demo",
          createdAt: "now",
          updatedAt: "now",
          archivedAt: null,
          available: true,
        },
      ],
      tasks: [
        {
          id: "t1",
          workspaceId: "w1",
          title: "Terminal task",
          description: "Use both sessions",
          status: "in_progress",
          priority: "normal",
          createdAt: "now",
          updatedAt: "now",
          completedAt: null,
        },
      ],
      agents: [
        running,
        {
          ...running,
          id: "22222222-2222-4222-8222-222222222222",
          name: "Review terminal task",
          provider: "claude",
          kind: "agent",
          tmuxSession: "daedalus_two",
        },
      ],
    };
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialActiveAgentId={running.id}
        initialDetailView="terminal"
        initialSelectedTaskId="t1"
        initialSnapshot={snapshot}
        initialWorkspaceView="sessions"
      />,
    );
    expect(html).toContain("Terminal task");
    expect(html).toContain("Review terminal task");
    expect(html).toContain("running · 111111");
    expect(html).toContain("running · 222222");
    expect(html).toContain("Terminal for Terminal task session 11111111");
    expect(html).toContain("session-navigator");
    expect(html).not.toContain("board-detail-column");
  });

  test("renders free terminals with lifecycle timestamps in Sessions", () => {
    const snapshot: DesktopSnapshotDto = {
      ...base,
      workspaces: [
        {
          id: "w1",
          slug: "demo",
          name: "Demo",
          path: "/tmp/demo",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          available: true,
        },
      ],
      agents: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          workspaceId: "w1",
          taskId: null,
          name: "Dev shell",
          provider: "custom",
          kind: "terminal",
          tmuxSession: "daedalus_terminal",
          command: "/bin/zsh",
          args: ["-l"],
          workingDirectory: "/tmp/demo",
          status: "running",
          exitCode: null,
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: null,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialModal="session"
        initialSnapshot={snapshot}
        initialWorkspaceView="sessions"
      />,
    );
    expect(html).toContain("Workspace session");
    expect(html).toContain("session-kind-icon terminal");
    expect(html).toContain("Started ·");
    expect(html).toContain("1/1/2026");
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("Session name");
    expect(html).toContain("session-tool-icon tool-terminal");
    expect(html).toContain("Codex");
    expect(html).toContain("Claude");
    expect(html).toContain("Terminal");
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).not.toContain(">CX<");
    expect(html).not.toContain(">CL<");
    expect(html).toContain("Opens in /tmp/demo");
    expect(html).not.toContain("Linked task");
    expect(html).not.toContain("Activity");
  });
});

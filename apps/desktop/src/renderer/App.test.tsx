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
  test("renders the three lifecycle columns and actionable empty states", () => {
    const html = renderToStaticMarkup(
      <App injectedClient={client} initialSnapshot={base} />,
    );
    expect(html).toContain("Workspaces");
    expect(html).toContain("Tasks");
    expect(html).toContain("Task brief");
    expect(html).toContain("No workspaces yet");
    expect(html).toContain('aria-label="Create workspace"');
    expect(html).toContain('aria-label="Create task"');
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
          provider: "codex",
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
    expect(html).toContain("running · agent-12");
    expect(html).toContain("Acceptance criteria");
    expect(html).toContain("bun test");
    expect(html).toContain("Edit");
    expect(html).toContain("Agent sessions");
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

  test("renders an active terminal and switches among task-owned sessions", () => {
    const running = {
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "w1",
      taskId: "t1",
      provider: "codex" as const,
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
          provider: "claude",
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
      />,
    );
    expect(html).toContain('aria-label="Active terminal session"');
    expect(html).toContain("codex · running · 11111111");
    expect(html).toContain("claude · running · 22222222");
    expect(html).toContain("Terminal for codex session 11111111");
  });
});

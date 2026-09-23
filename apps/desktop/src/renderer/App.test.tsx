import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { AgentSessionDto, DesktopSnapshotDto } from "@daedalus/protocol";
import { App, MarkdownPreview } from "./App";
import type { DesktopClient } from "./client-types";
import {
  agentMultilineSequence,
  clampExplorerSecondaryHeight,
  clampExplorerWidth,
  clampPanelSize,
  EXPLORER_DEFAULT_WIDTH,
  EXPLORER_MAX_WIDTH,
  EXPLORER_MIN_WIDTH,
  EXPLORER_SECONDARY_MIN_HEIGHT,
  EXPLORER_TREE_MIN_HEIGHT,
  lifecycleTone,
  parseRememberedDirectories,
  planExplorerRefresh,
  MAX_VISIBLE_TOASTS,
  sessionStatusView,
  statusAriaLabel,
  waitingLabel,
  launchMatchesSession,
  PANEL_RAIL_WIDTH,
  pendingSessionLaunches,
  preferredSessionId,
  preferredWorkspaceView,
  quitDisclosure,
  type SessionLaunchState,
  shouldFocusSession,
  TERMINAL_FONT_SIZE,
  TOAST_LIFT,
  TERMINAL_PANEL_MIN_HEIGHT,
} from "./WorkspaceApp";

const client = {
  request: {},
  subscribe: () => () => {},
} as unknown as DesktopClient;

const base: DesktopSnapshotDto = {
  workspaces: [],
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
    version: "0.3.0",
    channel: "stable",
    home: "/tmp/daedalus-test",
    workspaceRoot: "/tmp/daedalus-test/workspaces",
    databasePath: "/tmp/daedalus-test/state.db",
    repositoryRoot: "/tmp/daedalus-test/repos",
    tmuxAvailable: false,
    workspaceInstructionFilesEnabled: true,
    autoRestoreSessionsEnabled: true,
    focusMode: false,
    providers: [
      { name: "codex", executable: "codex", available: false },
      { name: "claude", executable: "claude", available: true },
    ],
  },
};

describe("quit disclosure", () => {
  const session = (id: string) => ({
    id,
    name: id,
    workspaceId: "workspace-1",
    provider: "claude" as const,
    disposition: "archive" as const,
  });

  test("names what keeps running, in the right number", () => {
    expect(
      quitDisclosure({
        sessions: [session("a"), session("b")],
        terminals: [{ id: "t", name: "Terminal" }],
      }),
    ).toBe("2 sessions and 1 terminal will keep running.");
    expect(quitDisclosure({ sessions: [session("a")], terminals: [] })).toBe(
      "1 session will keep running.",
    );
    expect(
      quitDisclosure({ sessions: [], terminals: [{ id: "t", name: "T" }] }),
    ).toBe("1 terminal will keep running.");
    expect(quitDisclosure({ sessions: [], terminals: [] })).toBe(
      "Nothing is running.",
    );
  });
});

describe("desktop application shell", () => {
  test("maps Shift+Enter to the portable agent multiline sequence", () => {
    const shiftEnter = {
      altKey: false,
      code: "Enter",
      ctrlKey: false,
      key: "Enter",
      metaKey: false,
      shiftKey: true,
      type: "keydown",
    };
    expect(agentMultilineSequence(shiftEnter, "agent")).toBe("\n");
    expect(agentMultilineSequence(shiftEnter, "integrated")).toBeUndefined();
    expect(
      agentMultilineSequence({ ...shiftEnter, shiftKey: false }, "agent"),
    ).toBeUndefined();
    expect(
      agentMultilineSequence({ ...shiftEnter, type: "keyup" }, "agent"),
    ).toBeUndefined();
  });

  test("keeps resized panels as narrow visible rails", () => {
    expect(clampPanelSize(0, 480)).toBe(PANEL_RAIL_WIDTH);
    expect(clampPanelSize(214.4, 480)).toBe(214);
    expect(clampPanelSize(900, 480)).toBe(480);
    expect(TERMINAL_PANEL_MIN_HEIGHT).toBeGreaterThan(PANEL_RAIL_WIDTH);
    expect(TERMINAL_FONT_SIZE).toBe(13);
  });

  test("keeps a dragged explorer between its own minimums", () => {
    // `available` is what the viewer beside it can spare, and it outranks the
    // nominal maximum — but never below the explorer's own floor, or a narrow
    // window would collapse it into nothing instead of pinning it.
    expect(clampExplorerWidth(10, 900)).toBe(EXPLORER_MIN_WIDTH);
    expect(clampExplorerWidth(260.6, 900)).toBe(261);
    expect(clampExplorerWidth(900, 900)).toBe(EXPLORER_MAX_WIDTH);
    expect(clampExplorerWidth(400, 320)).toBe(320);
    expect(clampExplorerWidth(400, 40)).toBe(EXPLORER_MIN_WIDTH);
    expect(EXPLORER_MIN_WIDTH).toBeLessThan(EXPLORER_DEFAULT_WIDTH);
    expect(EXPLORER_DEFAULT_WIDTH).toBeLessThan(EXPLORER_MAX_WIDTH);
  });

  test("stops the repositories section before it eats the file tree", () => {
    // `available` is the section's own height plus whatever the tree can give
    // up above its floor, so the tree always keeps something to scroll.
    expect(clampExplorerSecondaryHeight(10, 600)).toBe(
      EXPLORER_SECONDARY_MIN_HEIGHT,
    );
    expect(clampExplorerSecondaryHeight(240.4, 600)).toBe(240);
    expect(clampExplorerSecondaryHeight(600, 380)).toBe(380);
    expect(clampExplorerSecondaryHeight(600, 20)).toBe(
      EXPLORER_SECONDARY_MIN_HEIGHT,
    );
    expect(EXPLORER_TREE_MIN_HEIGHT).toBeGreaterThan(0);
  });

  test("restores remembered folders parents first, and survives junk", () => {
    expect(
      parseRememberedDirectories(
        JSON.stringify(["repos/daedalus/src", "repos", "repos/daedalus"]),
      ),
    ).toEqual(["repos", "repos/daedalus", "repos/daedalus/src"]);
    // A child listed before its parent would be restored into a tree that
    // cannot show it, so depth, not insertion order, decides.
    expect(parseRememberedDirectories(JSON.stringify(["a/b", "a"]))).toEqual([
      "a",
      "a/b",
    ]);
    expect(
      parseRememberedDirectories(JSON.stringify(["a", "a", "", 7, null])),
    ).toEqual(["a"]);
    // Nothing here is worth a blank explorer: a key written by an older build,
    // a hand-edited store, or no key at all all mean "nothing remembered".
    expect(parseRememberedDirectories(null)).toEqual([]);
    expect(parseRememberedDirectories("not json")).toEqual([]);
    expect(parseRememberedDirectories(JSON.stringify({ a: 1 }))).toEqual([]);
    expect(
      parseRememberedDirectories(
        JSON.stringify(Array.from({ length: 400 }, (_, index) => `d${index}`)),
      ),
    ).toHaveLength(200);
  });

  describe("planning an explorer refresh from filesystem changes", () => {
    const known = ["", "repos", "repos/daedalus", "worktrees"];
    const change = (
      path: string,
      kind: "added" | "updated" | "deleted",
      entryKind: "file" | "directory" | null = kind === "deleted"
        ? null
        : "file",
    ) => ({ path, kind, entryKind }) as const;

    test("re-lists only the folder a change happened in", () => {
      expect(
        planExplorerRefresh({
          known,
          changes: [change("repos/daedalus/README.md", "updated")],
          overflow: false,
        }),
      ).toEqual({ relist: ["repos/daedalus"], dropped: [] });
    });

    test("re-lists the root for a change at the top level", () => {
      expect(
        planExplorerRefresh({
          known,
          changes: [change("BRIEF.md", "updated")],
          overflow: false,
        }),
      ).toEqual({ relist: [""], dropped: [] });
    });

    test("ignores a change inside a folder nobody has opened", () => {
      // Real, but nothing on screen is wrong because of it, and listing it
      // would be work for no one.
      expect(
        planExplorerRefresh({
          known,
          changes: [change("worktrees/alpha/src/main.ts", "added")],
          overflow: false,
        }),
      ).toEqual({ relist: [], dropped: [] });
    });

    test("names one folder however many changes happened in it", () => {
      expect(
        planExplorerRefresh({
          known,
          changes: Array.from({ length: 50 }, (_, index) =>
            change(`repos/daedalus/f${index}.ts`, "added"),
          ),
          overflow: false,
        }),
      ).toEqual({ relist: ["repos/daedalus"], dropped: [] });
    });

    test("drops a deleted folder and everything cached beneath it", () => {
      expect(
        planExplorerRefresh({
          known,
          changes: [change("repos", "deleted")],
          overflow: false,
        }),
      ).toEqual({ relist: [""], dropped: ["repos", "repos/daedalus"] });
    });

    test("does not re-list a folder it is about to drop", () => {
      // Its own parent is in the same batch and reports it missing; asking for
      // a listing of a folder that is gone is a round trip that can only fail.
      expect(
        planExplorerRefresh({
          known,
          changes: [
            change("repos", "deleted"),
            change("repos/daedalus/README.md", "deleted"),
          ],
          overflow: false,
        }).relist,
      ).toEqual([""]);
    });

    test("re-reads everything on screen when the host reports an overflow", () => {
      // An overflow carries no paths at all, so the only correct answer is
      // everything the explorer has listed.
      expect(
        planExplorerRefresh({ known, changes: [], overflow: true }),
      ).toEqual({ relist: known, dropped: [] });
    });
  });

  test("reconciles a starting card with its server-created session", () => {
    expect(
      launchMatchesSession(
        {
          key: "optimistic",
          workspaceId: "w1",
          taskId: "t1",
          name: "Ship desktop",
          tool: "codex",
          startedAt: "2026-09-14T08:00:00.000Z",
          status: "starting",
        },
        {
          id: "server-session",
          workspaceId: "w1",
          taskId: "t1",
          name: "Ship desktop",
          provider: "codex",
          kind: "agent",
          tmuxSession: "daedalus_server_session",
          command: "codex",
          args: [],
          workingDirectory: "/tmp/demo",
          status: "starting",
          exitCode: null,
          startedAt: "2026-09-14T08:00:01.000Z",
          endedAt: null,
          providerSessionId: null,
          archivedAt: null,
          resumeCount: 0,
          lostReason: null,
          position: 1,
        },
      ),
    ).toBe(true);
  });

  test("selects the current, remembered, or first session in that order", () => {
    const sessions = [
      { id: "newest" },
      { id: "remembered" },
    ] as AgentSessionDto[];
    expect(preferredSessionId(sessions, "newest", "remembered")).toBe("newest");
    expect(preferredSessionId(sessions, "missing", "remembered")).toBe(
      "remembered",
    );
    expect(preferredSessionId(sessions, "missing", "also-missing")).toBe(
      "newest",
    );
    expect(preferredSessionId([])).toBeUndefined();
  });

  test("retires a launch card once its session exists, archived or not", () => {
    const launch = {
      key: "launch-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      name: "Testdfdf",
      tool: "codex",
      startedAt: "2026-09-15T22:34:55.000Z",
      status: "error",
      error: "codex exited before finishing startup",
    } as SessionLaunchState;
    const session = {
      id: "session-1",
      workspaceId: "workspace-1",
    } as AgentSessionDto;

    // While the failed session is listed, its own card carries the error.
    expect(pendingSessionLaunches([launch], [session])).toEqual([]);
    // Archiving that session is how the user clears it — the launch card must
    // not come back to take its place.
    expect(
      pendingSessionLaunches([launch], [
        { ...session, archivedAt: "2026-09-15T22:40:00.000Z" },
      ] as AgentSessionDto[]),
    ).toEqual([]);
    // A launch that never produced a session row has nothing to stand in for
    // it, so it stays until dismissed.
    expect(
      pendingSessionLaunches([{ ...launch, sessionId: undefined }], []),
    ).toHaveLength(1);
  });

  test("focuses only the session the user opened in this window", () => {
    // Opening a session from the UI claims the caret.
    expect(shouldFocusSession("opened", "opened")).toBe(true);
    // A session that became active on its own — restored at startup, chosen by
    // preferredSessionId, or spawned from the CLI — must not steal focus.
    expect(shouldFocusSession(undefined, "auto-selected")).toBe(false);
    // Nor may a stale request follow the user to a different session.
    expect(shouldFocusSession("opened", "another")).toBe(false);
    expect(shouldFocusSession(undefined, undefined)).toBe(false);
  });

  test("restores a remembered workspace mode and ignores unusable values", () => {
    expect(preferredWorkspaceView("sessions")).toBe("sessions");
    expect(preferredWorkspaceView("workspace")).toBe("workspace");
    expect(preferredWorkspaceView("board")).toBe("board");
    expect(preferredWorkspaceView("retired-mode")).toBe("workspace");
    expect(preferredWorkspaceView(null)).toBe("workspace");
    expect(preferredWorkspaceView()).toBe("workspace");
  });

  test("renders Board, Sessions, and Workspace as complete workspace modes", () => {
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialSnapshot={base}
        initialWorkspaceView="board"
      />,
    );
    expect(html).toContain("Workspaces");
    expect(html).toContain("Board");
    expect(html).toContain("Sessions");
    expect(html).toContain("Workspace");
    expect(html).not.toContain("Activity");
    expect(html).toContain('aria-label="Workspace mode"');
    expect(html).toContain("mode-board");
    expect(html).not.toContain("No session selected");
    expect(html).toContain("No workspaces yet");
    expect(html).toContain('aria-label="Create workspace"');
    expect(html).toContain('class="create-button"');
    expect(html).toContain('aria-label="Open settings"');
    expect(html).not.toContain(">Refresh</button>");
  });

  test("labels every provider in the app-wide usage footer", () => {
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialSnapshot={{
          ...base,
          providerUsage: [
            {
              provider: "codex",
              windows: [
                { label: "5h", usedPercent: 28 },
                { label: "7d", usedPercent: 61 },
              ],
              observedAt: "2026-09-15T08:00:00.000Z",
            },
            {
              provider: "claude",
              windows: [
                { label: "5h", usedPercent: 14 },
                { label: "7d", usedPercent: 33 },
              ],
              observedAt: "2026-09-15T08:00:00.000Z",
            },
          ],
        }}
      />,
    );
    expect(html).toContain("Codex</strong><span>5h 28%");
    expect(html).toContain("Claude</strong><span>5h 14%");
    expect(html).toContain("7d 61%");
    expect(html).toContain("7d 33%");
  });

  test("opens Settings on General, with its categories and the first toggle", () => {
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialModal="settings"
        initialSnapshot={base}
      />,
    );
    expect(html).toContain("Create workspace agent guidance");
    expect(html).toContain('type="checkbox" checked=""');
    // Every category is one click away, and only General is rendered. The
    // skill wording moved to the Skills category with the panel itself.
    for (const label of ["General", "Skills", "Notifications", "About"])
      expect(html).toContain(label);
    expect(html).not.toContain("Focus mode");
  });

  test("keeps provider default selected in the session model picker", () => {
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialModal="session"
        initialSnapshot={{
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
              position: 1,
            },
          ],
          settings: {
            ...base.settings,
            providers: [
              { name: "codex", executable: "codex", available: true },
              { name: "claude", executable: "claude", available: true },
            ],
          },
        }}
      />,
    );
    expect(html).toContain('class="session-model-picker"');
    expect(html).toContain("Loading Codex models");
    expect(html).toContain("Loading models");
    expect(html).toContain("Reading the models available to your account");
    expect(html).not.toContain("Provider default · Automatic");
  });

  test("renders the unified repository finder and clone action", () => {
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialModal="repository"
        initialSnapshot={{
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
              position: 1,
            },
          ],
          repositories: [
            {
              id: "library-r1",
              name: "daedalus",
              remoteUrl: "git@github.com:example/daedalus.git",
              defaultBranch: "main",
              lastFetchedAt: "2026-09-13T12:00:00.000Z",
            },
          ],
        }}
      />,
    );
    expect(html).toContain("Add repositories");
    expect(html).toContain("All repositories");
    expect(html).toContain("Local");
    expect(html).toContain("git@github.com:example/daedalus.git");
    // Real checkboxes inside the form, not buttons wearing a checkbox role:
    // that is what makes Space toggle and Enter submit without either being
    // scripted, so the markup is what the test pins.
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('data-repository-option="true"');
    expect(html).not.toContain('role="checkbox"');
    // Enter has to reach a submit button for implicit submission to happen.
    expect(html).toContain('type="submit"');
    expect(html).toContain(
      'aria-label="Search repositories or enter a Git URL or absolute local repository path"',
    );
    expect(html).toContain("Clone URL/path");
    expect(html).toContain("Add selected");
    expect(html).not.toContain("Planning + work");
    expect(html).not.toContain("Planning only");
  });

  test("a workspace with no repositories is told what to do about it", () => {
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
          position: 1,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialSnapshot={snapshot}
        initialWorkspaceView="workspace"
        initialWorkspaceContent={{
          workspaceId: "w1",
          brief: "# Objective",
          journal: "# Journal",
          files: [
            {
              name: "BRIEF.md",
              path: "BRIEF.md",
              kind: "file",
              mutable: false,
            },
          ],
          repositories: [],
          worktrees: [],
        }}
      />,
    );
    // An instruction, not a shrug: the empty state names the next action and
    // carries a control that performs it.
    expect(html).toContain("No repositories yet");
    expect(html).toContain("workspace-repository-invite");
    expect(html).toContain("Add a repository");
    expect(html).not.toContain("workspace-repository-group");
  });

  test("renders workspace files, context, repositories, and worktrees", () => {
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
          position: 1,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialSnapshot={snapshot}
        initialWorkspaceView="workspace"
        initialWorkspaceContent={{
          workspaceId: "w1",
          brief: "# Objective\n\nBuild the workspace view.",
          journal: "# Journal\n\n## progress\n\nStarted.",
          files: [
            {
              name: "worktrees",
              path: "worktrees",
              kind: "directory",
              mutable: false,
            },
            {
              name: "BRIEF.md",
              path: "BRIEF.md",
              kind: "file",
              mutable: false,
            },
            {
              name: "JOURNAL.md",
              path: "JOURNAL.md",
              kind: "file",
              mutable: false,
            },
          ],
          repositories: [
            {
              id: "r1",
              workspaceId: "w1",
              name: "daedalus",
              canonicalPath: "/code/daedalus",
              access: "write",
              libraryRepositoryId: "library-r1",
              referencePath: "/tmp/demo/repos/daedalus",
              baseBranch: "main",
              baseCommit: "1234567890abcdef1234567890abcdef12345678",
              fetchedAt: "now",
              createdAt: "now",
              status: "ready" as const,
              statusError: null,
              gitStatus: {
                state: "behind",
                changedFiles: 0,
                ahead: 0,
                behind: 2,
              },
            },
          ],
          worktrees: [
            {
              sessionId: "session-12345678",
              repositoryId: "r1",
              path: "/tmp/demo/worktrees/task/session/daedalus",
              branchName: "daedalus/demo/task/session",
              createdAt: "now",
            },
          ],
        }}
      />,
    );
    expect(html).toContain("mode-workspace");
    expect(html).toContain("Explorer");
    expect(html).toContain("workspace-viewer");
    expect(html).toContain("BRIEF.md");
    expect(html).toContain("JOURNAL.md");
    expect(html).toContain("workspace-code-editor");
    expect(html).toContain("Preview");
    expect(html).toContain('aria-label="New file"');
    expect(html).toContain('aria-label="New folder"');
    expect(html).toContain("Repositories");
    expect(html).toContain("main ·");
    expect(html).toContain("↓2 behind");
    expect(html).toContain('aria-label="Fetch daedalus"');
    expect(html).toContain('aria-label="Pull daedalus"');
    expect(html).toContain('aria-label="Add repository"');
    // The working tree is nested under the repository it was cut from, and
    // carries the branch it is on rather than only the session's name.
    expect(html).toContain("workspace-repository-group");
    expect(html).toContain("workspace-worktree-row");
    expect(html).toContain("daedalus/demo/task/session");
    expect(html).toContain('aria-label="Push daedalus/demo/task/session"');
    // Both of the explorer's own borders are grabbable, and both carry the
    // size they are currently set to so a keyboard can move them too.
    expect(html).toContain('aria-label="Resize explorer"');
    expect(html).toContain('aria-label="Resize repositories section"');
    expect(html).toContain("--explorer-width:");
    expect(html).toContain("--explorer-secondary-height:");
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
          position: 1,
        },
      ],
      tasks: [
        {
          id: "t1",
          workspaceId: "w1",
          number: 1,
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
          providerSessionId: "daedalus-agent-12345678",
          archivedAt: null,
          resumeCount: 0,
          lostReason: null,
          position: 1,
        },
        {
          id: "agent-needs-attention",
          workspaceId: "w1",
          taskId: null,
          name: "Needs developer input",
          provider: "claude",
          kind: "agent",
          tmuxSession: "daedalus_attention",
          command: "claude",
          args: [],
          workingDirectory: "/tmp/demo",
          status: "lost",
          exitCode: null,
          startedAt: "now",
          endedAt: null,
          providerSessionId: "agent-needs-attention",
          archivedAt: null,
          resumeCount: 0,
          lostReason: null,
          position: 1,
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
        initialWorkspaceView="board"
      />,
    );
    expect(html).toContain("Demo");
    expect(html).toContain("Ship desktop");
    expect(html).toContain("#1");
    expect(html).toContain("in progress");
    expect(html).toContain('aria-label="Open Ship desktop session"');
    expect(html).toContain("task-session-link tool-codex running");
    expect(html).toContain(
      'aria-label="2 sessions in Demo: 1 live, 1 need you"',
    );
    expect(html).toContain('data-attention="true"');
    expect(html).toContain("1 needs you");
    expect(html).toContain('aria-label="Archive Demo workspace"');
    expect(html).toContain('class="archive-icon"');
    expect(html).toContain("Start session…");
    expect(html).toContain("Sessions");
    expect(html).toContain("Acceptance criteria");
    expect(html).toContain("Edit");
    expect(html).toContain("board-detail-column");
    expect(html).not.toContain("linked-sessions");
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
          position: 1,
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
      providerSessionId: "11111111-1111-4111-8111-111111111111",
      archivedAt: null,
      resumeCount: 0,
      lostReason: null,
      position: 1,
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
          position: 1,
        },
      ],
      tasks: [
        {
          id: "t1",
          workspaceId: "w1",
          number: 1,
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
    expect(html).toContain("Terminal for Terminal task 11111111");
    expect(html).toContain("session-navigator");
    expect(html).toContain('aria-label="Resize sessions panel"');
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
          position: 1,
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
          providerSessionId: null,
          archivedAt: null,
          resumeCount: 0,
          lostReason: null,
          position: 1,
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
    expect(html).toContain("session-kind-icon tool-terminal");
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

  test("gives cards no drag affordance and no extra tab stops", () => {
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
          position: 1,
        },
      ],
      agents: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          workspaceId: "w1",
          taskId: null,
          name: "Session",
          provider: "claude",
          kind: "agent",
          tmuxSession: "daedalus_one",
          command: "claude",
          args: [],
          workingDirectory: "/tmp/demo",
          status: "running",
          exitCode: null,
          startedAt: "2026-01-02T00:00:00.000Z",
          endedAt: null,
          providerSessionId: null,
          archivedAt: null,
          resumeCount: 0,
          lostReason: null,
          position: 1,
        },
      ],
      settings: { ...base.settings, tmuxAvailable: true },
    };
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialSnapshot={snapshot}
        initialWorkspaceView="sessions"
      />,
    );
    // Cards carry no drag affordance at all — no grip, no grab cursor — by
    // request. Dragging still works from anywhere on a card.
    expect(html).not.toContain("list-drag-grip");
    // The card's own buttons opt out of starting a drag.
    expect(html).toContain("data-no-drag");
    // And nothing extra joined the tab order to make dragging reachable: the
    // keyboard route is ⌥↑/⌥↓ on the card itself.
    expect(html).not.toContain('tabindex="0" class="workspace-card');
  });

  test("renders lists in the order the snapshot supplies, without re-sorting", () => {
    const workspace = (id: string, name: string, position: number) => ({
      id,
      slug: id,
      name,
      path: `/tmp/${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      available: true,
      position,
    });
    // Deliberately not alphabetical, not by creation, and not by position
    // value either: the array order is what the service already applied, and
    // the renderer's job is to leave it alone.
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialSnapshot={{
          ...base,
          workspaces: [
            workspace("zulu", "Zulu", 1),
            workspace("alpha", "Alpha", 2),
            workspace("mike", "Mike", 3),
          ],
        }}
      />,
    );
    expect(html.indexOf("Zulu")).toBeLessThan(html.indexOf("Alpha"));
    expect(html.indexOf("Alpha")).toBeLessThan(html.indexOf("Mike"));
  });

  test("renders collapsed workspace and session archives with restore actions", () => {
    const archivedAt = "2026-02-02T00:00:00.000Z";
    const snapshot: DesktopSnapshotDto = {
      ...base,
      workspaces: [
        {
          id: "w1",
          slug: "active",
          name: "Active",
          path: "/tmp/active",
          createdAt: "now",
          updatedAt: "now",
          archivedAt: null,
          available: true,
          position: 1,
        },
        {
          id: "w2",
          slug: "archived",
          name: "Archived project",
          path: "/tmp/archived",
          createdAt: "now",
          updatedAt: archivedAt,
          archivedAt,
          available: true,
          position: 1,
        },
      ],
      agents: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          workspaceId: "w1",
          taskId: null,
          name: "Archived conversation",
          provider: "claude",
          kind: "agent",
          tmuxSession: "daedalus_archived",
          command: "claude",
          args: [],
          workingDirectory: "/tmp/active",
          status: "exited",
          exitCode: null,
          startedAt: "now",
          endedAt: archivedAt,
          providerSessionId: "44444444-4444-4444-8444-444444444444",
          archivedAt,
          resumeCount: 0,
          lostReason: null,
          position: 1,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialSnapshot={snapshot}
        initialWorkspaceView="sessions"
      />,
    );
    expect(html).toContain("Archived workspaces (1)");
    expect(html).toContain("Archived project");
    expect(html).toContain("Archived sessions (1)");
    expect(html).toContain("Archived conversation");
    expect(html).toContain("Restore &amp; resume");
    expect(html).toContain('aria-label="Archive Active workspace"');
  });

  test("renders persistent integrated terminal tabs separately from sessions", () => {
    const terminalId = "55555555-5555-4555-8555-555555555555";
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
          position: 1,
        },
      ],
      terminals: [
        {
          id: terminalId,
          name: "Demo",
          tmuxSession: "daedalus_terminal_demo",
          workingDirectory: "/tmp/demo",
          status: "running",
          startedAt: "now",
          endedAt: null,
          revivedAt: null,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialActiveTerminalId={terminalId}
        initialSnapshot={snapshot}
        initialTerminalPanelOpen
        initialWorkspaceView="board"
      />,
    );
    expect(html).toContain('aria-label="Integrated terminal"');
    expect(html).toContain('aria-label="Terminal tabs"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('title="/tmp/demo"');
    expect(html).toContain('aria-label="Demo, /tmp/demo"');
    expect(html).toContain("<small>/tmp/demo</small>");
    expect(html).toContain('aria-label="Resize integrated terminal"');
    expect(html).toContain('aria-label="Resize workspace panel"');
    expect(html).toContain('aria-label="Resize task inspector panel"');
    expect(html).toContain("Terminal for Demo 55555555");
    expect(html).toContain('aria-label="New terminal in Daedalus home"');
    expect(html).toContain('title="New terminal in /tmp/daedalus-test"');
    expect(html).toContain('aria-label="Open Demo in integrated terminal"');
    expect(html).not.toContain("Demo · archived");
  });

  test("renders session startup progress and failures on session cards", () => {
    const workspace = {
      id: "w-start",
      slug: "start",
      name: "Start",
      path: "/tmp/start",
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
      archivedAt: null,
      available: true,
      position: 1,
    };
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialSessionLaunches={[
          {
            key: "pending",
            workspaceId: workspace.id,
            name: "Launching Claude",
            tool: "claude",
            startedAt: "2026-09-14T00:00:00.000Z",
            status: "starting",
          },
          {
            key: "failed",
            workspaceId: workspace.id,
            name: "Broken Codex",
            tool: "codex",
            startedAt: "2026-09-14T00:00:01.000Z",
            status: "error",
            error: "The current working directory was deleted",
          },
        ]}
        initialSnapshot={{
          ...base,
          workspaces: [workspace],
          settings: { ...base.settings, tmuxAvailable: true },
        }}
        initialWorkspaceView="sessions"
      />,
    );
    expect(html).toContain("session-card-starting");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Starting claude…");
    expect(html).toContain("session-card-error");
    expect(html).toContain("Failed to start");
    expect(html).toContain("The current working directory was deleted");
    expect(html).not.toContain("session-launch-progress");
  });
});

const liveSession: AgentSessionDto = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "w1",
  taskId: null,
  name: "Claude",
  provider: "claude",
  kind: "agent",
  tmuxSession: "daedalus_live",
  command: "claude",
  args: [],
  workingDirectory: "/tmp/demo",
  status: "running",
  exitCode: null,
  startedAt: "2026-09-16T09:00:00.000Z",
  endedAt: null,
  providerSessionId: null,
  archivedAt: null,
  resumeCount: 0,
  lostReason: null,
  position: 1,
};

const at = (iso: string) => Date.parse(iso);

describe("session status indicators", () => {
  test("attention outranks everything else on screen", () => {
    const view = sessionStatusView(
      liveSession,
      {
        sessionId: liveSession.id,
        activity: "needs_permission",
        detail: "Bash(git push)",
        since: "2026-09-16T09:05:00.000Z",
        observedAt: "2026-09-16T09:05:00.000Z",
        source: "hook",
      },
      {
        sessionId: liveSession.id,
        workspaceId: "w1",
        reasons: [
          {
            id: "r1",
            text: "Claude needs permission: Bash(git push)",
            raisedAt: "2026-09-16T09:05:00.000Z",
            source: "hook",
          },
        ],
        raisedAt: "2026-09-16T09:05:00.000Z",
        updatedAt: "2026-09-16T09:05:00.000Z",
      },
    );
    expect(view.tone).toBe("attention");
    expect(view.label).toBe("needs permission");
    expect(view.detail).toBe("Claude needs permission: Bash(git push)");
    // The badge's age, not the activity's: that is what "waiting 4m" measures.
    expect(view.since).toBe("2026-09-16T09:05:00.000Z");
  });

  test("a pane reading is marked unconfirmed rather than stated as fact", () => {
    const view = sessionStatusView(liveSession, {
      sessionId: liveSession.id,
      activity: "working",
      detail: "Editing agents.ts",
      since: "2026-09-16T09:01:00.000Z",
      observedAt: "2026-09-16T09:02:00.000Z",
      source: "pane",
    });
    expect(view.tone).toBe("working");
    expect(view.unconfirmed).toBe(true);
    expect(
      sessionStatusView(liveSession, {
        sessionId: liveSession.id,
        activity: "working",
        detail: null,
        since: "2026-09-16T09:01:00.000Z",
        observedAt: "2026-09-16T09:02:00.000Z",
        source: "hook",
      }).unconfirmed,
    ).toBe(false);
  });

  test("falls back to lifecycle status when no activity has been observed", () => {
    expect(sessionStatusView(liveSession).tone).toBe("idle");
    expect(sessionStatusView({ ...liveSession, status: "lost" })).toMatchObject(
      {
        tone: "lost",
        attention: true,
      },
    );
    expect(
      sessionStatusView({ ...liveSession, status: "exited" }).attention,
    ).toBe(false);
    expect(lifecycleTone("starting")).toBe("working");
  });

  test("a session that could not be revived says why on its card", () => {
    // A reboot makes every session `lost` at once, so the handful that are
    // staying that way have to be tellable apart from the rest at a glance.
    expect(
      sessionStatusView({
        ...liveSession,
        status: "lost",
        lostReason: "Custom sessions do not define a native resume capability",
      }).detail,
    ).toBe("Custom sessions do not define a native resume capability");
    expect(
      sessionStatusView({ ...liveSession, status: "lost" }).detail,
    ).toBeNull();
    // An exited session was not something anything tried to bring back.
    expect(
      sessionStatusView({
        ...liveSession,
        status: "exited",
        lostReason: "stale",
      }).detail,
    ).toBeNull();
  });

  test("elapsed time reads as a wait, not as a zero", () => {
    expect(
      waitingLabel("2026-09-16T09:00:00.000Z", at("2026-09-16T09:00:20.000Z")),
    ).toBe("just now");
    expect(
      waitingLabel("2026-09-16T09:00:00.000Z", at("2026-09-16T09:04:00.000Z")),
    ).toBe("4m");
    expect(
      waitingLabel("2026-09-16T09:00:00.000Z", at("2026-09-16T11:30:00.000Z")),
    ).toBe("2h 30m");
    expect(waitingLabel(null, Date.now())).toBe("");
  });

  test("the accessible name states the activity, never the colour", () => {
    const view = sessionStatusView(liveSession, undefined, {
      sessionId: liveSession.id,
      workspaceId: "w1",
      reasons: [
        {
          id: "r1",
          text: "Need a decision on the schema",
          raisedAt: "2026-09-16T09:00:00.000Z",
          source: "agent",
        },
        {
          id: "r2",
          text: "Which branch should this land on?",
          raisedAt: "2026-09-16T09:01:00.000Z",
          source: "agent",
        },
      ],
      raisedAt: "2026-09-16T09:00:00.000Z",
      updatedAt: "2026-09-16T09:01:00.000Z",
    });
    const label = statusAriaLabel(
      liveSession,
      view,
      at("2026-09-16T09:04:00.000Z"),
    );
    expect(label).toBe(
      "Claude: needs input, waiting 4m, 2 reasons, Which branch should this land on?",
    );
    expect(label).not.toMatch(/red|green|colour|color/i);
  });

  test("a blocked session is identifiable from the lists without opening it", () => {
    const workspace: DesktopSnapshotDto["workspaces"][number] = {
      id: "w1",
      slug: "demo",
      name: "Demo",
      path: "/tmp/demo",
      createdAt: "now",
      updatedAt: "now",
      archivedAt: null,
      available: true,
      position: 1,
    };
    const blocked: AgentSessionDto = {
      ...liveSession,
      id: "22222222-2222-4222-8222-222222222222",
      name: "Blocked",
      tmuxSession: "daedalus_blocked",
    };
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialSnapshot={{
          ...base,
          workspaces: [workspace],
          agents: [liveSession, blocked],
          sessionActivity: [
            {
              sessionId: liveSession.id,
              activity: "working",
              detail: "Editing agents.ts",
              since: "2026-09-16T09:00:00.000Z",
              observedAt: "2026-09-16T09:02:00.000Z",
              source: "hook",
            },
            {
              sessionId: blocked.id,
              activity: "needs_permission",
              detail: "Bash(git push)",
              since: "2026-09-16T09:01:00.000Z",
              observedAt: "2026-09-16T09:02:00.000Z",
              source: "hook",
            },
          ],
          attention: [
            {
              sessionId: blocked.id,
              workspaceId: "w1",
              reasons: [
                {
                  id: "r1",
                  text: "Claude needs permission: Bash(git push)",
                  raisedAt: "2026-09-16T09:01:00.000Z",
                  source: "hook",
                },
              ],
              raisedAt: "2026-09-16T09:01:00.000Z",
              updatedAt: "2026-09-16T09:01:00.000Z",
            },
          ],
          settings: { ...base.settings, tmuxAvailable: true },
        }}
        initialWorkspaceView="sessions"
      />,
    );
    // The workspace list carries the roll-up, so a blocked session in a
    // background workspace is discoverable without clicking in.
    expect(html).toContain("1 needs you");
    expect(html).toContain("workspace-attention-badge");
    // The row itself is the loud one.
    expect(html).toContain("agent-dot tone-attention");
    expect(html).toContain("needs permission");
    expect(html).toContain("Bash(git push)");
    // It no longer floats above the working session. The list order became the
    // user's when it became draggable, and moving a card out from under them
    // to make a point they can already see — tone, badge, roll-up, filter — is
    // the behaviour a manual order exists to stop.
    expect(html.indexOf(`data-session-id="${liveSession.id}"`)).toBeLessThan(
      html.indexOf(`data-session-id="${blocked.id}"`),
    );
    expect(html).toContain("session-filter-toggle");
  });

  test("renders queued toasts and never more than the cap", () => {
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialSnapshot={{
          ...base,
          toasts: Array.from({ length: 7 }, (_unused, index) => ({
            id: `toast-${index}`,
            sessionId: null,
            workspaceId: null,
            level: "info" as const,
            title: `Alert ${index}`,
            body: "Something happened",
            createdAt: "2026-09-16T09:00:00.000Z",
          })),
        }}
      />,
    );
    expect(html).toContain("toast-stack");
    // Three, not five: past that a stack stops being read and starts being
    // dismissed unread.
    expect(MAX_VISIBLE_TOASTS).toBe(3);
    expect(html).toContain(`Alert ${MAX_VISIBLE_TOASTS - 1}`);
    expect(html).not.toContain(`Alert ${MAX_VISIBLE_TOASTS}`);
  });

  test("the deck is collapsed by default so it cannot wall off the page", () => {
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialSnapshot={{
          ...base,
          toasts: Array.from({ length: 3 }, (_unused, index) => ({
            id: `toast-${index}`,
            sessionId: null,
            workspaceId: null,
            level: "info" as const,
            title: `Alert ${index}`,
            body: "Something happened",
            createdAt: "2026-09-16T09:00:00.000Z",
          })),
        }}
      />,
    );
    expect(html).toContain('data-expanded="false"');
    // Each card behind the front one is a sliver lower and a little smaller,
    // so three toasts cost one card's height plus two slivers.
    expect(html).toContain("--toast-offset:0px");
    expect(html).toContain(`--toast-offset:${TOAST_LIFT}px`);
    expect(html).toContain(`--toast-offset:${TOAST_LIFT * 2}px`);
    expect(html).toContain("--toast-scale:0.95");
    expect(html).toContain("--toast-scale:0.9");
  });

  test("a stack of more than one offers a single way to clear it", () => {
    const toast = (index: number) => ({
      id: `toast-${index}`,
      sessionId: null,
      workspaceId: null,
      level: "info" as const,
      title: `Alert ${index}`,
      body: "Something happened",
      createdAt: "2026-09-16T09:00:00.000Z",
    });
    const render = (count: number) =>
      renderToStaticMarkup(
        <App
          injectedClient={client}
          initialSnapshot={{
            ...base,
            toasts: Array.from({ length: count }, (_u, index) => toast(index)),
          }}
        />,
      );
    expect(render(2)).toContain("toast-clear-all");
    // One toast already has its own dismiss; a "clear all" would be noise.
    expect(render(1)).not.toContain("toast-clear-all");
  });

  test("every toast carries a labelled dismiss, not only a timeout", () => {
    const html = renderToStaticMarkup(
      <App
        injectedClient={client}
        initialSnapshot={{
          ...base,
          toasts: [
            {
              id: "toast-0",
              sessionId: null,
              workspaceId: null,
              level: "error" as const,
              title: "Build failed",
              body: "Something happened",
              createdAt: "2026-09-16T09:00:00.000Z",
            },
          ],
        }}
      />,
    );
    expect(html).toContain("Dismiss notification: Build failed");
    // The level reads as a dot in the indicator vocabulary, not a stripe.
    expect(html).toContain("toast-level");
    expect(html).toContain("level-error");
  });
});

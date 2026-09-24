/**
 * The page `scripts/board-ui-check.ts` drives.
 *
 * A stateful stand-in for the host: requests change an in-memory snapshot
 * and announce, exactly as `mutate` does in `rpc.ts`, so a Start or a capture
 * redraws the board through the same subscribe path the app uses. Every call
 * is recorded on `window.__boardCalls` for the check to assert on. The tasks
 * are this workspace's own, so every lane has something real in it.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentSessionDto,
  DesktopSnapshotDto,
  TaskDto,
  TaskTimelineDto,
} from "@daedalus/protocol";
import { App } from "./App";
import type { DesktopClient } from "./client-types";
import "./styles.css";

declare global {
  interface Window {
    __boardCalls: Array<{ name: string; params: unknown }>;
  }
}
window.__boardCalls = [];

const WORKSPACE = "deadalus";
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

let sequence = 0;
const task = (
  number: number,
  title: string,
  status: TaskDto["status"],
  overrides: Partial<TaskDto> = {},
): TaskDto => ({
  id: `task-${number}`,
  workspaceId: WORKSPACE,
  number,
  title,
  description: `The brief for #${number}.`,
  status,
  priority: "normal",
  createdAt: ago(5000 - number * 10),
  updatedAt: ago(600 - number),
  completedAt: status === "done" ? ago(900 - number * 10) : null,
  briefUpdatedAt: null,
  references: [],
  ...overrides,
});

const session = (
  id: string,
  taskNumber: number,
  provider: "claude" | "codex",
  overrides: Partial<AgentSessionDto> = {},
): AgentSessionDto => ({
  id,
  workspaceId: WORKSPACE,
  taskId: `task-${taskNumber}`,
  name: `Session for #${taskNumber}`,
  provider,
  kind: "agent",
  tmuxSession: `daedalus_${id}`,
  command: provider,
  args: [],
  workingDirectory: `/tmp/deadalus/worktrees/${id}`,
  status: "running",
  exitCode: null,
  startedAt: ago(90),
  endedAt: null,
  providerSessionId: null,
  archivedAt: null,
  resumeCount: 0,
  lostReason: null,
  position: sequence++,
  ...overrides,
});

const done = [
  [10, "Real activity detection"],
  [11, "Attention-first indicators"],
  [12, "Manually orderable lists"],
  [19, "A reboot should be a non-event"],
  [21, "A file explorer that remembers"],
  [22, "Escape left a session reading working"],
  [23, "What actually interrupts a continuous run"],
] as const;

const snapshot: DesktopSnapshotDto = {
  workspaces: [
    {
      id: WORKSPACE,
      slug: "deadalus",
      name: "Daedalus",
      path: "/tmp/deadalus",
      createdAt: ago(9000),
      updatedAt: ago(10),
      archivedAt: null,
      available: true,
      position: 1,
      startSetsInProgress: true,
      defaultProvider: "claude",
      defaultModel: null,
    },
  ],
  tasks: [
    ...done.map(([number, title]) => task(number, title, "done")),
    task(20, "Honest quit", "in_progress"),
    task(24, "Explorer that does not go stale", "in_progress", {
      description: "Follow-on to #21.",
      references: [{ taskId: "task-21", number: 21, hard: false }],
    }),
    task(25, "Board rework", "in_progress", {
      priority: "high",
      description: "Depends on #13's brainstorm; see #11 for the rings.",
      references: [{ taskId: "task-11", number: 11, hard: false }],
    }),
    task(26, "Per-session permission mode", "todo", {
      priority: "high",
      description: "After #23.",
      references: [{ taskId: "task-23", number: 23, hard: true }],
    }),
    task(27, "Cross-workspace needs-me view", "todo", {
      description: "Blocked by #25.",
      references: [{ taskId: "task-25", number: 25, hard: true }],
    }),
    task(28, "Packaging and notarization", "blocked"),
    task(29, "Tidy the settings copy", "todo", { description: "" }),
  ],
  agents: [
    session("s-24", 24, "codex"),
    session("s-20", 20, "claude", {
      status: "exited",
      startedAt: ago(300),
      endedAt: ago(120),
    }),
    session("s-25", 25, "claude"),
  ],
  terminals: [],
  repositories: [],
  providerUsage: [],
  sessionTelemetry: [
    {
      sessionId: "s-24",
      model: "gpt-5",
      context: { usedTokens: 31_000, totalTokens: 258_000, usedPercent: 12 },
      observedAt: ago(1),
    },
    {
      sessionId: "s-25",
      model: "Opus 5.5",
      context: { usedTokens: 410_000, totalTokens: 1_000_000, usedPercent: 41 },
      observedAt: ago(1),
    },
  ],
  sessionActivity: [
    {
      sessionId: "s-24",
      activity: "needs_permission",
      detail: "Bash(git push origin daedalus/deadalus/e11f6aae)",
      since: ago(14),
      observedAt: ago(14),
      source: "hook",
    },
    {
      sessionId: "s-25",
      activity: "working",
      detail: "Editing BoardView.tsx",
      since: ago(3),
      observedAt: ago(0.2),
      source: "hook",
    },
  ],
  attention: [
    {
      sessionId: "s-24",
      workspaceId: WORKSPACE,
      reasons: [
        {
          id: "r-24",
          text: "Codex needs permission: Bash(git push origin daedalus/deadalus/e11f6aae)",
          raisedAt: ago(14),
          source: "hook",
          generated: true,
        },
      ],
      raisedAt: ago(14),
      updatedAt: ago(14),
    },
  ],
  worktrees: [
    {
      sessionId: "s-24",
      repositoryId: "repo",
      path: "/tmp/deadalus/worktrees/e11f6aae/daedalus",
      branchName: "daedalus/deadalus/e11f6aae",
      createdAt: ago(88),
      gitStatus: {
        state: "ahead",
        changedFiles: 0,
        ahead: 6,
        behind: 0,
        filesAhead: 12,
      },
      pullRequest: {
        number: 23,
        url: "https://github.com/Bakar0/daedalus/pull/23",
        state: "OPEN",
        isDraft: false,
      },
    },
    {
      sessionId: "s-20",
      repositoryId: "repo",
      path: "/tmp/deadalus/worktrees/e600d87d/daedalus",
      branchName: "daedalus/deadalus/e600d87d",
      createdAt: ago(298),
      gitStatus: {
        state: "ahead",
        changedFiles: 0,
        ahead: 4,
        behind: 0,
        filesAhead: 9,
      },
      pullRequest: {
        number: 20,
        url: "https://github.com/Bakar0/daedalus/pull/20",
        state: "OPEN",
        isDraft: false,
      },
    },
    {
      sessionId: "s-25",
      repositoryId: "repo",
      path: "/tmp/deadalus/worktrees/9c1a0b2d/daedalus",
      branchName: "daedalus/deadalus/9c1a0b2d",
      createdAt: ago(80),
      gitStatus: {
        state: "modified",
        changedFiles: 2,
        ahead: 1,
        behind: 0,
        filesAhead: 3,
      },
    },
  ],
  toasts: [],
  settings: {
    version: "0.7.0",
    channel: "dev",
    home: "/tmp/daedalus-board",
    workspaceRoot: "/tmp/daedalus-board/workspaces",
    databasePath: "/tmp/daedalus-board/state.db",
    repositoryRoot: "/tmp/daedalus-board/repos",
    tmuxAvailable: true,
    tmuxVersion: "3.7c",
    workspaceInstructionFilesEnabled: true,
    autoRestoreSessionsEnabled: true,
    focusMode: false,
    providers: [
      { name: "claude", executable: "claude", available: true },
      { name: "codex", executable: "codex", available: true },
    ],
  },
};

const JOURNAL = [
  "# Journal",
  "",
  "## #20 — Honest quit",
  "",
  // Separate paragraphs, so the journal is long enough that the #24 heading
  // starts below the fold and the link has to scroll to it.
  ...Array.from({ length: 60 }, (_unused, index) => [
    `Filler paragraph ${index}.`,
    "",
  ]).flat(),
  "",
  "## #24 — A tree that follows the filesystem, and three verbs that change it",
  "",
  "Follow-on to #21. Both phases landed.",
  "",
  // A later entry, so the viewer can put #24 at the top rather than running
  // out of journal first.
  "## #25 — A later entry",
  "",
  ...Array.from({ length: 40 }, (_unused, index) => [
    `Later paragraph ${index}.`,
    "",
  ]).flat(),
].join("\n");

const timelineFor = (id: string): TaskTimelineDto => {
  const target = snapshot.tasks.find((item) => item.id === id)!;
  return {
    taskId: id,
    events: [
      { kind: "created", at: target.createdAt, text: "Created" },
      {
        kind: "session_spawned",
        at: ago(90),
        text: "Codex started · gpt-5",
        detail: target.title,
        sessionId: "s-24",
      },
      {
        kind: "worktree_created",
        at: ago(88),
        text: "Worktree daedalus/deadalus/e11f6aae",
        detail: "/tmp/deadalus/worktrees/e11f6aae/daedalus",
      },
      {
        kind: "attention_raised",
        at: ago(40),
        text: "Codex asked",
        detail: "Which base branch should the explorer rebase onto?",
      },
      { kind: "attention_cleared", at: ago(37), text: "Attention cleared" },
      {
        kind: "attention_raised",
        at: ago(14),
        text: "Codex asked",
        detail: "Codex needs permission: Bash(git push)",
        open: true,
      },
      {
        kind: "journal",
        at: null,
        text: "Journal entry",
        detail:
          "#24 — A tree that follows the filesystem, and three verbs that change it",
        journalHeading:
          "#24 — A tree that follows the filesystem, and three verbs that change it",
      },
    ],
    cost: {
      sessions: 1,
      firstStartedAt: ago(90),
      lastEndedAt: null,
      running: true,
      peakContextPercent: 64,
      models: ["gpt-5"],
    },
  };
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
    window.__boardCalls.push({ name, params });
    return handler(params);
  };

const client = {
  request: {
    snapshot: async () => ok(structuredClone(snapshot)),
    terminalEndpoint: async () =>
      ok({ endpoint: "ws://127.0.0.1:1/board-test" }),
    presencePublish: async () => ok({}),
    toastsAcknowledge: async () => ok({ acknowledged: 0 }),
    workspaceWatchSet: async () => ok({ watching: [] }),
    agentModels: async ({ provider }: { provider: "codex" | "claude" }) =>
      ok({
        provider,
        models:
          provider === "claude"
            ? [
                { id: "opus", label: "Opus" },
                { id: "sonnet", label: "Sonnet" },
              ]
            : [{ id: "gpt-5", label: "GPT-5" }],
        source: "aliases",
      }),
    workspaceContentGet: async () =>
      ok({
        workspaceId: WORKSPACE,
        brief: "# Brief",
        journal: JOURNAL,
        files: [
          {
            name: "BRIEF.md",
            path: "BRIEF.md",
            kind: "file",
            mutable: false,
            immutableReason: "Daedalus regenerates it",
          },
          {
            name: "JOURNAL.md",
            path: "JOURNAL.md",
            kind: "file",
            mutable: false,
            immutableReason: "Daedalus regenerates it",
          },
        ],
        // Two repositories with the snapshot's worktrees under the first, so
        // the inspector's repositories section has rows to measure.
        repositories: [
          {
            id: "repo",
            workspaceId: WORKSPACE,
            name: "daedalus",
            canonicalPath: "/tmp/daedalus/repos/repo.git",
            access: "write",
            libraryRepositoryId: "repo",
            referencePath: "/tmp/deadalus/repos/daedalus",
            baseBranch: "main",
            baseCommit: "a".repeat(40),
            fetchedAt: ago(30),
            createdAt: ago(600),
            status: "ready",
            statusError: null,
            gitStatus: { state: "clean", changedFiles: 0, ahead: 0, behind: 0 },
          },
          {
            id: "repo-hive",
            workspaceId: WORKSPACE,
            name: "hive",
            canonicalPath: "/tmp/daedalus/repos/repo-hive.git",
            access: "write",
            libraryRepositoryId: "repo-hive",
            referencePath: "/tmp/deadalus/repos/hive",
            baseBranch: "main",
            baseCommit: "b".repeat(40),
            fetchedAt: ago(30),
            createdAt: ago(600),
            status: "ready",
            statusError: null,
            gitStatus: {
              state: "behind",
              changedFiles: 0,
              ahead: 0,
              behind: 3,
            },
          },
        ],
        worktrees: snapshot.worktrees,
      }),
    workspaceDirectoryList: async () => ok([]),
    taskTimeline: record("taskTimeline", ({ id }: { id: string }) =>
      ok(timelineFor(id)),
    ),
    taskCreate: record(
      "taskCreate",
      (params: { workspace: string; title: string }) => {
        const number = Math.max(...snapshot.tasks.map((t) => t.number)) + 1;
        const created = task(number, params.title, "todo", {
          description: "",
          createdAt: new Date().toISOString(),
        });
        snapshot.tasks.push(created);
        announce();
        return ok(created);
      },
    ),
    taskSetStatus: record(
      "taskSetStatus",
      (params: { id: string; status: TaskDto["status"] }) => {
        const target = snapshot.tasks.find((item) => item.id === params.id)!;
        target.status = params.status;
        target.completedAt =
          params.status === "done" ? new Date().toISOString() : null;
        announce();
        return ok(target);
      },
    ),
    workspaceUpdate: record(
      "workspaceUpdate",
      (params: Record<string, unknown> & { reference: string }) => {
        const { reference: _reference, ...changes } = params;
        Object.assign(snapshot.workspaces[0]!, changes);
        announce();
        return ok(snapshot.workspaces[0]!);
      },
    ),
    agentSpawn: record(
      "agentSpawn",
      (params: {
        taskId?: string;
        provider?: "claude" | "codex";
        draftBrief?: boolean;
      }) => {
        const target = snapshot.tasks.find((item) => item.id === params.taskId);
        const id = `s-new-${window.__boardCalls.length}`;
        const created = session(id, target?.number ?? 0, params.provider!, {
          startedAt: new Date().toISOString(),
        });
        snapshot.agents.unshift(created);
        snapshot.sessionActivity.push({
          sessionId: id,
          activity: "working",
          detail: "Reading BRIEF.md",
          since: new Date().toISOString(),
          observedAt: new Date().toISOString(),
          source: "hook",
        });
        // What the core does when the workspace setting is on.
        if (
          target &&
          !params.draftBrief &&
          snapshot.workspaces[0]!.startSetsInProgress &&
          (target.status === "todo" || target.status === "blocked")
        )
          target.status = "in_progress";
        announce();
        return ok(created);
      },
    ),
    agentSend: record("agentSend", (params: { id: string; text: string }) =>
      ok(snapshot.agents.find((item) => item.id === params.id)!),
    ),
    sessionWorktreeOpen: record(
      "sessionWorktreeOpen",
      (params: { session: string; repository: string }) =>
        ok({ path: `/tmp/${params.session}`, openedWith: "VS Code" }),
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

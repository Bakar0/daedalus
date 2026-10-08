/**
 * A page for looking at the World view without a host: two workspaces of
 * agents whose activity changes every few seconds, the way snapshots would.
 * `?theme=light` shows the light appearance, and `?hour=21.5` pins the sky
 * to that local time. `window.__world` reports what rendered, for a check to
 * read.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentActivityDto,
  AgentSessionDto,
  SessionAttentionDto,
  SessionWorktreeDto,
  ShippedPullRequestDto,
  TaskDto,
  WorkspaceDto,
} from "@daedalus/protocol";
import WorldView from "./world/WorldView";
import { buildWorldModel } from "./world/world-model";
import { setSkyClock } from "./world/themes/labyrinth-sky";
import "./styles.css";

declare global {
  interface Window {
    __world: { opened: string[]; ready: boolean; errors: string[] };
  }
}
window.__world = { opened: [], ready: false, errors: [] };
const pinnedHour = Number(new URLSearchParams(location.search).get("hour"));
if (
  new URLSearchParams(location.search).has("hour") &&
  Number.isFinite(pinnedHour)
)
  setSkyClock(() => pinnedHour);
window.addEventListener("error", (event) =>
  window.__world.errors.push(event.message),
);

const at = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const workspace = (id: string, name: string): WorkspaceDto => ({
  id,
  slug: id,
  name,
  path: `/tmp/${id}`,
  createdAt: at(600),
  updatedAt: at(600),
  archivedAt: null,
  available: true,
  position: 0,
  startSetsInProgress: true,
  autoHandoffPercent: null,
  defaultProvider: null,
  defaultModel: null,
  defaultClaudeAccount: null,
  defaultCodexAccount: null,
});

const session = (
  id: string,
  workspaceId: string,
  name: string,
  provider: "claude" | "codex",
  taskId: string | null = null,
): AgentSessionDto => ({
  id,
  workspaceId,
  taskId,
  name,
  provider,
  kind: "agent",
  tmuxSession: `daedalus_${id}`,
  command: provider,
  args: [],
  workingDirectory: "/tmp",
  status: "running",
  exitCode: null,
  startedAt: at(90),
  endedAt: null,
  providerSessionId: null,
  account: null,
  teamId: null,
  teamHandle: null,
  archivedAt: null,
  resumeCount: 0,
  lostReason: null,
  handoffRequestedAt: null,
  position: 0,
  pinnedAt: null,
  color: null,
});

const task = (id: string, number: number, title: string): TaskDto => ({
  id,
  workspaceId: "deadalus",
  number,
  title,
  description: "",
  status: "in_progress",
  priority: "normal",
  createdAt: at(600),
  updatedAt: at(600),
  completedAt: null,
  briefUpdatedAt: null,
});

const workspaces = [
  workspace("deadalus", "deadalus"),
  workspace("atlas", "atlas"),
];
const sessions = [
  session("a1", "deadalus", "World view", "claude", "t44"),
  session("a2", "deadalus", "Board polish", "codex", "t25"),
  session("a3", "deadalus", "Release notes", "claude"),
  session("a4", "deadalus", "Hook tests", "claude"),
  session("a5", "atlas", "API client", "codex"),
  session("a6", "atlas", "Migrations", "claude"),
  { ...session("a7", "atlas", "Old spike", "claude"), status: "lost" as const },
];
const tasks = [
  task("t44", 44, "All workspace 2d game world"),
  task("t25", 25, "Board lanes"),
];

type Beat = [AgentActivityDto["activity"], string | null];
const SCRIPT: Record<string, Beat[]> = {
  a1: [
    ["working", "Read(world-engine.ts)"],
    ["working", "Edit(office.ts)"],
    ["working", "Bash(bun test)"],
  ],
  a2: [
    ["needs_permission", "Bash(git push)"],
    ["needs_permission", "Bash(git push)"],
    ["working", "Bash(git push)"],
  ],
  // Web work for two beats running: long enough to go up to the Observatory.
  a3: [
    ["working", "WebFetch(https://pixijs.com)"],
    ["working", "WebSearch(pixi graphics)"],
    ["done", null],
  ],
  a4: [
    ["working", "Task(Explore hooks)"],
    ["error", "overloaded_error"],
    ["working", "TodoWrite"],
  ],
  a5: [
    ["working", "exec_command(cargo build)"],
    ["needs_input", "Which branch?"],
    ["needs_input", "Which branch?"],
  ],
  // Pushing, then ending its turn with a summary, which pops over it.
  a6: [
    ["working", "Bash(git push origin main)"],
    ["working", "Bash(gh pr create)"],
    ["idle", "Opened the migration PR; CI is green."],
  ],
};

/**
 * Branches on their way out. "World view" walks one branch through every
 * stage, a beat each; "API client" has a draft waiting and "Migrations" an
 * open pull request.
 */
const STAGES: Array<
  Pick<SessionWorktreeDto, "gitStatus" | "pullRequest" | "landed">
> = [
  {
    gitStatus: {
      state: "ahead",
      changedFiles: 0,
      ahead: 2,
      behind: 0,
      unpushed: 2,
    },
  },
  {
    gitStatus: {
      state: "ahead",
      changedFiles: 0,
      ahead: 2,
      behind: 0,
      unpushed: 0,
    },
  },
  {
    gitStatus: {
      state: "ahead",
      changedFiles: 0,
      ahead: 3,
      behind: 0,
      unpushed: 0,
    },
    pullRequest: {
      number: 512,
      url: "https://github.com/o/r/pull/512",
      state: "OPEN",
      isDraft: true,
    },
  },
  {
    gitStatus: {
      state: "ahead",
      changedFiles: 0,
      ahead: 3,
      behind: 0,
      unpushed: 0,
    },
    pullRequest: {
      number: 512,
      url: "https://github.com/o/r/pull/512",
      state: "OPEN",
      isDraft: false,
    },
  },
  {
    gitStatus: { state: "clean", changedFiles: 0, ahead: 0, behind: 0 },
    pullRequest: {
      number: 512,
      url: "https://github.com/o/r/pull/512",
      state: "MERGED",
      isDraft: false,
    },
    landed: true,
  },
];

const worktree = (
  sessionId: string,
  stage: (typeof STAGES)[number],
): SessionWorktreeDto => ({
  sessionId,
  repositoryId: "r",
  path: `/tmp/worktrees/${sessionId}`,
  branchName: `daedalus/${sessionId}`,
  createdAt: at(120),
  ...stage,
});

/**
 * What each workspace has finished: "deadalus" has `?wins=N` of them (27 by
 * default, a marble room), some with merged pull requests, and "atlas" four.
 */
const wins = Number(new URLSearchParams(location.search).get("wins") ?? 27);
const doneTasks: TaskDto[] = [
  ...Array.from({ length: wins }, (_, index) => ({
    ...task(`d${index}`, 100 + index, `Finished thing ${index + 1}`),
    status: "done" as const,
    completedAt: at(60 * (wins - index)),
  })),
  ...Array.from({ length: 4 }, (_, index) => ({
    ...task(`e${index}`, 200 + index, `Atlas thing ${index + 1}`),
    workspaceId: "atlas",
    status: "done" as const,
    completedAt: at(90 * (4 - index)),
  })),
];
const shipped: ShippedPullRequestDto[] = doneTasks
  .filter((_, index) => index % 3 === 0)
  .map((item) => ({
    url: `https://github.com/o/r/pull/${item.number + 300}`,
    workspaceId: item.workspaceId,
    sessionId: null,
    taskId: item.id,
    repositoryId: null,
    number: item.number + 300,
    title: item.title,
    branchName: `b${item.number}`,
    mergedAt: item.completedAt!,
  }));

function Page() {
  const [beat, setBeat] = useState(0);
  const appearance =
    new URLSearchParams(location.search).get("theme") === "light"
      ? "light"
      : "dark";
  useEffect(() => {
    const timer = setInterval(() => setBeat((value) => value + 1), 3500);
    window.__world.ready = true;
    return () => clearInterval(timer);
  }, []);
  const activity = new Map<string, AgentActivityDto>();
  const attention = new Map<string, SessionAttentionDto>();
  for (const [id, beats] of Object.entries(SCRIPT)) {
    const [value, detail] = beats[beat % beats.length]!;
    activity.set(id, {
      sessionId: id,
      activity: value,
      detail,
      since: at(3),
      observedAt: at(0),
      source: "hook",
    });
    if (value === "needs_permission" || value === "needs_input")
      attention.set(id, {
        sessionId: id,
        workspaceId: sessions.find((item) => item.id === id)!.workspaceId,
        reasons: [
          {
            id: `${id}-r`,
            text:
              value === "needs_input"
                ? "Which branch should I base this on?"
                : "Approve: git push origin main",
            raisedAt: at(4),
            source: "hook",
          },
        ],
        raisedAt: at(4),
        updatedAt: at(4),
      });
  }
  // From the second beat a new session starts, so it flies out of the
  // workshop, and "Release notes" finishes, so it flies back in.
  const live = [
    ...sessions.filter((item) => beat < 2 || item.id !== "a3"),
    ...(beat >= 1 ? [session("a8", "atlas", "New arrival", "claude")] : []),
  ];
  const model = buildWorldModel({
    workspaces,
    sessions: live,
    tasks: [...tasks, ...doneTasks],
    shipped,
    now: Date.now(),
    activity,
    attention,
    worktrees: [
      worktree("a1", STAGES[beat % STAGES.length]!),
      worktree("a5", STAGES[2]!),
      worktree("a6", {
        ...STAGES[3]!,
        pullRequest: { ...STAGES[3]!.pullRequest!, number: 498 },
      }),
    ],
    telemetry: new Map([
      [
        "a1",
        {
          sessionId: "a1",
          model: "claude-opus-5-5",
          context: { usedTokens: 90_000, usedPercent: 45 },
          observedAt: at(0),
        },
      ],
      // Sweating, and nearly out: black smoke.
      [
        "a4",
        {
          sessionId: "a4",
          context: { usedTokens: 120_000, usedPercent: 62 },
          observedAt: at(0),
        },
      ],
      [
        "a6",
        {
          sessionId: "a6",
          context: { usedTokens: 176_000, usedPercent: 88 },
          observedAt: at(0),
        },
      ],
    ]),
  });
  return (
    <div
      className="app"
      data-theme={appearance}
      style={{ display: "flex", padding: 20 }}
    >
      <WorldView
        appearance={appearance}
        model={model}
        now={Date.now()}
        preview
        onOpenSession={(id) => window.__world.opened.push(id)}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);

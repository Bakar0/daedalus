import { describe, expect, test } from "vitest";
import type {
  AgentActivityDto,
  AgentSessionDto,
  SessionWorktreeDto,
  TaskDto,
} from "@daedalus/protocol";
import { laneFor } from "./board-lanes";
import {
  taskActions,
  type BoardLaunch,
  type TaskActionInputs,
} from "./task-actions";

const task = (number: number, overrides: Partial<TaskDto> = {}): TaskDto => ({
  id: `task-${number}`,
  workspaceId: "w",
  number,
  title: `Task ${number}`,
  description: "A brief.",
  status: "todo",
  priority: "normal",
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  completedAt: null,
  briefUpdatedAt: null,
  ...overrides,
});

const session = (
  id: string,
  taskId: string | null,
  overrides: Partial<AgentSessionDto> = {},
): AgentSessionDto => ({
  id,
  workspaceId: "w",
  taskId,
  name: id,
  provider: "claude",
  kind: "agent",
  tmuxSession: `daedalus_${id}`,
  command: "claude",
  args: [],
  workingDirectory: "/tmp",
  status: "running",
  exitCode: null,
  startedAt: "2026-09-23T10:00:00.000Z",
  endedAt: null,
  providerSessionId: null,
  archivedAt: null,
  resumeCount: 0,
  lostReason: null,
  handoffRequestedAt: null,
  position: 0,
  ...overrides,
});

const working = (sessionId: string): AgentActivityDto => ({
  sessionId,
  activity: "working",
  detail: null,
  since: "2026-09-23T10:05:00.000Z",
  observedAt: "2026-09-23T10:05:00.000Z",
  source: "hook",
});

const worktree = (
  sessionId: string,
  ahead: number,
  pullRequest?: SessionWorktreeDto["pullRequest"],
): SessionWorktreeDto => ({
  sessionId,
  repositoryId: "r",
  path: `/tmp/worktrees/${sessionId}/repo`,
  branchName: `daedalus/${sessionId}`,
  createdAt: "2026-09-23T10:00:00.000Z",
  gitStatus: {
    state: ahead ? "ahead" : "clean",
    changedFiles: 0,
    ahead,
    behind: 0,
  },
  ...(pullRequest ? { pullRequest } : {}),
});

const inputs = (parts: {
  tasks?: TaskDto[];
  sessions?: AgentSessionDto[];
  activity?: AgentActivityDto[];
  worktrees?: SessionWorktreeDto[];
  launches?: BoardLaunch[];
  providers?: TaskActionInputs["availableProviders"];
}): TaskActionInputs => ({
  sessions: parts.sessions ?? [],
  activity: new Map(
    (parts.activity ?? []).map((item) => [item.sessionId, item]),
  ),
  attention: new Map(),
  worktrees: parts.worktrees ?? [],
  launches: parts.launches ?? [],
  availableProviders: parts.providers ?? ["claude", "codex"],
  tasksById: new Map((parts.tasks ?? []).map((item) => [item.id, item])),
});

/** Derives the lane the way the board does, then the actions. */
const actionsFor = (target: TaskDto, given: TaskActionInputs) =>
  taskActions(target, laneFor(target, given), given);

describe("taskActions", () => {
  test("a queued task with nothing running offers Start", () => {
    const actions = actionsFor(task(1), inputs({}));
    expect(actions.lane).toBe("queued");
    expect(actions.startable).toBe(true);
    expect(actions.starting).toBe(false);
    expect(actions.canDraftBrief).toBe(false);
    expect(actions.offersSecondOpinion).toBe(false);
    expect(actions.canMarkDone).toBe(false);
    expect(actions.liveSession).toBeUndefined();
  });

  test("an empty brief on a startable task offers Draft brief", () => {
    expect(
      actionsFor(task(1, { description: "  " }), inputs({})).canDraftBrief,
    ).toBe(true);
    expect(
      actionsFor(task(1, { description: "  ", status: "blocked" }), inputs({}))
        .canDraftBrief,
    ).toBe(true);
  });

  test("a parked task can be started too", () => {
    const actions = actionsFor(task(1, { status: "blocked" }), inputs({}));
    expect(actions.lane).toBe("parked");
    expect(actions.startable).toBe(true);
  });

  test("a Start in flight blocks another and stays listed", () => {
    const launch: BoardLaunch = {
      key: "l1",
      taskId: "task-1",
      tool: "claude",
      status: "starting",
    };
    const actions = actionsFor(task(1), inputs({ launches: [launch] }));
    expect(actions.starting).toBe(true);
    expect(actions.launches).toEqual([launch]);
  });

  test("a launch whose session row exists is the row's to show", () => {
    const target = task(1, { status: "in_progress" });
    const live = session("s1", "task-1");
    const actions = actionsFor(
      target,
      inputs({
        sessions: [live],
        activity: [working("s1")],
        launches: [
          {
            key: "l1",
            taskId: "task-1",
            tool: "claude",
            status: "starting",
            sessionId: "s1",
          },
          {
            key: "l2",
            taskId: "task-1",
            tool: "codex",
            status: "error",
            error: "no tmux",
            sessionId: "s1",
          },
          { key: "l3", taskId: "task-2", tool: "claude", status: "starting" },
        ],
      }),
    );
    // The failed one stays so its Dismiss can be clicked; the other task's
    // launch is not this task's business.
    expect(actions.launches.map((launch) => launch.key)).toEqual(["l2"]);
  });

  test("a running agent removes Start and offers the other provider", () => {
    const target = task(1, { status: "in_progress" });
    const live = session("s1", "task-1", { provider: "codex" });
    const actions = actionsFor(
      target,
      inputs({ sessions: [live], activity: [working("s1")] }),
    );
    expect(actions.lane).toBe("running");
    expect(actions.startable).toBe(false);
    expect(actions.liveAgent).toBe(true);
    expect(actions.liveSession?.id).toBe("s1");
    expect(actions.lastAgent?.id).toBe("s1");
    expect(actions.otherProvider).toBe("claude");
    expect(actions.offersSecondOpinion).toBe(true);
    expect(actions.canSetInProgress).toBe(false);
  });

  test("a second opinion needs a second provider installed", () => {
    const target = task(1, { status: "in_progress" });
    const live = session("s1", "task-1");
    const actions = actionsFor(
      target,
      inputs({
        sessions: [live],
        activity: [working("s1")],
        providers: ["claude"],
      }),
    );
    expect(actions.offersSecondOpinion).toBe(true);
    expect(actions.otherProvider).toBeUndefined();
  });

  test("a running agent on a to-do task offers Set in progress", () => {
    const live = session("s1", "task-1");
    const actions = actionsFor(
      task(1),
      inputs({ sessions: [live], activity: [working("s1")] }),
    );
    expect(actions.lane).toBe("running");
    expect(actions.canSetInProgress).toBe(true);
    expect(actions.startable).toBe(false);
  });

  test("the last agent is the most recently started, live or not", () => {
    const target = task(1, { status: "in_progress" });
    const first = session("s1", "task-1", {
      status: "exited",
      startedAt: "2026-09-23T09:00:00.000Z",
    });
    const second = session("s2", "task-1", {
      provider: "codex",
      startedAt: "2026-09-23T11:00:00.000Z",
    });
    const actions = actionsFor(
      target,
      inputs({ sessions: [second, first], activity: [working("s2")] }),
    );
    expect(actions.lastAgent?.id).toBe("s2");
    expect(actions.liveSession?.id).toBe("s2");
    expect(actions.otherProvider).toBe("claude");
  });

  test("a task ready for review offers Mark done, its worktree and PR", () => {
    const target = task(1, { status: "in_progress" });
    const stopped = session("s1", "task-1", { status: "exited" });
    const pullRequest = {
      number: 7,
      url: "https://example.test/pull/7",
      state: "OPEN" as const,
      isDraft: false,
    };
    const actions = actionsFor(
      target,
      inputs({
        sessions: [stopped],
        worktrees: [worktree("s1", 3, pullRequest)],
      }),
    );
    expect(actions.lane).toBe("review");
    expect(actions.canMarkDone).toBe(true);
    expect(actions.reviewWorktree?.sessionId).toBe("s1");
    expect(actions.reviewPullRequest).toEqual(pullRequest);
    expect(actions.offersSecondOpinion).toBe(true);
    expect(actions.liveSession).toBeUndefined();
    expect(actions.startable).toBe(false);
  });

  test("an archived session's worktree still counts as output", () => {
    const target = task(1, { status: "done" });
    const archived = session("s1", "task-1", {
      status: "exited",
      archivedAt: "2026-09-23T12:00:00.000Z",
    });
    const actions = actionsFor(
      target,
      inputs({ sessions: [archived], worktrees: [worktree("s1", 2)] }),
    );
    expect(actions.lane).toBe("done");
    expect(actions.linked).toEqual([]);
    expect(actions.reviewWorktree?.sessionId).toBe("s1");
    expect(actions.canMarkDone).toBe(false);
    expect(actions.startable).toBe(false);
  });

  test("Start warns about unfinished hard dependencies", () => {
    const blocker = task(2);
    const target = task(1, {
      references: [{ taskId: "task-2", number: 2, hard: true }],
    });
    const actions = actionsFor(target, inputs({ tasks: [blocker, target] }));
    expect(actions.startable).toBe(true);
    expect(actions.waitingOn.map((item) => item.id)).toEqual(["task-2"]);
  });
});

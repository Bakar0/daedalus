import { describe, expect, test } from "vitest";
import type {
  AgentActivityDto,
  AgentSessionDto,
  SessionWorktreeDto,
  TaskDto,
} from "@daedalus/protocol";
import { laneFor } from "./board-lanes";
import {
  cardButtons,
  startItemActions,
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
  account: null,
  teamId: null,
  teamHandle: null,
  spawnedBy: null,
  archivedAt: null,
  resumeCount: 0,
  lostReason: null,
  rebirthRequestedAt: null,
  position: 0,
  pinnedAt: null,
  color: null,
  autoRebirthPercent: null,
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

  test("an empty brief on a startable task offers Refine", () => {
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

  test("an in-progress task whose agent was archived can be restarted, finished or parked", () => {
    const target = task(1, { status: "in_progress" });
    const archived = session("s1", "task-1", {
      status: "exited",
      endedAt: "2026-09-23T11:00:00.000Z",
      archivedAt: "2026-09-23T12:00:00.000Z",
    });
    const actions = actionsFor(target, inputs({ sessions: [archived] }));
    expect(actions.lane).toBe("running");
    expect(actions.linked).toEqual([]);
    expect(actions.noAgent).toBe(true);
    expect(actions.agentEndedAt).toBe("2026-09-23T12:00:00.000Z");
    expect(actions.startable).toBe(true);
    expect(actions.canMarkDone).toBe(true);
    expect(actions.canPark).toBe(true);
    expect(actions.offersSecondOpinion).toBe(false);
  });

  test("an in-progress task whose agent exited counts as having no agent", () => {
    const target = task(1, { status: "in_progress" });
    const stopped = session("s1", "task-1", {
      status: "exited",
      endedAt: "2026-09-23T11:00:00.000Z",
    });
    const actions = actionsFor(target, inputs({ sessions: [stopped] }));
    expect(actions.noAgent).toBe(true);
    expect(actions.agentEndedAt).toBe("2026-09-23T11:00:00.000Z");
    expect(actions.startable).toBe(true);
  });

  test("an in-progress task set by hand with no agent ever has no end time", () => {
    const actions = actionsFor(task(1, { status: "in_progress" }), inputs({}));
    expect(actions.noAgent).toBe(true);
    expect(actions.agentEndedAt).toBeUndefined();
  });

  test("an idle live agent is still an agent", () => {
    const target = task(1, { status: "in_progress" });
    const idle = session("s1", "task-1");
    const actions = actionsFor(target, inputs({ sessions: [idle] }));
    expect(actions.lane).toBe("running");
    expect(actions.noAgent).toBe(false);
    expect(actions.startable).toBe(false);
    expect(actions.canMarkDone).toBe(false);
    expect(actions.canPark).toBe(false);
  });

  test("a task ready for review is not a no-agent task", () => {
    const target = task(1, { status: "in_progress" });
    const stopped = session("s1", "task-1", { status: "exited" });
    const actions = actionsFor(
      target,
      inputs({ sessions: [stopped], worktrees: [worktree("s1", 1)] }),
    );
    expect(actions.lane).toBe("review");
    expect(actions.noAgent).toBe(false);
    expect(actions.canPark).toBe(false);
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

describe("cardButtons", () => {
  const flags = (
    parts: Partial<Parameters<typeof cardButtons>[2]> = {},
  ): Parameters<typeof cardButtons>[2] => ({
    canPark: false,
    noAgent: false,
    offersSecondOpinion: false,
    startable: false,
    ...parts,
  });

  test("Park and Mark done are offered only where the card draws them", () => {
    // canPark and noAgent alone do not make the action row appear.
    expect(
      cardButtons(task(1), "needs_me", flags({ canPark: true, noAgent: true })),
    ).toEqual({
      actionRow: false,
      markDone: false,
      park: false,
      setInProgress: false,
    });
    expect(
      cardButtons(
        task(1),
        "queued",
        flags({ startable: true, canPark: true, noAgent: true }),
      ),
    ).toMatchObject({ actionRow: true, markDone: true, park: true });
  });

  test("review always offers Mark done; a running todo offers Set in progress", () => {
    expect(cardButtons(task(1), "review", flags()).markDone).toBe(true);
    expect(cardButtons(task(1), "running", flags())).toMatchObject({
      actionRow: true,
      setInProgress: true,
    });
    expect(
      cardButtons(task(1, { status: "in_progress" }), "running", flags())
        .setInProgress,
    ).toBe(false);
  });
});

describe("startItemActions", () => {
  const deps = (confirm: boolean) => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        tmuxAvailable: true,
        confirmStart: async (item: TaskDto, waiting: TaskDto[]) => {
          calls.push(`confirm:${item.number}:${waiting.length}`);
          return confirm;
        },
        onStart: (item: TaskDto) => calls.push(`start:${item.number}`),
        onStartWith: (item: TaskDto) => calls.push(`with:${item.number}`),
        onDraftBrief: (item: TaskDto) => calls.push(`refine:${item.number}`),
      },
    };
  };
  const ready = { startable: true, starting: false, waitingOn: [] };

  test("offers nothing for a task that cannot start", () => {
    expect(
      startItemActions(
        task(1),
        { ...ready, startable: false },
        deps(true).deps,
      ),
    ).toEqual([]);
  });

  test("asks about unfinished dependencies before starting, and starts only on yes", async () => {
    const blocker = task(2);
    const yes = deps(true);
    const actions = startItemActions(
      task(1),
      { ...ready, waitingOn: [blocker] },
      yes.deps,
    );
    expect(actions[0]?.label).toBe("Start, waiting on #2");
    actions[0]?.run();
    actions[1]?.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(yes.calls).toEqual([
      "confirm:1:1",
      "confirm:1:1",
      "start:1",
      "with:1",
    ]);
    const no = deps(false);
    startItemActions(
      task(1),
      { ...ready, waitingOn: [blocker] },
      no.deps,
    )[0]?.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(no.calls).toEqual(["confirm:1:1"]);
  });

  test("waits while a Start is in flight or tmux is missing", () => {
    for (const disabled of [
      startItemActions(task(1), { ...ready, starting: true }, deps(true).deps),
      startItemActions(task(1), ready, {
        ...deps(true).deps,
        tmuxAvailable: false,
      }),
    ])
      expect(disabled.every((action) => action.disabled)).toBe(true);
  });

  test("offers Refine only for a task with no brief", () => {
    const ids = (description: string) =>
      startItemActions(task(1, { description }), ready, deps(true).deps).map(
        (action) => action.id,
      );
    expect(ids("A brief.")).toEqual(["start", "start-with"]);
    expect(ids("  ")).toEqual(["start", "start-with", "refine"]);
  });
});

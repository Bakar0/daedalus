import { describe, expect, test } from "vitest";
import type {
  AgentActivityDto,
  AgentSessionDto,
  SessionAttentionDto,
  SessionWorktreeDto,
  TaskDto,
} from "@daedalus/protocol";
import {
  boardLanes,
  laneFor,
  taskRelations,
  taskWaitingSince,
  unfinishedDependencies,
  type LaneInputs,
} from "./board-lanes";

const task = (number: number, overrides: Partial<TaskDto> = {}): TaskDto => ({
  id: `task-${number}`,
  workspaceId: "w",
  number,
  title: `Task ${number}`,
  description: "",
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
  position: 0,
  ...overrides,
});

const activity = (
  sessionId: string,
  value: AgentActivityDto["activity"],
  since = "2026-09-23T10:05:00.000Z",
): AgentActivityDto => ({
  sessionId,
  activity: value,
  detail: null,
  since,
  observedAt: since,
  source: "hook",
});

const worktree = (sessionId: string, ahead: number): SessionWorktreeDto => ({
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
    ...(ahead ? { filesAhead: ahead * 2 } : {}),
  },
});

const inputs = (parts: {
  sessions?: AgentSessionDto[];
  activity?: AgentActivityDto[];
  attention?: SessionAttentionDto[];
  worktrees?: SessionWorktreeDto[];
}): LaneInputs => ({
  sessions: parts.sessions ?? [],
  activity: new Map(
    (parts.activity ?? []).map((item) => [item.sessionId, item]),
  ),
  attention: new Map(
    (parts.attention ?? []).map((item) => [item.sessionId, item]),
  ),
  worktrees: parts.worktrees ?? [],
});

const badge = (sessionId: string, raisedAt: string): SessionAttentionDto => ({
  sessionId,
  workspaceId: "w",
  reasons: [
    { id: `${sessionId}-r`, text: "Which branch?", raisedAt, source: "agent" },
  ],
  raisedAt,
  updatedAt: raisedAt,
});

describe("laneFor", () => {
  test("status alone decides when no agent is involved", () => {
    const none = inputs({});
    expect(laneFor(task(1), none)).toBe("queued");
    expect(laneFor(task(1, { status: "blocked" }), none)).toBe("parked");
    expect(laneFor(task(1, { status: "done" }), none)).toBe("done");
    expect(laneFor(task(1, { status: "cancelled" }), none)).toBe("done");
  });

  test("a session waiting on the user wins over everything", () => {
    const t = task(1, { status: "done" });
    for (const value of ["needs_permission", "needs_input", "error"] as const)
      expect(
        laneFor(
          t,
          inputs({
            sessions: [session("a", t.id), session("b", t.id)],
            activity: [activity("a", "working"), activity("b", value)],
          }),
        ),
      ).toBe("needs_me");
  });

  test("an open attention reason counts even when the activity says working", () => {
    const t = task(1, { status: "in_progress" });
    expect(
      laneFor(
        t,
        inputs({
          sessions: [session("a", t.id)],
          activity: [activity("a", "working")],
          attention: [badge("a", "2026-09-23T10:01:00.000Z")],
        }),
      ),
    ).toBe("needs_me");
  });

  test("a stale reading on a stopped session does not pin the task", () => {
    const t = task(1, { status: "in_progress" });
    expect(
      laneFor(
        t,
        inputs({
          sessions: [session("a", t.id, { status: "exited" })],
          activity: [activity("a", "needs_input")],
        }),
      ),
    ).toBe("running");
  });

  test("a todo task with a working agent is Running, not Queued", () => {
    // #13 sat in `todo` for its whole session. The stale status shows as
    // stale instead of deciding where the card goes.
    const t = task(13);
    expect(
      laneFor(
        t,
        inputs({
          sessions: [session("a", t.id)],
          activity: [activity("a", "working")],
        }),
      ),
    ).toBe("running");
    expect(
      laneFor(
        t,
        inputs({ sessions: [session("a", t.id, { status: "starting" })] }),
      ),
    ).toBe("running");
  });

  test("Ready for review needs in_progress, quiet agents and commits ahead", () => {
    const t = task(20, { status: "in_progress" });
    const quiet = {
      sessions: [session("a", t.id)],
      activity: [activity("a", "idle")],
    };
    expect(
      laneFor(t, inputs({ ...quiet, worktrees: [worktree("a", 4)] })),
    ).toBe("review");
    // Nothing committed yet: started, so Running, sorted after real work.
    expect(
      laneFor(t, inputs({ ...quiet, worktrees: [worktree("a", 0)] })),
    ).toBe("running");
    // Still working: not ready, whatever the worktree says.
    expect(
      laneFor(
        t,
        inputs({
          sessions: [session("a", t.id)],
          activity: [activity("a", "working")],
          worktrees: [worktree("a", 4)],
        }),
      ),
    ).toBe("running");
    // A todo task with commits is not in review; review is for started work.
    expect(
      laneFor(
        task(21),
        inputs({
          sessions: [session("b", "task-21", { status: "exited" })],
          worktrees: [worktree("b", 2)],
        }),
      ),
    ).toBe("queued");
  });

  test("an archived session's worktree is still the task's output", () => {
    const t = task(20, { status: "in_progress" });
    expect(
      laneFor(
        t,
        inputs({
          sessions: [
            session("a", t.id, {
              status: "exited",
              archivedAt: "2026-09-23T11:00:00.000Z",
            }),
          ],
          worktrees: [worktree("a", 3)],
        }),
      ),
    ).toBe("review");
  });

  test("archived sessions never make a task need the user", () => {
    const t = task(1, { status: "in_progress" });
    expect(
      laneFor(
        t,
        inputs({
          sessions: [
            session("a", t.id, { archivedAt: "2026-09-23T11:00:00.000Z" }),
          ],
          activity: [activity("a", "needs_input")],
          attention: [badge("a", "2026-09-23T10:00:00.000Z")],
        }),
      ),
    ).toBe("running");
  });

  test("a terminal linked to a todo task does not start it", () => {
    const t = task(1);
    expect(
      laneFor(
        t,
        inputs({ sessions: [session("a", t.id, { kind: "terminal" })] }),
      ),
    ).toBe("queued");
  });
});

describe("boardLanes", () => {
  test("returns every lane in board order, empty ones included", () => {
    expect(boardLanes([], inputs({})).map((group) => group.lane)).toEqual([
      "needs_me",
      "review",
      "running",
      "queued",
      "parked",
      "done",
    ]);
  });

  test("Needs me puts the longest wait first", () => {
    const early = task(1, { status: "in_progress" });
    const late = task(2, { status: "in_progress" });
    const state = inputs({
      sessions: [session("a", late.id), session("b", early.id)],
      attention: [
        badge("a", "2026-09-23T10:30:00.000Z"),
        badge("b", "2026-09-23T10:01:00.000Z"),
      ],
    });
    expect(taskWaitingSince(early, state)).toBe("2026-09-23T10:01:00.000Z");
    const needsMe = boardLanes([late, early], state)[0]!;
    expect(needsMe.tasks.map((item) => item.number)).toEqual([1, 2]);
  });

  test("Ready for review puts the most recent stop first", () => {
    const older = task(1, { status: "in_progress" });
    const newer = task(2, { status: "in_progress" });
    const review = boardLanes(
      [older, newer],
      inputs({
        sessions: [
          session("a", older.id, {
            status: "exited",
            endedAt: "2026-09-23T09:00:00.000Z",
          }),
          session("b", newer.id),
        ],
        activity: [activity("b", "idle", "2026-09-23T12:00:00.000Z")],
        worktrees: [worktree("a", 1), worktree("b", 1)],
      }),
    ).find((group) => group.lane === "review")!;
    expect(review.tasks.map((item) => item.number)).toEqual([2, 1]);
  });

  test("Running puts real work above started-but-idle, then recency", () => {
    const idle = task(1, { status: "in_progress" });
    const old = task(2);
    const fresh = task(3);
    const running = boardLanes(
      [idle, old, fresh],
      inputs({
        sessions: [
          session("i", idle.id),
          session("o", old.id),
          session("f", fresh.id),
        ],
        activity: [
          activity("i", "idle", "2026-09-23T12:30:00.000Z"),
          activity("o", "working", "2026-09-23T11:00:00.000Z"),
          activity("f", "working", "2026-09-23T12:00:00.000Z"),
        ],
      }),
    ).find((group) => group.lane === "running")!;
    expect(running.tasks.map((item) => item.number)).toEqual([3, 2, 1]);
  });

  test("Queued sorts by priority then position, and sinks waiting tasks", () => {
    const low = task(1, { priority: "low" });
    const normal = task(2);
    const high = task(3, { priority: "high" });
    const waitingHigh = task(4, { priority: "high" });
    const queued = boardLanes([low, normal, high, waitingHigh], inputs({}), {
      isWaiting: (item) => item.id === waitingHigh.id,
    }).find((group) => group.lane === "queued")!;
    expect(queued.tasks.map((item) => item.number)).toEqual([3, 2, 1, 4]);
  });

  test("Done shows the most recently completed first", () => {
    const first = task(1, {
      status: "done",
      completedAt: "2026-09-20T00:00:00.000Z",
    });
    const second = task(2, {
      status: "done",
      completedAt: "2026-09-22T00:00:00.000Z",
    });
    const done = boardLanes([first, second], inputs({})).at(-1)!;
    expect(done.tasks.map((item) => item.number)).toEqual([2, 1]);
  });
});

describe("dependencies", () => {
  const ten = task(10, { status: "done" });
  const twentyThree = task(23, { status: "in_progress" });
  const cancelled = task(5, { status: "cancelled" });
  const eleven = task(11, {
    references: [
      { taskId: ten.id, number: 10, hard: true },
      { taskId: twentyThree.id, number: 23, hard: true },
      { taskId: cancelled.id, number: 5, hard: true },
      { taskId: "task-21", number: 21, hard: false },
    ],
  });
  const twentyOne = task(21);
  const all = [ten, eleven, twentyThree, cancelled, twentyOne];

  test("only done finishes a hard dependency; mentions never block", () => {
    expect(
      unfinishedDependencies(eleven, new Map(all.map((t) => [t.id, t]))).map(
        (item) => item.number,
      ),
    ).toEqual([23, 5]);
  });

  test("the reverse direction comes from every other brief", () => {
    expect(taskRelations(ten, all)).toMatchObject({
      dependsOn: [],
      unblocks: [{ number: 11 }],
    });
    expect(taskRelations(twentyOne, all).mentionedBy).toMatchObject([
      { number: 11 },
    ]);
    const forward = taskRelations(eleven, all);
    expect(forward.dependsOn.map((item) => item.number)).toEqual([10, 23, 5]);
    expect(forward.mentions.map((item) => item.number)).toEqual([21]);
  });
});

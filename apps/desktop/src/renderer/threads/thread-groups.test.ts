import { describe, expect, test } from "vitest";
import type {
  AgentActivityDto,
  AgentSessionDto,
  PullRequestRefDto,
  SessionAttentionDto,
  SessionWorktreeDto,
} from "@daedalus/protocol";
import {
  classifyThread,
  THREAD_IDLE_RESOLVE_MS,
  homeThreadRows,
  threadRows,
  waitingCount,
  type ThreadInputs,
} from "./thread-groups";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const minutesAgo = (minutes: number) =>
  new Date(NOW - minutes * 60_000).toISOString();

function session(
  id: string,
  changes: Partial<AgentSessionDto> = {},
): AgentSessionDto {
  return {
    id,
    workspaceId: "checkout",
    taskId: null,
    name: id,
    provider: "claude",
    kind: "agent",
    tmuxSession: `t-${id}`,
    command: "claude",
    args: [],
    workingDirectory: `/w/${id}`,
    status: "running",
    exitCode: null,
    startedAt: minutesAgo(60),
    endedAt: null,
    providerSessionId: null,
    archivedAt: null,
    resumeCount: 0,
    lostReason: null,
    rebirthRequestedAt: null,
    position: 0,
    pinnedAt: null,
    color: null,
    autoRebirthPercent: null,
    account: null,
    teamId: "team",
    teamHandle: id,
    spawnedBy: null,
    ...changes,
  };
}

const activity = (
  sessionId: string,
  state: AgentActivityDto["activity"],
  detail: string | null = null,
  since = minutesAgo(5),
): AgentActivityDto => ({
  sessionId,
  activity: state,
  detail,
  since,
  observedAt: since,
  source: "hook",
});

const pr = (changes: Partial<PullRequestRefDto>): PullRequestRefDto => ({
  number: 412,
  url: "https://github.com/o/r/pull/412",
  state: "OPEN",
  isDraft: false,
  ...changes,
});

const tree = (
  sessionId: string,
  pullRequest?: PullRequestRefDto,
  landed = false,
): SessionWorktreeDto => ({
  sessionId,
  repositoryId: "repo",
  path: `/w/${sessionId}/repo`,
  branchName: "b",
  createdAt: minutesAgo(60),
  ...(pullRequest ? { pullRequest } : {}),
  ...(landed ? { landed } : {}),
});

const attention = (sessionId: string, text: string): SessionAttentionDto => ({
  sessionId,
  workspaceId: "checkout",
  reasons: [{ id: "r", text, raisedAt: minutesAgo(9), source: "agent" }],
  raisedAt: minutesAgo(9),
  updatedAt: minutesAgo(9),
});

function inputs(changes: Partial<ThreadInputs> = {}): ThreadInputs {
  return {
    agents: [],
    teams: [{ id: "team", leadId: "lead", name: "Main agent", goal: null }],
    workspaces: [
      {
        id: "checkout",
        name: "Checkout",
      } as ThreadInputs["workspaces"][number],
    ],
    activity: new Map(),
    attention: new Map(),
    worktrees: [],
    now: NOW,
    ...changes,
  };
}

describe("thread groups", () => {
  test("an open pull request is ready for review; an approved one is landing", () => {
    const review = classifyThread(
      session("crash"),
      inputs({
        activity: new Map([["crash", activity("crash", "done")]]),
        worktrees: [tree("crash", pr({ checks: "passing" }))],
      }),
    );
    expect(review).toMatchObject({
      group: "review",
      detail: "PR #412 open · checks passed · ready for your review",
    });
    expect(
      classifyThread(
        session("flag"),
        inputs({
          worktrees: [tree("flag", pr({ number: 405, review: "approved" }))],
        }),
      ),
    ).toMatchObject({ group: "landing", detail: "PR #405 approved" });
  });

  test("a question, a permission or a failure waits on you, in its own words", () => {
    expect(
      classifyThread(
        session("storage"),
        inputs({
          attention: new Map([
            ["storage", attention("storage", "Index on (user_id)?")],
          ]),
        }),
      ),
    ).toMatchObject({ group: "waiting", detail: "Index on (user_id)?" });
    expect(
      classifyThread(
        session("migrate"),
        inputs({
          activity: new Map([
            ["migrate", activity("migrate", "needs_permission")],
          ]),
        }),
      ),
    ).toMatchObject({ group: "waiting", detail: "Needs your permission" });
    expect(
      classifyThread(
        session("docs"),
        inputs({
          activity: new Map([
            ["docs", activity("docs", "error", "API rate limit")],
          ]),
        }),
      ),
    ).toMatchObject({
      group: "waiting",
      detail: "Failed: API rate limit",
      failed: true,
    });
    expect(
      classifyThread(
        session("gone", { status: "lost", lostReason: "claude exited" }),
        inputs(),
      ),
    ).toMatchObject({
      group: "waiting",
      detail: "Stopped: claude exited",
      failed: true,
    });
  });

  test("waiting on you comes before an open pull request", () => {
    expect(
      classifyThread(
        session("crash"),
        inputs({
          activity: new Map([["crash", activity("crash", "needs_input")]]),
          worktrees: [tree("crash", pr({}))],
        }),
      ).group,
    ).toBe("waiting");
  });

  test("working says what it is doing; a quiet one is idle", () => {
    expect(
      classifyThread(
        session("endpoints"),
        inputs({
          activity: new Map([
            [
              "endpoints",
              activity("endpoints", "working", "Editing cart/routes.ts"),
            ],
          ]),
        }),
      ),
    ).toMatchObject({ group: "working", detail: "Editing cart/routes.ts" });
    expect(
      classifyThread(
        session("audit"),
        inputs({
          activity: new Map([["audit", activity("audit", "done")]]),
        }),
      ),
    ).toMatchObject({ group: "idle", detail: "Finished its turn" });
  });

  test("resolved: marked done, merged, archived, or idle a week", () => {
    expect(
      classifyThread(
        session("typo", { resolvedAt: minutesAgo(1) }),
        inputs({
          activity: new Map([["typo", activity("typo", "needs_input")]]),
        }),
      ),
    ).toMatchObject({ group: "resolved", detail: "Marked done" });
    expect(
      classifyThread(
        session("typo"),
        inputs({ worktrees: [tree("typo", pr({ state: "MERGED" }))] }),
      ),
    ).toMatchObject({ group: "resolved", detail: "PR #412 merged" });
    expect(
      classifyThread(session("old", { archivedAt: minutesAgo(3) }), inputs())
        .group,
    ).toBe("resolved");
    const weekAgo = new Date(NOW - THREAD_IDLE_RESOLVE_MS).toISOString();
    expect(
      classifyThread(
        session("stale"),
        inputs({
          activity: new Map([
            ["stale", activity("stale", "idle", null, weekAgo)],
          ]),
        }),
      ),
    ).toMatchObject({ group: "resolved", detail: "Idle for a week" });
  });

  test("rows are the lead's members only, in group order, with the dot count", () => {
    const rows = threadRows(
      "lead",
      inputs({
        agents: [
          session("lead", { teamId: null }),
          session("other-team", { teamId: "elsewhere" }),
          session("audit"),
          session("storage"),
          session("crash"),
        ],
        attention: new Map([["storage", attention("storage", "Which index?")]]),
        worktrees: [tree("crash", pr({}))],
      }),
    );
    expect(rows.map((row) => [row.title, row.group])).toEqual([
      ["storage", "waiting"],
      ["crash", "review"],
      ["audit", "idle"],
    ]);
    expect(rows[0]!.workspaceName).toBe("Checkout");
    expect(waitingCount(rows)).toBe(1);
    expect(threadRows("nobody", inputs())).toEqual([]);
  });

  test("Home lists what the main agent tracks, or every session, in the same groups", () => {
    const home = inputs({
      teams: [],
      agents: [
        session("main", { workspaceId: "home", teamId: null }),
        session("discount", { teamId: null, teamHandle: null }),
        session("stale", { teamId: null, teamHandle: null }),
        session("refactor", { teamId: null, teamHandle: null }),
        session("old", { teamId: null, archivedAt: minutesAgo(30) }),
        session("shell", { teamId: null, kind: "terminal" }),
        session("home-note", { workspaceId: "home", teamId: null }),
      ],
      attention: new Map([["stale", attention("stale", "Full cart?")]]),
      worktrees: [tree("discount", pr({}))],
      tracks: [
        {
          trackerSessionId: "main",
          trackedSessionId: "discount",
          createdAt: "",
        },
        { trackerSessionId: "main", trackedSessionId: "stale", createdAt: "" },
        { trackerSessionId: "main", trackedSessionId: "old", createdAt: "" },
        {
          trackerSessionId: "other",
          trackedSessionId: "refactor",
          createdAt: "",
        },
      ],
    });
    const tracked = homeThreadRows("main", "home", "tracked", home);
    expect(tracked.map((row) => [row.title, row.group, row.tracked])).toEqual([
      ["stale", "waiting", true],
      ["discount", "review", true],
      ["old", "resolved", true],
    ]);
    expect(waitingCount(tracked)).toBe(1);

    // All: live agent sessions anywhere but Home, the main agent left out.
    const all = homeThreadRows("main", "home", "all", home);
    expect(all.map((row) => [row.title, row.tracked]).sort()).toEqual([
      ["discount", true],
      ["refactor", false],
      ["stale", true],
    ]);
    // The dot follows what the filter shows.
    expect(
      waitingCount(
        homeThreadRows("main", "home", "all", {
          ...home,
          attention: new Map([
            ["refactor", attention("refactor", "Which file?")],
          ]),
        }),
      ),
    ).toBe(1);
    expect(
      waitingCount(
        homeThreadRows("main", "home", "tracked", {
          ...home,
          attention: new Map([
            ["refactor", attention("refactor", "Which file?")],
          ]),
        }),
      ),
    ).toBe(0);
  });
});

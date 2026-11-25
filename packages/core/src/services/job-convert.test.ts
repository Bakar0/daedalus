import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { WorkflowRun, WorkflowRunStep } from "../domain";
import { replayJobs, type Job } from "../domain/jobs";
import { runMigrations } from "../repositories/migrations";
import { SqliteRepositories } from "../repositories/sqlite";
import { convertedJobs, convertOldWork, type OldSession } from "./job-convert";

const step = (
  name: string,
  state: WorkflowRunStep["state"],
  more: Partial<WorkflowRunStep> = {},
): WorkflowRunStep => ({
  name,
  description: "",
  gate: null,
  state,
  startedAt: state === "pending" ? null : "2026-11-24T10:01:00Z",
  endedAt: state === "done" ? "2026-11-24T10:05:00Z" : null,
  approvedAt: null,
  waitingSessionId: null,
  plan: null,
  note: state === "done" ? `${name} came out` : null,
  dynamic: false,
  ...more,
});

const run = (more: Partial<WorkflowRun>): WorkflowRun => ({
  id: "run",
  workspaceId: "w1",
  sessionId: "lead",
  workflow: "feature",
  steps: [],
  groups: [],
  dynamic: false,
  modified: false,
  loopTo: null,
  until: "",
  iteration: 1,
  history: [],
  endNote: null,
  startedAt: "2026-11-24T10:00:00Z",
  updatedAt: "2026-11-24T10:10:00Z",
  endedAt: null,
  ...more,
});

const session = (id: string, more: Partial<OldSession> = {}): OldSession => ({
  id,
  workspaceId: "w1",
  name: id,
  startedAt: "2026-11-24T09:59:00Z",
  spawnedBy: null,
  over: false,
  ...more,
});

test("a lead's run, its worker's task and a finished loop become one tree", () => {
  let ids = 0;
  const trees = convertedJobs({
    sessions: [
      session("lead"),
      session("worker", {
        spawnedBy: "lead",
        startedAt: "2026-11-24T10:06:00Z",
        over: true,
      }),
    ],
    runs: [
      run({
        steps: [
          step("plan", "done"),
          step("build", "active"),
          step("release/review", "pending"),
          step("release/ship", "pending", { gate: "result" }),
        ],
        groups: [
          {
            id: "release",
            workflow: "release",
            loopTo: null,
            until: "",
            iteration: 1,
            lastRound: null,
          },
        ],
      }),
      run({
        id: "run-2",
        sessionId: "worker",
        workflow: "rounds",
        startedAt: "2026-11-24T10:06:30Z",
        endedAt: "2026-11-24T10:09:00Z",
        loopTo: "look",
        iteration: 2,
        steps: [
          step("look", "done"),
          step("fix", "skipped", { note: "Clean" }),
        ],
        history: [
          {
            iteration: 1,
            name: "look",
            state: "done",
            startedAt: "2026-11-24T10:06:40Z",
            endedAt: "2026-11-24T10:07:00Z",
            note: "Found one",
          },
          {
            iteration: 1,
            name: "fix",
            state: "done",
            startedAt: "2026-11-24T10:07:00Z",
            endedAt: "2026-11-24T10:08:00Z",
            note: "Fixed one",
          },
        ],
      }),
    ],
    links: [
      {
        planPath: "/w/plans/checkout.plan.md",
        taskId: "api",
        sessionId: "worker",
        createdAt: "2026-11-24T10:06:00Z",
      },
    ],
    results: [
      {
        planPath: "/w/plans/checkout.plan.md",
        taskId: "api",
        sessionId: "worker",
        result: "API is in",
        submittedAt: "2026-11-24T10:09:30Z",
      },
    ],
    taskTitle: () => "Cart API",
    newId: () => `id-${String(++ids).padStart(3, "0")}`,
  });
  expect(trees).toHaveLength(1);
  const tree = replayJobs(trees[0]!.events.map((item) => item.event));
  const named = (name: string): Job =>
    [...tree.jobs.values()].find((job) => job.name === name)!;
  const root = [...tree.jobs.values()].find((job) => !job.parentId)!;
  expect(root).toMatchObject({ title: "lead", state: "running" });
  expect(named("feature")).toMatchObject({ state: "running", auto: true });
  expect(named("plan")).toMatchObject({
    state: "done",
    result: "plan came out",
  });
  expect(named("build")).toMatchObject({ state: "running", needs: ["plan"] });
  expect(named("release")).toMatchObject({
    state: "pending",
    needs: ["build"],
    source: "workflow:release",
  });
  expect(named("ship")).toMatchObject({
    parentId: named("release").id,
    gate: "result",
    needs: ["review"],
  });
  // The worker's task hangs under the step its starter was on.
  expect(named("api")).toMatchObject({
    parentId: named("build").id,
    title: "Cart API",
    state: "done",
    result: "API is in",
    sessionId: "worker",
    source: "plan:/w/plans/checkout.plan.md#api",
  });
  expect(named("rounds")).toMatchObject({
    parentId: named("api").id,
    state: "done",
    loop: { to: "look", until: null },
  });
  expect(named("look")).toMatchObject({ round: 2, state: "done" });
  expect(named("fix")).toMatchObject({
    round: 2,
    state: "skipped",
    why: "Clean",
  });
  expect(trees[0]!.sessionJobs).toEqual(
    new Map([
      ["lead", root.id],
      ["worker", named("api").id],
    ]),
  );
});

test("the old tables are converted once, backed up first, and dropped", async () => {
  const home = await mkdtemp(join(tmpdir(), "daedalus-convert-"));
  try {
    const databasePath = join(home, "state.db");
    await runMigrations(
      databasePath,
      join(import.meta.dir, "../../../../migrations"),
    );
    const repositories = new SqliteRepositories(databasePath);
    const now = "2026-11-24T10:00:00.000Z";
    repositories.database
      .query(
        "INSERT INTO workspaces (id, slug, name, path, created_at, updated_at) VALUES ('w1', 'demo', 'Demo', ?, ?, ?)",
      )
      .run(join(home, "demo"), now, now);
    // A run from before gates were renamed, whose session is gone.
    repositories.database
      .query(
        `INSERT INTO workflow_runs (id, workspace_id, session_id, workflow, steps, started_at, updated_at)
         VALUES ('run', 'w1', NULL, 'quick', ?, ?, ?)`,
      )
      .run(
        JSON.stringify([
          { ...step("do", "done"), plan: undefined },
          { ...step("deploy", "waiting"), gate: "user", note: "Shipped" },
        ]),
        now,
        now,
      );
    const outcome = await convertOldWork(
      repositories,
      databasePath,
      () => new Date(now),
    );
    expect(outcome).toMatchObject({ ran: true, trees: 1, error: null });
    expect(await readdir(home)).toContain("state.db.before-jobs-2026-11-24");
    const { tree } = repositories.jobs.all();
    const states = Object.fromEntries(
      [...tree.jobs.values()].map((job) => [job.name, job.state]),
    );
    // Its session is gone, so the run is over: what was open is skipped.
    expect(states).toEqual({
      work: "done",
      quick: "done",
      do: "done",
      deploy: "skipped",
    });
    expect(
      [...tree.jobs.values()].find((job) => job.name === "deploy")?.gate,
    ).toBe("result");
    expect(
      repositories.database
        .query(
          "SELECT name FROM sqlite_master WHERE name IN ('workflow_runs', 'plan_task_links', 'plan_task_results', 'plan_task_claims')",
        )
        .all(),
    ).toEqual([]);
    expect(await convertOldWork(repositories, databasePath)).toMatchObject({
      ran: false,
    });
    repositories.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

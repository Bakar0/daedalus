import { describe, expect, test } from "vitest";
import { buildFactoryRows, type FactorySession } from "./factory";
import { replayJobs, type JobEvent, type JobSpec } from "./jobs";

const spec = (
  id: string,
  parentId: string | null,
  position: number,
  more: Partial<JobSpec> = {},
): JobSpec => ({
  id,
  parentId,
  name: id,
  title: id,
  instructions: "",
  needs: [],
  gives: [],
  gate: null,
  runner: { kind: "inline" },
  auto: false,
  loop: null,
  source: null,
  position,
  ...more,
});

const session = (
  id: string,
  more: Partial<FactorySession> = {},
): FactorySession => ({
  id,
  name: id,
  teamHandle: null,
  status: "running",
  archivedAt: null,
  startedAt: "2026-11-24T10:00:00Z",
  activity: "working",
  needsAttention: false,
  ...more,
});

const added = (job: JobSpec): JobEvent => ({
  jobId: job.id,
  type: "added",
  spec: job,
});

const events: JobEvent[] = [
  added(
    spec("root", null, 0, {
      title: "Checkout v2",
      runner: { kind: "session", sessionId: "lead" },
    }),
  ),
  { jobId: "root", type: "started", sessionId: "lead" },
  added(spec("feature", "root", 0, { auto: true, source: "workflow:feature" })),
  { jobId: "feature", type: "started", sessionId: "lead" },
  added(spec("plan", "feature", 0, { source: "step:feature/plan" })),
  added(spec("build", "feature", 1, { needs: ["plan"] })),
  added(spec("ship", "feature", 2, { needs: ["build"] })),
  { jobId: "plan", type: "started", sessionId: "lead" },
  {
    jobId: "plan",
    type: "output",
    name: "plan",
    kind: "file",
    value: "plans/checkout.plan.md",
  },
  { jobId: "plan", type: "done", result: "Plan with 2 tasks" },
  { jobId: "build", type: "started", sessionId: "lead" },
  added(
    spec("api", "build", 0, {
      title: "Cart API",
      runner: { kind: "agent" },
      source: "plan:/w/plans/checkout.plan.md#api",
    }),
  ),
  added(
    spec("web", "build", 1, {
      title: "Cart page",
      needs: ["api"],
      runner: { kind: "agent" },
      source: "plan:/w/plans/checkout.plan.md#web",
    }),
  ),
  { jobId: "api", type: "started", sessionId: "worker" },
  { jobId: "api", type: "held", reason: "hold", why: "Which database?" },
  added(
    spec("old", null, 0, { runner: { kind: "session", sessionId: "gone" } }),
  ),
  { jobId: "old", type: "started", sessionId: "gone" },
  { jobId: "old", type: "done", result: "Done long ago" },
];

const rows = (sessions: FactorySession[]) =>
  buildFactoryRows({
    tree: replayJobs(events),
    times: (id) => ({
      createdAt: id === "old" ? "2026-11-01" : "2026-11-24",
      startedAt: id === "build" ? "2026-11-24T11:00:00Z" : null,
    }),
    sessions,
    threads: (job) => (job.id === "api" ? 1 : 0),
  });

describe("buildFactoryRows", () => {
  test("draws a piece of work as the tree its jobs form", () => {
    const [row, ...rest] = rows([session("lead"), session("worker")]);
    // Work that is over, with no agent left, is not a row.
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      sessionId: "lead",
      title: "Checkout v2",
      state: "waiting",
      waiting: 1,
    });
    expect(row?.level.owner?.sessionId).toBe("lead");
    // The workflow around the steps is not a box of its own: its steps
    // are the row's.
    expect(row?.level.title).toBe("Checkout v2");
    const [plan, build, ship] = row!.level.blocks;
    expect([plan?.column, build?.column, ship?.column]).toEqual([0, 1, 2]);
    expect(build?.needs).toEqual(["plan"]);
    expect(plan).toMatchObject({
      state: "done",
      detail: "Plan with 2 tasks",
      result: "Plan with 2 tasks\nplan = plans/checkout.plan.md",
    });
    expect(build).toMatchObject({
      state: "doing",
      startedAt: "2026-11-24T11:00:00Z",
    });
    expect(ship?.state).toBe("todo");
    const [api, web] = build!.inside!.blocks;
    expect(api).toMatchObject({
      kind: "task",
      title: "Cart API",
      state: "waiting",
      detail: "Which database?",
      threads: 1,
    });
    expect(api?.owner).toMatchObject({ sessionId: "worker", handle: "worker" });
    expect(web).toMatchObject({ kind: "task", state: "todo", needs: ["api"] });
    expect(web?.owner).toBeNull();
  });

  test("shows a block whose agent asks as waiting, and an agent that is gone", () => {
    const tree = replayJobs([
      ...events,
      { jobId: "api", type: "released", answer: "SQLite" },
    ]);
    const build = (sessions: FactorySession[]) =>
      buildFactoryRows({
        tree,
        times: () => ({ createdAt: "", startedAt: null }),
        sessions,
      })[0]!.level.blocks[1]!.inside!.blocks[0]!;
    expect(
      build([session("lead"), session("worker", { needsAttention: true })])
        .state,
    ).toBe("waiting");
    expect(build([session("lead")]).owner).toMatchObject({
      sessionId: null,
      state: "none",
    });
  });
});

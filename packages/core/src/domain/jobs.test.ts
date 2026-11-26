import { describe, expect, test } from "bun:test";
import {
  currentJob,
  decide,
  emptyJobTree,
  evolve,
  jobBrief,
  jobOutputProblem,
  replayJobs,
  type JobCommand,
  type JobEvent,
  type JobSpec,
  type JobTree,
} from "./jobs";

const spec = (id: string, over: Partial<JobSpec> = {}): JobSpec => ({
  id,
  parentId: null,
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
  position: 0,
  ...over,
});

const lead = { kind: "session", sessionId: "s-lead" } as const;
const user = { kind: "user" } as const;

/** Runs commands in order, keeping every event; a refusal throws. */
function run(...commands: JobCommand[]): { tree: JobTree; log: JobEvent[] } {
  const tree = emptyJobTree();
  const log: JobEvent[] = [];
  for (const command of commands) {
    const decision = decide(tree, command);
    if (!decision.ok) throw new Error(decision.reason);
    for (const event of decision.events) evolve(tree, event);
    log.push(...decision.events);
  }
  return { tree, log };
}

const refusal = (tree: JobTree, command: JobCommand): string => {
  const decision = decide(tree, command);
  return decision.ok ? "" : decision.reason;
};

const states = (tree: JobTree) =>
  Object.fromEntries([...tree.jobs].map(([id, job]) => [id, job.state]));

/** A root the lead runs, with three steps in a row under it. */
const steps = (over: Record<string, Partial<JobSpec>> = {}): JobCommand[] => [
  {
    type: "add",
    specs: [spec("root", { runner: { kind: "session", sessionId: "s-lead" } })],
  },
  { type: "start", jobId: "root", sessionId: "s-lead" },
  {
    type: "add",
    specs: [
      spec("design", { parentId: "root", position: 0, ...over.design }),
      spec("build", {
        parentId: "root",
        position: 1,
        needs: ["design"],
        ...over.build,
      }),
      spec("ship", {
        parentId: "root",
        position: 2,
        needs: ["build"],
        ...over.ship,
      }),
    ],
  },
];

const done = (
  jobId: string,
  outputs: { name: string; value: string }[] = [],
  actor: JobCommand & { type: "done" } extends { actor: infer A }
    ? A
    : never = lead,
): JobCommand => ({
  type: "done",
  jobId,
  actor,
  result: `${jobId} is done`,
  outputs,
});

describe("a job becomes ready when what it needs is finished", () => {
  test("the first step of a session's job starts by itself, the rest wait", () => {
    const { tree } = run(...steps());
    expect(states(tree)).toEqual({
      root: "running",
      design: "running",
      build: "pending",
      ship: "pending",
    });
    expect(tree.jobs.get("design")!.sessionId).toBe("s-lead");
  });

  test("finishing a step starts the next one in the same session", () => {
    const { tree, log } = run(...steps(), done("design"));
    expect(states(tree)).toMatchObject({ design: "done", build: "running" });
    expect(log.slice(-3).map((event) => [event.jobId, event.type])).toEqual([
      ["design", "done"],
      ["build", "ready"],
      ["build", "started"],
    ]);
  });

  test("a step cannot be finished before the one it needs", () => {
    const { tree } = run(...steps());
    expect(refusal(tree, done("build"))).toContain("pending, not running");
  });

  test("a skipped job counts as finished for what needs it", () => {
    const { tree } = run(...steps(), {
      type: "skip",
      jobId: "design",
      actor: lead,
      why: "Nothing to design",
    });
    expect(states(tree)).toMatchObject({ design: "skipped", build: "running" });
  });

  test("jobs that need the same one are ready together; a session does them in order", () => {
    const { tree } = run(
      ...steps({ ship: { needs: ["design"] } }),
      done("design"),
    );
    expect(states(tree)).toMatchObject({ build: "running", ship: "ready" });
  });

  test("a job for a new agent waits ready until the engine starts it", () => {
    const { tree } = run(
      ...steps({ build: { runner: { kind: "agent" } } }),
      done("design"),
    );
    expect(states(tree)).toMatchObject({ build: "ready", ship: "pending" });
    const started = run(
      ...steps({ build: { runner: { kind: "agent" } } }),
      done("design"),
      { type: "start", jobId: "build", sessionId: "s-worker" },
    ).tree;
    expect(started.jobs.get("build")).toMatchObject({
      state: "running",
      sessionId: "s-worker",
    });
  });
});

describe("a job is done only with what it declared", () => {
  const giving = steps({
    design: { gives: [{ name: "plan", kind: "file" }] },
    build: {
      gives: [
        { name: "branch", kind: "commit" },
        { name: "tests", kind: "number" },
      ],
    },
  });

  test("a missing output refuses the command and names it", () => {
    const { tree } = run(...giving);
    expect(refusal(tree, done("design"))).toContain("plan (file)");
  });

  test("an output of the wrong kind is refused", () => {
    const { tree } = run(
      ...giving,
      done("design", [{ name: "plan", value: "plans/x.plan.md" }]),
    );
    expect(
      refusal(
        tree,
        done("build", [
          { name: "branch", value: "team/api" },
          { name: "tests", value: "many" },
        ]),
      ),
    ).toContain('"tests" (number) is not a number');
  });

  test("outputs are kept, and the next job's brief carries them", () => {
    const { tree } = run(
      ...giving,
      done("design", [{ name: "plan", value: "plans/x.plan.md" }]),
    );
    expect(tree.jobs.get("design")!.outputs).toEqual([
      { name: "plan", kind: "file", value: "plans/x.plan.md" },
    ]);
    const brief = jobBrief(tree, "build");
    expect(brief).toContain('Your job: build (2 of 3 in "root").');
    expect(brief).toContain("plan = plans/x.plan.md");
    expect(brief).toContain("result = design is done");
    expect(brief).toContain("--out branch=<commit> --out tests=<number>");
  });

  test("a result is always required", () => {
    const { tree } = run(...steps());
    expect(
      refusal(tree, {
        type: "done",
        jobId: "design",
        actor: lead,
        result: " ",
        outputs: [],
      }),
    ).toContain("its result");
  });

  test("another session cannot finish the job", () => {
    const { tree } = run(...steps());
    expect(
      refusal(tree, done("design", [], { kind: "session", sessionId: "s-x" })),
    ).toContain("another session's job");
  });

  test("the text of a value is checked per kind", () => {
    expect(jobOutputProblem("url", "not a url")).toBe("is not a URL");
    expect(jobOutputProblem("url", "https://github.com/a/b/pull/1")).toBeNull();
    expect(jobOutputProblem("flag", "yes")).toBe("is neither true nor false");
    expect(jobOutputProblem("text", "  ")).toBe("is empty");
  });
});

describe("a job with children is done when they are", () => {
  const withTeam: JobCommand[] = [
    ...steps(),
    done("design"),
    {
      type: "add",
      specs: [
        spec("api", { parentId: "build", runner: { kind: "agent" } }),
        spec("web", {
          parentId: "build",
          position: 1,
          runner: { kind: "agent" },
        }),
      ],
    },
    { type: "start", jobId: "api", sessionId: "s-api" },
    { type: "start", jobId: "web", sessionId: "s-web" },
  ];
  const api = { kind: "session", sessionId: "s-api" } as const;
  const web = { kind: "session", sessionId: "s-web" } as const;

  test("the parent is refused while a child still runs, and names it", () => {
    const { tree } = run(...withTeam, done("api", [], api));
    expect(refusal(tree, done("build"))).toContain("web (running)");
  });

  test("the parent is done once every child is done or skipped", () => {
    const { tree } = run(
      ...withTeam,
      done("api", [], api),
      { type: "skip", jobId: "web", actor: lead, why: "Not needed" },
      done("build"),
    );
    expect(states(tree)).toMatchObject({ build: "done", ship: "running" });
  });

  test("a failed child holds the parent until it is retried or skipped", () => {
    const failed = run(...withTeam, done("api", [], api), {
      type: "fail",
      jobId: "web",
      actor: { kind: "engine" },
      why: "Its agent is gone.",
    }).tree;
    expect(refusal(failed, done("build"))).toContain("web (failed)");
    const retried = run(
      ...withTeam,
      done("api", [], api),
      { type: "fail", jobId: "web", actor: { kind: "engine" }, why: "gone" },
      { type: "redo", jobId: "web", actor: lead, why: "Try again" },
    ).tree;
    // A new agent is started for it: the old one is gone.
    expect(retried.jobs.get("web")).toMatchObject({
      state: "ready",
      round: 2,
      sessionId: null,
    });
  });

  test("a child is added only under a job that is not finished", () => {
    const { tree } = run(...steps(), done("design"));
    expect(
      refusal(tree, {
        type: "add",
        specs: [spec("late", { parentId: "design" })],
      }),
    ).toContain("Redo it before adding");
  });

  test("the session's current job is the deepest it runs", () => {
    const { tree } = run(...withTeam);
    expect(currentJob(tree, "s-lead")?.id).toBe("build");
    expect(currentJob(tree, "s-api")?.id).toBe("api");
    expect(currentJob(tree, "s-nobody")).toBeUndefined();
  });

  test("children of a parent that is not running wait", () => {
    const { tree } = run(...steps(), {
      type: "add",
      specs: [spec("early", { parentId: "ship" })],
    });
    expect(states(tree)).toMatchObject({ ship: "pending", early: "pending" });
  });
});

describe("gates and holds wait for the user", () => {
  test("a result gate holds the job after its runner finished it, and the next waits", () => {
    const { tree } = run(
      ...steps({ design: { gate: "result" } }),
      done("design"),
    );
    expect(tree.jobs.get("design")).toMatchObject({
      state: "held",
      hold: { reason: "result-gate" },
      result: "design is done",
    });
    expect(states(tree)).toMatchObject({ build: "pending" });
    expect(
      refusal(tree, { type: "release", jobId: "design", actor: lead }),
    ).toContain("Only the user");
  });

  test("the user's approval finishes it and starts the next", () => {
    const { tree } = run(
      ...steps({ design: { gate: "result" } }),
      done("design"),
      { type: "release", jobId: "design", actor: user },
    );
    expect(states(tree)).toMatchObject({ design: "done", build: "running" });
  });

  test("a start gate holds the job before it runs", () => {
    const held = run(
      ...steps({ build: { gate: "start" } }),
      done("design"),
    ).tree;
    expect(held.jobs.get("build")).toMatchObject({
      state: "held",
      hold: { reason: "start-gate" },
    });
    const { tree } = run(
      ...steps({ build: { gate: "start" } }),
      done("design"),
      { type: "release", jobId: "build", actor: user },
    );
    expect(states(tree)).toMatchObject({ build: "running" });
  });

  test("a runner holds its job with a reason, and the user's answer lets it go on", () => {
    const { tree, log } = run(
      ...steps(),
      { type: "hold", jobId: "design", actor: lead, why: "Which database?" },
      { type: "release", jobId: "design", actor: user, answer: "SQLite" },
    );
    expect(states(tree)).toMatchObject({ design: "running" });
    expect(log.at(-1)).toMatchObject({ type: "released", answer: "SQLite" });
  });
});

describe("redoing a job reopens what was built on it", () => {
  test("the job and every job that needs it go back, in a new round", () => {
    const { tree } = run(
      ...steps({ design: { gate: "result" } }),
      done("design"),
      { type: "release", jobId: "design", actor: user },
      done("build"),
      { type: "redo", jobId: "design", actor: user, why: "Change the layout" },
    );
    expect(states(tree)).toMatchObject({
      design: "running",
      build: "pending",
      ship: "pending",
    });
    expect(tree.jobs.get("design")).toMatchObject({
      round: 2,
      why: "Change the layout",
      // An approval covers one pass.
      approved: { start: false, result: false },
      outputs: [],
    });
  });

  test("a finished parent is reopened with its child", () => {
    const { tree } = run(
      ...steps(),
      done("design"),
      done("build"),
      done("ship"),
      done("root"),
      { type: "redo", jobId: "build", actor: user, why: "A bug" },
    );
    expect(states(tree)).toMatchObject({
      root: "ready",
      design: "done",
      build: "pending",
      ship: "pending",
    });
  });

  test("work that is still going is not redone", () => {
    const { tree } = run(...steps());
    expect(
      refusal(tree, { type: "redo", jobId: "design", actor: lead, why: "x" }),
    ).toContain("Only finished work");
  });
});

describe("a workflow as one job", () => {
  const flow = (loop: JobSpec["loop"]): JobCommand[] => [
    {
      type: "add",
      specs: [
        spec("root", { runner: { kind: "session", sessionId: "s-lead" } }),
      ],
    },
    { type: "start", jobId: "root", sessionId: "s-lead" },
    {
      type: "add",
      specs: [
        spec("flow", { parentId: "root", auto: !loop, loop }),
        spec("a", { parentId: "flow" }),
        spec("b", { parentId: "flow", position: 1, needs: ["a"] }),
      ],
    },
  ];

  test("it is finished by the engine when its last step is, with that step's result", () => {
    const { tree } = run(...flow(null), done("a"), done("b"));
    expect(tree.jobs.get("flow")).toMatchObject({
      state: "done",
      result: "b is done",
    });
    expect(currentJob(tree, "s-lead")?.id).toBe("root");
  });

  test("a loop goes round when its last step finishes, and ends when the job is finished", () => {
    const round = run(
      ...flow({ to: "a", until: "all green" }),
      done("a"),
      done("b"),
    );
    expect(states(round.tree)).toMatchObject({
      flow: "running",
      a: "running",
      b: "pending",
    });
    expect(round.tree.jobs.get("a")!.round).toBe(2);
    const ended = run(
      ...flow({ to: "a", until: "all green" }),
      done("a"),
      done("b"),
      done("flow"),
    );
    expect(states(ended.tree)).toMatchObject({
      flow: "done",
      a: "skipped",
      b: "skipped",
    });
  });
});

describe("adding jobs", () => {
  test("jobs that need each other are refused", () => {
    expect(
      refusal(emptyJobTree(), {
        type: "add",
        specs: [spec("a", { needs: ["b"] }), spec("b", { needs: ["a"] })],
      }),
    ).toContain("need each other");
  });

  test("two jobs of one parent cannot share a name", () => {
    const { tree } = run(...steps());
    expect(
      refusal(tree, {
        type: "add",
        specs: [spec("x", { parentId: "root", name: "design" })],
      }),
    ).toContain('already has a job named "design"');
  });

  test("a refused command changes nothing", () => {
    const { tree } = run(...steps());
    const before = JSON.stringify([...tree.jobs]);
    decide(tree, done("build"));
    decide(tree, done("design"));
    expect(JSON.stringify([...tree.jobs])).toBe(before);
  });
});

describe("the log is the whole truth", () => {
  test("replaying the events gives the same tree", () => {
    const { tree, log } = run(
      ...steps({ design: { gives: [{ name: "plan", kind: "file" }] } }),
      done("design", [{ name: "plan", value: "plans/x.plan.md" }]),
      { type: "hold", jobId: "build", actor: lead, why: "Stuck" },
    );
    expect([...replayJobs(log).jobs]).toEqual([...tree.jobs]);
  });

  test("a rebirth moves every job of the old session to the new one", () => {
    const { tree } = run(...steps(), {
      type: "move",
      from: "s-lead",
      to: "s-new",
    });
    expect(tree.jobs.get("root")).toMatchObject({
      sessionId: "s-new",
      runner: { kind: "session", sessionId: "s-new" },
    });
    expect(currentJob(tree, "s-new")?.id).toBe("design");
    expect(currentJob(tree, "s-lead")).toBeUndefined();
  });
});

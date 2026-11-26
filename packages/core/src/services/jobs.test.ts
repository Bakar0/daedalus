import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { replayJobs, type Job } from "../domain/jobs";
import { runMigrations } from "../repositories/migrations";
import { SqliteRepositories } from "../repositories/sqlite";
import { JobService, type JobPorts } from "./jobs";

const WORKSPACE = "w1";
const LEAD = "lead";

let home: string;
let repositories: SqliteRepositories;
let service: JobService;
let clock: number;
let ids: number;
let spawned: Parameters<JobPorts["spawn"]>[0][];
let told: { to: string; text: string }[];
let raised: { to: string; message: string }[];
let cleared: string[];
let retired: string[];
let gone: Set<string>;
let archived: Set<string>;
let missing: Set<string>;
let spawn: JobPorts["spawn"];
let roots: Set<string>;

const jobs = (rootId: string): Job[] =>
  [...repositories.jobs.tree(rootId).tree.jobs.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
const named = (rootId: string, name: string): Job => {
  const job = jobs(rootId).find((item) => item.name === name);
  if (!job) throw new Error(`no job named ${name}`);
  return job;
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "daedalus-jobs-"));
  const databasePath = join(home, "state.db");
  await runMigrations(
    databasePath,
    join(import.meta.dir, "../../../../migrations"),
  );
  repositories = new SqliteRepositories(databasePath);
  const now = "2026-11-24T10:00:00.000Z";
  repositories.createWorkspace({
    id: WORKSPACE,
    slug: "demo",
    name: "Demo",
    path: join(home, "demo"),
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    position: 1,
    startSetsInProgress: true,
    autoRebirthPercent: null,
    defaultProvider: null,
    defaultModel: null,
    accountModels: {},
    defaultClaudeAccount: null,
    defaultCodexAccount: null,
  });
  clock = Date.parse(now);
  ids = 0;
  spawned = [];
  told = [];
  raised = [];
  cleared = [];
  retired = [];
  gone = new Set();
  archived = new Set();
  missing = new Set();
  roots = new Set();
  spawn = async (input) => {
    spawned.push(input);
    return input.sessionId;
  };
  service = new JobService(repositories, {
    spawn: (input) => spawn(input),
    tell: (to, text) => {
      told.push({ to, text });
    },
    raise: (to, message) => {
      raised.push({ to, message });
    },
    clear: (to) => {
      cleared.push(to);
    },
    alive: (sessionId) => !gone.has(sessionId),
    kept: (sessionId) => !archived.has(sessionId),
    retire: (sessionId) => {
      retired.push(sessionId);
    },
    verify: (_workspace, _kind, value) =>
      missing.has(value) ? "does not exist" : null,
    newId: () => `id-${String(++ids).padStart(3, "0")}`,
    now: () => new Date(clock).toISOString(),
  });
});

afterEach(async () => {
  // The log alone rebuilds what the tables hold, in every test.
  for (const rootId of roots) {
    const replayed = replayJobs(
      repositories.jobs.events(rootId).map((stored) => stored.event),
    );
    expect(
      [...replayed.jobs.values()].sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(jobs(rootId));
  }
  repositories.close();
  await rm(home, { recursive: true, force: true });
});

async function open(title = "Checkout v2"): Promise<Job> {
  const root = await service.open(WORKSPACE, LEAD, {
    name: "work",
    title,
    instructions: "Build the checkout.",
  });
  roots.add(root.id);
  return root;
}

describe("JobService", () => {
  test("opens a root job that its session runs", async () => {
    const root = await open();
    expect(root.state).toBe("running");
    expect(root.sessionId).toBe(LEAD);
    expect(service.current(LEAD)?.job.id).toBe(root.id);
    expect(service.brief(LEAD)).toContain("Build the checkout.");
    expect(told).toEqual([]);
  });

  test("hands a session its next step when it finishes one", async () => {
    const root = await open();
    await service.add(
      root.id,
      [
        {
          name: "feature",
          auto: true,
          runner: { kind: "inline" },
          children: [
            {
              name: "plan",
              instructions: "Write the plan.",
              gives: [{ name: "plan", kind: "file" }],
              runner: { kind: "inline" },
            },
            {
              name: "build",
              instructions: "Build it.",
              needs: ["plan"],
              runner: { kind: "inline" },
            },
          ],
        },
      ],
      LEAD,
    );
    expect(service.current(LEAD)?.job.name).toBe("plan");

    await expect(
      service.done(LEAD, { result: "Planned" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const handed = await service.done(LEAD, {
      result: "Plan with 4 tasks",
      outputs: [{ name: "plan", value: "plans/checkout.plan.md" }],
    });
    expect(handed.job.state).toBe("done");
    expect(handed.next).toContain("Build it.");
    expect(handed.next).toContain("plan = plans/checkout.plan.md");
    expect(handed.next).toContain("result = Plan with 4 tasks");

    const last = await service.done(LEAD, { result: "Built" });
    expect(last.next).toBeNull();
    expect(named(root.id, "feature").state).toBe("done");
    expect(named(root.id, "feature").result).toBe("Built");
    expect(service.current(LEAD)?.job.id).toBe(root.id);
    // A session is not told what its own command did.
    expect(told).toEqual([]);
  });

  test("refuses a file that does not exist", async () => {
    const root = await open();
    await service.add(
      root.id,
      [
        {
          name: "plan",
          gives: [{ name: "plan", kind: "file" }],
          runner: { kind: "inline" },
        },
      ],
      LEAD,
    );
    missing.add("plans/none.md");
    await expect(
      service.done(LEAD, {
        result: "Planned",
        outputs: [{ name: "plan", value: "plans/none.md" }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(named(root.id, "plan").state).toBe("running");
  });

  test("starts agents for ready jobs, three of one parent at a time", async () => {
    const root = await open();
    await service.add(
      root.id,
      ["a", "b", "c", "d"].map((name) => ({
        name,
        instructions: `Do ${name}`,
      })),
      LEAD,
    );
    expect(spawned.map((input) => input.job.name)).toEqual(["a", "b", "c"]);
    expect(spawned[0]?.parentSessionId).toBe(LEAD);
    expect(spawned[0]?.brief).toContain("Do a");
    expect(named(root.id, "d").state).toBe("ready");

    await expect(
      service.done(LEAD, { result: "All done" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const worker = named(root.id, "a").sessionId!;
    const handed = await service.done(worker, { result: "a is in" });
    expect(handed.next).toBeNull();
    expect(told).toEqual([{ to: LEAD, text: '"a" is done: a is in' }]);
    expect(spawned.map((input) => input.job.name)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("starts a job once, whoever looks", async () => {
    const root = await open();
    await service.add(root.id, [{ name: "a" }], LEAD);
    await Promise.all([service.tick(WORKSPACE), service.tick(WORKSPACE)]);
    expect(spawned).toHaveLength(1);
  });

  test("records the session an agent was really given", async () => {
    const root = await open();
    spawn = async (input) => {
      spawned.push(input);
      return "real-session";
    };
    await service.add(root.id, [{ name: "a" }], LEAD);
    expect(named(root.id, "a").sessionId).toBe("real-session");
    expect(service.current("real-session")?.job.name).toBe("a");
  });

  test("fails a job whose agent does not start, and tells its parent", async () => {
    const root = await open();
    spawn = async () => {
      throw new Error("no tmux");
    };
    await service.add(root.id, [{ name: "a" }], LEAD);
    const job = named(root.id, "a");
    expect(job.state).toBe("failed");
    expect(job.why).toContain("no tmux");
    expect(told[0]?.to).toBe(LEAD);
    expect(told[0]?.text).toContain("daedal job retry a");

    spawn = async (input) => input.sessionId;
    await service.redo(job.id, LEAD, "tmux is back");
    expect(named(root.id, "a").state).toBe("running");
    expect(named(root.id, "a").round).toBe(2);
  });

  test("holds a result for the user and goes on when they approve", async () => {
    const root = await open();
    await service.add(
      root.id,
      [
        { name: "prototype", gate: "result", runner: { kind: "inline" } },
        {
          name: "build",
          needs: ["prototype"],
          instructions: "Build it.",
          runner: { kind: "inline" },
        },
      ],
      LEAD,
    );
    const handed = await service.done(LEAD, { result: "A page with boxes" });
    expect(handed.job.state).toBe("held");
    expect(handed.next).toBeNull();
    expect(raised).toEqual([
      { to: LEAD, message: 'Approve "prototype": A page with boxes' },
    ]);
    expect(service.held(LEAD)?.name).toBe("prototype");
    expect(named(root.id, "build").state).toBe("pending");

    const released = await service.release(handed.job.id, LEAD);
    expect(released.job.state).toBe("done");
    expect(released.next).toContain("Build it.");
    expect(cleared).toEqual([LEAD]);
    expect(told).toEqual([]);
  });

  test("tells a session when the user answers its hold", async () => {
    const root = await open();
    await service.add(root.id, [{ name: "a" }], LEAD);
    const worker = named(root.id, "a").sessionId!;
    await service.hold(worker, "Which database?");
    expect(raised).toEqual([{ to: worker, message: "Which database?" }]);
    expect(told).toEqual([
      { to: LEAD, text: '"a" waits for the user: Which database?' },
    ]);

    await expect(
      service.done(worker, { result: "Guessed" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    told = [];
    const released = await service.release(
      named(root.id, "a").id,
      null,
      "SQLite",
    );
    expect(released.job.state).toBe("running");
    expect(told).toEqual([
      { to: worker, text: 'The user released "a": SQLite' },
    ]);
    expect(cleared).toEqual([worker]);
  });

  test("hands a job of a named session to it", async () => {
    const root = await open();
    await service.add(
      root.id,
      [
        {
          name: "review",
          instructions: "Review the diff.",
          runner: { kind: "session", sessionId: "reviewer" },
        },
      ],
      LEAD,
    );
    expect(named(root.id, "review").sessionId).toBe("reviewer");
    expect(told).toHaveLength(1);
    expect(told[0]?.to).toBe("reviewer");
    expect(told[0]?.text).toContain("Review the diff.");
    expect(spawned).toEqual([]);
  });

  test("finds a job by name from where a session stands", async () => {
    const root = await open();
    await service.add(
      root.id,
      [
        { name: "a", runner: { kind: "inline" } },
        { name: "b", needs: ["a"] },
      ],
      LEAD,
    );
    expect(service.find(LEAD, "b").name).toBe("b");
    expect(service.find(LEAD, root.id).id).toBe(root.id);
    expect(() => service.find(LEAD, "none")).toThrow('no job named "none"');
    const skipped = await service.skip(
      service.find(LEAD, "b").id,
      LEAD,
      "Not needed",
    );
    expect(skipped.state).toBe("skipped");
  });

  test("gives a reborn session its jobs", async () => {
    const root = await open();
    await service.add(
      root.id,
      [{ name: "a", runner: { kind: "inline" } }],
      LEAD,
    );
    service.moveSession(LEAD, "lead-2");
    expect(service.current(LEAD)).toBeUndefined();
    expect(service.current("lead-2")?.job.name).toBe("a");
    expect(service.brief("lead-2")).toContain("Your job: a");
    const handed = await service.done("lead-2", {
      result: "Done after rebirth",
    });
    expect(handed.job.state).toBe("done");
  });

  test("fails the jobs of a session that is gone, after a grace period", async () => {
    const root = await open();
    await service.add(root.id, [{ name: "a" }, { name: "b" }], LEAD);
    const worker = named(root.id, "a").sessionId!;
    gone.add(worker);

    await service.tick(WORKSPACE);
    expect(named(root.id, "a").state).toBe("running");

    clock += 5 * 60_000;
    await service.tick(WORKSPACE);
    expect(named(root.id, "a").state).toBe("failed");
    expect(named(root.id, "a").why).toBe("Its agent is gone.");
    expect(named(root.id, "b").state).toBe("running");
    expect(told.map((item) => item.to)).toEqual([LEAD]);
  });

  test("keeps the jobs of a user's session that stopped, until it is archived", async () => {
    const root = await open();
    await service.add(
      root.id,
      [{ name: "a", runner: { kind: "inline" } }],
      LEAD,
    );
    gone.add(LEAD);
    clock += 5 * 60_000;
    await service.tick(WORKSPACE);
    expect(named(root.id, "a").state).toBe("running");

    archived.add(LEAD);
    await service.tick(WORKSPACE);
    expect(named(root.id, "a").state).toBe("failed");
    expect(named(root.id, "a").why).toBe("Its agent is gone.");
  });

  test("archives an agent whose job is finished", async () => {
    const root = await open();
    await service.add(root.id, [{ name: "a" }, { name: "b" }], LEAD);
    const worker = named(root.id, "a").sessionId!;
    await service.done(worker, { result: "In" });
    await service.tick(WORKSPACE);
    expect(retired).toEqual([worker]);
  });

  test("keeps when a job started and ended", async () => {
    const root = await open();
    await service.add(
      root.id,
      [{ name: "a", runner: { kind: "inline" } }],
      LEAD,
    );
    const id = named(root.id, "a").id;
    const record = () => repositories.jobs.tree(root.id).records.get(id);
    const startedAt = new Date(clock).toISOString();
    expect(record()).toMatchObject({ startedAt, endedAt: null });

    clock += 60_000;
    await service.done(LEAD, { result: "Done" });
    const endedAt = new Date(clock).toISOString();
    expect(record()).toMatchObject({ startedAt, endedAt });

    clock += 60_000;
    await service.redo(id, LEAD, "Again");
    expect(record()).toMatchObject({
      startedAt: new Date(clock).toISOString(),
      endedAt: null,
    });
    // The root was not redone: it was running all along.
    expect(repositories.jobs.tree(root.id).records.get(root.id)).toMatchObject({
      startedAt,
      endedAt: null,
    });
  });

  test("makes a session started by another a job under the starter's", async () => {
    const root = await open();
    roots.add(root.id);
    const member = await service.open(
      WORKSPACE,
      "member",
      { name: "api", title: "API", instructions: "Build the API." },
      root.id,
    );
    expect(member).toMatchObject({
      parentId: root.id,
      state: "running",
      sessionId: "member",
    });
    // Whoever started the session told it what to do.
    expect(told).toEqual([]);
    await expect(
      service.done(LEAD, { result: "All done" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await service.done("member", { result: "API is in" });
    expect(told).toEqual([{ to: LEAD, text: '"API" is done: API is in' }]);
  });

  test("starts an agent for a piece of work nobody is on", async () => {
    const job = await service.plant(
      WORKSPACE,
      { name: "schema", title: "Schema", instructions: "Two tables." },
      null,
    );
    roots.add(job.id);
    expect(job.state).toBe("running");
    expect(spawned[0]).toMatchObject({ parentSessionId: null });
    expect(spawned[0]?.brief).toContain("Two tables.");
  });
});

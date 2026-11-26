import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AgentSession, WorkflowDefinition } from "../domain";
import type { Job } from "../domain/jobs";
import { runMigrations } from "../repositories/migrations";
import { SqliteRepositories } from "../repositories/sqlite";
import { createJobPorts, JobIntakeService } from "./job-intake";
import { JobService } from "./jobs";
import { PlanService, type PlanFile } from "./plans";
import type { WorkflowCatalog } from "./workflow-files";

const PLAN = `---
plan: Checkout
---

## Tasks

- [ ] Schema ^schema
- [ ] API ^api
- [ ] Web @web
  - [ ] Cart page

## Flow

\`\`\`mermaid
flowchart LR
  schema --> api
\`\`\`
`;

const flow = (
  name: string,
  steps: string[],
  more: Partial<WorkflowDefinition> = {},
): WorkflowDefinition => ({
  name,
  description: "",
  when: "",
  steps,
  dynamic: false,
  loop: null,
  until: "",
  body: "",
  ...more,
});

let home: string;
let planPath: string;
let file: PlanFile;
let repositories: SqliteRepositories;
let jobs: JobService;
let intake: JobIntakeService;
let sessions: AgentSession[];
let sent: { to: string; text: string }[];
let enabled: boolean;

const session = (id: string, name: string): AgentSession =>
  ({
    id,
    workspaceId: "w1",
    name,
    teamHandle: null,
    status: "running",
    archivedAt: null,
    startedAt: "2026-11-24T10:00:00Z",
  }) as AgentSession;

const catalog: WorkflowCatalog = {
  workflows: [
    flow("feature", ["plan", "build"], { body: "Keep it small." }),
    flow("rounds", ["look", "fix"], { loop: "look", until: "nothing is left" }),
    flow("do", [], { dynamic: true }),
  ],
  steps: ["plan", "build", "look", "fix"].map((name) => ({
    name,
    description: "",
    gate: null,
    body: `Do ${name}.`,
  })),
  tools: [],
  problems: [],
  choosing: "",
  memories: [],
};

const tree = (job: Job): Job[] => [
  ...jobs.tree(jobs.rootOf(job.id)).tree.jobs.values(),
];
const named = (job: Job, name: string): Job => {
  const found = tree(job).find((item) => item.name === name);
  if (!found) throw new Error(`no job named ${name}`);
  return found;
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "daedalus-intake-"));
  const databasePath = join(home, "state.db");
  await runMigrations(
    databasePath,
    join(import.meta.dir, "../../../../migrations"),
  );
  repositories = new SqliteRepositories(databasePath);
  const now = "2026-11-24T10:00:00.000Z";
  const path = join(home, "demo");
  await mkdir(join(path, "plans"), { recursive: true });
  planPath = join(path, "plans", "checkout.plan.md");
  await writeFile(planPath, PLAN);
  repositories.createWorkspace({
    id: "w1",
    slug: "demo",
    name: "Demo",
    path,
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
  sessions = [session("lead", "Checkout lead"), session("web-1", "web")];
  sent = [];
  enabled = true;
  const plans = new PlanService({
    workspaceRoot: home,
    workspace: async () => ({
      id: "w1",
      slug: "demo",
      name: "Demo",
      path,
      defaultProvider: null,
    }),
    workspaces: async () => [{ id: "w1", name: "Demo", path }],
    sessions: async () => sessions,
  } as unknown as ConstructorParameters<typeof PlanService>[0]);
  file = await plans.find(undefined, planPath);
  jobs = new JobService(
    repositories,
    createJobPorts({
      spawn: async (input) => {
        const made = session(
          `worker-${sessions.length}`,
          `${input.name} worker`,
        );
        sessions.push(made);
        return made;
      },
      send: async (to, text) => {
        sent.push({ to, text });
      },
      raise: async () => undefined,
      clear: () => undefined,
      session: (id) => sessions.find((item) => item.id === id),
      archive: async () => undefined,
      places: async () => ({ path, repositories: [] }),
      plans,
      now: () => new Date(now),
    }),
  );
  intake = new JobIntakeService({
    jobs,
    catalog: async () => catalog,
    plans,
    session: (id) => sessions.find((item) => item.id === id),
    sessions: async () => sessions,
    leads: () => new Set(),
    enabled: () => enabled,
  });
});

afterEach(async () => {
  repositories.close();
  await rm(home, { recursive: true, force: true });
});

describe("startWorkflow", () => {
  test("opens a root job for the session and hands it the first step", async () => {
    const started = await intake.startWorkflow({
      sessionId: "lead",
      workflow: "feature",
    });
    expect(started.notes).toBe("Keep it small.");
    expect(started.brief).toContain("Do plan.");
    expect(started.job).toMatchObject({ name: "feature", state: "running" });
    const root = tree(started.job).find((job) => !job.parentId);
    expect(root).toMatchObject({ title: "Checkout lead", sessionId: "lead" });
    expect(intake.workflowOf("lead")?.job.id).toBe(started.job.id);

    const handed = await jobs.done("lead", { result: "Planned" });
    expect(handed.next).toContain("Do build.");
    await jobs.done("lead", { result: "Built" });
    expect(named(started.job, "feature").state).toBe("done");
    expect(intake.workflowOf("lead")).toBeUndefined();
  });

  test("refuses a second workflow unless it replaces or goes inside", async () => {
    const first = await intake.startWorkflow({
      sessionId: "lead",
      workflow: "feature",
    });
    await expect(
      intake.startWorkflow({ sessionId: "lead", steps: ["a", "b"] }),
    ).rejects.toThrow("--replace");

    const inside = await intake.startWorkflow({
      sessionId: "lead",
      steps: ["a", "b"],
      name: "probe",
      inside: true,
    });
    expect(inside.job.parentId).toBe(named(first.job, "plan").id);
    expect(inside.brief).toContain("Your job: a");

    const replaced = await intake.startWorkflow({
      sessionId: "lead",
      workflow: "feature",
      replace: true,
    });
    expect(named(first.job, "probe").state).toBe("skipped");
    expect(replaced.job.state).toBe("running");
  });

  test("runs the same workflow again under a new name", async () => {
    const first = await intake.startWorkflow({
      sessionId: "lead",
      steps: ["a"],
    });
    await jobs.done("lead", { result: "Done" });
    const second = await intake.startWorkflow({
      sessionId: "lead",
      steps: ["a"],
    });
    expect(first.job.name).toBe("dynamic");
    expect(second.job.name).toBe("dynamic-2");
    expect(second.brief).toContain("Your job: a");
  });

  test("ends a workflow that goes round when its job is finished", async () => {
    const started = await intake.startWorkflow({
      sessionId: "lead",
      workflow: "rounds",
    });
    await jobs.done("lead", { result: "Found two" });
    const again = await jobs.done("lead", { result: "Fixed two" });
    expect(again.next).toContain("Do look.");
    expect(named(started.job, "look").round).toBe(2);

    await jobs.done("lead", {
      result: "Nothing is left",
      jobId: started.job.id,
    });
    expect(named(started.job, "rounds").state).toBe("done");
    expect(named(started.job, "fix").state).toBe("skipped");
  });

  test("starts nothing while workflows are off", async () => {
    enabled = false;
    await expect(
      intake.startWorkflow({ sessionId: "lead", workflow: "feature" }),
    ).rejects.toThrow("Workflows are off");
  });
});

describe("addPlan", () => {
  test("turns tasks into jobs and keeps the file's marks current", async () => {
    const added = await intake.addPlan({ sessionId: "lead", file });
    expect(added.map((job) => [job.name, job.state])).toEqual([
      ["schema", "running"],
      ["api", "pending"],
      ["web", "running"],
    ]);
    // Tasks without an id got one before their jobs were added.
    let text = await readFile(planPath, "utf8");
    expect(text).toContain("- [/] Schema @schema-worker ^schema");
    expect(text).toContain("- [ ] API ^api");
    expect(text).toContain("- [/] Web @web ^web");
    expect(text).toContain("  - [/] Cart page ^cart-page");
    // The owner of a task is told its brief, then the brief of the first
    // task nested in it. No agent is started for either.
    expect(sent.map((item) => item.to)).toEqual(["web-1", "web-1"]);
    expect(sent[0]?.text).toContain("^web");
    expect(sent[1]?.text).toContain("^cart-page");

    const worker = named(added[0]!, "schema").sessionId!;
    sent = [];
    await jobs.done(worker, { result: "Two tables" });
    text = await readFile(planPath, "utf8");
    expect(text).toContain("- [x] Schema @schema-worker ^schema");
    expect(text).toContain("- [/] API @api-worker ^api");
    expect(sent).toEqual([
      { to: "lead", text: '"Schema" is done: Two tables' },
    ]);
    const api = named(added[0]!, "api");
    expect(jobs.brief(api.sessionId!)).toContain("result = Two tables");
  });

  test("closes the first job of a session that owns a task", async () => {
    const standing = await intake.standing("lead");
    const first = await jobs.open(
      "w1",
      "web-1",
      { name: "web-first", title: "web", instructions: "Build the web side." },
      standing.id,
    );
    const added = await intake.addPlan({ sessionId: "lead", file });
    const after = named(added[0]!, "web-first");
    expect(after.id).toBe(first.id);
    expect(after.state).toBe("skipped");
    expect(after.why).toContain('plan task "Web"');
    // The session stands on its task, so work it hands on goes under it.
    expect(jobs.current("web-1")?.job.name).toBe("cart-page");
  });

  test("hands a session its next task in the answer, not as a message", async () => {
    await writeFile(
      planPath,
      [
        "---",
        "plan: Two",
        "---",
        "",
        "## Tasks",
        "",
        "- [ ] One @web ^one",
        "- [ ] Two @web ^two",
        "",
        "## Flow",
        "",
        "```mermaid",
        "flowchart LR",
        "  one --> two",
        "```",
        "",
      ].join("\n"),
    );
    await intake.addPlan({ sessionId: "lead", file });
    sent = [];
    const handed = await jobs.done("web-1", { result: "First part" });
    expect(handed.next).toContain("^two");
    // The lead hears of the finished task; the owner is not sent a brief
    // it would read after it had done the work.
    expect(sent.map((item) => item.to)).toEqual(["lead"]);
  });

  test("adds only new tasks when the plan is added again", async () => {
    await intake.addPlan({ sessionId: "lead", file });
    expect(await intake.addPlan({ sessionId: "lead", file })).toEqual([]);
    await writeFile(
      planPath,
      (await readFile(planPath, "utf8")).replace(
        "\n## Flow",
        "- [ ] Docs\n\n## Flow",
      ),
    );
    const more = await intake.addPlan({ sessionId: "lead", file });
    expect(more.map((job) => job.name)).toEqual(["docs"]);
    expect(intake.planJob("w1", planPath, "docs")?.id).toBe(more[0]?.id);
  });
});

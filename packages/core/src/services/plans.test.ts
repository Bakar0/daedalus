import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AgentSession } from "../domain";
import { findPlanTask } from "../domain/plans";
import { PlanService, type PlanPorts } from "./plans";

const FIXTURE = join(
  import.meta.dir,
  "../../../../tests/fixtures/plans/cart-api-v2.plan.md",
);

function session(fields: Partial<AgentSession>): AgentSession {
  return {
    id: "s",
    workspaceId: "w1",
    name: "x",
    teamHandle: null,
    status: "running",
    archivedAt: null,
    startedAt: "2026-11-01T00:00:00Z",
    ...fields,
  } as AgentSession;
}

let root: string;
let sessions: AgentSession[];
let sent: { id: string; text: string }[];
let spawned: Parameters<PlanPorts["spawn"]>[0][];
let service: PlanService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "daedalus-plans-"));
  await mkdir(join(root, "checkout", "plans"), { recursive: true });
  await writeFile(
    join(root, "checkout", "plans", "cart-api-v2.plan.md"),
    await readFile(FIXTURE, "utf8"),
  );
  sessions = [
    session({ id: "api-1", name: "Cart endpoints", teamHandle: "api" }),
    session({ id: "db-old", name: "db", status: "exited" }),
    session({
      id: "db-new",
      name: "db",
      startedAt: "2026-11-02T00:00:00Z",
    }),
    session({ id: "lead", name: "Checkout lead" }),
  ];
  sent = [];
  spawned = [];
  service = new PlanService({
    workspaceRoot: root,
    workspace: async () => ({
      id: "w1",
      slug: "checkout",
      name: "Checkout",
      path: join(root, "checkout"),
      defaultProvider: null,
    }),
    workspaces: async () => [{ id: "w1", path: join(root, "checkout") }],
    sessions: async () => sessions,
    activity: (id) => (id === "api-1" ? "working" : "idle"),
    needsAttention: (id) => id === "db-new",
    spawn: async (input) => {
      spawned.push(input);
      return session({ id: "new", name: input.name });
    },
    send: async (id, text) => {
      sent.push({ id, text });
      return session({ id });
    },
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("PlanService", () => {
  test("creates a plan under plans/ and refuses a second with the title", async () => {
    const file = await service.create(
      { workspace: "checkout" },
      { title: "Search v3", owner: "lead" },
    );
    expect(file.path).toBe("plans/search-v3.plan.md");
    expect(await readFile(file.absolutePath, "utf8")).toContain(
      'plan: "Search v3"',
    );
    await expect(
      service.create({ workspace: "checkout" }, { title: "Search v3" }),
    ).rejects.toThrow(/already exists/);
  });

  test("Home plans live in the workspaces root", async () => {
    const file = await service.create({ home: true }, { title: "Quarter" });
    expect(file.absolutePath).toBe(join(root, "plans", "quarter.plan.md"));
    expect(file.workspaceId).toBeNull();
  });

  test("lists and finds plans by slug, name, path or absolute path", async () => {
    const scope = { workspace: "checkout" };
    const [summary] = await service.list(scope);
    expect(summary).toMatchObject({
      title: "Cart API v2",
      done: 3,
      total: 9,
      questions: 2,
    });
    for (const reference of [
      "cart-api-v2",
      "cart-api-v2.plan.md",
      "plans/cart-api-v2.plan.md",
    ])
      expect((await service.find(scope, reference)).path).toBe(
        "plans/cart-api-v2.plan.md",
      );
    const absolute = await service.find(undefined, summary!.absolutePath);
    expect(absolute.workspaceId).toBe("w1");
    await expect(service.find(scope, "nope")).rejects.toThrow(/plan list/);
    await expect(service.find(scope, "../../etc/passwd")).rejects.toThrow();
  });

  test("resolves owners to live sessions", async () => {
    const file = await service.find({ workspace: "w1" }, "cart-api-v2");
    const { plan } = await service.read(file);
    const owners = await service.owners(file, plan);
    const by = Object.fromEntries(owners.map((owner) => [owner.handle, owner]));
    expect(by.api).toMatchObject({ sessionId: "api-1", state: "working" });
    // The running one of two sessions called db, waiting on the user.
    expect(by.db).toMatchObject({ sessionId: "db-new", state: "waiting" });
    expect(by["checkout-lead"]).toMatchObject({
      sessionId: "lead",
      state: "idle",
    });
    expect(by.ui).toMatchObject({ sessionId: null, state: "none" });
  });

  test("sets states and adds questions in the file", async () => {
    const file = await service.find({ workspace: "w1" }, "cart-api-v2");
    await service.setState(file, "^screens", "doing", "web");
    await service.ask(file, "^screens", "Mobile too?");
    const text = await readFile(file.absolutePath, "utf8");
    expect(text).toContain("- [/] Checkout screens @web ^screens");
    expect(text).toContain("  > ? Mobile too?");
  });

  test("starting a task spawns on the default provider and claims the task", async () => {
    const file = await service.find({ workspace: "w1" }, "cart-api-v2");
    const { session: started, plan } = await service.startTask(
      file,
      "^screens",
    );
    expect(spawned[0]).toMatchObject({
      workspace: "w1",
      provider: "claude",
      name: "Checkout screens",
    });
    expect(spawned[0]!.message).toContain(file.absolutePath);
    expect(spawned[0]!.message).toContain("Cart page and checkout summary");
    expect(started.id).toBe("new");
    expect(findPlanTask(plan, "screens")).toMatchObject({
      state: "doing",
      owner: "checkout-screens",
    });
    await expect(service.startTask(file, "^migrate")).rejects.toThrow(/done/);
  });

  test("a task without an id gets one when it starts", async () => {
    const path = join(root, "checkout", "plans", "small.plan.md");
    await writeFile(path, "## Tasks\n\n- [ ] Write docs\n");
    const file = await service.find({ workspace: "w1" }, "small");
    await service.startTask(file, "L3");
    expect(await readFile(path, "utf8")).toBe(
      "## Tasks\n\n- [/] Write docs @write-docs ^write-docs\n",
    );
  });

  test("asks the owner with the question first, then where, then the quote", async () => {
    const file = await service.find({ workspace: "w1" }, "cart-api-v2");
    const { message } = await service.askOwner(file, {
      owner: "api",
      question: "Why 409 and not 412?",
      startLine: 47,
      endLine: 48,
      quote: "Writes use optimistic locking\non `version`",
    });
    expect(sent).toEqual([{ id: "api-1", text: message }]);
    expect(message).toBe(
      `Why 409 and not 412?\n\n${file.absolutePath}:47-48:\n> Writes use optimistic locking\n> on \`version\``,
    );
    // No owner on the part: the plan's owner answers.
    await service.askOwner(file, {
      owner: null,
      question: "Q",
      startLine: 3,
      endLine: 3,
      quote: "x",
    });
    expect(sent[1]!.id).toBe("lead");
    await expect(
      service.askOwner(file, {
        owner: "ui",
        question: "Q",
        startLine: 1,
        endLine: 1,
        quote: "x",
      }),
    ).rejects.toThrow(/No session answers to @ui/);
  });
});

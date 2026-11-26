import { describe, expect, test } from "vitest";
import { parsePlanFlow } from "../domain/plan-flow";
import { parsePlan } from "../domain/plans";
import { planJobDrafts, planMarkOf, planTaskOfJob } from "./plan-jobs";

const SOURCE = `---
plan: Checkout
---

## Tasks

- [ ] Schema ^schema
  Two tables.
- [ ] API ^api
  - [ ] Cart endpoints ^cart
  - [ ] Pay endpoints ^pay
- [ ] Web @web ^web
  - [ ] Cart page ^page
- [~] Maybe later ^later
- [x] Old thing ^old
- [ ] Ghost @nobody ^ghost
- [ ] No id yet

## Flow

\`\`\`mermaid
flowchart LR
  schema --> cart
  schema --> pay
  cart --> pay
  pay --> page
  old --> schema
\`\`\`
`;

const drafts = (known?: Set<string>) =>
  planJobDrafts({
    plan: parsePlan(SOURCE),
    flow: parsePlanFlow(SOURCE),
    planPath: "/w/plans/checkout.plan.md",
    owner: (handle) => (handle === "web" ? "web-session" : null),
    ...(known ? { known } : {}),
  });

describe("planJobDrafts", () => {
  test("leaves out drafts, closed tasks, tasks with no id and owners that are no session", () => {
    expect(drafts().map((draft) => draft.name)).toEqual([
      "schema",
      "api",
      "web",
    ]);
  });

  test("gives a leaf an agent, a group nothing, and an owner its tasks", () => {
    const [schema, api, web] = drafts();
    expect(schema).toMatchObject({
      title: "Schema",
      runner: { kind: "agent" },
      auto: false,
      source: "plan:/w/plans/checkout.plan.md#schema",
    });
    expect(schema?.instructions).toContain("Two tables.");
    expect(schema?.instructions).toContain("^schema");
    expect(api).toMatchObject({ runner: { kind: "inline" }, auto: true });
    expect(api?.children?.map((child) => child.runner)).toEqual([
      { kind: "agent" },
      { kind: "agent" },
    ]);
    expect(web).toMatchObject({
      runner: { kind: "session", sessionId: "web-session" },
      auto: false,
    });
    expect(web?.children?.[0]).toMatchObject({
      name: "page",
      runner: { kind: "inline" },
      auto: false,
    });
  });

  test("turns the flow into needs between jobs that stand side by side", () => {
    const [schema, api, web] = drafts();
    // `old` is closed, so it is no job. A need that names no job holds
    // nothing back in the engine.
    expect(schema?.needs).toEqual(["old"]);
    expect(api?.needs).toEqual(["schema"]);
    expect(api?.children?.map((child) => child.needs)).toEqual([[], ["cart"]]);
    expect(web?.needs).toEqual(["api"]);
    expect(web?.children?.[0]?.needs).toEqual([]);
  });

  test("adds only the tasks that are no jobs yet", () => {
    expect(
      drafts(new Set(["schema", "api"])).map((draft) => draft.name),
    ).toEqual(["web"]);
  });
});

test("planTaskOfJob reads a job's source", () => {
  expect(planTaskOfJob("plan:/w/plans/a#b.plan.md#cart")).toEqual({
    planPath: "/w/plans/a#b.plan.md",
    taskId: "cart",
  });
  expect(planTaskOfJob("step:feature/build")).toBeNull();
  expect(planTaskOfJob(null)).toBeNull();
});

test("planMarkOf maps a job's state to a mark", () => {
  const mark = (state: string, reason?: string) =>
    planMarkOf({
      state,
      hold: reason ? { reason, why: null } : null,
    } as Parameters<typeof planMarkOf>[0]);
  expect(mark("ready")).toBe("todo");
  expect(mark("running")).toBe("doing");
  expect(mark("held", "hold")).toBe("blocked");
  expect(mark("held", "result-gate")).toBe("doing");
  expect(mark("done")).toBe("done");
  expect(mark("failed")).toBe("blocked");
  expect(mark("skipped")).toBe("dropped");
});

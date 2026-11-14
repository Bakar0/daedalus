import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  addPlanTaskQuestion,
  ensurePlanTaskId,
  findPlanTask,
  parsePlan,
  planProgress,
  planQuestions,
  planTaskOwner,
  planTasks,
  renderNewPlan,
  setPlanTaskOwner,
  setPlanTaskState,
} from "./plans";

const FIXTURE = readFileSync(
  join(import.meta.dir, "../../../../tests/fixtures/plans/cart-api-v2.plan.md"),
  "utf8",
);

/** The lines that differ between two texts, by number. */
function changedLines(before: string, after: string): number[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1)
    if (a[i] !== b[i]) out.push(i + 1);
  return out;
}

describe("parsePlan on the demo fixture", () => {
  const plan = parsePlan(FIXTURE);

  test("reads the frontmatter", () => {
    expect(plan.title).toBe("Cart API v2");
    expect(plan.owner).toBe("checkout-lead");
    expect(plan.hasTasksSection).toBe(true);
  });

  test("finds every task, nested ones included, and none in a fence", () => {
    expect(planTasks(plan).map((task) => task.key)).toEqual([
      "^migrate",
      "^endpoints",
      "^get-post",
      "^stale",
      "^rate-limit",
      "^storage",
      "^cache",
      "^payments",
      "^screens",
      "^guest-merge",
    ]);
  });

  test("reads states, owners and titles", () => {
    const endpoints = findPlanTask(plan, "^endpoints");
    expect(endpoints).toMatchObject({
      state: "doing",
      owner: "api",
      title: "Cart endpoints",
      depth: 0,
    });
    expect(findPlanTask(plan, "payments").state).toBe("blocked");
    expect(findPlanTask(plan, "guest-merge").state).toBe("dropped");
    expect(findPlanTask(plan, "stale")).toMatchObject({
      depth: 1,
      owner: null,
    });
    expect(planTaskOwner(plan, findPlanTask(plan, "stale"))).toBe("api");
    expect(planTaskOwner(plan, findPlanTask(plan, "screens"))).toBe(
      "checkout-lead",
    );
  });

  test("keeps details in order, with the fence and nested list intact", () => {
    const endpoints = findPlanTask(plan, "^endpoints");
    const kinds = endpoints.body.map((part) => part.kind);
    expect(kinds).toEqual(["markdown", "task", "task", "task"]);
    const details = endpoints.body[0]!;
    if (details.kind !== "markdown") throw new Error("expected markdown");
    expect(details.text).toContain("- Validate SKUs");
    expect(details.text).toContain("```ts\n// - [ ] not a task");
    // Dedented to the task's content column.
    expect(details.text.startsWith("Build the four endpoints")).toBe(true);
    const lines = FIXTURE.split("\n");
    expect(lines[details.startLine - 1]).toContain("Build the four endpoints");
    expect(lines[details.endLine - 1]).toBe("  ```");
  });

  test("collects open questions, not those of finished tasks", () => {
    expect(
      planQuestions(plan).map((question) => [question.owner, question.text]),
    ).toEqual([
      ["db", expect.stringContaining("Which index")],
      ["payments", "Ship behind the old provider while the sandbox is down?"],
    ]);
  });

  test("counts progress without dropped tasks", () => {
    expect(planProgress(plan)).toEqual({ done: 3, total: 9 });
  });

  test("keeps the markdown outside the tasks section as blocks", () => {
    const markdown = plan.blocks.filter((block) => block.kind === "markdown");
    expect(markdown[0]!.text).toContain("# Cart API v2");
    expect(markdown.some((block) => block.text.includes("## Risks"))).toBe(
      true,
    );
    // The fence in Approach does not hide the headings after it.
    expect(markdown.some((block) => block.text.includes("```"))).toBe(true);
  });
});

describe("edits change only their own line", () => {
  test("state", () => {
    const after = setPlanTaskState(FIXTURE, "^screens", "doing");
    expect(changedLines(FIXTURE, after)).toHaveLength(1);
    expect(after).toContain("- [/] Checkout screens ^screens");
    expect(findPlanTask(parsePlan(after), "screens").state).toBe("doing");
  });

  test("owner, added before the id or replaced in place", () => {
    const added = setPlanTaskOwner(FIXTURE, "^screens", "@web");
    expect(added).toContain("- [ ] Checkout screens @web ^screens");
    expect(changedLines(FIXTURE, added)).toHaveLength(1);
    const replaced = setPlanTaskOwner(FIXTURE, "^storage", "db2");
    expect(replaced).toContain("- [/] Cart storage @db2 ^storage");
    expect(changedLines(FIXTURE, replaced)).toHaveLength(1);
  });

  test("an id from the title", () => {
    const source = "## Tasks\n\n- [ ] Write the docs\n- [ ] Write the docs\n";
    const first = ensurePlanTaskId(source, "L3");
    expect(first.id).toBe("write-the-docs");
    const second = ensurePlanTaskId(first.source, "L4");
    expect(second.id).toBe("write-the-docs-2");
    expect(second.source).toBe(
      "## Tasks\n\n- [ ] Write the docs ^write-the-docs\n- [ ] Write the docs ^write-the-docs-2\n",
    );
  });

  test("a question goes after the details, before nested tasks", () => {
    const after = addPlanTaskQuestion(FIXTURE, "^endpoints", "Which flag?");
    const lines = after.split("\n");
    const at = lines.indexOf("  > ? Which flag?");
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toBe("  ```");
    expect(lines[at + 1]).toBe("");
    expect(changedLines(FIXTURE, after)[0]).toBe(at + 1);
    expect(after.length).toBe(FIXTURE.length + "  > ? Which flag?\n".length);
    const question = planQuestions(parsePlan(after)).find(
      (item) => item.text === "Which flag?",
    );
    expect(question?.owner).toBe("api");
  });

  test("a question under a task with no details, and at the end of a file", () => {
    expect(
      addPlanTaskQuestion("## Tasks\n- [ ] A\n- [ ] B\n", "L2", "Q?"),
    ).toBe("## Tasks\n- [ ] A\n  > ? Q?\n- [ ] B\n");
    expect(addPlanTaskQuestion("## Tasks\n- [ ] A", "L2", "Q?")).toBe(
      "## Tasks\n- [ ] A\n  > ? Q?",
    );
  });
});

describe("CRLF files", () => {
  const crlf = FIXTURE.replace(/\n/g, "\r\n");

  test("parse the same as LF", () => {
    const plan = parsePlan(crlf);
    expect(plan.eol).toBe("\r\n");
    expect(planTasks(plan).map((task) => [task.key, task.line])).toEqual(
      planTasks(parsePlan(FIXTURE)).map((task) => [task.key, task.line]),
    );
    expect(findPlanTask(plan, "endpoints").body[0]).toMatchObject({
      kind: "markdown",
    });
    const details = findPlanTask(plan, "endpoints").body[0]!;
    expect(details.kind === "markdown" && details.text.includes("\r")).toBe(
      false,
    );
  });

  test("keep their line endings through every edit", () => {
    let source = setPlanTaskState(crlf, "^screens", "done");
    source = setPlanTaskOwner(source, "^screens", "web");
    source = addPlanTaskQuestion(source, "^screens", "Mobile too?");
    expect(source.replace(/\r\n/g, "")).not.toContain("\n");
    expect(source).toContain(
      "- [x] Checkout screens @web ^screens\r\n  Cart page",
    );
    expect(source).toContain("  > ? Mobile too?\r\n");
  });
});

describe("long details and odd shapes", () => {
  test("a task with hundreds of lines of details", () => {
    const body = Array.from(
      { length: 400 },
      (_, index) => `  Line ${index} of the details.`,
    ).join("\n");
    const source = `## Tasks\n\n- [ ] Big ^big\n${body}\n- [ ] After ^after\n`;
    const plan = parsePlan(source);
    const big = findPlanTask(plan, "big");
    expect(big.endLine).toBe(403);
    expect(big.body).toHaveLength(1);
    expect(findPlanTask(plan, "after").line).toBe(404);
    const after = setPlanTaskState(source, "after", "done");
    expect(changedLines(source, after)).toEqual([404]);
  });

  test("a fence with unindented lines stays inside its task", () => {
    const source = [
      "## Tasks",
      "- [ ] Code ^code",
      "  ```",
      "## not a heading",
      "- [ ] not a task",
      "  ```",
      "- [ ] Next ^next",
      "## Done when",
      "- [ ] a checkbox outside Tasks",
    ].join("\n");
    const plan = parsePlan(source);
    expect(planTasks(plan).map((task) => task.key)).toEqual(["^code", "^next"]);
    expect(findPlanTask(plan, "code").endLine).toBe(6);
  });

  test("deeply nested tasks and tab indents", () => {
    const source =
      "## Tasks\n- [ ] A ^a\n\t- [ ] B ^b\n\t\t- [x] C ^c\n\t\t  detail of C\n\t- [ ] D ^d\n* [!] E ^e\n1. [-] F ^f\n";
    const plan = parsePlan(source);
    expect(
      planTasks(plan).map((task) => `${task.id}:${task.depth}:${task.state}`),
    ).toEqual([
      "a:0:todo",
      "b:1:todo",
      "c:2:done",
      "d:1:todo",
      "e:0:blocked",
      "f:0:dropped",
    ]);
    const c = findPlanTask(plan, "c");
    expect(c.body).toEqual([
      { kind: "markdown", text: "detail of C", startLine: 5, endLine: 5 },
    ]);
  });

  test("a file with no frontmatter and no tasks section", () => {
    const plan = parsePlan("# Just notes\n\n- [ ] not a plan task\n");
    expect(plan.title).toBe("Just notes");
    expect(plan.owner).toBeNull();
    expect(plan.hasTasksSection).toBe(false);
    expect(planTasks(plan)).toEqual([]);
  });

  test("an unknown id says how to find one", () => {
    expect(() => findPlanTask(parsePlan(FIXTURE), "^nope")).toThrow(
      /plan show/,
    );
  });
});

describe("renderNewPlan", () => {
  test("a skeleton that parses", () => {
    const text = renderNewPlan({ title: "Ship: v2", owner: "@lead" });
    const plan = parsePlan(text);
    expect(plan.title).toBe("Ship: v2");
    expect(plan.owner).toBe("lead");
    expect(planTasks(plan)[0]?.id).toBe("first");
  });

  test("a given body keeps its own heading", () => {
    const text = renderNewPlan({
      title: "X",
      body: "# Mine\n\n## Tasks\n- [ ] A\n",
    });
    expect(text).not.toContain("# X\n");
    expect(parsePlan(text).title).toBe("X");
  });
});

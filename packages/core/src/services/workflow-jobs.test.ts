import { describe, expect, test } from "vitest";
import type { WorkflowDefinition, WorkflowStepDefinition } from "../domain";
import { parseStepFile, renderStepFile } from "./workflow-files";
import { dynamicJobDraft, workflowJobDraft } from "./workflow-jobs";

const step = (
  name: string,
  more: Partial<WorkflowStepDefinition> = {},
): WorkflowStepDefinition => ({
  name,
  description: "",
  gate: null,
  body: `Do ${name}.`,
  ...more,
});

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

const catalog = {
  workflows: [
    flow("feature", ["plan", "build", "@release"], { body: "Keep it small." }),
    flow("release", ["review", "ship"]),
    flow("rounds", ["look", "fix"], { loop: "look", until: "nothing is left" }),
  ],
  steps: [
    step("plan", { gives: [{ name: "plan", kind: "file" as const }] }),
    step("build", { gate: "result" }),
    step("review"),
    step("ship", { needs: [] }),
    step("look"),
    step("fix"),
  ],
  memories: [],
};

describe("step files", () => {
  test("read what a step gives and needs", () => {
    const parsed = parseStepFile(
      "---\nname: build\nneeds: [design]\ngives: [branch: commit, tests: number, notes]\n---\nBuild it.\n",
    );
    expect(parsed.needs).toEqual(["design"]);
    expect(parsed.gives).toEqual([
      { name: "branch", kind: "commit" },
      { name: "tests", kind: "number" },
      { name: "notes", kind: "text" },
    ]);
    expect(parseStepFile(renderStepFile(parsed))).toEqual(parsed);
  });

  test("leave both out of a step that declares neither", () => {
    const parsed = parseStepFile("---\nname: build\n---\nBuild it.\n");
    expect(parsed).not.toHaveProperty("needs");
    expect(parsed).not.toHaveProperty("gives");
  });

  test("refuse a kind that does not exist", () => {
    expect(() =>
      parseStepFile("---\nname: x\ngives: [branch: sha]\n---\nDo it.\n"),
    ).toThrow("'gives' must be a list of outputs");
  });
});

describe("workflowJobDraft", () => {
  test("makes a workflow one job with its steps under it", () => {
    const draft = workflowJobDraft(catalog.workflows[0]!, catalog);
    expect(draft).toMatchObject({
      name: "feature",
      auto: true,
      loop: null,
      instructions: "Keep it small.",
      runner: { kind: "inline" },
      source: "workflow:feature",
    });
    expect(
      draft.children?.map((child) => [child.name, child.needs, child.gate]),
    ).toEqual([
      ["plan", [], null],
      ["build", ["plan"], "result"],
      ["release", ["build"], undefined],
    ]);
    expect(draft.children?.[0]).toMatchObject({
      instructions: "Do plan.",
      gives: [{ name: "plan", kind: "file" }],
      source: "step:feature/plan",
    });
    // An included workflow is a job with its own steps. A step that says it
    // needs nothing does not wait for the one before it.
    expect(
      draft.children?.[2]?.children?.map((child) => [child.name, child.needs]),
    ).toEqual([
      ["review", []],
      ["ship", []],
    ]);
  });

  test("makes a workflow that goes round a loop job", () => {
    const draft = workflowJobDraft(catalog.workflows[2]!, catalog);
    expect(draft.auto).toBe(false);
    expect(draft.loop).toEqual({ to: "look", until: "nothing is left" });
  });

  test("refuses a workflow whose step has no file", () => {
    expect(() =>
      workflowJobDraft(flow("broken", ["plan", "nowhere"]), catalog),
    ).toThrow("nowhere");
  });
});

describe("dynamicJobDraft", () => {
  test("takes a named step from its file and any other as it is", () => {
    const draft = dynamicJobDraft(
      { label: "do", steps: ["plan", "run-test"] },
      catalog,
    );
    expect(draft.children?.map((child) => child.instructions)).toEqual([
      "Do plan.",
      "",
    ]);
    expect(draft.children?.[1]).toMatchObject({
      needs: ["plan"],
      gives: [],
      source: "step:do/run-test",
    });
  });

  test("refuses a step listed twice and a loop that names none", () => {
    expect(() =>
      dynamicJobDraft({ label: "do", steps: ["a", "a"] }, catalog),
    ).toThrow("listed twice");
    expect(() =>
      dynamicJobDraft({ label: "do", steps: ["a"], loop: "b" }, catalog),
    ).toThrow("--loop");
  });
});

test("a step's brief ends with the tools it suggests", () => {
  const draft = workflowJobDraft(
    {
      name: "fix",
      description: "",
      when: "",
      steps: ["proof"],
      dynamic: false,
      loop: null,
      until: "",
      body: "",
    },
    {
      workflows: [],
      steps: [
        {
          name: "proof",
          description: "",
          gate: null,
          body: "Prove it.",
          tools: ["logs", "gone"],
        },
      ],
      memories: [],
      tools: [
        { name: "logs", description: "Read service logs", body: "Use cx." },
      ],
    },
  );
  const text = draft.children![0]!.instructions!;
  expect(text.startsWith("Prove it.")).toBe(true);
  expect(text).toContain("daedal tool show <name>");
  expect(text).toContain("- logs: Read service logs");
  // A suggested tool with no file says nothing.
  expect(text).not.toContain("gone");
});

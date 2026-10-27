import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { WorkflowRunDto, WorkflowStepStateDto } from "@daedalus/protocol";
import { WorkflowPane, WorkflowSteps } from "./WorkflowPane";

const run = (states: WorkflowStepStateDto[]): WorkflowRunDto => ({
  id: "run",
  workspaceId: "w",
  sessionId: "s",
  workflow: "feature",
  steps: ["research", "review", "deploy"].map((name, index) => ({
    name,
    description: `About ${name}`,
    gate: name === "deploy" ? "result" : null,
    state: states[index]!,
    startedAt: null,
    endedAt: null,
    approvedAt: null,
    plan: name === "review" ? "Reading the diff of index.ts" : null,
    note:
      name === "research"
        ? "Found the index code"
        : name === "deploy"
          ? "1.2 is on the beta feed"
          : null,
    dynamic: false,
  })),
  dynamic: false,
  modified: false,
  loopTo: null,
  until: "",
  iteration: 1,
  history: [],
  endNote: null,
  startedAt: "2026-10-25T10:00:00.000Z",
  updatedAt: "2026-10-25T10:00:00.000Z",
  endedAt: null,
});

describe("workflow pane", () => {
  test("a vertical list: done steps checked, the current one spinning", () => {
    const html = renderToStaticMarkup(
      <WorkflowSteps run={run(["done", "active", "pending"])} />,
    );
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).toContain("workflow-mark state-done");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("workflow-mark spinning");
    expect(html).toContain("Found the index code");
    expect(html).not.toContain("Approve");
  });

  test("a step waiting on its result says so and shows what to approve, with no button", () => {
    const html = renderToStaticMarkup(
      <WorkflowSteps run={run(["done", "done", "waiting"])} />,
    );
    expect(html).toMatch(
      /deploy.*review.*waiting for you to approve the result · answer in the session.*1\.2 is on the beta feed/s,
    );
    expect(html).not.toContain("<button");
  });

  test("the pane names the workflow; without a run it says so in one dim line", () => {
    const open = renderToStaticMarkup(
      <WorkflowPane
        enabled
        onOpenSettings={() => {}}
        onOpenEditor={() => {}}
        run={run(["active", "pending", "pending"])}
        task={{ number: 12, title: "Version prints the name" }}
      />,
    );
    // The heading, then the run's own row: its workflow and its task.
    expect(open).toMatch(
      /Workflow<\/span>.*workflow-pane-run.*feature.*#12 Version prints the name/s,
    );
    expect(open).toContain("Workflows, steps and examples");
    // The dock around the pane resizes it, not the pane itself.
    expect(open).not.toContain("Resize");
    const empty = renderToStaticMarkup(
      <WorkflowPane
        enabled
        onOpenSettings={() => {}}
        onOpenEditor={() => {}}
      />,
    );
    expect(empty).toContain("No workflow in this session");
  });

  test("a circular run shows its iteration and earlier rounds", () => {
    const looping: WorkflowRunDto = {
      ...run(["active", "pending", "pending"]),
      dynamic: true,
      loopTo: "research",
      until: "The cache is fast enough",
      iteration: 2,
      history: [
        {
          iteration: 1,
          name: "review",
          state: "done",
          startedAt: null,
          endedAt: null,
          note: "Too slow on cold start",
        },
      ],
    };
    const html = renderToStaticMarkup(
      <WorkflowPane
        enabled
        onOpenSettings={() => {}}
        onOpenEditor={() => {}}
        run={looping}
      />,
    );
    expect(html).toContain("dynamic");
    expect(html).toContain("↻ 2");
    expect(html).toContain("until: The cache is fast enough");
    expect(html).toContain("Earlier iterations (1)");
  });

  test("a step shows its plan until done, then what came out, cut to fit", () => {
    const html = renderToStaticMarkup(
      <WorkflowSteps run={run(["done", "active", "pending"])} />,
    );
    // A row with a line opens it on a click; the line is the step's own.
    expect(html).toMatch(
      /has-note[^>]*>.*<span class="workflow-step-note">Reading the diff of index.ts<\/span>/s,
    );
    expect(html).toContain("Found the index code");
  });

  test("off, the pane says so and links to Settings, with no steps", () => {
    const html = renderToStaticMarkup(
      <WorkflowPane
        enabled={false}
        onOpenEditor={() => {}}
        onOpenSettings={() => {}}
        run={run(["active", "pending", "pending"])}
      />,
    );
    expect(html).toContain("Workflows are off");
    expect(html).toContain("Turn on in Settings");
    expect(html).not.toContain("workflow-step");
    // The tab stays reachable, to read or write workflows before turning them on.
    expect(html).toContain("Open ");
  });
});

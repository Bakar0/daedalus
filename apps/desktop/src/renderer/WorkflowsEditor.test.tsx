import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { WorkflowFileDto } from "@daedalus/protocol";
import { StepChips, StepPicker, ToolPicker } from "./WorkflowsEditor";

const file = (fields: Partial<WorkflowFileDto>): WorkflowFileDto => ({
  name: "x",
  path: "",
  text: "",
  description: "",
  problem: null,
  ...fields,
});

describe("the step picker", () => {
  test("offers steps, and workflows marked with the workflow icon, never the one being edited", () => {
    const html = renderToStaticMarkup(
      <StepPicker
        files={{
          root: "/w",
          choosing: { path: "/w/CHOOSING.md", text: "" },
          tools: [],
          steps: [file({ name: "review" }), file({ name: "ship" })],
          flows: [
            file({ name: "feature", steps: ["review", "@release"] }),
            file({ name: "release", steps: ["review", "ship"] }),
            file({ name: "do", dynamic: true }),
            file({
              name: "broken",
              problem: "Workflow 'broken' includes itself",
            }),
          ],
        }}
        onAdd={() => {}}
        self="feature"
      />,
    );
    expect(html).toMatch(
      /step-picker-item"[^>]*>review<.*step-picker-item"[^>]*>ship</s,
    );
    expect(html).toMatch(
      /step-picker-item workflow"[^>]*><svg[^>]*class="workflow-icon".*<\/svg>release</s,
    );
    // Not itself, not a dynamic workflow, not one that cannot be used.
    expect(html).not.toMatch(/<\/svg>feature</);
    expect(html).not.toMatch(/<\/svg>do</);
    expect(html).not.toMatch(/<\/svg>broken</);
    // Quiet buttons: the global blue button rule leaves them alone.
    expect(html).toContain('class="quiet step-picker-item');
  });
});

describe("the tool picker", () => {
  test("offers the tools the step does not suggest yet", () => {
    const html = renderToStaticMarkup(
      <ToolPicker
        draft={"---\nname: build\ntools: [logs]\n---\nDo.\n"}
        onAdd={() => {}}
        tools={[
          file({ name: "logs" }),
          file({ name: "aws-access", description: "Get AWS access" }),
          file({ name: "bad", problem: "No instructions" }),
        ]}
      />,
    );
    expect(html).toContain("aws-access");
    expect(html).toContain("Get AWS access");
    expect(html).not.toContain(">logs<");
    expect(html).not.toContain(">bad<");
  });
});

describe("a step's card", () => {
  const step = (tools: string[]) => file({ name: "proof", tools });

  test("names two tools and says how many more there are", () => {
    const html = renderToStaticMarkup(
      <StepChips step={step(["aws", "cx", "gh", "kubectl", "dx"])} />,
    );
    expect(html).toContain(">aws<");
    expect(html).toContain(">cx<");
    expect(html).not.toContain(">gh<");
    expect(html).toContain("+3 more");
    expect(html).toContain('title="gh, kubectl, dx"');
  });

  test("with two tools or fewer says nothing more", () => {
    const html = renderToStaticMarkup(<StepChips step={step(["aws", "cx"])} />);
    expect(html).toContain(">cx<");
    expect(html).not.toContain("more");
  });
});

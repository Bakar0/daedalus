import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { WorkflowFileDto } from "@daedalus/protocol";
import { StepPicker } from "./WorkflowsEditor";

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

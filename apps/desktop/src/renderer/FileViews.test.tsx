import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { WorkflowFileDto } from "@daedalus/protocol";
import {
  InstructionsIndexView,
  StepView,
  TopicView,
  WorkflowView,
} from "./FileViews";

const file = (fields: Partial<WorkflowFileDto>): WorkflowFileDto => ({
  name: "x",
  path: "",
  text: "",
  description: "",
  problem: null,
  ...fields,
});

const flow = file({
  name: "bug",
  description: "Find it and fix it.",
  when: "Something broken.",
  steps: ["reproduce", "ship", "missing"],
});
const steps = [
  file({ name: "reproduce", description: "Make it happen.", body: "Run it." }),
  file({ name: "ship", description: "Get it out.", gate: "user" }),
];

describe("file read views", () => {
  test("a workflow reads as its purpose, when it fits, and numbered steps", () => {
    const html = renderToStaticMarkup(
      <WorkflowView flow={flow} onStep={() => {}} steps={steps} />,
    );
    expect(html).toContain("Find it and fix it.");
    expect(html).toContain("Something broken.");
    expect(html).toMatch(/>1<.*reproduce.*Make it happen.*Run it\./s);
    expect(html).toMatch(/>2<.*ship.*gate/s);
    expect(html).toContain("No step file");
  });

  test("a step shows its gate and the workflows that use it", () => {
    const html = renderToStaticMarkup(
      <StepView flows={[flow]} onFlow={() => {}} step={steps[1]!} />,
    );
    expect(html).toContain("Waits for your approval");
    expect(html).toMatch(/Used by.*bug/s);
  });

  test("the index shows its Always rules and a card per topic", () => {
    const html = renderToStaticMarkup(
      <InstructionsIndexView
        instructions={{
          root: "/i",
          index: {
            path: "/i/INDEX.md",
            text: "## Always\n\n- Be brief.\n  - Even in PRs.\n\n## Topics\n\n- [git.md](git.md): branches and pushes\n",
          },
          topics: [
            {
              name: "git",
              path: "/i/git.md",
              text: "# Git\n\n- One.\n- Two.\n",
            },
          ],
        }}
        onTopic={() => {}}
      />,
    );
    expect(html).toContain("1 rule");
    expect(html).toContain("Be brief.");
    expect(html).toMatch(/Git.*branches and pushes.*2 rules/s);
  });

  test("a topic lists its rules", () => {
    const html = renderToStaticMarkup(
      <TopicView covers="Pushing" text={"# Git\n\n- One.\n- Two.\n"} />,
    );
    expect(html).toContain("Pushing");
    expect(html).toContain("2 rules");
  });
});

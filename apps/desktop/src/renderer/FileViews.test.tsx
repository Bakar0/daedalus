import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { WorkflowFileDto } from "@daedalus/protocol";
import {
  InstructionsIndexView,
  StepView,
  ToolView,
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
  file({ name: "ship", description: "Get it out.", gate: "result" }),
];

describe("file read views", () => {
  test("a workflow reads as its purpose, when it fits, and numbered steps", () => {
    const html = renderToStaticMarkup(
      <WorkflowView
        flow={flow}
        flows={[flow]}
        onFlow={() => {}}
        onStep={() => {}}
        steps={steps}
      />,
    );
    expect(html).toContain("Find it and fix it.");
    expect(html).toContain("Something broken.");
    expect(html).toMatch(/>1<.*reproduce.*Make it happen.*Run it\./s);
    expect(html).toMatch(/>2<.*ship.*gate/s);
    expect(html).toContain("No step file");
  });

  test("an included workflow is a card marked as one, listing its steps", () => {
    const release = file({
      name: "release",
      description: "Review, prove, ship.",
      steps: ["review", "proof", "ship"],
    });
    const feature = file({
      name: "feature",
      steps: ["reproduce", "@release", "@ghost"],
    });
    const html = renderToStaticMarkup(
      <WorkflowView
        flow={feature}
        flows={[feature, release]}
        onFlow={() => {}}
        onStep={() => {}}
        steps={steps}
      />,
    );
    expect(html).toMatch(
      />2<.*step-timeline-card included.*workflow-icon.*release.*workflow.*Review, prove, ship\..*review → proof → ship/s,
    );
    expect(html).toMatch(/>3<.*ghost.*No workflow file/s);
  });

  test("a step shows its gate and the workflows that use it", () => {
    const html = renderToStaticMarkup(
      <StepView flows={[flow]} onFlow={() => {}} step={steps[1]!} />,
    );
    expect(html).toContain("approve what comes out of this step");
    expect(html).toMatch(/Used by.*bug/s);
  });

  test("a step lists its memory, proposals first, with Accept only on a proposal", () => {
    const memory = (text: string, status: "proposed" | "accepted") => ({
      text,
      why: "The delete call skipped the owner check.",
      runs: 2,
      lastSeen: "2026-11-20",
      workflow: "feature",
      status,
      acceptedOn: status === "accepted" ? "2026-11-21" : null,
      only: null,
    });
    const html = renderToStaticMarkup(
      <StepView
        flows={[flow]}
        onFlow={() => {}}
        onMemory={() => {}}
        step={{
          ...steps[1]!,
          memories: [
            memory("Check the empty case", "accepted"),
            memory("Check every delete path", "proposed"),
          ],
        }}
      />,
    );
    expect(html).toContain("1 to review");
    expect(html).toMatch(
      /Check every delete path.*Accept<.*Check the empty case.*Promote to instructions/s,
    );
    expect(html.match(/>Accept</g)).toHaveLength(1);
    expect(html).toContain("Seen in 2 runs, last 2026-11-20 in feature");
  });

  test("a step shows the tools it suggests, and marks one with no file", () => {
    const html = renderToStaticMarkup(
      <StepView
        flows={[flow]}
        onFlow={() => {}}
        step={{ ...steps[1]!, tools: ["logs", "gone"] }}
        tools={[file({ name: "logs", description: "Query the logs" })]}
      />,
    );
    expect(html).toMatch(/Tools.*Query the logs.*logs.*gone · no file/s);
  });

  test("a tool shows the steps that suggest it and how to use it", () => {
    const html = renderToStaticMarkup(
      <ToolView
        onStep={() => {}}
        steps={[{ ...steps[1]!, tools: ["logs"] }, steps[0]!]}
        tool={file({
          name: "logs",
          description: "Query the logs",
          body: "Run the cx CLI.",
        })}
      />,
    );
    expect(html).toMatch(/Query the logs.*Steps.*ship.*Run the cx CLI/s);
    expect(html).not.toContain(">reproduce<");
  });

  test("a step shown without its memory, as in a preview, has no memory section", () => {
    const html = renderToStaticMarkup(
      <StepView flows={[flow]} onFlow={() => {}} step={steps[1]!} />,
    );
    expect(html).not.toContain("step-memory");
  });

  test("the index shows its Always rules and a card per topic file left over", () => {
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

  test("the index with no topic files shows only its Always rules", () => {
    const html = renderToStaticMarkup(
      <InstructionsIndexView
        instructions={{
          root: "/i",
          index: { path: "/i/INDEX.md", text: "## Always\n\n- Be brief.\n" },
          topics: [],
        }}
        onTopic={() => {}}
      />,
    );
    expect(html).toContain("Be brief.");
    expect(html).not.toContain("topic");
  });

  test("a topic lists its rules", () => {
    const html = renderToStaticMarkup(
      <TopicView covers="Pushing" text={"# Git\n\n- One.\n- Two.\n"} />,
    );
    expect(html).toContain("Pushing");
    expect(html).toContain("2 rules");
  });
});

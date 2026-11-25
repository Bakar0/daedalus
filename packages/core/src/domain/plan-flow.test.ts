import { describe, expect, test } from "bun:test";
import { flowColumns, parsePlanFlow } from "./plan-flow";

const plan = (flow: string) =>
  `# Plan\n\n## Flow\n\n\`\`\`mermaid\n${flow}\n\`\`\`\n\n## Tasks\n\n- [ ] A ^a\n`;

describe("parsePlanFlow", () => {
  test("a plan without a flow section has none", () => {
    const flow = parsePlanFlow("# Plan\n\n## Tasks\n\n- [ ] A ^a\n");
    expect(flow.present).toBe(false);
    expect(flow.needs.size).toBe(0);
  });

  test("a mermaid fence outside ## Flow is not the flow", () => {
    const flow = parsePlanFlow(
      "# Plan\n\n## Notes\n\n```mermaid\nflowchart LR\n  a --> b\n```\n",
    );
    expect(flow.present).toBe(false);
  });

  test("a chain with & fans out and back in", () => {
    const flow = parsePlanFlow(
      plan("flowchart LR\n  design --> api & page & mig --> proof"),
    );
    expect(flow.errors).toEqual([]);
    expect(flow.needs.get("api")).toEqual(["design"]);
    expect(flow.needs.get("proof")).toEqual(["api", "page", "mig"]);
    expect(
      flowColumns(["design", "api", "page", "mig", "proof"], flow),
    ).toEqual(
      new Map([
        ["design", 0],
        ["api", 1],
        ["page", 1],
        ["mig", 1],
        ["proof", 2],
      ]),
    );
  });

  test("labels, shapes, link text, comments and subgraphs order nothing", () => {
    const flow = parsePlanFlow(
      plan(
        [
          "flowchart TD",
          "  %% the api part",
          "  subgraph API",
          '    schema["The schema (v2)"] -->|then| ep(Endpoints);',
          "    schema -- also --> tests{Tests}",
          "  end",
          "  ep -.-> ship",
          "  tests ==> ship:::done",
          "  classDef done fill:#0f0",
        ].join("\n"),
      ),
    );
    expect(flow.errors).toEqual([]);
    expect(flow.needs.get("ep")).toEqual(["schema"]);
    expect(flow.needs.get("tests")).toEqual(["schema"]);
    expect(flow.needs.get("ship")).toEqual(["ep", "tests"]);
  });

  test("a line that is not a link is reported and the rest is read", () => {
    const flow = parsePlanFlow(plan("flowchart LR\n  a --> b\n  what is this"));
    expect(flow.errors).toHaveLength(1);
    expect(flow.needs.get("b")).toEqual(["a"]);
  });

  test("a circle is reported and orders nothing", () => {
    const flow = parsePlanFlow(plan("flowchart LR\n  a --> b --> c --> a"));
    expect(flow.errors[0]).toContain("circle");
    expect(flow.needs.size).toBe(0);
  });

  test("needs outside the level do not move a column", () => {
    const flow = parsePlanFlow(plan("flowchart LR\n  outside --> a --> b"));
    expect(flowColumns(["a", "b", "c"], flow)).toEqual(
      new Map([
        ["a", 0],
        ["b", 1],
        ["c", 0],
      ]),
    );
  });
});

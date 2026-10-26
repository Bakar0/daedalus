import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { alwaysRuleCount, InstructionsPane } from "./InstructionsPane";
import { TabIntro } from "./WorkflowsEditor";

describe("InstructionsPane", () => {
  test("names what there is under its own Open", () => {
    const html = renderToStaticMarkup(
      <InstructionsPane onOpen={() => {}} summary={{ always: 2, topics: 1 }} />,
    );
    expect(html).toContain("Custom instructions");
    expect(html).toContain("Open ");
    expect(html).toContain("2 Always rules · 1 topic");
  });

  test("with none yet, it says how they are made", () => {
    const html = renderToStaticMarkup(
      <InstructionsPane onOpen={() => {}} summary={{ always: 0, topics: 0 }} />,
    );
    expect(html).toContain("None yet");
  });

  test("counts only the bullets under ## Always", () => {
    const index = [
      "# Custom instructions",
      "",
      "## Always",
      "",
      "- Answer in short sentences.",
      "* Never push without asking.",
      "",
      "## Topics",
      "",
      "- [review.md](review.md): Code review",
    ].join("\n");
    expect(alwaysRuleCount(index)).toBe(2);
    expect(alwaysRuleCount("## Always\n- one\n")).toBe(1);
    expect(alwaysRuleCount("# Index\n- stray\n")).toBe(0);
    // A sub-bullet belongs to its rule; numbered rules count too.
    expect(
      alwaysRuleCount(
        "## Always\n- one\n  - detail of one\n1. two\n2) three\n",
      ),
    ).toBe(3);
  });

  test("a tab's intro says what it is for and links to the docs", () => {
    const html = renderToStaticMarkup(
      <TabIntro onReadMore={() => {}}>Rules every session follows.</TabIntro>,
    );
    expect(html).toContain("Rules every session follows.");
    expect(html).toContain("Read more and examples");
  });
});

import { describe, expect, test } from "vitest";
import { quickDiff } from "./quick-diff";

describe("quickDiff", () => {
  test("marks added, modified and deleted lines as VS Code's margin does", () => {
    const original = "a\nb\nc\nd\ne\n";
    const current = "a\nB\nc\nnew 1\nnew 2\nd\n";
    expect(quickDiff(original, current)).toEqual([
      { kind: "modified", startLine: 2, endLine: 2 },
      { kind: "added", startLine: 4, endLine: 5 },
      { kind: "deleted", startLine: 7, endLine: 7 },
    ]);
  });

  test("an empty original makes every line added", () => {
    expect(quickDiff("", "x\ny\n")).toEqual([
      { kind: "added", startLine: 1, endLine: 2 },
    ]);
  });

  test("the same text has no marks", () => {
    expect(quickDiff("same\n", "same\n")).toEqual([]);
  });
});

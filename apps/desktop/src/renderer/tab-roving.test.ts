import { describe, expect, test } from "vitest";
import { rovingTabIndex, rovingTarget } from "./tab-roving";

describe("rovingTarget", () => {
  test("the arrows move one tab and wrap at the ends", () => {
    expect(rovingTarget("ArrowRight", 0, 3)).toBe(1);
    expect(rovingTarget("ArrowRight", 2, 3)).toBe(0);
    expect(rovingTarget("ArrowLeft", 1, 3)).toBe(0);
    expect(rovingTarget("ArrowLeft", 0, 3)).toBe(2);
  });

  test("Home and End go to the first and the last tab", () => {
    expect(rovingTarget("Home", 2, 3)).toBe(0);
    expect(rovingTarget("End", 0, 3)).toBe(2);
  });

  test("other keys, and an empty row, move nothing", () => {
    expect(rovingTarget("ArrowDown", 0, 3)).toBeUndefined();
    expect(rovingTarget("Enter", 0, 3)).toBeUndefined();
    expect(rovingTarget("ArrowRight", 0, 0)).toBeUndefined();
  });
});

describe("rovingTabIndex", () => {
  test("only the selected tab is a Tab stop", () => {
    expect([0, 1, 2].map((index) => rovingTabIndex(index, 1))).toEqual([
      -1, 0, -1,
    ]);
  });

  test("with none selected, the first tab is the stop", () => {
    expect([0, 1, 2].map((index) => rovingTabIndex(index, -1))).toEqual([
      0, -1, -1,
    ]);
  });
});

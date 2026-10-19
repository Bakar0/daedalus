import { describe, expect, test } from "vitest";
import { COLOR_GRID } from "./SessionMenu";

describe("COLOR_GRID", () => {
  test("is five rows of ten distinct #rrggbb colors", () => {
    expect(COLOR_GRID).toHaveLength(50);
    expect(new Set(COLOR_GRID).size).toBe(50);
    for (const hex of COLOR_GRID) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    // The first row starts at red, the last row is grey.
    expect(COLOR_GRID[0]).toBe("#8c2121");
    for (const grey of COLOR_GRID.slice(40))
      expect(grey.slice(1, 3)).toBe(grey.slice(3, 5));
  });
});

import { describe, expect, test } from "vitest";
import {
  DRAG_THRESHOLD_PX,
  dropIndexFor,
  exceedsDragThreshold,
  keyboardMoveTarget,
  moveItem,
  orderChanged,
} from "./list-reorder";

describe("telling a drag from a click", () => {
  test("a press that barely moves stays a click", () => {
    const start = { x: 100, y: 100 };
    expect(exceedsDragThreshold(start, { x: 100, y: 100 })).toBe(false);
    expect(exceedsDragThreshold(start, { x: 102, y: 102 })).toBe(false);
  });

  test("crosses the threshold in any direction, not just vertically", () => {
    const start = { x: 100, y: 100 };
    expect(exceedsDragThreshold(start, { x: 100, y: 100 - 6 })).toBe(true);
    expect(exceedsDragThreshold(start, { x: 108, y: 100 })).toBe(true);
    expect(
      exceedsDragThreshold(start, { x: 100, y: 100 + DRAG_THRESHOLD_PX }),
    ).toBe(true);
  });
});

describe("moving a card", () => {
  test("moves an item without losing or duplicating one", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  test("leaves the list alone for a no-op or an impossible move", () => {
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });

  test("returns a copy rather than sorting in place", () => {
    const original = ["a", "b", "c"];
    expect(moveItem(original, 0, 2)).not.toBe(original);
    expect(original).toEqual(["a", "b", "c"]);
  });
});

describe("choosing the slot under the pointer", () => {
  // Three 20px-tall cards stacked from y=0: midpoints at 10, 30, 50.
  const midpoints = [10, 30, 50];

  test("drops where the pointer is, counting only the other cards", () => {
    expect(dropIndexFor(midpoints, 0, 5)).toBe(0);
    expect(dropIndexFor(midpoints, 0, 35)).toBe(1);
    expect(dropIndexFor(midpoints, 0, 55)).toBe(2);
    expect(dropIndexFor(midpoints, 2, 5)).toBe(0);
    expect(dropIndexFor(midpoints, 2, 55)).toBe(2);
  });

  test("holds its slot until the pointer clears a neighbour's midpoint", () => {
    // Dragging the middle card: it stays put anywhere between the midpoints
    // either side of it, and only moves once one is crossed.
    expect(dropIndexFor(midpoints, 1, 29)).toBe(1);
    expect(dropIndexFor(midpoints, 1, 49)).toBe(1);
    expect(dropIndexFor(midpoints, 1, 9)).toBe(0);
    expect(dropIndexFor(midpoints, 1, 51)).toBe(2);
  });

  test("the answer does not depend on where the dragged card sits", () => {
    // Its own midpoint is excluded from the count, which is what stops the
    // slot flickering as the card reflows underneath the pointer.
    expect(dropIndexFor([10, 30, 50], 1, 35)).toBe(
      dropIndexFor([10, 999, 50], 1, 35),
    );
  });

  test("never lands outside the list", () => {
    for (const pointer of [-500, 0, 25, 1000]) {
      const index = dropIndexFor(midpoints, 1, pointer);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(midpoints.length);
    }
  });
});

describe("committing only a real change", () => {
  test("recognises an unchanged order so a drop costs no round trip", () => {
    expect(orderChanged(["a", "b"], ["a", "b"])).toBe(false);
    expect(orderChanged(["a", "b"], ["b", "a"])).toBe(true);
    expect(orderChanged(["a"], ["a", "b"])).toBe(true);
  });
});

describe("moving a card from the keyboard", () => {
  test("steps one place at a time", () => {
    expect(keyboardMoveTarget(1, "up", 3)).toBe(0);
    expect(keyboardMoveTarget(1, "down", 3)).toBe(2);
  });

  test("clamps at the ends instead of wrapping", () => {
    expect(keyboardMoveTarget(0, "up", 3)).toBeUndefined();
    expect(keyboardMoveTarget(2, "down", 3)).toBeUndefined();
  });

  test("declines a card that is not in the list", () => {
    expect(keyboardMoveTarget(-1, "down", 3)).toBeUndefined();
  });
});

import { describe, expect, test } from "vitest";
import { gridMove, gridTabStop } from "./board-grid";
import {
  nextNeedingYou,
  recordMru,
  stepSwitcher,
  switcherOrder,
} from "./session-cycle";
import {
  type TreeItem,
  neighbourOf,
  treeKeyAction,
  treeTabStop,
} from "./sidebar-tree";

describe("treeKeyAction", () => {
  const items: TreeItem[] = [
    { id: "w:a", level: 1, expandable: true, expanded: true, label: "Alpha" },
    {
      id: "s:1",
      level: 2,
      parent: "w:a",
      expandable: false,
      expanded: false,
      label: "one",
    },
    {
      id: "s:2",
      level: 2,
      parent: "w:a",
      expandable: false,
      expanded: false,
      label: "two",
    },
    { id: "w:b", level: 1, expandable: true, expanded: false, label: "Beta" },
    { id: "w:c", level: 1, expandable: false, expanded: false, label: "Gamma" },
  ];

  test("↑ and ↓ move through what is shown and stop at the ends", () => {
    expect(treeKeyAction(items, "w:a", "ArrowDown")).toEqual({
      kind: "focus",
      id: "s:1",
    });
    expect(treeKeyAction(items, "s:2", "ArrowDown")).toEqual({
      kind: "focus",
      id: "w:b",
    });
    expect(treeKeyAction(items, "w:b", "ArrowUp")).toEqual({
      kind: "focus",
      id: "s:2",
    });
    expect(treeKeyAction(items, "w:a", "ArrowUp")).toBeUndefined();
    expect(treeKeyAction(items, "w:c", "ArrowDown")).toBeUndefined();
  });

  test("Home and End go to the first and the last item", () => {
    expect(treeKeyAction(items, "s:2", "Home")).toEqual({
      kind: "focus",
      id: "w:a",
    });
    expect(treeKeyAction(items, "s:1", "End")).toEqual({
      kind: "focus",
      id: "w:c",
    });
  });

  test("→ expands a folded workspace, then moves to its first session", () => {
    expect(treeKeyAction(items, "w:b", "ArrowRight")).toEqual({
      kind: "expand",
      id: "w:b",
    });
    expect(treeKeyAction(items, "w:a", "ArrowRight")).toEqual({
      kind: "focus",
      id: "s:1",
    });
    expect(treeKeyAction(items, "w:c", "ArrowRight")).toBeUndefined();
    expect(treeKeyAction(items, "s:1", "ArrowRight")).toBeUndefined();
  });

  test("← folds an open workspace, and goes from a session to its workspace", () => {
    expect(treeKeyAction(items, "w:a", "ArrowLeft")).toEqual({
      kind: "collapse",
      id: "w:a",
    });
    expect(treeKeyAction(items, "s:2", "ArrowLeft")).toEqual({
      kind: "focus",
      id: "w:a",
    });
    expect(treeKeyAction(items, "w:b", "ArrowLeft")).toBeUndefined();
  });

  test("a letter moves to the next item it starts, wrapping", () => {
    expect(treeKeyAction(items, "w:a", "t")).toEqual({
      kind: "focus",
      id: "s:2",
    });
    expect(treeKeyAction(items, "w:c", "A")).toEqual({
      kind: "focus",
      id: "w:a",
    });
    expect(treeKeyAction(items, "w:a", "z")).toBeUndefined();
  });

  test("Enter and Space are left to the item, and an unknown item does nothing", () => {
    expect(treeKeyAction(items, "w:a", "Enter")).toBeUndefined();
    expect(treeKeyAction(items, "w:a", " ")).toBeUndefined();
    expect(treeKeyAction(items, "w:x", "ArrowDown")).toBeUndefined();
  });

  test("the Tab stop is the last focused item, else the selected, else the first", () => {
    const shown = items.map((item) => item.id);
    expect(treeTabStop(shown, "s:2", ["w:a"])).toBe("s:2");
    expect(treeTabStop(shown, "s:9", ["s:9", "w:b"])).toBe("w:b");
    expect(treeTabStop(shown, undefined, [undefined])).toBe("w:a");
    expect(treeTabStop([], undefined, ["w:a"])).toBeUndefined();
  });

  test("a removed item hands focus to the next, or the previous at the end", () => {
    const shown = items.map((item) => item.id);
    expect(neighbourOf(shown, "s:1")).toBe("s:2");
    expect(neighbourOf(shown, "w:c")).toBe("w:b");
    expect(neighbourOf(["w:a"], "w:a")).toBeUndefined();
    expect(neighbourOf(shown, "w:x")).toBeUndefined();
  });
});

describe("gridMove", () => {
  const lanes = [["a1", "a2", "a3"], [], ["b1"], ["c1", "c2"]];

  test("↑ and ↓ move within a lane and run on into the next one", () => {
    expect(gridMove(lanes, "a1", "ArrowDown")).toBe("a2");
    expect(gridMove(lanes, "a3", "ArrowDown")).toBe("b1");
    expect(gridMove(lanes, "b1", "ArrowUp")).toBe("a3");
    expect(gridMove(lanes, "a1", "ArrowUp")).toBeUndefined();
    expect(gridMove(lanes, "c2", "ArrowDown")).toBeUndefined();
  });

  test("← and → change lane, keeping the closest position", () => {
    expect(gridMove(lanes, "a3", "ArrowRight")).toBe("b1");
    expect(gridMove(lanes, "b1", "ArrowRight")).toBe("c1");
    expect(gridMove(lanes, "c2", "ArrowLeft")).toBe("b1");
    expect(gridMove(lanes, "a2", "ArrowLeft")).toBeUndefined();
    expect(
      gridMove(
        [
          ["a1", "a2"],
          ["b1", "b2"],
        ],
        "a2",
        "ArrowRight",
      ),
    ).toBe("b2");
  });

  test("Home and End go to the ends of the lane", () => {
    expect(gridMove(lanes, "a2", "Home")).toBe("a1");
    expect(gridMove(lanes, "a2", "End")).toBe("a3");
    expect(gridMove(lanes, "a1", "Home")).toBeUndefined();
  });

  test("a card no longer on the board starts over at the first", () => {
    expect(gridMove(lanes, "zz", "ArrowDown")).toBe("a1");
    expect(gridMove([], "zz", "ArrowDown")).toBeUndefined();
  });

  test("the Tab stop is the last focused card, else the selected, else the first", () => {
    expect(gridTabStop(lanes, "b1", "a2")).toBe("b1");
    expect(gridTabStop(lanes, "gone", "a2")).toBe("a2");
    expect(gridTabStop(lanes, undefined, undefined)).toBe("a1");
  });
});

describe("the session switcher", () => {
  test("the session just shown moves to the front of the recent order", () => {
    let order: readonly string[] = [];
    order = recordMru(order, "a");
    order = recordMru(order, "b");
    order = recordMru(order, "a");
    expect(order).toEqual(["a", "b"]);
    // Already first: the same list, so nothing re-renders.
    expect(recordMru(order, "a")).toBe(order);
    expect(recordMru(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });

  test("lists the live sessions used lately first, then the rest in sidebar order", () => {
    expect(switcherOrder(["c", "gone", "a"], ["a", "b", "c", "d"])).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
    expect(switcherOrder([], ["a", "b"])).toEqual(["a", "b"]);
    expect(switcherOrder(["a"], [])).toEqual([]);
  });

  test("Tab moves down and ⇧Tab up, wrapping", () => {
    expect(stepSwitcher(0, 3, 1)).toBe(1);
    expect(stepSwitcher(2, 3, 1)).toBe(0);
    expect(stepSwitcher(0, 3, -1)).toBe(2);
    expect(stepSwitcher(0, 0, 1)).toBe(0);
  });
});

describe("next session that needs you", () => {
  const order = ["a", "b", "c", "d"];

  test("goes round the sessions that need you", () => {
    const needs = (id: string) => id === "b" || id === "d";
    expect(nextNeedingYou(order, needs, undefined)).toBe("b");
    expect(nextNeedingYou(order, needs, "b")).toBe("d");
    expect(nextNeedingYou(order, needs, "d")).toBe("b");
    expect(nextNeedingYou(order, needs, "c")).toBe("d");
    expect(nextNeedingYou(order, (id) => id === "b", "b")).toBeUndefined();
    expect(nextNeedingYou(order, () => false, "a")).toBeUndefined();
  });
});

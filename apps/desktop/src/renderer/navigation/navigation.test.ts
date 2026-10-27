import { describe, expect, test } from "vitest";
import { cycleArea } from "./areas";
import { gridMove, gridTabStop } from "./board-grid";
import { EMPTY_HISTORY, recordVisit, stepHistory, type Visit } from "./history";
import { nextNeedingYou, stepSession } from "./session-cycle";
import {
  type TreeItem,
  neighbourOf,
  treeKeyAction,
  treeTabStop,
} from "./sidebar-tree";

describe("cycleArea", () => {
  const all = [
    "sidebar",
    "center",
    "right-panel",
    "terminal-panel",
    "toasts",
  ] as const;

  test("F6 goes forward and ⇧F6 back, wrapping", () => {
    expect(cycleArea(all, "sidebar", 1)).toBe("center");
    expect(cycleArea(all, "toasts", 1)).toBe("sidebar");
    expect(cycleArea(all, "sidebar", -1)).toBe("toasts");
    expect(cycleArea(all, "right-panel", -1)).toBe("center");
  });

  test("skips regions that are not showing, whatever order they come in", () => {
    expect(cycleArea(["center", "sidebar"], "sidebar", 1)).toBe("center");
    expect(cycleArea(["terminal-panel", "sidebar"], "sidebar", 1)).toBe(
      "terminal-panel",
    );
    expect(cycleArea(["sidebar", "center"], "center", 1)).toBe("sidebar");
  });

  test("from nowhere, or a hidden region, F6 enters the first and ⇧F6 the last", () => {
    expect(cycleArea(all, undefined, 1)).toBe("sidebar");
    expect(cycleArea(all, undefined, -1)).toBe("toasts");
    expect(cycleArea(["sidebar", "center"], "toasts", 1)).toBe("sidebar");
    expect(cycleArea([], "sidebar", 1)).toBeUndefined();
  });
});

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

describe("visit history", () => {
  const session = (id: string): Visit => ({
    kind: "session",
    id,
    workspaceId: "w",
  });
  const task = (id: string): Visit => ({ kind: "task", id, workspaceId: "w" });
  const all = () => true;

  test("back from a task returns to the session it came from, and forward again", () => {
    let history = recordVisit(EMPTY_HISTORY, session("s1"));
    history = recordVisit(history, task("t1"));
    const back = stepHistory(history, -1, all);
    expect(back?.visit).toEqual(session("s1"));
    const forward = stepHistory(back!.history, 1, all);
    expect(forward?.visit).toEqual(task("t1"));
    expect(stepHistory(forward!.history, 1, all)).toBeUndefined();
  });

  test("visiting what is shown records nothing", () => {
    const history = recordVisit(EMPTY_HISTORY, session("s1"));
    expect(recordVisit(history, session("s1"))).toBe(history);
  });

  test("a new visit after going back drops what was ahead", () => {
    let history = recordVisit(EMPTY_HISTORY, session("s1"));
    history = recordVisit(history, session("s2"));
    history = stepHistory(history, -1, all)!.history;
    history = recordVisit(history, task("t1"));
    expect(history.entries).toEqual([session("s1"), task("t1")]);
    expect(stepHistory(history, 1, all)).toBeUndefined();
  });

  test("entries that are gone are skipped", () => {
    let history = recordVisit(EMPTY_HISTORY, session("s1"));
    history = recordVisit(history, session("gone"));
    history = recordVisit(history, task("t1"));
    const back = stepHistory(history, -1, (visit) => visit.id !== "gone");
    expect(back?.visit).toEqual(session("s1"));
    expect(back?.history.entries).toEqual([session("s1"), task("t1")]);
    expect(stepHistory(EMPTY_HISTORY, -1, all)).toBeUndefined();
  });
});

describe("session cycling", () => {
  const order = ["a", "b", "c", "d"];

  test("⌥⌘↓ and ⌥⌘↑ step through sidebar order, wrapping", () => {
    expect(stepSession(order, "b", 1)).toBe("c");
    expect(stepSession(order, "d", 1)).toBe("a");
    expect(stepSession(order, "a", -1)).toBe("d");
    expect(stepSession(order, undefined, 1)).toBe("a");
    expect(stepSession(order, undefined, -1)).toBe("d");
    expect(stepSession(["a"], "a", 1)).toBeUndefined();
    expect(stepSession([], undefined, 1)).toBeUndefined();
  });

  test("⇧⌘A goes round the sessions that need you", () => {
    const needs = (id: string) => id === "b" || id === "d";
    expect(nextNeedingYou(order, needs, undefined)).toBe("b");
    expect(nextNeedingYou(order, needs, "b")).toBe("d");
    expect(nextNeedingYou(order, needs, "d")).toBe("b");
    expect(nextNeedingYou(order, needs, "c")).toBe("d");
    expect(nextNeedingYou(order, (id) => id === "b", "b")).toBeUndefined();
    expect(nextNeedingYou(order, () => false, "a")).toBeUndefined();
  });
});

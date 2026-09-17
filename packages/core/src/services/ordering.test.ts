import { describe, expect, test } from "vitest";
import { DaedalusError } from "../errors";
import { applyManualOrder } from "./ordering";

const order = (current: string[], subset: string[]) =>
  applyManualOrder(current, subset, "Workspace");

describe("applying a manual order", () => {
  test("reorders a list the caller names in full", () => {
    expect(order(["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
  });

  test("leaves the items it was not given exactly where they are", () => {
    // The archived workspace `b` sits between two visible ones. Dragging `c`
    // above `a` must not drag it past `b` as a side effect.
    expect(order(["a", "b", "c"], ["c", "a"])).toEqual(["c", "b", "a"]);
    expect(order(["a", "b", "c", "d"], ["d", "b"])).toEqual([
      "a",
      "d",
      "c",
      "b",
    ]);
  });

  test("naming one item is a no-op rather than a move to the front", () => {
    expect(order(["a", "b", "c"], ["b"])).toEqual(["a", "b", "c"]);
  });

  test("an empty reorder changes nothing", () => {
    expect(order(["a", "b"], [])).toEqual(["a", "b"]);
  });

  test("rejects an item the list does not hold", () => {
    expect(() => order(["a", "b"], ["a", "zzz"])).toThrow(DaedalusError);
    expect(() => order(["a", "b"], ["a", "zzz"])).toThrow(
      "Workspace 'zzz' was not found",
    );
  });

  test("rejects a duplicate rather than dropping one silently", () => {
    // Two cards claiming one slot means the caller's model of the list is
    // wrong; quietly picking a winner would hide that.
    expect(() => order(["a", "b"], ["a", "a"])).toThrow(
      "Workspace 'a' was listed twice in the new order",
    );
  });

  test("never adds, drops, or duplicates a member", () => {
    const current = ["a", "b", "c", "d", "e"];
    const result = order(current, ["e", "c", "a"]);
    expect([...result].sort()).toEqual([...current].sort());
    expect(result).toHaveLength(current.length);
  });
});

import { describe, expect, test } from "vitest";
import {
  type NavHistory,
  type Place,
  emptyHistory,
  moveTo,
  placeId,
  stepTarget,
  visit,
} from "./history";

const session = (id: string, workspaceId = "w"): Place => ({
  workspaceId,
  kind: "session",
  id,
});
const anywhere = () => true;

const walk = (...places: Place[]): NavHistory =>
  places.reduce((history, place) => visit(history, place), emptyHistory);

describe("visit", () => {
  test("adds each new place and points at it", () => {
    const history = walk(session("a"), session("b"));
    expect(history.places).toEqual([session("a"), session("b")]);
    expect(history.cursor).toBe(1);
  });

  test("the place already shown changes nothing", () => {
    const history = walk(session("a"));
    expect(visit(history, session("a"))).toBe(history);
  });

  test("tells places apart by workspace and kind", () => {
    const history = walk(
      session("a", "w1"),
      session("a", "w2"),
      { workspaceId: "w2", kind: "task", id: "a" },
      { workspaceId: "w2", kind: "board" },
    );
    expect(history.places).toHaveLength(4);
  });

  test("a new place after going back drops the places ahead", () => {
    const back = moveTo(walk(session("a"), session("b"), session("c")), 0);
    const history = visit(back, session("d"));
    expect(history.places).toEqual([session("a"), session("d")]);
    expect(history.cursor).toBe(1);
  });

  test("arriving at the place a step went to keeps the places ahead", () => {
    const back = moveTo(walk(session("a"), session("b")), 0);
    expect(visit(back, session("a"))).toBe(back);
  });

  test("forgets the oldest places past the limit", () => {
    const history = [1, 2, 3, 4].reduce(
      (current, n) => visit(current, session(String(n)), 3),
      emptyHistory,
    );
    expect(history.places).toEqual([session("2"), session("3"), session("4")]);
    expect(history.cursor).toBe(2);
  });
});

describe("stepTarget", () => {
  const history = walk(session("a"), session("b"), session("c"));

  test("back is the place before, forward the place after", () => {
    expect(stepTarget(history, -1, anywhere)).toBe(1);
    expect(stepTarget(moveTo(history, 0), 1, anywhere)).toBe(1);
  });

  test("nothing at either end", () => {
    expect(stepTarget(history, 1, anywhere)).toBeUndefined();
    expect(stepTarget(moveTo(history, 0), -1, anywhere)).toBeUndefined();
    expect(stepTarget(emptyHistory, -1, anywhere)).toBeUndefined();
  });

  test("steps over a place that can no longer be opened", () => {
    const open = (place: Place) => placeId(place) !== "b";
    expect(stepTarget(history, -1, open)).toBe(0);
    expect(stepTarget(moveTo(history, 0), -1, open)).toBeUndefined();
  });

  test("steps over the place already shown", () => {
    // a, b (gone), a: back from the second a would land on a again.
    const looped = walk(session("a"), session("b"), session("a"));
    const open = (place: Place) => placeId(place) !== "b";
    expect(stepTarget(looped, -1, open)).toBeUndefined();
  });
});

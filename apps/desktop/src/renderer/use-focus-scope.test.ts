import { describe, expect, test } from "vitest";
import {
  holdInert,
  pickRestoreTarget,
  releaseInert,
  topmostIndex,
  trapTab,
} from "./use-focus-scope";

describe("trapTab", () => {
  test("wraps from the last stop to the first, and back", () => {
    expect(trapTab(3, 2, false)).toBe(0);
    expect(trapTab(3, 0, true)).toBe(2);
  });

  test("leaves a move between middle stops to the browser", () => {
    expect(trapTab(3, 0, false)).toBeUndefined();
    expect(trapTab(3, 1, false)).toBeUndefined();
    expect(trapTab(3, 2, true)).toBeUndefined();
  });

  test("from the scope itself, goes to the first or the last stop", () => {
    expect(trapTab(3, -1, false)).toBe(0);
    expect(trapTab(3, -1, true)).toBe(2);
  });

  test("a single stop keeps focus on it either way", () => {
    expect(trapTab(1, 0, false)).toBe(0);
    expect(trapTab(1, 0, true)).toBe(0);
  });

  test("with no stops, focus stays on the scope", () => {
    expect(trapTab(0, -1, false)).toBe(-1);
    expect(trapTab(0, -1, true)).toBe(-1);
  });
});

describe("pickRestoreTarget", () => {
  const element = (
    name: string,
    options: { connected?: boolean; disabled?: boolean; inert?: boolean } = {},
  ) => ({
    name,
    isConnected: options.connected ?? true,
    disabled: options.disabled ?? false,
    closest: (selector: string) =>
      selector === "[inert]" && options.inert ? {} : null,
  });

  test("gives focus back to the element that had it", () => {
    const opener = element("opener");
    expect(pickRestoreTarget([opener, element("list")])).toBe(opener);
  });

  test("falls back to the container when the opener is gone", () => {
    const list = element("list");
    expect(
      pickRestoreTarget([element("opener", { connected: false }), list]),
    ).toBe(list);
  });

  test("skips a disabled opener and one under an inert page", () => {
    const list = element("list");
    expect(
      pickRestoreTarget([
        element("disabled", { disabled: true }),
        element("behind", { inert: true }),
        list,
      ]),
    ).toBe(list);
  });

  test("finds nothing when nothing is left", () => {
    expect(
      pickRestoreTarget([null, undefined, element("x", { connected: false })]),
    ).toBeUndefined();
  });
});

describe("holdInert and releaseInert", () => {
  test("an element stays inert until the last scope holding it lets go", () => {
    const page = { inert: false };
    expect(holdInert(page)).toBe(true); // the dialog
    expect(holdInert(page)).toBe(true); // a confirm over it
    // The dialog closes first: the confirm is still open.
    releaseInert(page);
    expect(page.inert).toBe(true);
    releaseInert(page);
    expect(page.inert).toBe(false);
  });

  test("an element inert before any scope is not ours to wake", () => {
    const hidden = { inert: true };
    expect(holdInert(hidden)).toBe(false);
    releaseInert(hidden);
    expect(hidden.inert).toBe(true);
  });
});

describe("topmostIndex", () => {
  // Positions in the document; a later one is drawn on top.
  const follows = (a: number, b: number) => b > a;

  test("the scope last in the document is on top, whenever it opened", () => {
    // A confirm (position 9) open before a dialog (position 4) stays on top.
    expect(topmostIndex([9, 4], follows)).toBe(0);
    expect(topmostIndex([4, 9], follows)).toBe(1);
    expect(topmostIndex([1, 7, 3], follows)).toBe(1);
  });

  test("no scopes, no top", () => {
    expect(topmostIndex([], follows)).toBeUndefined();
  });
});

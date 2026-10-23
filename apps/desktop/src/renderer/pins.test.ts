import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { DEFAULT_PINS, readPins } from "./pins";

const store = new Map<string, string>();
const global = globalThis as { window?: unknown };
const before = global.window;

// Other test files share this process; the stand-in window goes after.
beforeAll(() => {
  global.window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  };
});
afterAll(() => {
  if (before === undefined) delete global.window;
  else global.window = before;
});
afterEach(() => store.clear());

describe("pins", () => {
  test("start with rebirth, cloud and archive on sessions and nothing extra on workspaces", () => {
    expect(readPins()).toEqual(DEFAULT_PINS);
  });

  test("keep only the actions they know", () => {
    store.set(
      "daedalus.pins",
      JSON.stringify({ workspace: ["terminal", "bogus"], session: ["cloud"] }),
    );
    const pins = readPins();
    expect([...pins.workspace]).toEqual(["terminal"]);
    expect([...pins.session]).toEqual(["cloud"]);
  });

  test("a broken entry falls back to the defaults", () => {
    store.set("daedalus.pins", "{not json");
    expect(readPins()).toEqual(DEFAULT_PINS);
  });
});

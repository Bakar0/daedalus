import { describe, expect, test } from "bun:test";
import { filterTools } from "./client";

const { distance, find, matches } = filterTools();

describe("admin filter", () => {
  test("distance counts edits and a swap of neighbours as one", () => {
    expect(distance("asleep", "asleep")).toBe(0);
    expect(distance("aslep", "asleep")).toBe(1);
    expect(distance("aselep", "asleep")).toBe(1);
    expect(distance("", "abc")).toBe(3);
  });

  test("finds substrings anywhere, case aside", () => {
    expect(find("Dana@Example.com", "example")).toEqual([5, 12]);
    expect(find("0f8e2c1a-7b3d-4e5f", "7b3d")).toEqual([9, 13]);
    expect(find("website", "xyz")).toBeNull();
  });

  test("tolerates one typo from 4 letters and two from 8, on a word or its start", () => {
    expect(find("Asleep", "aslep")).toEqual([0, 6]);
    expect(find("failed", "fialed")).toEqual([0, 6]);
    // The start of a longer word: "pipline" for "pipeline".
    expect(find("data pipeline", "pipline")).toEqual([5, 13]);
    expect(find("data pipeline", "pipelnie")).not.toBeNull();
    expect(find("bob@example.com", "exmaple")).toEqual([4, 11]);
    // Short terms must match exactly.
    expect(find("run", "rn")).toBeNull();
    expect(find("app", "apq")).toBeNull();
    // Two typos are too many for a short term.
    expect(find("running", "rnuing")).toBeNull();
  });

  test("every term must match some field", () => {
    const fields = [
      "dana@example.com",
      "dznz6r5ggm5a",
      "website <redesign>",
      "57d3d500-1e49-46f8-a07e-9c1da72dfc6e",
      "Asleep asleep sleeping",
    ];
    expect(matches(fields, ["dana", "asleep"])).toBe(true);
    expect(matches(fields, ["dana", "running"])).toBe(false);
    expect(matches(fields, ["websit", "57d3"])).toBe(true);
    expect(matches(fields, [])).toBe(true);
  });
});

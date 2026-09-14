import { describe, expect, test } from "vitest";
import { fuzzyScore, repositoryFuzzyScore } from "./repository-search";

describe("repository fuzzy search", () => {
  test("matches non-contiguous characters", () => {
    expect(fuzzyScore("dls", "daedalus")).toBeTypeOf("number");
    expect(fuzzyScore("xyz", "daedalus")).toBeUndefined();
  });

  test("ranks exact, prefix, consecutive, and boundary matches higher", () => {
    expect(fuzzyScore("code", "code")).toBeGreaterThan(
      fuzzyScore("code", "decode-tools") ?? 0,
    );
    expect(fuzzyScore("repo", "repository-tools")).toBeGreaterThan(
      fuzzyScore("repo", "remote-example-project-object") ?? 0,
    );
    expect(fuzzyScore("dt", "dev-tools")).toBeGreaterThan(
      fuzzyScore("dt", "data") ?? 0,
    );
  });

  test("requires every whitespace-separated term", () => {
    expect(fuzzyScore("daed app", "barak/daedalus-app")).toBeTypeOf("number");
    expect(fuzzyScore("daed missing", "barak/daedalus-app")).toBeUndefined();
  });

  test("prefers a repository name match over owner metadata", () => {
    expect(
      repositoryFuzzyScore("dae", "daedalus", "other/project"),
    ).toBeGreaterThan(
      repositoryFuzzyScore("dae", "project", "daedalus/project") ?? 0,
    );
  });
});

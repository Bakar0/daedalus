import { describe, expect, test } from "bun:test";
import { normalizeWorkspaceSlug, workspaceNameProblem } from "./index";

const existing = [
  { slug: "my-app", name: "My App", archivedAt: null },
  { slug: "old", name: "Old", archivedAt: "2026-01-01T00:00:00.000Z" },
];

describe("normalizeWorkspaceSlug", () => {
  test("lower-cases and joins each run of other characters with a hyphen", () => {
    expect(normalizeWorkspaceSlug("  My  App!! 2 ")).toBe("my-app-2");
    expect(normalizeWorkspaceSlug("--x--")).toBe("x");
    expect(normalizeWorkspaceSlug("!!!")).toBe("");
  });
});

describe("workspaceNameProblem", () => {
  test("takes a free name", () => {
    expect(workspaceNameProblem("Fresh", existing)).toBeUndefined();
  });

  test("names the workspace that already has the slug", () => {
    expect(workspaceNameProblem("my app", existing)).toBe(
      'A workspace named "My App" already exists',
    );
    expect(workspaceNameProblem("OLD", existing)).toBe(
      'An archived workspace is named "Old"',
    );
  });

  test("says what the core would refuse", () => {
    expect(workspaceNameProblem("  ", existing)).toBe("Enter a name");
    expect(workspaceNameProblem("!!!", existing)).toBe(
      "Use at least one letter or number",
    );
    expect(workspaceNameProblem("a".repeat(121), existing)).toBe(
      "Use at most 120 characters",
    );
    expect(workspaceNameProblem("a".repeat(64), existing)).toBe(
      "Use a shorter name",
    );
  });
});

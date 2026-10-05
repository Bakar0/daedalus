import { describe, expect, test } from "vitest";
import { findPathCandidates } from "./terminal-file-links";

describe("findPathCandidates", () => {
  const paths = (line: string) =>
    findPathCandidates(line).map(({ path, line, column }) => ({
      path,
      ...(line ? { line } : {}),
      ...(column ? { column } : {}),
    }));

  test("finds relative and absolute paths with line and column", () => {
    expect(
      paths(
        "Updated apps/desktop/src/App.tsx:42:7 and ./notes.md:3, see /Users/me/x.ts(10,2)",
      ),
    ).toEqual([
      { path: "apps/desktop/src/App.tsx", line: 42, column: 7 },
      { path: "./notes.md", line: 3 },
      { path: "/Users/me/x.ts", line: 10, column: 2 },
    ]);
  });

  test("takes a bare file name with an extension, and a dotted folder path", () => {
    expect(paths("Read(BRIEF.md) then packages/core")).toEqual([
      { path: "BRIEF.md" },
      { path: "packages/core" },
    ]);
  });

  test("leaves URLs, version numbers and plain words alone", () => {
    expect(
      paths("see https://example.com/docs/a.html v1.2.3 and done. 0.11.3"),
    ).toEqual([]);
  });
});

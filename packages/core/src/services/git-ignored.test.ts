import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@daedalus/platform";
import { IgnoredPaths, ignoredPathMatcher } from "./git-ignored";

describe("ignoredPathMatcher", () => {
  const matches = ignoredPathMatcher("dist/\0debug.log\0src/cache/\0");
  test("a listed file, and everything under a listed folder", () => {
    expect(matches("debug.log")).toBe(true);
    expect(matches("dist")).toBe(true);
    expect(matches("dist/app.js")).toBe(true);
    expect(matches("dist/deep/chunk.js")).toBe(true);
    expect(matches("src/cache/entry")).toBe(true);
  });
  test("nothing git would report", () => {
    expect(matches("src/index.ts")).toBe(false);
    expect(matches("distribution/app.js")).toBe(false);
    expect(matches("src/cached")).toBe(false);
    expect(matches("other/debug.log")).toBe(false);
  });
});

describe("IgnoredPaths", () => {
  test("learns what git ignores, and forgets it when a .gitignore changes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "daedalus-ignored-"));
    try {
      await runCommand("git", ["-C", repo, "init", "-q"]);
      await writeFile(join(repo, ".gitignore"), "dist/\n*.log\n");
      await mkdir(join(repo, "dist"));
      await writeFile(join(repo, "dist", "app.js"), "");
      await writeFile(join(repo, "build.log"), "");
      await writeFile(join(repo, "index.ts"), "");
      let listings = 0;
      const ignored = new IgnoredPaths((...args) => {
        listings += 1;
        return runCommand(...args);
      });

      // Nothing counts as ignored before the listing has arrived.
      expect(ignored.matches(repo, "dist/app.js")).toBe(false);
      await ignored.settle();
      expect(ignored.matches(repo, "dist/app.js")).toBe(true);
      expect(ignored.matches(repo, "dist/new-chunk.js")).toBe(true);
      expect(ignored.matches(repo, "build.log")).toBe(true);
      expect(ignored.matches(repo, "index.ts")).toBe(false);
      expect(listings).toBe(1);

      // The edit to the rules is itself a change, and the next question
      // lists again.
      expect(ignored.matches(repo, ".gitignore")).toBe(false);
      await writeFile(join(repo, ".gitignore"), "*.log\n");
      expect(ignored.matches(repo, "dist/app.js")).toBe(false);
      await ignored.settle();
      expect(ignored.matches(repo, "dist/app.js")).toBe(false);
      expect(ignored.matches(repo, "build.log")).toBe(true);
      expect(listings).toBe(2);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

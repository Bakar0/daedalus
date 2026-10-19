import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspacePath, toWorkspacePath } from "./paths";

let root: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-root-"));
  outside = mkdtempSync(join(tmpdir(), "runner-outside-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("accepts paths inside the workspace", () => {
  expect(resolveWorkspacePath(root, "")).toBe(root);
  expect(resolveWorkspacePath(root, ".")).toBe(root);
  expect(resolveWorkspacePath(root, "a/b/../c.txt")).toBe(
    join(root, "a/c.txt"),
  );
});

test("refuses absolute paths and parent traversal", () => {
  expect(() => resolveWorkspacePath(root, "/etc/passwd")).toThrow();
  expect(() => resolveWorkspacePath(root, "../x")).toThrow();
  expect(() => resolveWorkspacePath(root, "a/../../x")).toThrow();
  expect(() => resolveWorkspacePath(root, "a\0b")).toThrow();
});

test("refuses a symlink that points out of the workspace", () => {
  symlinkSync(outside, join(root, "link"));
  expect(() => resolveWorkspacePath(root, "link/file")).toThrow(/link/);
  mkdirSync(join(root, "real"));
  expect(resolveWorkspacePath(root, "real/file")).toBe(join(root, "real/file"));
});

test("toWorkspacePath maps a directory or falls back to the root", () => {
  expect(toWorkspacePath(root, join(root, "a/b"))).toBe("a/b");
  expect(toWorkspacePath(root, root)).toBe(".");
  expect(toWorkspacePath(root, "/somewhere/else")).toBe(".");
});

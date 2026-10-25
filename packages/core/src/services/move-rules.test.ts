import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@daedalus/platform";
import { snapshotRepository } from "./move-git";
import { LocalMoveSide } from "./move-side";
import {
  lastPermissionMode,
  rewriteTranscript,
  safeTranscriptPath,
} from "./move-transcript";

let root: string;

const git = async (cwd: string, ...args: string[]) => {
  const result = await runCommand(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd },
  );
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "daedalus-move-rules-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("move rules", () => {
  test("two snapshots of an unchanged repository are two commits", async () => {
    const repo = join(root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-q");
    await writeFile(join(repo, "a.txt"), "a\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "a");
    const side = new LocalMoveSide();
    const [first, second] = [
      await snapshotRepository(side, repo),
      await snapshotRepository(side, repo),
    ];
    // Within one second they would otherwise be the same commit, and a
    // bundle against the first would leave the second out.
    expect(second.work).not.toBe(first.work);
    expect(second.index).not.toBe(first.index);
    expect(await git(repo, "rev-parse", `${second.work}^{tree}`)).toBe(
      await git(repo, "rev-parse", `${first.work}^{tree}`),
    );
  });

  test("rewrites cwd and the permission mode, and reads the last mode", () => {
    const text = [
      JSON.stringify({ type: "permission-mode", permissionMode: "plan" }),
      JSON.stringify({ cwd: "/a/b", permissionMode: "plan" }),
      JSON.stringify({ cwd: "/a/bc" }),
      "",
    ].join("\n");
    expect(lastPermissionMode(text)).toBe("plan");
    const out = rewriteTranscript(text, {
      from: "/a/b",
      to: "/workspace/x",
      permissionMode: "auto",
      strict: true,
    });
    expect(out).toContain('"cwd":"/workspace/x"');
    expect(out).toContain('"cwd":"/a/bc"');
    expect(out).not.toContain('"plan"');
    expect(() =>
      rewriteTranscript("[1]\n", { from: "/a", to: "/b", strict: true }),
    ).toThrow();
    expect(safeTranscriptPath("subagents/a.jsonl")).toBe(true);
    expect(safeTranscriptPath("../x")).toBe(false);
    expect(safeTranscriptPath("a/b/c/d")).toBe(false);
  });
});

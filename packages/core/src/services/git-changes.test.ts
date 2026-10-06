import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChangedFiles } from "./workspace-content";

const git = async (cwd: string, ...args: string[]) => {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string | undefined>),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  const stdout = await new Response(child.stdout).text();
  await child.exited;
  return stdout;
};

describe("parseChangedFiles", () => {
  test("reads real git output: added, modified, deleted, renamed, binary", async () => {
    const repo = await mkdtemp(join(tmpdir(), "daedalus-changes-"));
    try {
      await git(repo, "init", "-q");
      await writeFile(join(repo, "keep.ts"), "a\nb\n");
      await writeFile(join(repo, "gone.ts"), "x\n");
      await writeFile(
        join(repo, "old name.md"),
        "same content long enough to be a rename\n".repeat(5),
      );
      await writeFile(join(repo, "logo.bin"), new Uint8Array([0, 1, 2]));
      await git(repo, "add", "-A");
      await git(repo, "commit", "-qm", "base");
      const base = (await git(repo, "rev-parse", "HEAD")).trim();
      await writeFile(join(repo, "keep.ts"), "a\nB\nc\n");
      await rm(join(repo, "gone.ts"));
      await git(repo, "mv", "old name.md", "new name.md");
      await writeFile(join(repo, "fresh.ts"), "1\n2\n");
      await writeFile(join(repo, "logo.bin"), new Uint8Array([0, 9, 9, 9]));
      await git(repo, "add", "fresh.ts");
      const files = parseChangedFiles(
        await git(repo, "diff", "--name-status", "-z", "-M", base),
        await git(repo, "diff", "--numstat", "-z", "-M", base),
      );
      const byPath = Object.fromEntries(
        files.map((file) => [file.repositoryPath, file]),
      );
      expect(byPath["keep.ts"]).toEqual({
        repositoryPath: "keep.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
      });
      expect(byPath["gone.ts"]).toMatchObject({
        status: "deleted",
        deletions: 1,
      });
      expect(byPath["fresh.ts"]).toMatchObject({
        status: "added",
        additions: 2,
      });
      expect(byPath["new name.md"]).toMatchObject({
        status: "renamed",
        originalRepositoryPath: "old name.md",
        additions: 0,
        deletions: 0,
      });
      expect(byPath["logo.bin"]).toEqual({
        repositoryPath: "logo.bin",
        status: "modified",
      });
      expect(files).toHaveLength(5);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

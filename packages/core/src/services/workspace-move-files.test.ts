import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalMoveSide } from "./move-side";
import {
  applyFromPod,
  insideFolders,
  safeWorkspacePath,
  unpackFromPod,
} from "./workspace-move-files";

const TREE = "worktrees/unassigned/claude-1/app";

let base: string;
let root: string;
const local = new LocalMoveSide();

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "daedalus-move-files-"));
  root = join(base, "workspace");
  // A worktree's .git is a file naming its git folder.
  await mkdir(join(root, TREE), { recursive: true });
  await writeFile(join(root, TREE, ".git"), "gitdir: /library/app.git\n");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** An archive as a pod would pack it, holding `files`. */
async function podArchive(files: Record<string, string>): Promise<string> {
  const staging = join(base, "staging");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(staging, path)), { recursive: true });
    await writeFile(join(staging, path), text);
  }
  const archive = join(base, "files.tar");
  await local.run(staging, "tar", ["-c", "-f", archive, ...Object.keys(files)]);
  return archive;
}

/** What `#toMac` does with an archive, or the refusal. */
async function bringHome(
  files: Record<string, string>,
  expected = new Set(Object.keys(files)),
) {
  const archive = await podArchive(files);
  const scratch = join(base, "scratch");
  await mkdir(scratch, { recursive: true });
  const skip = new Set([TREE, "repos/app"]);
  const arrived = await unpackFromPod(local, archive, scratch, {
    expected,
    skip,
  });
  await applyFromPod(root, scratch, arrived, [], skip);
}

describe("files coming home from the pod", () => {
  test("refuse .git and Daedalus's folders in any case or Unicode form", () => {
    for (const path of [
      "a/.git/config",
      "a/.GIT/config",
      "a/.gi​t/config",
      "a/.ｇｉｔ/config",
      "notes/.Daedalus/x",
      ".HOME/.claude.json",
      ".Daedalus-Move/x",
    ])
      expect(safeWorkspacePath(path)).toBe(false);
    expect(safeWorkspacePath("notes/git.md")).toBe(true);
  });

  test("a worktree's .git file is never replaced", async () => {
    for (const name of [".git", ".GIT"])
      await expect(
        bringHome({ [`${TREE}/${name}`]: "gitdir: /tmp/evil\n" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(root, TREE, ".git"), "utf8")).toBe(
      "gitdir: /library/app.git\n",
    );
  });

  test("nothing lands inside a worktree or a reference checkout, in any case", async () => {
    for (const path of [
      `${TREE}/src/x.ts`,
      `${TREE.toUpperCase()}/src/x.ts`,
      "repos/app/README.md",
      "REPOS/App/README.md",
    ])
      await expect(bringHome({ [path]: "x\n" })).rejects.toMatchObject({
        code: "CONFLICT",
      });
    expect(insideFolders("repos/application/x", new Set(["repos/app"]))).toBe(
      false,
    );
  });

  test("an archive holding more than this Mac asked for is refused", async () => {
    await expect(
      bringHome(
        { "notes/a.md": "a\n", "notes/b.md": "b\n" },
        new Set(["notes/a.md"]),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("plain files come home", async () => {
    await bringHome({ "notes/a.md": "a\n", "BRIEF.md": "brief\n" });
    expect(await readFile(join(root, "notes", "a.md"), "utf8")).toBe("a\n");
    expect(await readFile(join(root, "BRIEF.md"), "utf8")).toBe("brief\n");
  });
});

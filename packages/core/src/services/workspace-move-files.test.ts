import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
  // As the pod's GNU tar packs it: no `._` entries.
  await local.run(
    staging,
    "tar",
    ["-c", "-f", archive, ...Object.keys(files)],
    { COPYFILE_DISABLE: "1" },
  );
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

/** One tar header block, as GNU tar writes it, with a correct checksum. */
function header(name: string, type: string, size: number): Uint8Array {
  const block = new Uint8Array(512);
  const put = (text: string, at: number) =>
    block.set(new TextEncoder().encode(text), at);
  put(name, 0);
  put("0000644\0", 100);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124);
  put(type, 156);
  put("ustar  \0", 257);
  block.fill(32, 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

/** An archive of the given header blocks and data, ended as tar ends one. */
async function handMade(...parts: Uint8Array[]): Promise<string> {
  const archive = join(base, "hand.tar");
  const padded = parts.map((part) => {
    const out = new Uint8Array(Math.ceil(part.length / 512) * 512);
    out.set(part);
    return out;
  });
  await writeFile(archive, Buffer.concat([...padded, new Uint8Array(1024)]));
  return archive;
}

describe("reading the pod's archive", () => {
  const unpack = async (archive: string, maxBytes?: number) => {
    const scratch = join(base, "scratch");
    await mkdir(scratch, { recursive: true });
    try {
      return await unpackFromPod(local, archive, scratch, {
        ...(maxBytes ? { maxBytes } : {}),
      });
    } finally {
      // Nothing is written when anything is refused.
      if (!(await readdir(scratch)).length)
        await rm(scratch, { recursive: true });
    }
  };

  test("takes regular files and GNU long names", async () => {
    const long = `notes/${"n".repeat(120)}.md`;
    const archive = await handMade(
      header("notes/a.md", "0", 2),
      new TextEncoder().encode("a\n"),
      header("././@LongLink", "L", long.length + 1),
      new TextEncoder().encode(`${long}\0`),
      header(long.slice(0, 99), "0", 2),
      new TextEncoder().encode("b\n"),
    );
    expect(await unpack(archive)).toEqual([long, "notes/a.md"].sort());
    expect(await readFile(join(base, "scratch", long), "utf8")).toBe("b\n");
  });

  test("refuses sparse, special and global entries before writing anything", async () => {
    for (const type of ["S", "3", "4", "6", "2", "1", "5", "g"]) {
      const archive = await handMade(
        header("notes/a.md", "0", 2),
        new TextEncoder().encode("a\n"),
        header("notes/b.md", type, 0),
      );
      await expect(unpack(archive)).rejects.toBeInstanceOf(Error);
      expect(await exists(join(base, "scratch", "notes", "a.md"))).toBe(false);
    }
  });

  test("refuses a header whose checksum is wrong", async () => {
    const bad = header("notes/a.md", "0", 2);
    bad[0] = "m".charCodeAt(0);
    await expect(
      unpack(await handMade(bad, new TextEncoder().encode("a\n"))),
    ).rejects.toMatchObject({ code: "DEPENDENCY" });
  });

  test("stops at the cap on unpacked bytes", async () => {
    const archive = await handMade(
      header("notes/a.md", "0", 600),
      new Uint8Array(600).fill(97),
    );
    await expect(unpack(archive, 512)).rejects.toThrow("more than 512 bytes");
    expect(await unpack(archive, 600)).toEqual(["notes/a.md"]);
  });
});

const exists = (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  );

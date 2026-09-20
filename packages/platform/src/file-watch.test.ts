import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  coalesceFileChanges,
  isIgnoredWatchPath,
  watchFileTree,
  type FileChange,
  type FileChangeBatch,
} from "./file-watch";

const added = (
  path: string,
  entryKind: "file" | "directory" = "file",
): FileChange => ({
  path,
  kind: "added",
  entryKind,
});
const updated = (
  path: string,
  entryKind: "file" | "directory" = "file",
): FileChange => ({
  path,
  kind: "updated",
  entryKind,
});
const deleted = (path: string): FileChange => ({
  path,
  kind: "deleted",
  entryKind: null,
});

describe("coalesceFileChanges", () => {
  test("keeps unrelated changes as they are", () => {
    expect(
      coalesceFileChanges([added("a.txt"), updated("b.txt"), deleted("c.txt")]),
    ).toEqual([added("a.txt"), updated("b.txt"), deleted("c.txt")]);
  });

  test("drops a file that was created and deleted inside one window", () => {
    // Nothing watching ever had a chance to see it, so reporting either half
    // would describe a file that never existed as far as the consumer knows.
    expect(coalesceFileChanges([added("tmp.swp"), deleted("tmp.swp")])).toEqual(
      [],
    );
  });

  test("reads delete-then-create as an update", () => {
    // This is how an atomic save arrives: write a temporary file, rename it
    // over the original. The original is not gone, it is different.
    expect(
      coalesceFileChanges([deleted("BRIEF.md"), added("BRIEF.md")]),
    ).toEqual([updated("BRIEF.md")]);
  });

  test("a write that follows a creation is still a creation", () => {
    expect(coalesceFileChanges([added("new.md"), updated("new.md")])).toEqual([
      added("new.md"),
    ]);
  });

  test("a later delete supersedes an earlier update", () => {
    expect(
      coalesceFileChanges([updated("gone.md"), deleted("gone.md")]),
    ).toEqual([deleted("gone.md")]);
  });

  test("a deleted directory swallows every change beneath it", () => {
    // `rm -r` of a 500-file directory produces 500 unordered child events plus
    // the parent's own, and never collapses them itself.
    expect(
      coalesceFileChanges([
        deleted("worktrees/alpha/notes.md"),
        deleted("worktrees/alpha/src/main.ts"),
        deleted("worktrees/alpha"),
        updated("BRIEF.md"),
      ]),
    ).toEqual([deleted("worktrees/alpha"), updated("BRIEF.md")]);
  });

  test("coalescing by ancestor does not need the parent's event to arrive last", () => {
    // It does not arrive last in practice — the parent's event is buried
    // among the children, in whatever order the kernel produced them.
    expect(
      coalesceFileChanges([
        deleted("docs"),
        deleted("docs/a.md"),
        deleted("docs/nested/b.md"),
      ]),
    ).toEqual([deleted("docs")]);
  });

  test("a deleted sibling never swallows a path that merely shares its prefix", () => {
    expect(
      coalesceFileChanges([deleted("repos"), updated("repos-backup/a.md")]),
    ).toEqual([deleted("repos"), updated("repos-backup/a.md")]);
  });

  test("a surviving directory does not swallow anything", () => {
    expect(
      coalesceFileChanges([updated("docs"), added("docs/new.md")]),
    ).toEqual([updated("docs"), added("docs/new.md")]);
  });
});

describe("isIgnoredWatchPath", () => {
  test("drops Git and dependency churn wherever it appears", () => {
    expect(isIgnoredWatchPath(".git/index")).toBe(true);
    expect(isIgnoredWatchPath("repos/daedalus/.git/ORIG_HEAD")).toBe(true);
    expect(isIgnoredWatchPath("worktrees/a/node_modules/react/index.js")).toBe(
      true,
    );
  });

  test("keeps paths that only look like them", () => {
    expect(isIgnoredWatchPath("BRIEF.md")).toBe(false);
    expect(isIgnoredWatchPath("docs/.gitignore")).toBe(false);
    expect(isIgnoredWatchPath("notes/node_modules.md")).toBe(false);
  });
});

/**
 * The classification half cannot be proven without a filesystem: the whole
 * point is that the reported event type says nothing and `stat` says
 * everything. These use a real temporary directory and a real watcher.
 */
describe("watchFileTree", () => {
  const collect = async (
    act: (root: string) => Promise<void>,
    options: { overflowLimit?: number } = {},
  ): Promise<FileChangeBatch[]> => {
    const root = await mkdtemp(join(tmpdir(), "daedalus-watch-"));
    const batches: FileChangeBatch[] = [];
    // Born before the watcher starts, so it can only ever read as `updated`.
    await writeFile(join(root, "BRIEF.md"), "before");
    await new Promise((settle) => setTimeout(settle, 20));
    const watcher = watchFileTree({
      root,
      debounceMs: 40,
      ...(options.overflowLimit === undefined
        ? {}
        : { overflowLimit: options.overflowLimit }),
      onChanges: (batch) => batches.push(batch),
    });
    try {
      await new Promise((settle) => setTimeout(settle, 60));
      await act(root);
      // Waits for the watcher to go quiet rather than for a fixed duration.
      // A flat sleep is a race that happens to be winnable on an idle machine
      // — the sibling check in `workspace-watch.test.ts` lost it about one run
      // in five under load before it was written this way.
      let seen = -1;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((settle) => setTimeout(settle, 100));
        if (batches.length === seen && attempt > 2) break;
        seen = batches.length;
      }
    } finally {
      watcher.close();
      await rm(root, { recursive: true, force: true });
    }
    return batches;
  };

  const flatten = (batches: FileChangeBatch[]): FileChange[] =>
    coalesceFileChanges(batches.flatMap((batch) => batch.changes));

  test("classifies a new file as added and an existing one as updated", async () => {
    const changes = flatten(
      await collect(async (root) => {
        await writeFile(join(root, "new.md"), "hello");
        await writeFile(join(root, "BRIEF.md"), "after");
      }),
    );
    expect(changes).toContainEqual(added("new.md"));
    expect(changes).toContainEqual(updated("BRIEF.md"));
  });

  test("classifies a removed file as deleted even though the event says rename", async () => {
    const changes = flatten(
      await collect(async (root) => {
        await rm(join(root, "BRIEF.md"));
      }),
    );
    expect(changes).toEqual([deleted("BRIEF.md")]);
  });

  test("reports a rename as both halves, because the watcher never links them", async () => {
    const changes = flatten(
      await collect(async (root) => {
        await rename(join(root, "BRIEF.md"), join(root, "OVERVIEW.md"));
      }),
    );
    expect(changes.map((change) => change.path).sort()).toEqual([
      "BRIEF.md",
      "OVERVIEW.md",
    ]);
    expect(changes.find((change) => change.path === "BRIEF.md")?.kind).toBe(
      "deleted",
    );
  });

  test("reports a created directory as a directory", async () => {
    const changes = flatten(
      await collect(async (root) => {
        await mkdir(join(root, "notes"));
      }),
    );
    expect(changes).toContainEqual(added("notes", "directory"));
  });

  test("collapses a recursive delete to the directory itself", async () => {
    const batches = await collect(async (root) => {
      await mkdir(join(root, "docs", "nested"), { recursive: true });
      for (let index = 0; index < 20; index += 1)
        await writeFile(join(root, "docs", "nested", `f${index}.md`), "x");
      // Long enough to close the creation window, so the delete is its own.
      await new Promise((settle) => setTimeout(settle, 300));
      await rm(join(root, "docs"), { recursive: true, force: true });
    });
    // Asserted on the delete's own window rather than on every batch flattened
    // together: across two windows the creation and the deletion legitimately
    // cancel each other out, which is a different rule being tested above.
    expect(batches.at(-1)?.changes).toEqual([deleted("docs")]);
  });

  test("never reports Git or dependency churn", async () => {
    const changes = flatten(
      await collect(async (root) => {
        await mkdir(join(root, ".git"), { recursive: true });
        await writeFile(join(root, ".git", "index"), "x");
        await mkdir(join(root, "node_modules", "react"), { recursive: true });
        await writeFile(join(root, "node_modules", "react", "index.js"), "x");
        await writeFile(join(root, "visible.md"), "x");
      }),
    );
    expect(changes).toEqual([added("visible.md")]);
  });

  test("gives up on precision past the overflow limit and says so", async () => {
    const batches = await collect(
      async (root) => {
        await mkdir(join(root, "bulk"));
        for (let index = 0; index < 40; index += 1)
          await writeFile(join(root, "bulk", `f${index}.md`), String(index));
      },
      { overflowLimit: 8 },
    );
    const overflowed = batches.filter((batch) => batch.overflow);
    expect(overflowed.length).toBeGreaterThan(0);
    // An overflow carries nothing: the consumer is being told to re-read, not
    // handed a partial list it might trust.
    for (const batch of overflowed) expect(batch.changes).toEqual([]);
  });

  test("stops reporting once closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "daedalus-watch-"));
    const batches: FileChangeBatch[] = [];
    const watcher = watchFileTree({
      root,
      debounceMs: 40,
      onChanges: (batch) => batches.push(batch),
    });
    await new Promise((settle) => setTimeout(settle, 60));
    watcher.close();
    await writeFile(join(root, "after-close.md"), "x");
    await new Promise((settle) => setTimeout(settle, 300));
    await rm(root, { recursive: true, force: true });
    expect(batches).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand } from "@daedalus/platform";
import type { DaedalusConfig } from "../config";
import type { SessionWorktree, Workspace } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import { PodMoveSide, type PodAccess } from "./move-side";
import { MAX_EXPLORER_BYTES, PodFiles } from "./pod-files";
import { WorkspaceFiles } from "./workspace-files";
import type { WorkspaceService } from "./workspaces";

/** A pod whose workspace root is a folder, its commands run on this Mac. */
const fakePod = (podRoot: string): PodAccess => ({
  run: async ({ cwd, executable, args, env }) => {
    const result = await runCommand(executable, args, {
      cwd: join(podRoot, cwd),
      ...(env ? { env } : {}),
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
  readFile: async (path) => {
    try {
      return new Uint8Array(await readFile(join(podRoot, path)));
    } catch {
      return undefined;
    }
  },
  writeFiles: async (files) => {
    for (const file of files) {
      await mkdir(dirname(join(podRoot, file.path)), { recursive: true });
      await writeFile(join(podRoot, file.path), file.contents);
    }
  },
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

let root: string;
let podRoot: string;
let outside: string;
let pod: PodMoveSide;
let worktrees: SessionWorktree[];
let files: PodFiles;

const workspace = {
  id: "w0000000-0000-4000-8000-000000000001",
  name: "w",
  path: "/Users/someone/.daedalus/workspaces/w",
  place: "cloud",
} as Workspace;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pod-files-"));
  podRoot = join(root, "pod");
  outside = join(root, "outside");
  await mkdir(join(podRoot, "notes", "deep"), { recursive: true });
  await mkdir(join(podRoot, "repos", "app"), { recursive: true });
  await mkdir(join(podRoot, ".daedalus"), { recursive: true });
  await mkdir(join(podRoot, ".home"), { recursive: true });
  await mkdir(join(podRoot, ".daedalus-trash"), { recursive: true });
  await mkdir(join(podRoot, ".git"), { recursive: true });
  await mkdir(join(podRoot, "worktrees", "unassigned", "s1"), {
    recursive: true,
  });
  await mkdir(outside, { recursive: true });
  await writeFile(join(podRoot, "BRIEF.md"), "# Brief\n");
  await writeFile(join(podRoot, ".env"), "A=1\n");
  await writeFile(join(podRoot, "notes", "a.txt"), "alpha\n");
  await writeFile(join(podRoot, "repos", "app", "r.txt"), "ref\n");
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await symlink(outside, join(podRoot, "out"));
  await symlink(join(outside, "secret.txt"), join(podRoot, "notes", "s.txt"));
  pod = new PodMoveSide(fakePod(podRoot), MAX_EXPLORER_BYTES);
  worktrees = [];
  files = new PodFiles({
    listSessionWorktrees: () => worktrees,
  } as unknown as SqliteRepositories);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("PodFiles", () => {
  test("lists folders first, hides Daedalus's root folders and .git, marks links", async () => {
    const listed = await files.listDirectory(workspace, pod, "");
    expect(listed.map((entry) => [entry.name, entry.kind])).toEqual([
      ["notes", "directory"],
      ["repos", "directory"],
      ["worktrees", "directory"],
      [".env", "file"],
      ["BRIEF.md", "file"],
      ["out", "symlink"],
    ]);
    expect(listed.find((entry) => entry.name === "repos")?.mutable).toBe(false);
    expect(listed.find((entry) => entry.name === "out")?.mutable).toBe(false);
    expect(
      (await files.listDirectory(workspace, pod, "notes")).map((e) => e.path),
    ).toEqual(["notes/deep", "notes/a.txt", "notes/s.txt"]);
  });

  test("refuses hidden, escaping and absolute paths", async () => {
    for (const path of [".daedalus", ".home/x", "../outside", "/etc", ".git"])
      await expect(
        files.listDirectory(workspace, pod, path),
      ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  test("never follows a link, at the end of a path or on the way", async () => {
    await expect(files.readFile(pod, "notes/s.txt")).rejects.toThrow(
      /Symbolic links/,
    );
    await expect(files.readFile(pod, "out/secret.txt")).rejects.toThrow(
      /Symbolic links/,
    );
    await expect(
      files.listDirectory(workspace, pod, "out"),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      files.writeFile(pod, {
        path: "out/secret.txt",
        content: "x",
        expectedContent: "secret\n",
      }),
    ).rejects.toThrow(/Symbolic links/);
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe(
      "secret\n",
    );
  });

  test("reads text and refuses binary and missing files", async () => {
    expect(await files.readFile(pod, "BRIEF.md")).toEqual({
      name: "BRIEF.md",
      path: "BRIEF.md",
      content: "# Brief\n",
      format: "markdown",
    });
    await writeFile(join(podRoot, "bin.dat"), new Uint8Array([1, 0, 2]));
    await expect(files.readFile(pod, "bin.dat")).rejects.toThrow(/Binary/);
    await expect(files.readFile(pod, "nope.txt")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("writes only over the content the editor last saw", async () => {
    const saved = await files.writeFile(pod, {
      path: "notes/a.txt",
      content: "beta\n",
      expectedContent: "alpha\n",
    });
    expect(saved.content).toBe("beta\n");
    await expect(
      files.writeFile(pod, {
        path: "notes/a.txt",
        content: "gamma\n",
        expectedContent: "alpha\n",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(podRoot, "notes", "a.txt"), "utf8")).toBe(
      "beta\n",
    );
  });

  test("leaves reference checkouts and session worktrees alone", async () => {
    await expect(
      files.writeFile(pod, {
        path: "repos/app/r.txt",
        content: "x",
        expectedContent: "ref\n",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      files.createEntry(workspace, pod, {
        parentPath: "repos",
        name: "new.txt",
        kind: "file",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      files.removeEntry(workspace, pod, { path: "repos/app" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    worktrees = [
      {
        path: join(workspace.path, "worktrees/unassigned/s1"),
      } as SessionWorktree,
    ];
    await expect(
      files.renameEntry(workspace, pod, {
        path: "worktrees/unassigned/s1",
        name: "s2",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await exists(join(podRoot, "worktrees", "unassigned", "s1"))).toBe(
      true,
    );
  });

  test("creates, renames and moves entries", async () => {
    await files.createEntry(workspace, pod, {
      name: "plan.md",
      kind: "file",
    });
    await files.createEntry(workspace, pod, {
      name: "drafts",
      kind: "directory",
    });
    await expect(
      files.createEntry(workspace, pod, { name: "plan.md", kind: "file" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      files.createEntry(workspace, pod, {
        name: ".daedalus-trash",
        kind: "directory",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const renamed = await files.renameEntry(workspace, pod, {
      path: "plan.md",
      name: "plan-2.md",
    });
    expect(renamed.path).toBe("plan-2.md");
    const moved = await files.moveEntry(workspace, pod, {
      path: "plan-2.md",
      destinationPath: "drafts",
    });
    expect(moved.path).toBe("drafts/plan-2.md");
    expect(await exists(join(podRoot, "drafts", "plan-2.md"))).toBe(true);
    await expect(
      files.moveEntry(workspace, pod, {
        path: "notes",
        destinationPath: "notes/deep",
      }),
    ).rejects.toThrow(/inside itself/);
  });

  test("removes into the pod's trash and restores", async () => {
    const removed = await files.removeEntry(workspace, pod, {
      path: "notes/a.txt",
    });
    expect(await exists(join(podRoot, "notes", "a.txt"))).toBe(false);
    expect(
      (await files.listDirectory(workspace, pod, "")).some(
        (entry) => entry.name === ".daedalus-trash",
      ),
    ).toBe(false);
    await expect(
      files.restoreEntry(
        { ...workspace, id: "w0000000-0000-4000-8000-000000000002" },
        pod,
        { trashId: removed.trashId },
      ),
    ).rejects.toThrow(/another workspace/);
    const restored = await files.restoreEntry(workspace, pod, {
      trashId: removed.trashId,
    });
    expect(restored.path).toBe("notes/a.txt");
    expect(await readFile(join(podRoot, "notes", "a.txt"), "utf8")).toBe(
      "alpha\n",
    );
    expect(
      await exists(join(podRoot, ".daedalus-trash", removed.trashId)),
    ).toBe(false);
  });
});

describe("WorkspaceFiles in the cloud", () => {
  const service = (podFor?: () => Promise<PodMoveSide>) => {
    const files = new WorkspaceFiles(
      { listSessionWorktrees: () => [] } as unknown as SqliteRepositories,
      {
        get: async () => workspace,
        getActive: async () => workspace,
      } as unknown as WorkspaceService,
      {} as DaedalusConfig,
    );
    if (podFor) files.usePod(podFor);
    return files;
  };

  test("routes the explorer to the pod, not this Mac's folder", async () => {
    const files = service(async () => pod);
    expect(
      (await files.listDirectory(workspace.id, "notes")).map((e) => e.name),
    ).toEqual(["deep", "a.txt", "s.txt"]);
    expect((await files.readFile(workspace.id, "BRIEF.md")).content).toBe(
      "# Brief\n",
    );
  });

  test("gives the brief, journal and top folder from the pod, empty while it sleeps", async () => {
    const content = await service(async () => pod).podContent(workspace);
    expect(content?.brief).toBe("# Brief\n");
    expect(content?.journal).toBe("");
    expect(content?.files.map((entry) => entry.name)).toContain("notes");
    const asleep = service(async () => {
      throw new DaedalusError("CONFLICT", "The cloud workspace is asleep");
    });
    expect(await asleep.podContent(workspace)).toEqual({
      brief: "",
      journal: "",
      files: [],
    });
    expect(
      await service(async () => pod).podContent({
        ...workspace,
        place: undefined,
      } as Workspace),
    ).toBeUndefined();
  });

  test("refuses when nothing can reach the pod", async () => {
    await expect(service().listDirectory(workspace.id)).rejects.toThrow(
      /runs in the cloud/,
    );
  });
});

import { join } from "node:path";
import { mkdir, readFile, readdir, utimes } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { pathExists } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { createApplicationContext } from "../index";

describe("WorkspaceFiles", () => {
  describe("renaming, moving and removing entries", () => {
    const withWorkspace = async (
      body: (input: {
        context: Awaited<ReturnType<typeof createApplicationContext>>;
        workspaceId: string;
        workspacePath: string;
      }) => Promise<void>,
    ) =>
      withTemporaryDaedalusHome(async (home) => {
        const context = await createApplicationContext({
          env: { DAEDALUS_HOME: home },
          reconcile: false,
        });
        const workspace = await context.workspaces.create({ name: "Files" });
        try {
          await body({
            context,
            workspaceId: workspace.id,
            workspacePath: workspace.path,
          });
        } finally {
          context.close();
        }
      });

    test("renames a file in place and leaves its contents alone", async () => {
      await withWorkspace(async ({ context, workspaceId }) => {
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "notes.md",
          kind: "file",
        });
        await context.workspaceContent.files.writeFile({
          workspace: workspaceId,
          path: "notes.md",
          content: "# Notes\n",
          expectedContent: "",
        });
        expect(
          await context.workspaceContent.files.renameEntry({
            workspace: workspaceId,
            path: "notes.md",
            name: "ideas.md",
          }),
        ).toEqual({
          name: "ideas.md",
          path: "ideas.md",
          kind: "file",
          mutable: true,
        });
        expect(
          await context.workspaceContent.files.readFile(
            workspaceId,
            "ideas.md",
          ),
        ).toMatchObject({ content: "# Notes\n" });
        expect(
          await pathExists(
            join((await context.workspaces.get(workspaceId)).path, "notes.md"),
          ),
        ).toBe(false);
      });
    });

    test("renames a folder with everything inside it", async () => {
      await withWorkspace(async ({ context, workspaceId }) => {
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "draft",
          kind: "directory",
        });
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          parentPath: "draft",
          name: "plan.md",
          kind: "file",
        });
        await context.workspaceContent.files.renameEntry({
          workspace: workspaceId,
          path: "draft",
          name: "final",
        });
        expect(
          (
            await context.workspaceContent.files.listDirectory(
              workspaceId,
              "final",
            )
          ).map((entry) => entry.path),
        ).toEqual(["final/plan.md"]);
      });
    });

    /**
     * The filesystem is case-insensitive but case-preserving, so `README.md`
     * "already exists" when the file on disk is `Readme.md`. A naive
     * already-exists check makes fixing a file's capitalisation impossible.
     */
    test("allows a rename that only changes case", async () => {
      await withWorkspace(async ({ context, workspaceId, workspacePath }) => {
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "Readme.md",
          kind: "file",
        });
        expect(
          await context.workspaceContent.files.renameEntry({
            workspace: workspaceId,
            path: "Readme.md",
            name: "README.md",
          }),
        ).toMatchObject({ name: "README.md" });
        expect(await readdir(workspacePath)).toContain("README.md");
        expect(await readdir(workspacePath)).not.toContain("Readme.md");
      });
    });

    /**
     * `rename` overwrites an existing file silently and reports success, so
     * without an explicit check this destroys the target and says nothing.
     */
    test("refuses to rename onto a different existing entry", async () => {
      await withWorkspace(async ({ context, workspaceId }) => {
        for (const name of ["one.md", "two.md"])
          await context.workspaceContent.files.createEntry({
            workspace: workspaceId,
            name,
            kind: "file",
          });
        await context.workspaceContent.files.writeFile({
          workspace: workspaceId,
          path: "two.md",
          content: "keep me\n",
          expectedContent: "",
        });
        await expect(
          context.workspaceContent.files.renameEntry({
            workspace: workspaceId,
            path: "one.md",
            name: "two.md",
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(
          await context.workspaceContent.files.readFile(workspaceId, "two.md"),
        ).toMatchObject({ content: "keep me\n" });
      });
    });

    test("refuses a name that is not one path segment", async () => {
      await withWorkspace(async ({ context, workspaceId }) => {
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "notes.md",
          kind: "file",
        });
        for (const name of ["../escape.md", "nested/name.md", "..", ""])
          await expect(
            context.workspaceContent.files.renameEntry({
              workspace: workspaceId,
              path: "notes.md",
              name,
            }),
          ).rejects.toMatchObject({ code: "VALIDATION" });
      });
    });

    test("moves an entry into another folder and back to the root", async () => {
      await withWorkspace(async ({ context, workspaceId }) => {
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "inbox",
          kind: "directory",
        });
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "note.md",
          kind: "file",
        });
        expect(
          await context.workspaceContent.files.moveEntry({
            workspace: workspaceId,
            path: "note.md",
            destinationPath: "inbox",
          }),
        ).toEqual({
          name: "note.md",
          path: "inbox/note.md",
          kind: "file",
          mutable: true,
        });
        expect(
          await context.workspaceContent.files.moveEntry({
            workspace: workspaceId,
            path: "inbox/note.md",
            destinationPath: "",
          }),
        ).toEqual({
          name: "note.md",
          path: "note.md",
          kind: "file",
          mutable: true,
        });
      });
    });

    test("refuses to move a folder inside itself", async () => {
      await withWorkspace(async ({ context, workspaceId }) => {
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "outer",
          kind: "directory",
        });
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          parentPath: "outer",
          name: "inner",
          kind: "directory",
        });
        for (const destinationPath of ["outer", "outer/inner"])
          await expect(
            context.workspaceContent.files.moveEntry({
              workspace: workspaceId,
              path: "outer",
              destinationPath,
            }),
          ).rejects.toMatchObject({ code: "VALIDATION" });
      });
    });

    test("copies entries in with a VS Code copy suffix when the name is taken", async () => {
      await withWorkspace(async ({ context, workspaceId, workspacePath }) => {
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "inbox",
          kind: "directory",
        });
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          parentPath: "inbox",
          name: "note.md",
          kind: "file",
        });
        const copy = () =>
          context.workspaceContent.files.copyEntries({
            workspace: workspaceId,
            sources: [join(workspacePath, "inbox/note.md")],
            destinationPath: "inbox",
          });
        expect((await copy()).map((entry) => entry.path)).toEqual([
          "inbox/note copy.md",
        ]);
        expect((await copy()).map((entry) => entry.path)).toEqual([
          "inbox/note copy 2.md",
        ]);
        // A folder, recursively, into the root.
        expect(
          await context.workspaceContent.files.copyEntries({
            workspace: workspaceId,
            sources: [join(workspacePath, "inbox")],
            destinationPath: "",
          }),
        ).toEqual([
          {
            name: "inbox copy",
            path: "inbox copy",
            kind: "directory",
            mutable: true,
          },
        ]);
        expect(
          await readFile(
            join(workspacePath, "inbox copy", "note copy 2.md"),
            "utf8",
          ),
        ).toBe("");
      });
    });

    test("refuses to copy into repos/, inside itself, or from a relative path", async () => {
      await withWorkspace(async ({ context, workspaceId, workspacePath }) => {
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "outer",
          kind: "directory",
        });
        await expect(
          context.workspaceContent.files.copyEntries({
            workspace: workspaceId,
            sources: [join(workspacePath, "outer")],
            destinationPath: "outer",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION" });
        await expect(
          context.workspaceContent.files.copyEntries({
            workspace: workspaceId,
            sources: ["outer"],
            destinationPath: "",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION" });
        await expect(
          context.workspaceContent.files.copyEntries({
            workspace: workspaceId,
            sources: [join(workspacePath, "outer")],
            destinationPath: "repos",
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      });
    });

    test("resolves a terminal path to a workspace file, and nothing else", async () => {
      await withWorkspace(async ({ context, workspaceId, workspacePath }) => {
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "notes",
          kind: "directory",
        });
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          parentPath: "notes",
          name: "a.md",
          kind: "file",
        });
        const resolveLink = (path: string, baseDirectories: string[]) =>
          context.workspaceContent.files.resolveFileLink({
            path,
            baseDirectories,
          });
        // Relative: the first base directory where it exists wins.
        expect(
          await resolveLink("a.md", [
            workspacePath,
            join(workspacePath, "notes"),
          ]),
        ).toEqual({ workspaceId, path: "notes/a.md" });
        expect(
          await resolveLink(join(workspacePath, "notes", "a.md"), []),
        ).toEqual({ workspaceId, path: "notes/a.md" });
        // From a folder deeper in the workspace, a path relative to the
        // workspace root still resolves, after the folder itself.
        await mkdir(join(workspacePath, "worktrees", "task", "session"), {
          recursive: true,
        });
        expect(
          await resolveLink("notes/a.md", [
            join(workspacePath, "worktrees", "task", "session"),
          ]),
        ).toEqual({ workspaceId, path: "notes/a.md" });
        // A folder, a missing file and a file outside every workspace are not links.
        expect(await resolveLink("notes", [workspacePath])).toBeNull();
        expect(await resolveLink("missing.md", [workspacePath])).toBeNull();
        expect(await resolveLink("/etc/hosts", [])).toBeNull();
      });
    });

    test("removes a file, and a folder with everything under it", async () => {
      await withWorkspace(async ({ context, workspaceId, workspacePath }) => {
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "scratch",
          kind: "directory",
        });
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          parentPath: "scratch",
          name: "a.md",
          kind: "file",
        });
        expect(
          await context.workspaceContent.files.removeEntry({
            workspace: workspaceId,
            path: "scratch",
          }),
        ).toMatchObject({
          name: "scratch",
          path: "scratch",
          kind: "directory",
          mutable: true,
        });
        expect(await pathExists(join(workspacePath, "scratch"))).toBe(false);
      });
    });

    test("restores a removed folder, with what was in it, where it was", async () => {
      await withWorkspace(async ({ context, workspaceId, workspacePath }) => {
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "scratch",
          kind: "directory",
        });
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          parentPath: "scratch",
          name: "a.md",
          kind: "file",
        });
        await Bun.write(join(workspacePath, "scratch", "a.md"), "kept");
        const { trashId } = await context.workspaceContent.files.removeEntry({
          workspace: workspaceId,
          path: "scratch",
        });
        expect(
          await context.workspaceContent.files.restoreEntry({
            workspace: workspaceId,
            trashId,
          }),
        ).toMatchObject({ path: "scratch", kind: "directory" });
        expect(
          await readFile(join(workspacePath, "scratch", "a.md"), "utf8"),
        ).toBe("kept");
        // Restored once, it is gone from the trash.
        await expect(
          context.workspaceContent.files.restoreEntry({
            workspace: workspaceId,
            trashId,
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      });
    });

    test("does not restore over an entry that took the removed one's place", async () => {
      await withWorkspace(async ({ context, workspaceId, workspacePath }) => {
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "a.md",
          kind: "file",
        });
        const { trashId } = await context.workspaceContent.files.removeEntry({
          workspace: workspaceId,
          path: "a.md",
        });
        await Bun.write(join(workspacePath, "a.md"), "new");
        await expect(
          context.workspaceContent.files.restoreEntry({
            workspace: workspaceId,
            trashId,
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(await readFile(join(workspacePath, "a.md"), "utf8")).toBe("new");
      });
    });

    test("empties what has been in the trash for over a week", async () => {
      await withWorkspace(async ({ context, workspaceId }) => {
        for (const name of ["old.md", "new.md"])
          await context.workspaceContent.files.createEntry({
            workspace: workspaceId,
            name,
            kind: "file",
          });
        const old = await context.workspaceContent.files.removeEntry({
          workspace: workspaceId,
          path: "old.md",
        });
        const trash = join(context.config.home, "trash");
        const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        await utimes(join(trash, old.trashId), eightDaysAgo, eightDaysAgo);
        const recent = await context.workspaceContent.files.removeEntry({
          workspace: workspaceId,
          path: "new.md",
        });
        // Emptying runs behind the remove; give it its turn.
        for (let tries = 0; tries < 50; tries++) {
          if (!(await pathExists(join(trash, old.trashId)))) break;
          await Bun.sleep(10);
        }
        expect(await readdir(trash)).toEqual([recent.trashId]);
      });
    });

    test("refuses every verb on a read-only repository checkout", async () => {
      await withWorkspace(async ({ context, workspaceId, workspacePath }) => {
        // `repos/` is populated by the repository library, not by these verbs,
        // so the fixture is written directly.
        await mkdir(join(workspacePath, "repos", "daedalus"), {
          recursive: true,
        });
        await Bun.write(
          join(workspacePath, "repos", "daedalus", "README.md"),
          "x",
        );
        // Thunks, not promises: an array of already-started rejections would
        // reject before `expect` attached and surface as an unhandled
        // rejection in whichever test happened to run next.
        for (const attempt of [
          () =>
            context.workspaceContent.files.renameEntry({
              workspace: workspaceId,
              path: "repos/daedalus/README.md",
              name: "OTHER.md",
            }),
          () =>
            context.workspaceContent.files.removeEntry({
              workspace: workspaceId,
              path: "repos/daedalus/README.md",
            }),
          () =>
            context.workspaceContent.files.moveEntry({
              workspace: workspaceId,
              path: "repos/daedalus/README.md",
              destinationPath: "",
            }),
        ])
          await expect(attempt()).rejects.toMatchObject({ code: "CONFLICT" });
        // And refuses to move something *into* it, which is the direction the
        // read-only check on the source path does not cover.
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "note.md",
          kind: "file",
        });
        await expect(
          context.workspaceContent.files.moveEntry({
            workspace: workspaceId,
            path: "note.md",
            destinationPath: "repos/daedalus",
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      });
    });

    test("refuses to touch the workspace root or the folders Daedalus manages", async () => {
      await withWorkspace(async ({ context, workspaceId }) => {
        await expect(
          context.workspaceContent.files.removeEntry({
            workspace: workspaceId,
            path: "",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION" });
        for (const path of ["worktrees", "artifacts"])
          await expect(
            context.workspaceContent.files.renameEntry({
              workspace: workspaceId,
              path,
              name: "renamed",
            }),
          ).rejects.toMatchObject({ code: "CONFLICT" });
      });
    });

    /**
     * The bug this exists for: deleting BRIEF.md *succeeded*, and the next
     * `workspaceContentGet` — which the desktop fires after every mutation —
     * recreated it before the tree redrew, so the menu looked broken while the
     * service did exactly what it was told.
     */
    test("refuses the files Daedalus regenerates, rather than deleting them twice", async () => {
      await withWorkspace(async ({ context, workspaceId, workspacePath }) => {
        for (const path of [
          "BRIEF.md",
          "JOURNAL.md",
          "AGENTS.md",
          "CLAUDE.md",
        ]) {
          await expect(
            context.workspaceContent.files.removeEntry({
              workspace: workspaceId,
              path,
            }),
          ).rejects.toMatchObject({ code: "CONFLICT" });
          // Renaming is the worse half: it also succeeded, and the original
          // then regenerated beside it, silently leaving two files.
          await expect(
            context.workspaceContent.files.renameEntry({
              workspace: workspaceId,
              path,
              name: `renamed-${path}`,
            }),
          ).rejects.toMatchObject({ code: "CONFLICT" });
          expect(await pathExists(join(workspacePath, path))).toBe(true);
        }
      });
    });

    test("leaves a same-named file inside a folder alone", async () => {
      // Only the workspace root regenerates; a BRIEF.md in a folder is an
      // ordinary file and refusing it would be a guard that overreached.
      await withWorkspace(async ({ context, workspaceId }) => {
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "notes",
          kind: "directory",
        });
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          parentPath: "notes",
          name: "BRIEF.md",
          kind: "file",
        });
        expect(
          await context.workspaceContent.files.removeEntry({
            workspace: workspaceId,
            path: "notes/BRIEF.md",
          }),
        ).toMatchObject({ path: "notes/BRIEF.md" });
      });
    });

    /**
     * The flag the renderer greys its menu from. It is computed by the same
     * rule that does the refusing, so the menu cannot drift out of agreement
     * with the service — which is how Delete came to be offered on BRIEF.md.
     */
    test("tells the caller which listed entries can be changed", async () => {
      await withWorkspace(async ({ context, workspaceId }) => {
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "notes.md",
          kind: "file",
        });
        const byPath = new Map(
          (await context.workspaceContent.files.listDirectory(workspaceId)).map(
            (entry) => [entry.path, entry.mutable],
          ),
        );
        for (const path of [
          "repos",
          "worktrees",
          "artifacts",
          "BRIEF.md",
          "JOURNAL.md",
          "AGENTS.md",
          "CLAUDE.md",
        ])
          expect([path, byPath.get(path)]).toEqual([path, false]);
        expect(byPath.get("notes.md")).toBe(true);
      });
    });

    test("marks a same-named file inside a folder as changeable", async () => {
      // Only the workspace root regenerates; a BRIEF.md in a folder is an
      // ordinary file, and a guard that caught it would be overreaching.
      await withWorkspace(async ({ context, workspaceId }) => {
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "notes",
          kind: "directory",
        });
        const created = await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          parentPath: "notes",
          name: "BRIEF.md",
          kind: "file",
        });
        expect(created.mutable).toBe(true);
        expect(
          (
            await context.workspaceContent.files.listDirectory(
              workspaceId,
              "notes",
            )
          )[0]?.mutable,
        ).toBe(true);
      });
    });

    test("keeps every verb inside the workspace and away from its metadata", async () => {
      await withWorkspace(async ({ context, workspaceId }) => {
        await expect(
          context.workspaceContent.files.removeEntry({
            workspace: workspaceId,
            path: "../outside.md",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION" });
        await expect(
          context.workspaceContent.files.removeEntry({
            workspace: workspaceId,
            path: ".daedalus/workspace.json",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION" });
        await context.workspaceContent.files.createEntry({
          workspace: workspaceId,
          name: "note.md",
          kind: "file",
        });
        await expect(
          context.workspaceContent.files.moveEntry({
            workspace: workspaceId,
            path: "note.md",
            destinationPath: "..",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION" });
      });
    });
  });
});

import { join } from "node:path";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  createApplicationContext,
  DaedalusError,
  workspaceSlug,
} from "../index";

describe("WorkspaceService", () => {
  test("creates, updates, unregisters, and preserves workspace files", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        reconcile: false,
      });
      const workspace = await context.workspaces.create({ name: "My Project" });
      expect(workspace.slug).toBe("my-project");
      expect(
        JSON.parse(
          await readFile(
            join(workspace.path, ".daedalus/workspace.json"),
            "utf8",
          ),
        ),
      ).toEqual({ id: workspace.id });
      const updated = await context.workspaces.update(workspace.id, {
        slug: "renamed",
      });
      expect(updated.path).toBe(workspace.path);
      await context.workspaces.remove(updated.id, { force: true });
      expect(
        await Bun.file(
          join(workspace.path, ".daedalus/workspace.json"),
        ).exists(),
      ).toBe(true);
      context.close();
    });
  });

  test("requires force and a matching marker before deleting files", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        reconcile: false,
      });
      const workspace = await context.workspaces.create({ name: "Danger" });
      await expect(
        context.workspaces.remove(workspace.id, {}),
      ).rejects.toMatchObject({
        code: "VALIDATION",
      });
      await Bun.write(
        join(workspace.path, ".daedalus/workspace.json"),
        JSON.stringify({ id: "wrong" }),
      );
      await expect(
        context.workspaces.remove(workspace.id, {
          force: true,
          deleteFiles: true,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        await Bun.file(
          join(workspace.path, ".daedalus/workspace.json"),
        ).exists(),
      ).toBe(true);
      context.close();
    });
  });

  test("deletes only a verified workspace directory when explicitly requested", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        reconcile: false,
      });
      const workspace = await context.workspaces.create({ name: "Delete Me" });
      const result = await context.workspaces.remove(workspace.id, {
        force: true,
        deleteFiles: true,
      });
      expect(result.filesDeleted).toBe(true);
      expect(
        await Bun.file(
          join(workspace.path, ".daedalus/workspace.json"),
        ).exists(),
      ).toBe(false);
      context.close();
    });
  });

  test("rejects collisions and symlink workspace paths", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        reconcile: false,
      });
      await context.workspaces.create({ name: "Demo" });
      await expect(
        context.workspaces.create({ name: "Demo" }),
      ).rejects.toBeInstanceOf(DaedalusError);
      const target = join(home, "target");
      const link = join(home, "link");
      await mkdir(target);
      await symlink(target, link);
      await expect(
        context.workspaces.create({ name: "Link", path: link }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      context.close();
    });
  });

  test("normalizes safe slugs and rejects traversal", () => {
    expect(workspaceSlug("  Nice Project  ")).toBe("nice-project");
    expect(() => workspaceSlug("../")).toThrow(DaedalusError);
  });
});

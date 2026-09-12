import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { createApplicationContext } from "../index";

describe("TaskService", () => {
  test("supports CRUD, filters, and explicit status transitions", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        reconcile: false,
      });
      const workspace = await context.workspaces.create({ name: "Tasks" });
      const task = await context.tasks.create({
        workspace: workspace.slug,
        title: "  Ship it  ",
        description: "Safely",
        priority: "high",
      });
      expect(task).toMatchObject({
        title: "Ship it",
        status: "todo",
        priority: "high",
      });
      expect(await context.tasks.list({ status: "todo" })).toHaveLength(1);
      expect(
        context.tasks.setStatus(task.id, "done").completedAt,
      ).not.toBeNull();
      expect(
        context.tasks.setStatus(task.id, "blocked").completedAt,
      ).toBeNull();
      expect(context.tasks.update(task.id, { title: "Released" }).title).toBe(
        "Released",
      );
      await expect(context.tasks.remove(task.id, false)).rejects.toMatchObject({
        code: "VALIDATION",
      });
      await context.tasks.remove(task.id, true);
      expect(() => context.tasks.get(task.id)).toThrow();
      context.close();
    });
  });

  test("validates filters and workspace references", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        reconcile: false,
      });
      await expect(
        context.tasks.list({ status: "unknown" }),
      ).rejects.toMatchObject({
        code: "VALIDATION",
      });
      await expect(
        context.tasks.create({ workspace: "missing", title: "No" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      context.close();
    });
  });
});

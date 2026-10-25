import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { createApplicationContext } from "../index";
import { IN_CLOUD_MESSAGE } from "./cloud-launch";

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A workspace that moved to the cloud, its folder here left as a backup. */
const withCloudWorkspace = (
  body: (input: {
    context: Awaited<ReturnType<typeof createApplicationContext>>;
    workspaceId: string;
    path: string;
  }) => Promise<void>,
) =>
  withTemporaryDaedalusHome(async (home) => {
    const context = await createApplicationContext({
      env: { DAEDALUS_HOME: home },
      reconcile: false,
    });
    try {
      const workspace = await context.workspaces.create({ name: "Pods" });
      context.repositories.setWorkspacePlace(workspace.id, {
        place: "cloud",
        notice: null,
      });
      await body({ context, workspaceId: workspace.id, path: workspace.path });
    } finally {
      context.close();
    }
  });

const refused = { code: "CONFLICT", message: IN_CLOUD_MESSAGE };

describe("a cloud workspace's folder on this Mac", () => {
  test("is not rewritten when the workspace is read", async () => {
    await withCloudWorkspace(async ({ context, workspaceId, path }) => {
      await rm(join(path, "BRIEF.md"));
      await context.workspaces.get(workspaceId);
      expect(await exists(join(path, "BRIEF.md"))).toBe(false);
      // No pod is awake, so the pod's content reads empty; the backup is not
      // shown in its place.
      const content = await context.workspaceContent.get(workspaceId);
      expect(content).toMatchObject({ brief: "", journal: "", files: [] });
      expect(await exists(join(path, "BRIEF.md"))).toBe(false);
    });
  });

  test("refuses journal writes and a session prepared here", async () => {
    await withCloudWorkspace(async ({ context, workspaceId, path }) => {
      const journal = await readFile(join(path, "JOURNAL.md"), "utf8");
      await expect(
        context.workspaceContent.appendJournal({
          workspace: workspaceId,
          kind: "decision",
          summary: "x",
        }),
      ).rejects.toMatchObject(refused);
      expect(await readFile(join(path, "JOURNAL.md"), "utf8")).toBe(journal);
      await expect(
        context.workspaceContent.prepareSession({
          workspace: await context.workspaces.get(workspaceId),
          sessionId: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject(refused);
    });
  });

  test("refuses attaching repositories under repos/", async () => {
    await withCloudWorkspace(async ({ context, workspaceId, path }) => {
      const input = {
        workspace: workspaceId,
        remoteUrl: "https://example.invalid/app.git",
      };
      await expect(
        context.workspaceContent.addAndAttachRepository(input),
      ).rejects.toMatchObject(refused);
      await expect(
        context.workspaceContent.beginAddAndAttachRepository(input),
      ).rejects.toMatchObject(refused);
      expect(
        context.repositories.listWorkspaceRepositories(workspaceId),
      ).toEqual([]);
      expect(await exists(join(path, "repos", "app"))).toBe(false);
    });
  });

  test("is left out of the instruction file sync", async () => {
    await withCloudWorkspace(async ({ context, path }) => {
      await rm(join(path, "AGENTS.md"), { force: true });
      await context.workspaceContent.setInstructionFilesEnabled(true);
      expect(await exists(join(path, "AGENTS.md"))).toBe(false);
    });
  });
});

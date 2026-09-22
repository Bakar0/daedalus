import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { createApplicationContext } from "../index";
import {
  WORKSPACE_FILES_CHANGED,
  type WorkspaceFilesChanged,
} from "./workspace-watch";

/**
 * Asserting that something was published waits for it, not for a duration.
 *
 * A fixed wait failed about one run in five on a loaded machine: the 150ms
 * debounce plus a classification round trip is usually well inside it and
 * occasionally is not, which is a flake rather than a finding.
 */
const until = async (ready: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (ready()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
};

/**
 * Asserting that something was *not* published has to wait a fixed time —
 * there is no event to wait for — so this one is deliberately generous.
 */
const quietFor = () => new Promise((done) => setTimeout(done, 900));

describe("WorkspaceWatchService", () => {
  const withWatchedWorkspace = async (
    body: (input: {
      context: Awaited<ReturnType<typeof createApplicationContext>>;
      workspaceId: string;
      workspacePath: string;
      published: WorkspaceFilesChanged[];
    }) => Promise<void>,
  ) =>
    withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        reconcile: false,
      });
      const workspace = await context.workspaces.create({ name: "Watched" });
      const published: WorkspaceFilesChanged[] = [];
      context.events.subscribe((event) => {
        if (event.type === WORKSPACE_FILES_CHANGED)
          published.push(event.payload as WorkspaceFilesChanged);
      });
      try {
        await body({
          context,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          published,
        });
      } finally {
        context.close();
      }
    });

  test("publishes a change under the workspace it belongs to", async () => {
    await withWatchedWorkspace(
      async ({ context, workspaceId, workspacePath, published }) => {
        await context.workspaceWatch.watchOnly([workspaceId]);
        await writeFile(join(workspacePath, "note.md"), "hello");
        await until(() =>
          published.some((batch) =>
            batch.changes.some((change) => change.path === "note.md"),
          ),
        );
        const changes = published.flatMap((batch) => batch.changes);
        expect(
          published.every((batch) => batch.workspaceId === workspaceId),
        ).toBe(true);
        expect(changes).toContainEqual({
          path: "note.md",
          kind: "added",
          entryKind: "file",
        });
      },
    );
  });

  test("stops publishing once the workspace is no longer watched", async () => {
    await withWatchedWorkspace(
      async ({ context, workspaceId, workspacePath, published }) => {
        await context.workspaceWatch.watchOnly([workspaceId]);
        expect(context.workspaceWatch.watching).toEqual([workspaceId]);
        await context.workspaceWatch.watchOnly([]);
        expect(context.workspaceWatch.watching).toEqual([]);
        published.length = 0;
        await writeFile(join(workspacePath, "after.md"), "hello");
        await quietFor();
        expect(published).toEqual([]);
      },
    );
  });

  test("accepts a slug as readily as an id, and resolves it to the id", async () => {
    // Every other service takes a reference rather than an id, and a caller
    // that had to know which one this wanted would be the odd one out.
    await withWatchedWorkspace(async ({ context, workspaceId }) => {
      const workspace = await context.workspaces.get(workspaceId);
      expect(await context.workspaceWatch.watchOnly([workspace.slug])).toEqual([
        workspaceId,
      ]);
    });
  });

  test("watching the same workspace again does not open a second watcher", async () => {
    await withWatchedWorkspace(async ({ context, workspaceId }) => {
      await context.workspaceWatch.watchOnly([workspaceId]);
      await context.workspaceWatch.watchOnly([workspaceId]);
      expect(context.workspaceWatch.watching).toEqual([workspaceId]);
    });
  });

  test("never reports Git or dependency churn", async () => {
    await withWatchedWorkspace(
      async ({ context, workspaceId, workspacePath, published }) => {
        await context.workspaceWatch.watchOnly([workspaceId]);
        await mkdir(join(workspacePath, "repos", "app", ".git"), {
          recursive: true,
        });
        await writeFile(
          join(workspacePath, "repos", "app", ".git", "index"),
          "x",
        );
        await mkdir(join(workspacePath, "node_modules", "react"), {
          recursive: true,
        });
        await writeFile(
          join(workspacePath, "node_modules", "react", "index.js"),
          "x",
        );
        // Something visible, written last, so there is an event to wait for
        // rather than a duration to hope is long enough — and the ignored
        // paths have had at least as long to arrive as this one did.
        await writeFile(join(workspacePath, "visible.md"), "x");
        await until(() =>
          published.some((batch) =>
            batch.changes.some((change) => change.path === "visible.md"),
          ),
        );
        await quietFor();
        const paths = published
          .flatMap((batch) => batch.changes)
          .map((change) => change.path);
        expect(paths.some((path) => path.includes(".git"))).toBe(false);
        expect(paths.some((path) => path.includes("node_modules"))).toBe(false);
      },
    );
  });

  test("closing the context releases every watcher", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        reconcile: false,
      });
      const workspace = await context.workspaces.create({ name: "Closed" });
      const published: unknown[] = [];
      context.events.subscribe((event) => {
        if (event.type === WORKSPACE_FILES_CHANGED) published.push(event);
      });
      await context.workspaceWatch.watchOnly([workspace.id]);
      // A watcher is a kernel resource held outside the database, so closing
      // has to release it rather than leave it to the process exiting.
      context.close();
      expect(context.workspaceWatch.watching).toEqual([]);
      await writeFile(join(workspace.path, "after-close.md"), "x");
      await quietFor();
      expect(published).toEqual([]);
      await rm(workspace.path, { recursive: true, force: true });
    });
  });
});

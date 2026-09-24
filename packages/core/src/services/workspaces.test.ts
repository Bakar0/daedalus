import { join } from "node:path";
import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import {
  createApplicationContext,
  DaedalusError,
  workspaceSlug,
} from "../index";

class FakeTmux implements TmuxClient {
  readonly sessions = new Set<string>();
  async probe() {
    return "tmux 3.7c";
  }
  async createSession(launch: TmuxLaunch) {
    this.sessions.add(launch.session);
  }
  async hasSession(session: string) {
    return this.sessions.has(session);
  }
  async listSessions() {
    return [...this.sessions];
  }
  async attach() {
    return 0;
  }
  async capture() {
    return "";
  }
  async sendKeys() {}
  async send() {}
  async stop(session: string) {
    this.sessions.delete(session);
  }
  async killServer() {
    const running = this.sessions.size > 0;
    this.sessions.clear();
    return running;
  }
}

describe("WorkspaceService", () => {
  test("creates, updates, unregisters, and preserves workspace files", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux: new FakeTmux(),
      });
      const workspace = await context.workspaces.create({ name: "My Project" });
      expect(workspace.id).toBe("my-project");
      expect(workspace.slug).toBe("my-project");
      expect(
        JSON.parse(
          await readFile(
            join(workspace.path, ".daedalus/workspace.json"),
            "utf8",
          ),
        ),
      ).toEqual({ id: workspace.id });
      expect(await Bun.file(join(workspace.path, "BRIEF.md")).exists()).toBe(
        true,
      );
      expect(await Bun.file(join(workspace.path, "JOURNAL.md")).exists()).toBe(
        true,
      );
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

  test("a default model needs a provider and a valid name", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux: new FakeTmux(),
      });
      const workspace = await context.workspaces.create({ name: "Defaults" });
      // On its own the model would apply to whichever provider happened to be
      // installed first, which is the drift the setting exists to stop.
      await expect(
        context.workspaces.update(workspace.id, { defaultModel: "sonnet" }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(
        context.workspaces.update(workspace.id, {
          defaultProvider: "claude",
          defaultModel: "not a model",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      const set = await context.workspaces.update(workspace.id, {
        defaultProvider: "claude",
        defaultModel: " sonnet ",
      });
      expect(set).toMatchObject({
        defaultProvider: "claude",
        defaultModel: "sonnet",
      });
      // Clearing the provider takes the model with it rather than leaving a
      // Claude id to be handed to Codex later.
      const cleared = await context.workspaces.update(workspace.id, {
        defaultProvider: null,
      });
      expect(cleared).toMatchObject({
        defaultProvider: null,
        defaultModel: null,
      });
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

  test("reports registered workspaces whose authoritative folder is missing", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        reconcile: false,
      });
      const workspace = await context.workspaces.create({ name: "Moved" });
      await rm(workspace.path, { recursive: true });
      expect(await context.workspaces.list()).toEqual([]);
      expect(await context.workspaces.listWithHealth()).toEqual([
        { workspace, available: false },
      ]);
      context.close();
    });
  });

  test("normalizes safe slugs and rejects traversal", () => {
    expect(workspaceSlug("  Nice Project  ")).toBe("nice-project");
    expect(() => workspaceSlug("../")).toThrow(DaedalusError);
  });

  test("archives sessions with a workspace and restores only the workspace", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux: new FakeTmux(),
      });
      const workspace = await context.workspaces.create({ name: "Archive" });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        terminal: true,
      });
      const archived = await context.workspaces.archive(workspace.id);
      expect(archived.archivedAt).not.toBeNull();
      expect((await context.agents.get(session.id)).archivedAt).not.toBeNull();
      expect(await context.workspaces.list()).toEqual([]);
      const restored = await context.workspaces.restore(workspace.id);
      expect(restored.archivedAt).toBeNull();
      expect((await context.agents.get(session.id)).archivedAt).not.toBeNull();
      context.close();
    });
  });
});

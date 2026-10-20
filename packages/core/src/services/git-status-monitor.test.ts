import { isAbsolute, join } from "node:path";
import { readdir, stat, unlink, utimes } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { runCommand } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { createApplicationContext } from "../index";
import {
  GitStatusMonitor,
  gitMeasure,
  type GitMeasure,
} from "./git-status-monitor";
import {
  contextWithStubbedAgent,
  createRepository,
} from "./workspace-content.fixtures";

describe("GitStatusMonitor", () => {
  describe("working tree state", () => {
    // One workspace with one session worktree, and the helpers both tests
    // below read it through.
    const lazyFixture = async (home: string) => {
      const source = join(home, "source", "product");
      await createRepository(source);
      const context = await contextWithStubbedAgent(home);
      const workspace = await context.workspaces.create({ name: "Lazy" });
      await context.workspaceContent.addAndAttachRepository({
        workspace: workspace.id,
        remoteUrl: source,
      });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
      });
      const worktree = await context.workspaceContent.createSessionWorktree({
        session: session.id,
        repository: "product",
        branch: `work-${session.id.slice(0, 8)}`,
      });
      const content = context.workspaceContent;
      const status = async () =>
        (await content.get(workspace.id)).worktrees[0]?.gitStatus;
      return {
        context,
        content,
        session,
        workspace,
        worktree,
        status,
        relativeRoot: worktree.path.slice(workspace.path.length + 1),
        // A report reaches the status on its own, a moment later.
        statusBecomes: async (changedFiles: number) => {
          const deadline = Date.now() + 5_000;
          while (
            (await status())?.changedFiles !== changedFiles &&
            Date.now() < deadline
          ) {
            await Bun.sleep(100);
            await content.gitStatus.settle();
          }
          return status();
        },
      };
    };

    test("runs git only for a tree that changed, and never misses the change", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const { context, content, session, workspace, worktree, relativeRoot } =
          await lazyFixture(home);
        // Whatever creating the worktree started on the context's own
        // monitor has finished; this test measures through a monitor of its
        // own, whose git calls it counts.
        await content.gitStatus.settle();
        const counts = { status: 0, changes: 0 };
        const counting: GitMeasure = {
          status: (path, baseBranch) => {
            counts.status += 1;
            return gitMeasure.status(path, baseBranch);
          },
          changes: (path) => {
            counts.changes += 1;
            return gitMeasure.changes(path);
          },
        };
        const monitor = new GitStatusMonitor(
          context.repositories,
          context.workspaces,
          () => {},
          counting,
        );
        const status = async () => {
          const [row] = context.repositories.listSessionWorktrees({
            workspaceId: workspace.id,
          });
          return row && monitor.withMeasurements(row).gitStatus;
        };
        // A report reaches the status on its own, a moment later.
        const statusBecomes = async (changedFiles: number) => {
          const deadline = Date.now() + 5_000;
          while (
            (await status())?.changedFiles !== changedFiles &&
            Date.now() < deadline
          ) {
            await Bun.sleep(100);
            await monitor.settle();
          }
          return status();
        };
        // An ended session's worktree has no watcher of its own, so nothing
        // starts a pass behind this test's back and every count is exact.
        await context.agents.stop(session.id, true);
        // What the window does on every update: list, which schedules an
        // ordinary pass once the rate limit allows, then wait for it.
        const ordinaryPass = async () => {
          await Bun.sleep(1_100);
          monitor.scheduleRefresh(workspace.id);
          await monitor.settle();
        };
        // How many trees `run` measured with git, for status and for changes.
        const measured = async (run: () => Promise<unknown>) => {
          const before = { ...counts };
          await run();
          return {
            status: counts.status - before.status,
            changes: counts.changes - before.changes,
          };
        };

        // A full pass measures both trees, the checkout under repos/ and the
        // worktree, so every zero below is a tree left alone.
        expect(
          await measured(async () => {
            monitor.remeasureWorkspace(workspace.id);
            await monitor.settle();
          }),
        ).toMatchObject({ status: 2 });
        expect(await status()).toMatchObject({ state: "clean", ahead: 0 });

        // Nothing moved: an ordinary pass and a changes listing run no git.
        await monitor.worktreeChanges(workspace.id);
        expect(await measured(ordinaryPass)).toEqual({ status: 0, changes: 0 });
        expect(
          await measured(() => monitor.worktreeChanges(workspace.id)),
        ).toEqual({ status: 0, changes: 0 });

        // A commit moves HEAD, which the cheap check sees on its own.
        await runCommand("git", [
          "-C",
          worktree.path,
          "-c",
          "user.name=Daedalus Test",
          "-c",
          "user.email=test@daedalus.local",
          "commit",
          "--allow-empty",
          "-qm",
          "agent work",
        ]);
        // Measured: the worktree, and the checkout under repos/ beside it.
        // Both are trees of one shared clone, whose refs live in a single
        // reftable; a commit rewrites it, and which branch moved is not
        // knowable without git. Commits come minutes apart, so this is cheap.
        expect(await measured(ordinaryPass)).toEqual({ status: 2, changes: 0 });
        expect(await status()).toMatchObject({ state: "ahead", ahead: 1 });

        // An edit moves no git metadata; the watcher's report is what says
        // the tree changed, and its pass follows without being asked.
        await Bun.write(join(worktree.path, "SCRATCH.md"), "# Scratch\n");
        monitor.noteFilesChanged(
          workspace.id,
          [{ path: `${relativeRoot}/SCRATCH.md` }],
          false,
        );
        expect(await statusBecomes(1)).toMatchObject({
          state: "modified",
          changedFiles: 1,
        });
        expect(
          (await monitor.worktreeChanges(workspace.id))[0]?.files.map(
            (file) => file.repositoryPath,
          ),
        ).toEqual(["SCRATCH.md"]);

        // A change outside every tree marks none of them.
        monitor.noteFilesChanged(workspace.id, [{ path: "BRIEF.md" }], false);
        expect(
          await measured(() => monitor.worktreeChanges(workspace.id)),
        ).toEqual({ status: 0, changes: 0 });

        // Fetch is the user saying something changed: everything is measured
        // again, whatever the cheap checks say.
        await unlink(join(worktree.path, "SCRATCH.md"));
        monitor.remeasureWorkspace(workspace.id);
        await monitor.settle();
        expect(await status()).toMatchObject({
          state: "ahead",
          changedFiles: 0,
        });
        monitor.close();
        context.close();
      });
      // It waits out the rate limit and the file-change settle on purpose.
    }, 20_000);

    test("sees an edit nothing reports in a live session's worktree", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const { context, content, worktree, statusBecomes } =
          await lazyFixture(home);
        await content.gitStatus.settle();
        // As in a workspace that is not open: no workspace watcher, nobody
        // calls noteFilesChanged. The live session's own worktree watcher is
        // what sees it.
        await Bun.write(join(worktree.path, "WATCHED.md"), "# Watched\n");
        expect(await statusBecomes(1)).toMatchObject({
          state: "modified",
          changedFiles: 1,
        });
        context.close();
      });
    }, 20_000);

    test("reports each worktree's own changes and distance from the base branch", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const source = join(home, "source", "product");
        await createRepository(source);
        const context = await contextWithStubbedAgent(home);
        const workspace = await context.workspaces.create({ name: "Trees" });
        await context.workspaceContent.addAndAttachRepository({
          workspace: workspace.id,
          remoteUrl: source,
        });
        const session = await context.agents.spawn({
          workspace: workspace.id,
          provider: "claude",
        });
        const worktree = await context.workspaceContent.createSessionWorktree({
          session: session.id,
          repository: "product",
          branch: `work-${session.id.slice(0, 8)}`,
        });

        // The listing deliberately does not wait for git, so the measurement
        // is asked for rather than assumed to have happened.
        await context.workspaceContent.get(workspace.id);
        await context.workspaceContent.gitStatus.settle(workspace.id);

        // A clean worktree sitting exactly on the base branch.
        const clean = (await context.workspaceContent.get(workspace.id))
          .worktrees[0];
        expect(clean?.gitStatus).toEqual({
          state: "clean",
          changedFiles: 0,
          ahead: 0,
          behind: 0,
        });

        // One commit on top, plus one uncommitted file.
        await Bun.write(join(worktree.path, "LANDED.md"), "# Landed\n");
        expect(
          (await runCommand("git", ["-C", worktree.path, "add", "LANDED.md"]))
            .exitCode,
        ).toBe(0);
        expect(
          (
            await runCommand("git", [
              "-C",
              worktree.path,
              "-c",
              "user.name=Daedalus Test",
              "-c",
              "user.email=test@daedalus.local",
              "commit",
              "-qm",
              "agent work",
            ])
          ).exitCode,
        ).toBe(0);
        await Bun.write(join(worktree.path, "SCRATCH.md"), "# Not committed\n");

        await context.workspaceContent.gitStatus.settle(workspace.id);
        const moved = (await context.workspaceContent.get(workspace.id))
          .worktrees[0];
        expect(moved?.gitStatus).toEqual({
          state: "modified",
          changedFiles: 1,
          ahead: 1,
          behind: 0,
          // The committed file only: SCRATCH.md is not part of the diff a
          // reviewer would read.
          filesAhead: 1,
          // Never pushed, so the one commit exists only here.
          unpushed: 1,
        });

        // The board reads the same measurement for every workspace at once,
        // without the workspace view having been opened.
        context.workspaceContent.listWorktrees();
        await context.workspaceContent.gitStatus.settle(null);
        expect(context.workspaceContent.listWorktrees()).toMatchObject([
          {
            sessionId: session.id,
            path: worktree.path,
            gitStatus: { ahead: 1, filesAhead: 1 },
          },
        ]);

        // The read-only planning checkout is unaffected by the agent's work.
        await context.workspaceContent.gitStatus.settle(workspace.id);
        expect(
          (await context.workspaceContent.get(workspace.id)).repositories[0]
            ?.gitStatus?.state,
        ).toBe("clean");
        context.close();
      });
    });

    test("pushes a session branch to origin, and says when there was nothing to send", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const source = join(home, "source", "product");
        await createRepository(source);
        const context = await contextWithStubbedAgent(home);
        const workspace = await context.workspaces.create({ name: "Push" });
        await context.workspaceContent.addAndAttachRepository({
          workspace: workspace.id,
          remoteUrl: source,
        });
        const session = await context.agents.spawn({
          workspace: workspace.id,
          provider: "claude",
        });
        const worktree = await context.workspaceContent.createSessionWorktree({
          session: session.id,
          repository: "product",
          branch: `work-${session.id.slice(0, 8)}`,
        });
        await Bun.write(join(worktree.path, "LANDED.md"), "# Landed\n");
        expect(
          (await runCommand("git", ["-C", worktree.path, "add", "LANDED.md"]))
            .exitCode,
        ).toBe(0);
        expect(
          (
            await runCommand("git", [
              "-C",
              worktree.path,
              "-c",
              "user.name=Daedalus Test",
              "-c",
              "user.email=test@daedalus.local",
              "commit",
              "-qm",
              "agent work",
            ])
          ).exitCode,
        ).toBe(0);

        const pushed = await context.workspaceContent.pushSessionWorktree({
          session: session.id,
          repository: "product",
        });
        expect(pushed.alreadyUpToDate).toBe(false);
        expect(
          (
            await runCommand("git", [
              "-C",
              source,
              "rev-parse",
              worktree.branchName,
            ])
          ).stdout.trim(),
        ).toBe(
          (
            await runCommand("git", ["-C", worktree.path, "rev-parse", "HEAD"])
          ).stdout.trim(),
        );

        // Pushing again sends nothing, and says so rather than failing.
        expect(
          (
            await context.workspaceContent.pushSessionWorktree({
              session: session.id,
              repository: "product",
            })
          ).alreadyUpToDate,
        ).toBe(true);
        context.close();
      });
    });

    test("refuses to push a session that has no working tree for the repository", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const source = join(home, "source", "product");
        await createRepository(source);
        const context = await contextWithStubbedAgent(home);
        const workspace = await context.workspaces.create({ name: "Push" });
        await context.workspaceContent.addAndAttachRepository({
          workspace: workspace.id,
          remoteUrl: source,
        });
        const session = await context.agents.spawn({
          workspace: workspace.id,
          provider: "claude",
        });
        await expect(
          context.workspaceContent.pushSessionWorktree({
            session: session.id,
            repository: "product",
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        context.close();
      });
    });

    test("fetching moves the workspace checkout to the remote tip", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const source = join(home, "source", "product");
        await createRepository(source);
        const context = await createApplicationContext({
          env: { DAEDALUS_HOME: home },
          reconcile: false,
        });
        const workspace = await context.workspaces.create({ name: "Fetch" });
        const attached = await context.workspaceContent.addAndAttachRepository({
          workspace: workspace.id,
          remoteUrl: source,
        });
        const land = async (file: string, message: string) => {
          await Bun.write(join(source, file), `# ${message}\n`);
          expect(
            (await runCommand("git", ["-C", source, "add", file])).exitCode,
          ).toBe(0);
          expect(
            (
              await runCommand("git", [
                "-C",
                source,
                "-c",
                "user.name=Daedalus Test",
                "-c",
                "user.email=test@daedalus.local",
                "commit",
                "-qm",
                message,
              ])
            ).exitCode,
          ).toBe(0);
          return (
            await runCommand("git", ["-C", source, "rev-parse", "HEAD"])
          ).stdout.trim();
        };
        const head = async () =>
          (
            await runCommand("git", [
              "-C",
              attached.referencePath!,
              "rev-parse",
              "HEAD",
            ])
          ).stdout.trim();

        const shipped = await land("SHIPPED.md", "landed upstream");
        const fetched = await context.workspaceContent.fetchRepository(
          attached.id,
        );
        expect(fetched.baseCommit).toBe(shipped);
        expect(fetched.gitStatus).toMatchObject({ state: "clean", behind: 0 });
        expect(await head()).toBe(shipped);
        // Reached by name, so a person opening a terminal there reads which
        // branch they are looking at rather than a bare hash.
        expect(
          (
            await runCommand("git", [
              "-C",
              attached.referencePath!,
              "branch",
              "--list",
            ])
          ).stdout,
        ).toContain("HEAD detached at origin/main");

        // A checkout someone has changed is not moved under them; it reports
        // how far behind it is, and an explicit sync says why it stayed.
        await Bun.write(join(attached.referencePath!, "NOTES.md"), "mine\n");
        await land("LATER.md", "landed again");
        const behind = await context.workspaceContent.fetchRepository(
          attached.id,
        );
        expect(behind.gitStatus).toMatchObject({ behind: 1 });
        expect(await head()).toBe(shipped);
        await expect(
          context.workspaceContent.syncRepository(attached.id),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        context.close();
      });
    });
  });

  test("lists repositories without waiting for git to measure them", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const source = join(home, "source", "product");
      await createRepository(source);
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        reconcile: false,
      });
      const workspace = await context.workspaces.create({ name: "Fast" });
      await context.workspaceContent.addAndAttachRepository({
        workspace: workspace.id,
        remoteUrl: source,
      });

      // The row is there straight away; its status is not, because measuring
      // it means running git over a working tree and that is what used to sit
      // between the user and a list the database already had.
      const immediate = await context.workspaceContent.get(workspace.id);
      expect(immediate.repositories).toHaveLength(1);
      expect(immediate.repositories[0]?.name).toBe("product");
      // The absence is the assertion. A timing bound would not catch a
      // regression here: against a small repository, measuring inline is fast
      // enough to stay under any threshold worth setting.
      expect(immediate.repositories[0]?.gitStatus).toBeUndefined();

      await context.workspaceContent.gitStatus.settle(workspace.id);
      expect(
        (await context.workspaceContent.get(workspace.id)).repositories[0]
          ?.gitStatus?.state,
      ).toBe("clean");

      // And once measured it is served from memory, so listing again costs
      // nothing even when the working tree is large.
      const start = performance.now();
      await context.workspaceContent.get(workspace.id);
      expect(performance.now() - start).toBeLessThan(120);
      context.close();
    });
  });

  test("measuring a working tree never writes to it", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const source = join(home, "source", "product");
      await createRepository(source);
      const context = await contextWithStubbedAgent(home);
      const workspace = await context.workspaces.create({ name: "Quiet" });
      await context.workspaceContent.addAndAttachRepository({
        workspace: workspace.id,
        remoteUrl: source,
      });
      const checkout = (await context.workspaceContent.get(workspace.id))
        .repositories[0]!.referencePath!;

      // A `git status` that refreshes the index takes `index.lock` to write it
      // back, and an agent running `git add` in the same tree at that moment
      // fails outright — measured at 5 collisions in 30 attempts before this
      // was fixed. Daedalus polls every tree in the background, so reading one
      // has to leave it alone. A rewritten index is the visible proof that it
      // did not: the lock is held too briefly to observe directly.
      // A linked worktree's `.git` is a file, and its index lives beside the
      // main repository's, so the path is asked for rather than assumed.
      const indexPath = (
        await runCommand("git", [
          "-C",
          checkout,
          "rev-parse",
          "--git-path",
          "index",
        ])
      ).stdout.trim();
      expect(indexPath).not.toBe("");
      const resolvedIndex = isAbsolute(indexPath)
        ? indexPath
        : join(checkout, indexPath);
      const before = (await stat(resolvedIndex)).mtimeMs;
      // Make the index stale, which is what tempts git into refreshing it.
      const entries = await readdir(checkout);
      const now = new Date();
      for (const entry of entries)
        if (entry !== ".git") await utimes(join(checkout, entry), now, now);

      await context.workspaceContent.gitStatus.settle(workspace.id);
      expect(
        (await context.workspaceContent.get(workspace.id)).repositories[0]
          ?.gitStatus?.state,
      ).toBe("clean");
      expect((await stat(resolvedIndex)).mtimeMs).toBe(before);
      context.close();
    });
  });
});

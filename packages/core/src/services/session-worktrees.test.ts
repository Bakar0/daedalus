import { join } from "node:path";
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { pathExists, runCommand } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { createApplicationContext } from "../index";
import { pullRequestAnswerHoldsHead } from "./workspace-content";
import {
  FakeTmux,
  contextWithStubbedAgent,
  createRepository,
} from "./workspace-content.fixtures";

describe("SessionWorktrees", () => {
  test("starts an agent in an isolated folder and creates only requested worktrees", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const source = join(home, "repositories", "app");
      await createRepository(source);
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { shell: { executable: "/bin/sh", args: ["-l"] } },
        }),
      );
      const tmux = new FakeTmux();
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux,
      });
      const workspace = await context.workspaces.create({ name: "Agent work" });
      const task = await context.tasks.create({
        workspace: workspace.id,
        title: "Implement feature",
      });
      const libraryRepository =
        await context.workspaceContent.addRepositoryToLibrary({
          remoteUrl: source,
        });
      await context.workspaceContent.attachRepository({
        workspace: workspace.id,
        libraryRepositoryId: libraryRepository.id,
      });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        taskId: task.id,
        command: "shell",
      });
      expect(session.workingDirectory).toBe(
        join(
          workspace.path,
          "worktrees",
          `${task.number}-implement-feature`,
          `custom-${session.id.slice(0, 8)}`,
        ),
      );
      expect(tmux.launches[0]?.cwd).toBe(session.workingDirectory);
      expect(tmux.launches[0]?.env).toMatchObject({
        DAEDALUS_HOME: home,
        DAEDALUS_SESSION_ID: session.id,
      });
      expect(tmux.launches[0]?.env?.PATH?.split(":")[0]).toBe(
        join(home, "bin"),
      );
      expect(
        (await context.workspaceContent.get(workspace.id)).worktrees,
      ).toEqual([]);

      const worktree =
        await context.workspaceContent.worktrees.createSessionWorktree({
          session: session.id,
          repository: "app",
          branch: `work-${session.id.slice(0, 8)}`,
        });
      expect(worktree.path).toBe(join(session.workingDirectory, "app"));
      expect(await readFile(join(worktree.path, "README.md"), "utf8")).toBe(
        "# Source\n",
      );
      expect(
        await context.workspaceContent.worktrees.createSessionWorktree({
          session: session.id,
          repository: "app",
        }),
      ).toEqual(worktree);
      expect(
        (await context.workspaceContent.get(workspace.id)).worktrees,
      ).toHaveLength(1);
      context.close();
    });
  });

  test("branches a session worktree from the latest base-branch commit", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const source = join(home, "repositories", "app");
      await createRepository(source);
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { shell: { executable: "/bin/sh", args: ["-l"] } },
        }),
      );
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux: new FakeTmux(),
      });
      const workspace = await context.workspaces.create({ name: "Parallel" });
      const libraryRepository =
        await context.workspaceContent.addRepositoryToLibrary({
          remoteUrl: source,
        });
      const repository = await context.workspaceContent.attachRepository({
        workspace: workspace.id,
        libraryRepositoryId: libraryRepository.id,
      });
      const attachedCommit = repository.baseCommit;

      // Something lands on the base branch after this workspace attached the
      // repository — another agent merging, or an ordinary push.
      await Bun.write(join(source, "SHIPPED.md"), "# Landed later\n");
      expect(
        (await runCommand("git", ["-C", source, "add", "SHIPPED.md"])).exitCode,
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
            "landed after attachment",
          ])
        ).exitCode,
      ).toBe(0);
      const landedCommit = (
        await runCommand("git", ["-C", source, "rev-parse", "HEAD"])
      ).stdout.trim();
      expect(landedCommit).not.toBe(attachedCommit);

      const session = await context.agents.spawn({
        workspace: workspace.id,
        command: "shell",
      });
      const worktree =
        await context.workspaceContent.worktrees.createSessionWorktree({
          session: session.id,
          repository: "app",
          branch: `work-${session.id.slice(0, 8)}`,
        });

      // The session starts from what is on the base branch now, so the later
      // commit is already in its history and needs no rebase.
      expect(await readFile(join(worktree.path, "SHIPPED.md"), "utf8")).toBe(
        "# Landed later\n",
      );
      expect(
        (
          await runCommand("git", ["-C", worktree.path, "rev-parse", "HEAD"])
        ).stdout.trim(),
      ).toBe(landedCommit);

      // The fetch that fed the new worktree also moved the read-only planning
      // checkout, so planning and implementing see the same code.
      expect(
        (await context.workspaceContent.get(workspace.id)).repositories.find(
          (item) => item.name === "app",
        )?.baseCommit,
      ).toBe(landedCommit);
      expect(
        await readFile(join(repository.referencePath!, "SHIPPED.md"), "utf8"),
      ).toBe("# Landed later\n");
      context.close();
    });
  });

  describe("removing a working tree", () => {
    const commitIn = async (path: string, name: string) => {
      await Bun.write(join(path, name), `# ${name}\n`);
      expect(
        (await runCommand("git", ["-C", path, "add", name])).exitCode,
      ).toBe(0);
      expect(
        (
          await runCommand("git", [
            "-C",
            path,
            "-c",
            "user.name=Daedalus Test",
            "-c",
            "user.email=test@daedalus.local",
            "commit",
            "-qm",
            name,
          ])
        ).exitCode,
      ).toBe(0);
    };

    const scenario = async (home: string) => {
      const source = join(home, "source", "product");
      await createRepository(source);
      const context = await contextWithStubbedAgent(home);
      const workspace = await context.workspaces.create({ name: "Remove" });
      const repository = await context.workspaceContent.addAndAttachRepository({
        workspace: workspace.id,
        remoteUrl: source,
      });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
      });
      const worktree =
        await context.workspaceContent.worktrees.createSessionWorktree({
          session: session.id,
          repository: "product",
          branch: `work-${session.id.slice(0, 8)}`,
        });
      return { context, workspace, repository, session, worktree };
    };

    test("removes a tree that holds nothing, and frees the repository to be detached", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const { context, workspace, repository, session, worktree } =
          await scenario(home);

        // A repository with a working tree cannot be detached...
        await expect(
          context.workspaceContent.detachRepository(repository.id),
        ).rejects.toMatchObject({ code: "CONFLICT" });

        await context.workspaceContent.worktrees.removeSessionWorktree({
          session: session.id,
          repository: "product",
        });
        expect(await pathExists(worktree.path)).toBe(false);
        expect(
          (await context.workspaceContent.get(workspace.id)).worktrees,
        ).toHaveLength(0);
        // The branch existed only to carry that tree.
        expect(
          (
            await runCommand("git", [
              "--git-dir",
              repository.canonicalPath,
              "rev-parse",
              "--verify",
              worktree.branchName,
            ])
          ).exitCode,
        ).not.toBe(0);

        // ...and now it can be, taking its checkout with it.
        await context.workspaceContent.detachRepository(repository.id);
        expect(await pathExists(repository.referencePath!)).toBe(false);
        context.close();
      });
    });

    test("deleting an archived workspace takes its trees, checkouts and folder", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const { context, workspace, repository, session, worktree } =
          await scenario(home);
        await commitIn(worktree.path, "UNPUSHED.md");

        // Only an archived workspace can be deleted.
        await expect(
          context.workspaces.deletePermanently(workspace.id),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await context.workspaces.archive(workspace.id);
        // Archiving kept the tree, because it holds an unpushed commit.
        expect(await pathExists(worktree.path)).toBe(true);

        await context.workspaces.deletePermanently(workspace.id);
        expect(await pathExists(workspace.path)).toBe(false);
        await expect(
          context.workspaces.get(workspace.id),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(context.repositories.findAgent(session.id)).toBeUndefined();
        // The shared clone stays, with no worktree registered into the
        // deleted folder and no branch left from the session.
        const git = (args: string[]) =>
          runCommand("git", ["--git-dir", repository.canonicalPath, ...args]);
        expect((await git(["worktree", "list"])).stdout).not.toContain(
          workspace.path,
        );
        expect(
          (await git(["rev-parse", "--verify", worktree.branchName])).exitCode,
        ).not.toBe(0);
        context.close();
      });
    });

    test("deleting an archived session takes its trees and its own folder", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const { context, workspace, repository, session, worktree } =
          await scenario(home);
        await commitIn(worktree.path, "UNPUSHED.md");
        const folder = context.repositories.findAgent(
          session.id,
        )!.workingDirectory;

        await expect(
          context.agents.deletePermanently(session.id),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await context.agents.archive(session.id);
        expect(await pathExists(worktree.path)).toBe(true);

        await context.agents.deletePermanently(session.id);
        expect(context.repositories.findAgent(session.id)).toBeUndefined();
        expect(await pathExists(folder)).toBe(false);
        expect(await pathExists(workspace.path)).toBe(true);
        expect(
          (
            await runCommand("git", [
              "--git-dir",
              repository.canonicalPath,
              "rev-parse",
              "--verify",
              worktree.branchName,
            ])
          ).exitCode,
        ).not.toBe(0);
        context.close();
      });
    });

    test("deleting a session keeps a folder another session runs in", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const { context, workspace, session } = await scenario(home);
        const folder = context.repositories.findAgent(
          session.id,
        )!.workingDirectory;
        const other = await context.agents.spawn({
          workspace: workspace.id,
          provider: "claude",
        });
        // As `agent continue` leaves it: the successor runs in this folder.
        const database = new Database(context.config.databasePath);
        database
          .query("UPDATE agent_sessions SET working_directory = ? WHERE id = ?")
          .run(folder, other.id);
        database.close();
        await context.agents.archive(session.id);
        await context.agents.deletePermanently(session.id);
        expect(await pathExists(folder)).toBe(true);
        context.close();
      });
    });

    test("refuses to remove a tree holding uncommitted or unpushed work", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const { context, session, worktree } = await scenario(home);

        await Bun.write(join(worktree.path, "SCRATCH.md"), "# scratch\n");
        await expect(
          context.workspaceContent.worktrees.removeSessionWorktree({
            session: session.id,
            repository: "product",
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(await pathExists(worktree.path)).toBe(true);

        // Committing everything does not make it safe either: the commits are
        // still only here. With nothing uncommitted left, this is the unpushed
        // guard on its own.
        await commitIn(worktree.path, "SCRATCH.md");
        expect(
          (
            await runCommand("git", [
              "-C",
              worktree.path,
              "status",
              "--porcelain",
            ])
          ).stdout.trim(),
        ).toBe("");
        await expect(
          context.workspaceContent.worktrees.removeSessionWorktree({
            session: session.id,
            repository: "product",
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(await pathExists(worktree.path)).toBe(true);

        // Pushing is what the message tells the user to do, so pushing has to
        // be what clears it. Measuring this against the base branch instead
        // produced a guard that refused just the same after a push.
        await context.workspaceContent.worktrees.pushSessionWorktree({
          session: session.id,
          repository: "product",
        });
        await context.workspaceContent.worktrees.removeSessionWorktree({
          session: session.id,
          repository: "product",
        });
        expect(await pathExists(worktree.path)).toBe(false);
        context.close();
      });
    });

    test("a tree with an open terminal survives archiving, and deleting closes the terminal", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const { context, workspace, session, worktree } = await scenario(home);
        const terminal = await context.terminals.create({
          workspace: workspace.id,
          workingDirectory: worktree.path,
        });

        // A shell still working in the tree: deleting the folder under it
        // would leave every command there failing to find its directory.
        await context.agents.archive(session.id);
        expect(await pathExists(worktree.path)).toBe(true);

        // Deleting is the user's explicit call, so the terminal goes first.
        await context.agents.deletePermanently(session.id);
        expect(await pathExists(worktree.path)).toBe(false);
        expect(
          (await context.terminals.list()).some(
            (item) => item.id === terminal.id,
          ),
        ).toBe(false);
        context.close();
      });
    }, 30_000);

    test("archiving a session releases only the trees that hold nothing", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const { context, workspace, session, worktree } = await scenario(home);
        const keeper = await context.agents.spawn({
          workspace: workspace.id,
          provider: "claude",
        });
        const kept =
          await context.workspaceContent.worktrees.createSessionWorktree({
            session: keeper.id,
            repository: "product",
            branch: `work-${keeper.id.slice(0, 8)}`,
          });
        await commitIn(kept.path, "UNPUSHED.md");

        await context.agents.archive(session.id);
        await context.agents.archive(keeper.id);

        // The empty one is gone; the one carrying a commit is untouched.
        expect(await pathExists(worktree.path)).toBe(false);
        expect(await pathExists(kept.path)).toBe(true);
        expect(
          (await context.workspaceContent.get(workspace.id)).worktrees.map(
            (item) => item.path,
          ),
        ).toEqual([kept.path]);
        expect(
          await readFile(join(kept.path, "UNPUSHED.md"), "utf8"),
        ).toContain("UNPUSHED.md");
        context.close();
      });
    }, 30_000);
  });

  describe("git state the agents and the user share", () => {
    const git = async (args: string[]) => {
      const result = await runCommand("git", args);
      expect(result.exitCode).toBe(0);
      return result.stdout.trim();
    };
    const commitIn = (path: string, name: string) =>
      Bun.write(join(path, name), `# ${name}\n`).then(async () => {
        await git(["-C", path, "add", name]);
        await git([
          "-C",
          path,
          "-c",
          "user.name=Daedalus Test",
          "-c",
          "user.email=test@daedalus.local",
          "commit",
          "-qm",
          name,
        ]);
      });
    const branchExists = async (gitDirectory: string, branch: string) =>
      (
        await runCommand("git", [
          "--git-dir",
          gitDirectory,
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ])
      ).exitCode === 0;

    test("a clone keeps only the default branch, and every fetch moves it", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const source = join(home, "source", "product");
        await createRepository(source);
        await git(["-C", source, "branch", "old-topic"]);
        const context = await createApplicationContext({
          env: { DAEDALUS_HOME: home },
          reconcile: false,
        });
        const workspace = await context.workspaces.create({ name: "Heads" });
        const attached = await context.workspaceContent.addAndAttachRepository({
          workspace: workspace.id,
          remoteUrl: source,
        });
        const bare = attached.canonicalPath;
        // The clone's copy of every remote branch is gone; the remote-tracking
        // ref is what a checkout of it builds on.
        expect(await branchExists(bare, "old-topic")).toBe(false);
        expect(
          await git([
            "--git-dir",
            bare,
            "rev-parse",
            "refs/remotes/origin/old-topic",
          ]),
        ).toBeTruthy();

        await commitIn(source, "LATER.md");
        await context.workspaceContent.fetchRepository(attached.id);
        expect(
          await git(["--git-dir", bare, "rev-parse", "refs/heads/main"]),
        ).toBe(await git(["-C", source, "rev-parse", "HEAD"]));
        context.close();
      });
    });

    test("fetch only downloads; pull also moves the checkout", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const source = join(home, "source", "product");
        await createRepository(source);
        const context = await createApplicationContext({
          env: { DAEDALUS_HOME: home },
          reconcile: false,
        });
        const workspace = await context.workspaces.create({ name: "Pull" });
        const attached = await context.workspaceContent.addAndAttachRepository({
          workspace: workspace.id,
          remoteUrl: source,
        });
        const checkout = attached.referencePath!;
        const before = await git(["-C", checkout, "rev-parse", "HEAD"]);
        await commitIn(source, "LATER.md");
        const latest = await git(["-C", source, "rev-parse", "HEAD"]);

        const fetched = await context.workspaceContent.fetchRepository(
          attached.id,
          { pull: false },
        );
        expect(await git(["-C", checkout, "rev-parse", "HEAD"])).toBe(before);
        expect(fetched.gitStatus?.behind).toBe(1);

        await context.workspaceContent.fetchRepository(attached.id, {
          pull: true,
        });
        expect(await git(["-C", checkout, "rev-parse", "HEAD"])).toBe(latest);
        context.close();
      });
    });

    test("follows a branch the agent switched to", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const source = join(home, "source", "product");
        await createRepository(source);
        const context = await contextWithStubbedAgent(home);
        const workspace = await context.workspaces.create({ name: "Names" });
        const attached = await context.workspaceContent.addAndAttachRepository({
          workspace: workspace.id,
          remoteUrl: source,
        });
        const task = await context.tasks.create({
          workspace: workspace.id,
          title: "Agent status in the app!",
        });
        const session = await context.agents.spawn({
          workspace: workspace.id,
          provider: "claude",
          taskId: task.id,
        });
        const worktree =
          await context.workspaceContent.worktrees.createSessionWorktree({
            session: session.id,
            repository: "product",
            branch: `work-${session.id.slice(0, 8)}`,
          });
        expect(worktree.branchName).toBe(`work-${session.id.slice(0, 8)}`);

        // The agent moves its work to a branch of its own.
        await git(["-C", worktree.path, "checkout", "-q", "-b", "topic"]);
        await commitIn(worktree.path, "WORK.md");
        const pushed =
          await context.workspaceContent.worktrees.pushSessionWorktree({
            session: session.id,
            repository: "product",
          });
        expect(pushed.worktree.branchName).toBe("topic");
        expect(await git(["-C", source, "rev-parse", "topic"])).toBe(
          await git(["-C", worktree.path, "rev-parse", "HEAD"]),
        );
        expect(await branchExists(source, worktree.branchName)).toBe(false);
        expect(
          (await context.workspaceContent.get(workspace.id)).worktrees[0]
            ?.branchName,
        ).toBe("topic");

        // Pushed, so removable; and both branches the tree carried go with it.
        await context.workspaceContent.worktrees.removeSessionWorktree({
          session: session.id,
          repository: "product",
        });
        expect(await branchExists(attached.canonicalPath, "topic")).toBe(false);
        expect(
          await branchExists(attached.canonicalPath, worktree.branchName),
        ).toBe(false);
        context.close();
      });
    });

    test("requires a branch name, and refuses an invalid or taken one, here or on origin", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const source = join(home, "source", "product");
        await createRepository(source);
        const context = await contextWithStubbedAgent(home);
        const workspace = await context.workspaces.create({ name: "Chosen" });
        const attached = await context.workspaceContent.addAndAttachRepository({
          workspace: workspace.id,
          remoteUrl: source,
        });
        const spawn = () =>
          context.agents.spawn({ workspace: workspace.id, provider: "claude" });

        const first = await spawn();
        const worktree =
          await context.workspaceContent.worktrees.createSessionWorktree({
            session: first.id,
            repository: "product",
            branch: "feat/ABC-123-status",
          });
        expect(worktree.branchName).toBe("feat/ABC-123-status");
        expect(
          await git(["-C", worktree.path, "branch", "--show-current"]),
        ).toBe("feat/ABC-123-status");
        expect(
          await branchExists(attached.canonicalPath, "feat/ABC-123-status"),
        ).toBe(true);

        const second = await spawn();
        await expect(
          context.workspaceContent.worktrees.createSessionWorktree({
            session: second.id,
            repository: "product",
            branch: "feat/ABC-123-status",
          }),
        ).rejects.toThrow("already exists");
        await expect(
          context.workspaceContent.worktrees.createSessionWorktree({
            session: second.id,
            repository: "product",
            branch: "bad..name",
          }),
        ).rejects.toThrow("not a valid branch name");
        await expect(
          context.workspaceContent.worktrees.createSessionWorktree({
            session: second.id,
            repository: "product",
          }),
        ).rejects.toThrow("--branch <name> is required");
        await expect(
          context.workspaceContent.worktrees.createSessionWorktree({
            session: second.id,
            repository: "product",
            branch: "@{-1}",
          }),
        ).rejects.toThrow("not a valid branch name");

        // A teammate's branch on origin is taken too.
        await git(["-C", source, "branch", "fix/teammate"]);
        await expect(
          context.workspaceContent.worktrees.createSessionWorktree({
            session: second.id,
            repository: "product",
            branch: "fix/teammate",
          }),
        ).rejects.toThrow("already exists on origin");

        // A repeat call returns the worktree, but not under another name.
        expect(
          await context.workspaceContent.worktrees.createSessionWorktree({
            session: first.id,
            repository: "product",
          }),
        ).toEqual(worktree);
        await expect(
          context.workspaceContent.worktrees.createSessionWorktree({
            session: first.id,
            repository: "product",
            branch: "feat/other",
          }),
        ).rejects.toThrow("already has a worktree");
        context.close();
      });
    });

    test("a squash merge counts as landed only when the merged pull request holds the tree's HEAD", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const source = join(home, "source", "product");
        await createRepository(source);
        const context = await contextWithStubbedAgent(home);
        const workspace = await context.workspaces.create({ name: "Squash" });
        const attached = await context.workspaceContent.addAndAttachRepository({
          workspace: workspace.id,
          remoteUrl: source,
        });
        const session = await context.agents.spawn({
          workspace: workspace.id,
          provider: "claude",
        });
        const worktree =
          await context.workspaceContent.worktrees.createSessionWorktree({
            session: session.id,
            repository: "product",
            branch: `work-${session.id.slice(0, 8)}`,
          });
        await commitIn(worktree.path, "ONE.md");
        await commitIn(worktree.path, "TWO.md");
        await context.workspaceContent.worktrees.pushSessionWorktree({
          session: session.id,
          repository: "product",
        });
        const head = await git(["-C", worktree.path, "rev-parse", "HEAD"]);

        // What GitHub does: the work lands as one new commit, and the branch
        // is deleted. The fetch prunes the remote branch that made it safe.
        await git(["-C", source, "merge", "--squash", worktree.branchName]);
        await git([
          "-C",
          source,
          "-c",
          "user.name=Daedalus Test",
          "-c",
          "user.email=test@daedalus.local",
          "commit",
          "-qm",
          "Squashed (#1)",
        ]);
        await git(["-C", source, "branch", "-D", worktree.branchName]);
        await context.workspaceContent.fetchRepository(attached.id);

        // No pull request: the commits are only here, so the guard holds.
        await expect(
          context.workspaceContent.worktrees.removeSessionWorktree({
            session: session.id,
            repository: "product",
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });

        // What `gh pr view` answers decides it. A merged pull request whose
        // head is some other commit proves nothing; one whose head is this
        // tree's HEAD does; an open one does not yet.
        const answer = (state: string, headRefOid: string) =>
          pullRequestAnswerHoldsHead(
            "git",
            worktree.path,
            JSON.stringify({ state, headRefOid }),
          );
        const squashed = await git(["-C", source, "rev-parse", "HEAD"]);
        expect(await answer("MERGED", squashed)).toBe(false);
        expect(await answer("OPEN", head)).toBe(false);
        expect(await answer("MERGED", head)).toBe(true);
        expect(
          await pullRequestAnswerHoldsHead("git", worktree.path, "not json"),
        ).toBe(false);
        context.close();
      });
    });
  });
});

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { runCommand } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { createApplicationContext, parseGitHubRepositoryPages } from "../index";
import {
  contextWithStubbedAgent,
  createRepository,
} from "./workspace-content.fixtures";

test("parses every paginated GitHub repository and removes duplicates", () => {
  expect(
    parseGitHubRepositoryPages(
      JSON.stringify([
        [
          {
            name: "one",
            full_name: "example/one",
            clone_url: "https://github.com/example/one.git",
          },
        ],
        [
          {
            name: "two",
            full_name: "Example/two",
            clone_url: "https://github.com/Example/two.git",
          },
          {
            name: "ONE",
            full_name: "EXAMPLE/ONE",
            clone_url: "https://github.com/EXAMPLE/ONE.git",
          },
        ],
      ]),
    ),
  ).toEqual([
    {
      name: "one",
      nameWithOwner: "example/one",
      remoteUrl: "https://github.com/example/one.git",
    },
    {
      name: "two",
      nameWithOwner: "Example/two",
      remoteUrl: "https://github.com/Example/two.git",
    },
  ]);
});

describe("RepositoryLibrary", () => {
  test("fetches the latest remote default branch and prepares isolated lazy sessions", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const source = join(home, "repositories", "product");
      await createRepository(source);
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        reconcile: false,
      });
      const workspace = await context.workspaces.create({
        name: "Parallel work",
      });
      const task = await context.tasks.create({
        workspace: workspace.id,
        title: "Try two models",
      });
      const libraryRepository =
        await context.workspaceContent.library.addRepositoryToLibrary({
          remoteUrl: source,
        });
      await Bun.write(join(source, "README.md"), "# Latest remote state\n");
      expect(
        (await runCommand("git", ["-C", source, "add", "README.md"])).exitCode,
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
            "latest remote change",
          ])
        ).exitCode,
      ).toBe(0);
      const repository =
        await context.workspaceContent.library.attachRepository({
          workspace: workspace.id,
          libraryRepositoryId: libraryRepository.id,
        });
      const latestCommit = (
        await runCommand("git", ["-C", source, "rev-parse", "HEAD"])
      ).stdout.trim();
      expect(repository.baseBranch).toBe("main");
      expect(repository.baseCommit).toBe(latestCommit);
      expect(repository.referencePath).toBe(
        join(workspace.path, "repos", "product"),
      );
      expect(
        await readFile(join(repository.referencePath!, "README.md"), "utf8"),
      ).toBe("# Latest remote state\n");
      expect(
        await context.workspaceContent.listDirectory(
          workspace.id,
          join("repos", "product"),
        ),
      ).not.toContainEqual(expect.objectContaining({ name: ".git" }));
      await expect(
        context.workspaceContent.writeFile({
          workspace: workspace.id,
          path: join("repos", "product", "README.md"),
          content: "Do not edit references\n",
          expectedContent: "# Latest remote state\n",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      await context.workspaceContent.settleGitStatus(workspace.id);
      expect(
        (await context.workspaceContent.get(workspace.id)).repositories[0]
          ?.gitStatus,
      ).toMatchObject({ state: "clean", changedFiles: 0, ahead: 0, behind: 0 });

      // A routine pass leaves a measured reference checkout alone; only a
      // forced one, or the slow interval, measures it again.
      await Bun.write(
        join(repository.referencePath!, "README.md"),
        "Unmeasured reference edit\n",
      );
      await Bun.sleep(1_100);
      await context.workspaceContent.get(workspace.id);
      await context.workspaceContent.settleGitStatus();
      expect(
        (await context.workspaceContent.get(workspace.id)).repositories[0]
          ?.gitStatus,
      ).toMatchObject({ state: "clean", changedFiles: 0 });
      await context.workspaceContent.settleGitStatus(workspace.id);
      expect(
        (await context.workspaceContent.get(workspace.id)).repositories[0]
          ?.gitStatus,
      ).toMatchObject({ state: "modified", changedFiles: 1 });
      await Bun.write(
        join(repository.referencePath!, "README.md"),
        "# Latest remote state\n",
      );
      await context.workspaceContent.settleGitStatus(workspace.id);

      await Bun.write(join(source, "README.md"), "# Synced remote state\n");
      expect(
        (await runCommand("git", ["-C", source, "add", "README.md"])).exitCode,
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
            "state to synchronize",
          ])
        ).exitCode,
      ).toBe(0);
      const synchronized =
        await context.workspaceContent.library.syncRepository(repository.id);
      expect(synchronized.gitStatus).toMatchObject({
        state: "clean",
        ahead: 0,
        behind: 0,
      });
      expect(
        await readFile(join(repository.referencePath!, "README.md"), "utf8"),
      ).toBe("# Synced remote state\n");
      expect(
        context.workspaceContent.library
          .listRepositoryLibrary()
          .find((item) => item.id === libraryRepository.id)?.lastFetchedAt,
      ).toBe(synchronized.fetchedAt);

      await Bun.write(
        join(repository.referencePath!, "README.md"),
        "Local reference edit\n",
      );
      await context.workspaceContent.settleGitStatus(workspace.id);
      expect(
        (await context.workspaceContent.get(workspace.id)).repositories[0]
          ?.gitStatus,
      ).toMatchObject({ state: "modified", changedFiles: 1 });
      await expect(
        context.workspaceContent.library.syncRepository(repository.id),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await Bun.write(
        join(repository.referencePath!, "README.md"),
        "# Synced remote state\n",
      );

      const first = await context.workspaceContent.prepareSession({
        workspace,
        task,
        sessionId: "session-one",
      });
      const second = await context.workspaceContent.prepareSession({
        workspace,
        task,
        sessionId: "session-two",
      });

      const taskDirectory = join(
        workspace.path,
        "worktrees",
        `${task.number}-try-two-models`,
      );
      expect(first.workingDirectory).toBe(join(taskDirectory, "session-"));
      // Both IDs start with "session-", so the second takes its full ID.
      expect(second.workingDirectory).toBe(join(taskDirectory, "session-two"));
      expect(first.worktrees).toEqual([]);
      expect(second.worktrees).toEqual([]);
      expect(first.references).toEqual([
        expect.objectContaining({ id: repository.id, name: repository.name }),
      ]);
      expect(
        context.workspaceContent.library.listRepositoryLibrary(),
      ).toHaveLength(1);
      expect(
        (await context.workspaceContent.get(workspace.id)).worktrees,
      ).toEqual([]);
      context.close();
    });
  });

  describe("adding a repository", () => {
    test("records the remote branches and default branch without a second fetch", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const source = join(home, "source", "product");
        // Not `main`: the default branch has to be read from the clone rather
        // than assumed, now that `remote set-head --auto` no longer asks.
        await createRepository(source, "trunk");
        const context = await createApplicationContext({
          env: { DAEDALUS_HOME: home },
          reconcile: false,
        });
        const repository =
          await context.workspaceContent.library.addRepositoryToLibrary({
            remoteUrl: source,
          });
        expect(repository.defaultBranch).toBe("trunk");

        // Worktree creation and status comparison both resolve against
        // refs/remotes/origin/*, which a bare clone does not create on its own.
        const refs = await runCommand("git", [
          "--git-dir",
          repository.gitDirectory,
          "for-each-ref",
          "--format=%(refname)",
          "refs/remotes/",
        ]);
        expect(refs.stdout.trim().split("\n").sort()).toEqual([
          "refs/remotes/origin/HEAD",
          "refs/remotes/origin/trunk",
        ]);
        expect(
          (
            await runCommand("git", [
              "--git-dir",
              repository.gitDirectory,
              "symbolic-ref",
              "--short",
              "refs/remotes/origin/HEAD",
            ])
          ).stdout.trim(),
        ).toBe("origin/trunk");
        context.close();
      });
    });

    test("clones and attaches in one call, pinned to the remote tip", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const source = join(home, "source", "product");
        await createRepository(source);
        const context = await createApplicationContext({
          env: { DAEDALUS_HOME: home },
          reconcile: false,
        });
        const workspace = await context.workspaces.create({ name: "Combined" });
        const repository =
          await context.workspaceContent.library.addAndAttachRepository({
            workspace: workspace.id,
            remoteUrl: source,
          });
        expect(repository.baseBranch).toBe("main");
        expect(repository.baseCommit).toBe(
          (
            await runCommand("git", ["-C", source, "rev-parse", "HEAD"])
          ).stdout.trim(),
        );
        expect(repository.referencePath).toBe(
          join(workspace.path, "repos", "product"),
        );
        expect(
          await readFile(join(repository.referencePath!, "README.md"), "utf8"),
        ).toBe("# Source\n");
        expect(
          context.repositories.listWorkspaceRepositories(workspace.id),
        ).toHaveLength(1);
        context.close();
      });
    });

    test("a session worktree off a one-call attachment tracks the base branch", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const source = join(home, "source", "product");
        await createRepository(source, "trunk");
        const context = await contextWithStubbedAgent(home);
        const workspace = await context.workspaces.create({ name: "Combined" });
        await context.workspaceContent.library.addAndAttachRepository({
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
        expect(
          (
            await runCommand("git", ["-C", worktree.path, "rev-parse", "HEAD"])
          ).stdout.trim(),
        ).toBe(
          (
            await runCommand("git", ["-C", source, "rev-parse", "HEAD"])
          ).stdout.trim(),
        );
        context.close();
      });
    });
  });

  describe("fetching every repository", () => {
    const git = async (args: string[]) => {
      const result = await runCommand("git", args);
      expect(result.exitCode).toBe(0);
      return result.stdout.trim();
    };
    const commitIn = async (path: string, name: string) => {
      await Bun.write(join(path, name), `# ${name}\n`);
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
        `Add ${name}`,
      ]);
    };

    test("says what each checkout took, and why one stayed behind", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const moving = join(home, "source", "moving");
        const quiet = join(home, "source", "quiet");
        const held = join(home, "source", "held");
        for (const source of [moving, quiet, held])
          await createRepository(source);
        const context = await createApplicationContext({
          env: { DAEDALUS_HOME: home },
          reconcile: false,
        });
        const workspace = await context.workspaces.create({ name: "All" });
        const attached = [];
        for (const remoteUrl of [moving, quiet, held])
          attached.push(
            await context.workspaceContent.library.addAndAttachRepository({
              workspace: workspace.id,
              remoteUrl,
            }),
          );
        await commitIn(moving, "ONE.md");
        await commitIn(moving, "TWO.md");
        await commitIn(held, "LATER.md");
        await Bun.write(
          join(attached[2]!.referencePath!, "NOTES.md"),
          "mine\n",
        );

        const outcomes =
          await context.workspaceContent.library.fetchRepositories({
            workspace: workspace.id,
          });
        const byName = new Map(outcomes.map((item) => [item.name, item]));
        expect(byName.get("moving")).toMatchObject({
          newCommits: 2,
          behind: 0,
          commits: [{ subject: "Add TWO.md" }, { subject: "Add ONE.md" }],
          to: await git(["-C", moving, "rev-parse", "HEAD"]),
        });
        expect(byName.get("quiet")).toMatchObject({
          newCommits: 0,
          behind: 0,
          commits: [],
        });
        expect(byName.get("held")).toMatchObject({
          newCommits: 0,
          behind: 1,
          heldBack: "local-changes",
        });
        expect(byName.get("held")?.from).toBe(byName.get("held")?.to);

        // Naming one fetches only that one.
        const one = await context.workspaceContent.library.fetchRepositories({
          workspace: workspace.id,
          ids: [attached[1]!.id],
        });
        expect(one.map((item) => item.name)).toEqual(["quiet"]);
        context.close();
      });
    }, 30_000);

    test("counts as unpushed only the commits origin does not have", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const source = join(home, "source", "product");
        await createRepository(source);
        const context = await contextWithStubbedAgent(home);
        const workspace = await context.workspaces.create({ name: "Push" });
        await context.workspaceContent.library.addAndAttachRepository({
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
        await commitIn(worktree.path, "WORK.md");
        const status = async () => {
          await context.workspaceContent.settleGitStatus(workspace.id);
          return (await context.workspaceContent.get(workspace.id)).worktrees[0]
            ?.gitStatus;
        };
        expect(await status()).toMatchObject({ ahead: 1, unpushed: 1 });

        // Pushed: still ahead of the base branch, but nothing left to push.
        await context.workspaceContent.pushSessionWorktree({
          session: session.id,
          repository: "product",
        });
        await context.workspaceContent.get(workspace.id);
        expect(await status()).toMatchObject({ ahead: 1, unpushed: 0 });
        context.close();
      });
    });
  });

  describe("preparing a repository in the background", () => {
    test("the attachment exists immediately and becomes ready on its own", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const source = join(home, "source", "product");
        await createRepository(source);
        const context = await createApplicationContext({
          env: { DAEDALUS_HOME: home },
          reconcile: false,
        });
        const workspace = await context.workspaces.create({ name: "Async" });

        const pending =
          await context.workspaceContent.library.beginAddAndAttachRepository({
            workspace: workspace.id,
            remoteUrl: source,
          });
        // Named and listed before anything has been cloned.
        expect(pending.status).toBe("preparing");
        expect(pending.name).toBe("product");
        expect(pending.referencePath).toBeNull();
        expect(
          (await context.workspaceContent.get(workspace.id)).repositories,
        ).toHaveLength(1);

        // Nothing can be done to it while it is still arriving.
        await expect(
          context.workspaceContent.library.fetchRepository(pending.id),
        ).rejects.toMatchObject({ code: "CONFLICT" });

        await context.workspaceContent.library.settlePreparations();
        const ready = (await context.workspaceContent.get(workspace.id))
          .repositories[0];
        // Asserted as a pair so a failure prints why it failed rather than
        // only that it did.
        expect([ready?.status, ready?.statusError]).toEqual(["ready", null]);
        expect(ready?.id).toBe(pending.id);
        expect(ready?.baseBranch).toBe("main");
        expect(ready?.referencePath).toBe(
          join(workspace.path, "repos", "product"),
        );
        expect(
          await readFile(join(ready!.referencePath!, "README.md"), "utf8"),
        ).toBe("# Source\n");
        context.close();
      });
    });

    test("a repository that cannot be cloned says why, and can be dismissed", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const context = await createApplicationContext({
          env: { DAEDALUS_HOME: home },
          reconcile: false,
        });
        const workspace = await context.workspaces.create({ name: "Async" });
        const pending =
          await context.workspaceContent.library.beginAddAndAttachRepository({
            workspace: workspace.id,
            remoteUrl: join(home, "source", "missing"),
          });
        await context.workspaceContent.library.settlePreparations();

        const failed = (await context.workspaceContent.get(workspace.id))
          .repositories[0];
        expect(failed?.status).toBe("failed");
        expect(failed?.statusError ?? "").not.toBe("");
        // A failure is a row the user can clear, not a permanent resident.
        await context.workspaceContent.library.detachRepository(pending.id);
        expect(
          (await context.workspaceContent.get(workspace.id)).repositories,
        ).toHaveLength(0);
        context.close();
      });
    });

    test("a preparation interrupted by shutdown is reported, not left spinning", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const first = await createApplicationContext({
          env: { DAEDALUS_HOME: home },
          reconcile: false,
        });
        const workspace = await first.workspaces.create({ name: "Async" });
        // The state a quit mid-clone leaves behind, written directly rather
        // than by racing a real clone against `close()` — which way that race
        // falls is a property of the machine, not of the behaviour under test.
        first.repositories.createWorkspaceRepository({
          id: crypto.randomUUID(),
          workspaceId: workspace.id,
          name: "product",
          canonicalPath: join(home, "repos", "abandoned.git"),
          access: "write",
          libraryRepositoryId: null,
          referencePath: null,
          baseBranch: null,
          baseCommit: null,
          fetchedAt: null,
          createdAt: new Date().toISOString(),
          status: "preparing",
          statusError: null,
        });
        first.close();

        const second = await createApplicationContext({
          env: { DAEDALUS_HOME: home },
        });
        const recovered = (await second.workspaceContent.get(workspace.id))
          .repositories[0];
        expect(recovered?.status).toBe("failed");
        expect(recovered?.statusError).toContain("interrupted");
        second.close();
      });
    });
  });
});

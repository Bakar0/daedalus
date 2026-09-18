import { join } from "node:path";
import { lstat, mkdir, readFile, readlink, unlink } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  pathExists,
  runCommand,
  type TmuxClient,
  type TmuxLaunch,
} from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { createApplicationContext, parseGitHubRepositoryPages } from "../index";

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

async function createRepository(path: string, branch = "main"): Promise<void> {
  await mkdir(path, { recursive: true });
  expect(
    (await runCommand("git", ["init", "-q", "-b", branch, path])).exitCode,
  ).toBe(0);
  await Bun.write(join(path, "README.md"), "# Source\n");
  expect(
    (await runCommand("git", ["-C", path, "add", "README.md"])).exitCode,
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
        "initial",
      ])
    ).exitCode,
  ).toBe(0);
}

class FakeTmux implements TmuxClient {
  sessions = new Set<string>();
  launches: TmuxLaunch[] = [];
  async probe() {
    return "tmux 3.7c";
  }
  async createSession(launch: TmuxLaunch) {
    this.launches.push(launch);
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
}

describe("WorkspaceContentService", () => {
  test("creates visible workspace context without replacing existing files", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        reconcile: false,
      });
      const workspace = await context.workspaces.create({ name: "Content" });
      expect(
        await readFile(join(workspace.path, "BRIEF.md"), "utf8"),
      ).toContain("# Brief");
      expect(
        await readFile(join(workspace.path, "BRIEF.md"), "utf8"),
      ).not.toContain("## Active work");
      expect(
        await readFile(join(workspace.path, "JOURNAL.md"), "utf8"),
      ).toContain("# Journal");
      expect(
        await readFile(join(workspace.path, "AGENTS.md"), "utf8"),
      ).toContain("`BRIEF.md` contains the durable objective");
      expect(
        await readFile(join(workspace.path, "AGENTS.md"), "utf8"),
      ).toContain("daedal repo worktree create");
      expect(
        await readFile(join(workspace.path, "CLAUDE.md"), "utf8"),
      ).toContain("@AGENTS.md");
      expect(
        await readFile(
          join(workspace.path, ".agents/skills/daedalus-control/SKILL.md"),
          "utf8",
        ),
      ).toContain("name: daedalus-control");
      expect(
        await readFile(
          join(workspace.path, ".claude/skills/daedalus-control/SKILL.md"),
          "utf8",
        ),
      ).toContain("daedal repo library add");
      expect(
        (
          await lstat(join(workspace.path, ".agents/skills/daedalus-control"))
        ).isSymbolicLink(),
      ).toBe(true);
      expect(
        await readlink(join(workspace.path, ".agents/skills/daedalus-control")),
      ).toBe(join(home, "skills", "daedalus-control"));
      const briefPath = join(workspace.path, "BRIEF.md");
      const simpleBrief = await readFile(briefPath, "utf8");
      await Bun.write(
        briefPath,
        `${simpleBrief}\n## Active work\n\n## Blockers\n\n## Next steps\n`,
      );
      await context.workspaceContent.get(workspace.id);
      expect(await readFile(briefPath, "utf8")).toBe(simpleBrief);
      await Bun.write(join(workspace.path, "BRIEF.md"), "# My brief\n");
      await mkdir(join(workspace.path, "notes"));
      await Bun.write(join(workspace.path, "notes", "idea.txt"), "Try this.\n");
      await context.workspaceContent.get(workspace.id);
      expect(await readFile(join(workspace.path, "BRIEF.md"), "utf8")).toBe(
        "# My brief\n",
      );
      expect(
        await context.workspaceContent.listDirectory(workspace.id, "notes"),
      ).toEqual([
        { name: "idea.txt", path: join("notes", "idea.txt"), kind: "file" },
      ]);
      expect(
        await context.workspaceContent.readFile(
          workspace.id,
          join("notes", "idea.txt"),
        ),
      ).toMatchObject({ content: "Try this.\n", format: "text" });
      const folder = await context.workspaceContent.createEntry({
        workspace: workspace.id,
        name: "drafts",
        kind: "directory",
      });
      const file = await context.workspaceContent.createEntry({
        workspace: workspace.id,
        parentPath: folder.path,
        name: "plan.md",
        kind: "file",
      });
      const saved = await context.workspaceContent.writeFile({
        workspace: workspace.id,
        path: file.path,
        content: "# Plan\n",
        expectedContent: "",
      });
      expect(saved).toMatchObject({ content: "# Plan\n", format: "markdown" });
      await expect(
        context.workspaceContent.writeFile({
          workspace: workspace.id,
          path: file.path,
          content: "Overwrite\n",
          expectedContent: "",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        context.workspaceContent.readFile(workspace.id, "../outside.txt"),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(
        context.workspaceContent.readFile(
          workspace.id,
          ".daedalus/workspace.json",
        ),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      context.close();
    });
  });

  test("toggles generated instruction files and preserves user-authored files", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        reconcile: false,
      });
      const generated = await context.workspaces.create({ name: "Generated" });
      const customized = await context.workspaces.create({
        name: "Customized",
      });
      const generatedPath = join(generated.path, "AGENTS.md");
      const generatedContents = await readFile(generatedPath, "utf8");
      const legacyContents = `<!-- Generated by Daedalus. Configure this in Settings. -->
# Daedalus workspace

Before working in this workspace:

1. Read \`BRIEF.md\`.
2. Read recent entries in \`JOURNAL.md\`.
3. Read \`.daedalus/workspace.json\` for workspace metadata.
4. Respect the access role of every attached repository.
5. Read project-specific instructions inside a repository before modifying it.
6. Treat \`repos/\` checkouts as read-only. Before modifying a repository, create only the worktree you need with \`daedal repo worktree create --session "$DAEDALUS_SESSION_ID" --repository <repository-name>\`, then work in the returned path.
7. Add meaningful decisions, blockers, questions, and handoffs to \`JOURNAL.md\`.
`;
      expect(legacyContents).not.toBe(generatedContents);
      await Bun.write(generatedPath, legacyContents);
      await context.workspaceContent.get(generated.id);
      expect(await readFile(generatedPath, "utf8")).toBe(generatedContents);
      await Bun.write(join(customized.path, "AGENTS.md"), "# My rules\n");
      const customizedSkillPath = join(
        customized.path,
        ".agents/skills/daedalus-control/SKILL.md",
      );
      await unlink(join(customized.path, ".agents/skills/daedalus-control"));
      await mkdir(join(customized.path, ".agents/skills/daedalus-control"));
      await Bun.write(customizedSkillPath, "# My custom skill\n");

      await context.workspaceContent.setInstructionFilesEnabled(false);
      expect(await Bun.file(join(generated.path, "AGENTS.md")).exists()).toBe(
        false,
      );
      expect(await Bun.file(join(generated.path, "CLAUDE.md")).exists()).toBe(
        false,
      );
      expect(await readFile(join(customized.path, "AGENTS.md"), "utf8")).toBe(
        "# My rules\n",
      );
      expect(await Bun.file(join(customized.path, "CLAUDE.md")).exists()).toBe(
        false,
      );
      expect(
        await Bun.file(
          join(generated.path, ".agents/skills/daedalus-control/SKILL.md"),
        ).exists(),
      ).toBe(false);
      expect(
        await Bun.file(
          join(generated.path, ".claude/skills/daedalus-control/SKILL.md"),
        ).exists(),
      ).toBe(false);
      expect(await readFile(customizedSkillPath, "utf8")).toBe(
        "# My custom skill\n",
      );

      const disabledWorkspace = await context.workspaces.create({
        name: "Disabled",
      });
      expect(
        await Bun.file(join(disabledWorkspace.path, "AGENTS.md")).exists(),
      ).toBe(false);
      expect(
        await Bun.file(
          join(
            disabledWorkspace.path,
            ".agents/skills/daedalus-control/SKILL.md",
          ),
        ).exists(),
      ).toBe(false);

      await context.workspaceContent.setInstructionFilesEnabled(true);
      expect(await Bun.file(join(generated.path, "AGENTS.md")).exists()).toBe(
        true,
      );
      expect(await Bun.file(join(generated.path, "CLAUDE.md")).exists()).toBe(
        true,
      );
      expect(await readFile(join(customized.path, "AGENTS.md"), "utf8")).toBe(
        "# My rules\n",
      );
      expect(await Bun.file(join(customized.path, "CLAUDE.md")).exists()).toBe(
        false,
      );
      expect(
        await Bun.file(
          join(generated.path, ".agents/skills/daedalus-control/SKILL.md"),
        ).exists(),
      ).toBe(true);
      expect(
        await Bun.file(
          join(generated.path, ".claude/skills/daedalus-control/SKILL.md"),
        ).exists(),
      ).toBe(true);
      expect(await readFile(customizedSkillPath, "utf8")).toBe(
        "# My custom skill\n",
      );
      context.close();
    });
  });

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
        await context.workspaceContent.addRepositoryToLibrary({
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
      const repository = await context.workspaceContent.attachRepository({
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

      expect(
        (await context.workspaceContent.get(workspace.id)).repositories[0]
          ?.gitStatus,
      ).toMatchObject({ state: "clean", changedFiles: 0, ahead: 0, behind: 0 });
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
      const synchronized = await context.workspaceContent.syncRepository(
        repository.id,
      );
      expect(synchronized.gitStatus).toMatchObject({
        state: "clean",
        ahead: 0,
        behind: 0,
      });
      expect(
        await readFile(join(repository.referencePath!, "README.md"), "utf8"),
      ).toBe("# Synced remote state\n");
      expect(
        context.workspaceContent
          .listRepositoryLibrary()
          .find((item) => item.id === libraryRepository.id)?.lastFetchedAt,
      ).toBe(synchronized.fetchedAt);

      await Bun.write(
        join(repository.referencePath!, "README.md"),
        "Local reference edit\n",
      );
      expect(
        (await context.workspaceContent.get(workspace.id)).repositories[0]
          ?.gitStatus,
      ).toMatchObject({ state: "modified", changedFiles: 1 });
      await expect(
        context.workspaceContent.syncRepository(repository.id),
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

      expect(first.workingDirectory).toBe(
        join(
          workspace.path,
          "worktrees",
          `${task.id.slice(0, 12)}-try-two-models`,
          "session-one",
        ),
      );
      expect(second.workingDirectory).not.toBe(first.workingDirectory);
      expect(first.worktrees).toEqual([]);
      expect(second.worktrees).toEqual([]);
      expect(first.references).toEqual([
        expect.objectContaining({ id: repository.id, name: repository.name }),
      ]);
      expect(context.workspaceContent.listRepositoryLibrary()).toHaveLength(1);
      expect(
        (await context.workspaceContent.get(workspace.id)).worktrees,
      ).toEqual([]);
      context.close();
    });
  });

  test("appends typed journal entries", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        reconcile: false,
      });
      const workspace = await context.workspaces.create({ name: "Journal" });
      await context.workspaceContent.appendJournal({
        workspace: workspace.id,
        kind: "decision",
        summary: "Use one worktree per session.",
      });
      const content = await context.workspaceContent.get(workspace.id);
      expect(content.journal).toContain("· decision");
      expect(content.journal).toContain("Use one worktree per session.");
      context.close();
    });
  });

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
          `${task.id.slice(0, 12)}-implement-feature`,
          session.id,
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

      const worktree = await context.workspaceContent.createSessionWorktree({
        session: session.id,
        repository: "app",
      });
      expect(worktree.path).toBe(join(session.workingDirectory, "app"));
      expect(await readFile(join(worktree.path, "README.md"), "utf8")).toBe(
        "# Source\n",
      );
      expect(
        await context.workspaceContent.createSessionWorktree({
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
      const worktree = await context.workspaceContent.createSessionWorktree({
        session: session.id,
        repository: "app",
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

      // The attachment pin is untouched: the read-only planning checkout under
      // repos/ still sits where the workspace put it.
      expect(
        (await context.workspaceContent.get(workspace.id)).repositories.find(
          (item) => item.name === "app",
        )?.baseCommit,
      ).toBe(attachedCommit);
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
          await context.workspaceContent.addRepositoryToLibrary({
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
          await context.workspaceContent.addAndAttachRepository({
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
        const context = await createApplicationContext({
          env: { DAEDALUS_HOME: home },
          reconcile: false,
        });
        const workspace = await context.workspaces.create({ name: "Combined" });
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

  describe("working tree state", () => {
    test("reports each worktree's own changes and distance from the base branch", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const source = join(home, "source", "product");
        await createRepository(source);
        const context = await createApplicationContext({
          env: { DAEDALUS_HOME: home },
          reconcile: false,
        });
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
        });

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

        const moved = (await context.workspaceContent.get(workspace.id))
          .worktrees[0];
        expect(moved?.gitStatus).toEqual({
          state: "modified",
          changedFiles: 1,
          ahead: 1,
          behind: 0,
        });

        // The read-only planning checkout is unaffected by the agent's work.
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
        const context = await createApplicationContext({
          env: { DAEDALUS_HOME: home },
          reconcile: false,
        });
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
        const context = await createApplicationContext({
          env: { DAEDALUS_HOME: home },
          reconcile: false,
        });
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

    test("fetching updates the shared clone without touching the checkout", async () => {
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
        const checkedOut = (
          await runCommand("git", [
            "-C",
            attached.referencePath!,
            "rev-parse",
            "HEAD",
          ])
        ).stdout.trim();

        await Bun.write(join(source, "SHIPPED.md"), "# Shipped\n");
        expect(
          (await runCommand("git", ["-C", source, "add", "SHIPPED.md"]))
            .exitCode,
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
              "landed upstream",
            ])
          ).exitCode,
        ).toBe(0);

        const fetched = await context.workspaceContent.fetchRepository(
          attached.id,
        );
        // The status is now true again...
        expect(fetched.gitStatus).toMatchObject({ state: "behind", behind: 1 });
        // ...without the working tree having moved.
        expect(
          (
            await runCommand("git", [
              "-C",
              attached.referencePath!,
              "rev-parse",
              "HEAD",
            ])
          ).stdout.trim(),
        ).toBe(checkedOut);
        context.close();
      });
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
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        reconcile: false,
      });
      const workspace = await context.workspaces.create({ name: "Remove" });
      const repository = await context.workspaceContent.addAndAttachRepository({
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

        await context.workspaceContent.removeSessionWorktree({
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

    test("refuses to remove a tree holding uncommitted or unpushed work", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const { context, session, worktree } = await scenario(home);

        await Bun.write(join(worktree.path, "SCRATCH.md"), "# scratch\n");
        await expect(
          context.workspaceContent.removeSessionWorktree({
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
          context.workspaceContent.removeSessionWorktree({
            session: session.id,
            repository: "product",
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(await pathExists(worktree.path)).toBe(true);

        // Pushing is what the message tells the user to do, so pushing has to
        // be what clears it. Measuring this against the base branch instead
        // produced a guard that refused just the same after a push.
        await context.workspaceContent.pushSessionWorktree({
          session: session.id,
          repository: "product",
        });
        await context.workspaceContent.removeSessionWorktree({
          session: session.id,
          repository: "product",
        });
        expect(await pathExists(worktree.path)).toBe(false);
        context.close();
      });
    });

    test("archiving a session releases only the trees that hold nothing", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const { context, workspace, session, worktree } = await scenario(home);
        const keeper = await context.agents.spawn({
          workspace: workspace.id,
          provider: "claude",
        });
        const kept = await context.workspaceContent.createSessionWorktree({
          session: keeper.id,
          repository: "product",
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
          await context.workspaceContent.beginAddAndAttachRepository({
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
          context.workspaceContent.fetchRepository(pending.id),
        ).rejects.toMatchObject({ code: "CONFLICT" });

        await context.workspaceContent.settlePreparations();
        const ready = (await context.workspaceContent.get(workspace.id))
          .repositories[0];
        expect(ready?.status).toBe("ready");
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
          await context.workspaceContent.beginAddAndAttachRepository({
            workspace: workspace.id,
            remoteUrl: join(home, "source", "missing"),
          });
        await context.workspaceContent.settlePreparations();

        const failed = (await context.workspaceContent.get(workspace.id))
          .repositories[0];
        expect(failed?.status).toBe("failed");
        expect(failed?.statusError ?? "").not.toBe("");
        // A failure is a row the user can clear, not a permanent resident.
        await context.workspaceContent.detachRepository(pending.id);
        expect(
          (await context.workspaceContent.get(workspace.id)).repositories,
        ).toHaveLength(0);
        context.close();
      });
    });

    test("a preparation interrupted by shutdown is reported, not left spinning", async () => {
      await withTemporaryDaedalusHome(async (home) => {
        const source = join(home, "source", "product");
        await createRepository(source);
        const first = await createApplicationContext({
          env: { DAEDALUS_HOME: home },
          reconcile: false,
        });
        const workspace = await first.workspaces.create({ name: "Async" });
        await first.workspaceContent.beginAddAndAttachRepository({
          workspace: workspace.id,
          remoteUrl: source,
        });
        // Closing without settling is what a crash or a quit looks like.
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

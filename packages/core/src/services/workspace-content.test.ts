import { isAbsolute, join } from "node:path";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  pathExists,
  runCommand,
  type TmuxClient,
  type TmuxLaunch,
} from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { createApplicationContext, parseGitHubRepositoryPages } from "../index";
import { pullRequestAnswerHoldsHead } from "./workspace-content";

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

/**
 * A context whose agent provider is stubbed, following `agents.test.ts`.
 *
 * Spawning `claude` for real needs the binary on PATH — which CI does not have
 * — waits up to thirty seconds for it to report ready, and leaves a live agent
 * behind, all to obtain a session row that a working tree can hang from.
 * Pointing the provider at a harmless executable and faking tmux gives the same
 * session with none of that, and keeps it archivable, which a `command`
 * session is not: those are provider `custom` and deliberately cannot be.
 */
async function contextWithStubbedAgent(home: string) {
  await Bun.write(
    join(home, "config.json"),
    JSON.stringify({
      agents: { claude: { executable: process.execPath, args: ["run"] } },
    }),
  );
  return createApplicationContext({
    env: { DAEDALUS_HOME: home },
    tmux: new FakeTmux(),
    reconcile: false,
  });
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
    // A screen that looks like a started provider. Spawning a Claude session
    // polls the pane until it recognises one, so an empty capture makes every
    // spawn wait out the full startup timeout instead of returning.
    return "Ask Codex to do anything\nClaude Code v2.1.251\nshift+tab to cycle";
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
      // Skills are installed globally now, so a workspace carries instruction
      // files and no skill links of its own.
      expect(
        await pathExists(
          join(workspace.path, ".agents/skills/daedalus-control"),
        ),
      ).toBe(false);
      expect(
        await pathExists(
          join(workspace.path, ".claude/skills/daedalus-control"),
        ),
      ).toBe(false);
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
        {
          name: "idea.txt",
          path: join("notes", "idea.txt"),
          kind: "file",
          mutable: true,
        },
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
      // A real directory the user put where the old managed link used to sit.
      // Retiring the per-workspace links must not take it with them.
      await mkdir(join(customized.path, ".agents/skills/daedalus-control"), {
        recursive: true,
      });
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
        await pathExists(
          join(generated.path, ".agents/skills/daedalus-control"),
        ),
      ).toBe(false);
      expect(
        await pathExists(
          join(generated.path, ".claude/skills/daedalus-control"),
        ),
      ).toBe(false);
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

      await context.workspaceContent.settleGitStatus(workspace.id);
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
      await context.workspaceContent.settleGitStatus(workspace.id);
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
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          name: "notes.md",
          kind: "file",
        });
        await context.workspaceContent.writeFile({
          workspace: workspaceId,
          path: "notes.md",
          content: "# Notes\n",
          expectedContent: "",
        });
        expect(
          await context.workspaceContent.renameEntry({
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
          await context.workspaceContent.readFile(workspaceId, "ideas.md"),
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
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          name: "draft",
          kind: "directory",
        });
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          parentPath: "draft",
          name: "plan.md",
          kind: "file",
        });
        await context.workspaceContent.renameEntry({
          workspace: workspaceId,
          path: "draft",
          name: "final",
        });
        expect(
          (
            await context.workspaceContent.listDirectory(workspaceId, "final")
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
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          name: "Readme.md",
          kind: "file",
        });
        expect(
          await context.workspaceContent.renameEntry({
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
          await context.workspaceContent.createEntry({
            workspace: workspaceId,
            name,
            kind: "file",
          });
        await context.workspaceContent.writeFile({
          workspace: workspaceId,
          path: "two.md",
          content: "keep me\n",
          expectedContent: "",
        });
        await expect(
          context.workspaceContent.renameEntry({
            workspace: workspaceId,
            path: "one.md",
            name: "two.md",
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(
          await context.workspaceContent.readFile(workspaceId, "two.md"),
        ).toMatchObject({ content: "keep me\n" });
      });
    });

    test("refuses a name that is not one path segment", async () => {
      await withWorkspace(async ({ context, workspaceId }) => {
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          name: "notes.md",
          kind: "file",
        });
        for (const name of ["../escape.md", "nested/name.md", "..", ""])
          await expect(
            context.workspaceContent.renameEntry({
              workspace: workspaceId,
              path: "notes.md",
              name,
            }),
          ).rejects.toMatchObject({ code: "VALIDATION" });
      });
    });

    test("moves an entry into another folder and back to the root", async () => {
      await withWorkspace(async ({ context, workspaceId }) => {
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          name: "inbox",
          kind: "directory",
        });
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          name: "note.md",
          kind: "file",
        });
        expect(
          await context.workspaceContent.moveEntry({
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
          await context.workspaceContent.moveEntry({
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
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          name: "outer",
          kind: "directory",
        });
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          parentPath: "outer",
          name: "inner",
          kind: "directory",
        });
        for (const destinationPath of ["outer", "outer/inner"])
          await expect(
            context.workspaceContent.moveEntry({
              workspace: workspaceId,
              path: "outer",
              destinationPath,
            }),
          ).rejects.toMatchObject({ code: "VALIDATION" });
      });
    });

    test("removes a file, and a folder with everything under it", async () => {
      await withWorkspace(async ({ context, workspaceId, workspacePath }) => {
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          name: "scratch",
          kind: "directory",
        });
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          parentPath: "scratch",
          name: "a.md",
          kind: "file",
        });
        expect(
          await context.workspaceContent.removeEntry({
            workspace: workspaceId,
            path: "scratch",
          }),
        ).toEqual({
          name: "scratch",
          path: "scratch",
          kind: "directory",
          mutable: true,
        });
        expect(await pathExists(join(workspacePath, "scratch"))).toBe(false);
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
            context.workspaceContent.renameEntry({
              workspace: workspaceId,
              path: "repos/daedalus/README.md",
              name: "OTHER.md",
            }),
          () =>
            context.workspaceContent.removeEntry({
              workspace: workspaceId,
              path: "repos/daedalus/README.md",
            }),
          () =>
            context.workspaceContent.moveEntry({
              workspace: workspaceId,
              path: "repos/daedalus/README.md",
              destinationPath: "",
            }),
        ])
          await expect(attempt()).rejects.toMatchObject({ code: "CONFLICT" });
        // And refuses to move something *into* it, which is the direction the
        // read-only check on the source path does not cover.
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          name: "note.md",
          kind: "file",
        });
        await expect(
          context.workspaceContent.moveEntry({
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
          context.workspaceContent.removeEntry({
            workspace: workspaceId,
            path: "",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION" });
        for (const path of ["worktrees", "artifacts"])
          await expect(
            context.workspaceContent.renameEntry({
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
            context.workspaceContent.removeEntry({
              workspace: workspaceId,
              path,
            }),
          ).rejects.toMatchObject({ code: "CONFLICT" });
          // Renaming is the worse half: it also succeeded, and the original
          // then regenerated beside it, silently leaving two files.
          await expect(
            context.workspaceContent.renameEntry({
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
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          name: "notes",
          kind: "directory",
        });
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          parentPath: "notes",
          name: "BRIEF.md",
          kind: "file",
        });
        expect(
          await context.workspaceContent.removeEntry({
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
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          name: "notes.md",
          kind: "file",
        });
        const byPath = new Map(
          (await context.workspaceContent.listDirectory(workspaceId)).map(
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
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          name: "notes",
          kind: "directory",
        });
        const created = await context.workspaceContent.createEntry({
          workspace: workspaceId,
          parentPath: "notes",
          name: "BRIEF.md",
          kind: "file",
        });
        expect(created.mutable).toBe(true);
        expect(
          (
            await context.workspaceContent.listDirectory(workspaceId, "notes")
          )[0]?.mutable,
        ).toBe(true);
      });
    });

    test("keeps every verb inside the workspace and away from its metadata", async () => {
      await withWorkspace(async ({ context, workspaceId }) => {
        await expect(
          context.workspaceContent.removeEntry({
            workspace: workspaceId,
            path: "../outside.md",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION" });
        await expect(
          context.workspaceContent.removeEntry({
            workspace: workspaceId,
            path: ".daedalus/workspace.json",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION" });
        await context.workspaceContent.createEntry({
          workspace: workspaceId,
          name: "note.md",
          kind: "file",
        });
        await expect(
          context.workspaceContent.moveEntry({
            workspace: workspaceId,
            path: "note.md",
            destinationPath: "..",
          }),
        ).rejects.toMatchObject({ code: "VALIDATION" });
      });
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
        const context = await contextWithStubbedAgent(home);
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
        });

        // The listing deliberately does not wait for git, so the measurement
        // is asked for rather than assumed to have happened.
        await context.workspaceContent.get(workspace.id);
        await context.workspaceContent.settleGitStatus(workspace.id);

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

        await context.workspaceContent.settleGitStatus(workspace.id);
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
        });

        // The board reads the same measurement for every workspace at once,
        // without the workspace view having been opened.
        context.workspaceContent.listWorktrees();
        await context.workspaceContent.settleGitStatus(null);
        expect(context.workspaceContent.listWorktrees()).toMatchObject([
          {
            sessionId: session.id,
            path: worktree.path,
            gitStatus: { ahead: 1, filesAhead: 1 },
          },
        ]);

        // The read-only planning checkout is unaffected by the agent's work.
        await context.workspaceContent.settleGitStatus(workspace.id);
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

    test("names a task's branch after the task, and follows a branch the agent switched to", async () => {
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
        const worktree = await context.workspaceContent.createSessionWorktree({
          session: session.id,
          repository: "product",
        });
        expect(worktree.branchName).toBe(
          `daedalus/agent-status-in-the-app-${session.id.slice(0, 8)}`,
        );

        // The agent moves its work to a branch of its own.
        await git(["-C", worktree.path, "checkout", "-q", "-b", "topic"]);
        await commitIn(worktree.path, "WORK.md");
        const pushed = await context.workspaceContent.pushSessionWorktree({
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
        await context.workspaceContent.removeSessionWorktree({
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
        const worktree = await context.workspaceContent.createSessionWorktree({
          session: session.id,
          repository: "product",
        });
        await commitIn(worktree.path, "ONE.md");
        await commitIn(worktree.path, "TWO.md");
        await context.workspaceContent.pushSessionWorktree({
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
          context.workspaceContent.removeSessionWorktree({
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

      await context.workspaceContent.settleGitStatus(workspace.id);
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

      await context.workspaceContent.settleGitStatus(workspace.id);
      expect(
        (await context.workspaceContent.get(workspace.id)).repositories[0]
          ?.gitStatus?.state,
      ).toBe("clean");
      expect((await stat(resolvedIndex)).mtimeMs).toBe(before);
      context.close();
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

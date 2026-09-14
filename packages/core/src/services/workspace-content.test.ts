import { join } from "node:path";
import { lstat, mkdir, readFile, readlink, unlink } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
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

async function createRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  expect(
    (await runCommand("git", ["init", "-q", "-b", "main", path])).exitCode,
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
});

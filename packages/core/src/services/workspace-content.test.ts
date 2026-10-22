import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { pathExists } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { createApplicationContext, versionsAfterAnnouncing } from "../index";
import { createRepository, FakeTmux } from "./workspace-content.fixtures";
import {
  AGENTS_TEMPLATE,
  ensureSessionInstructionFiles,
  ensureWorkspaceContentFiles,
  sessionDirectoryName,
  sessionInstructionsTemplate,
  sessionTaskDirectoryName,
} from "./workspace-content";

describe("session folder names", () => {
  test("uses the task number and the first words of the title", () => {
    expect(
      sessionTaskDirectoryName({
        number: 42,
        title:
          "looks like we have issue with the git eorking tree i dsdont see agents working treers",
      }),
    ).toBe("42-looks-like-we-have-issue-with");
    expect(sessionTaskDirectoryName({ number: 7, title: "Fix login" })).toBe(
      "7-fix-login",
    );
    expect(sessionTaskDirectoryName({ number: 3, title: "!!!" })).toBe(
      "3-task",
    );
  });

  test("names a session by provider and short ID", () => {
    expect(
      sessionDirectoryName({
        sessionId: "038ed21c-dfdf-4201-858f-0eb9b89ff8da",
        provider: "claude",
      }),
    ).toBe("claude-038ed21c");
    expect(
      sessionDirectoryName({
        sessionId: "038ed21c-dfdf-4201-858f-0eb9b89ff8da",
      }),
    ).toBe("038ed21c");
  });
});

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
      // Images come back as base64 for the viewer; anything else is refused.
      const pixel = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
      await Bun.write(join(workspace.path, "notes", "dot.png"), pixel);
      expect(
        await context.workspaceContent.readImage(
          workspace.id,
          join("notes", "dot.png"),
        ),
      ).toEqual({
        name: "dot.png",
        path: join("notes", "dot.png"),
        mimeType: "image/png",
        base64: Buffer.from(pixel).toString("base64"),
      });
      await expect(
        context.workspaceContent.readImage(
          workspace.id,
          join("notes", "idea.txt"),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(
        context.workspaceContent.readImage(workspace.id, "../outside.png"),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      // A file dropped from Finder comes in byte for byte, binary or not,
      // and never over a name already there.
      const imported = await context.workspaceContent.importFile({
        workspace: workspace.id,
        parentPath: "notes",
        name: "logo.png",
        base64: Buffer.from(pixel).toString("base64"),
      });
      expect(imported.path).toBe(join("notes", "logo.png"));
      expect(
        new Uint8Array(
          await Bun.file(
            join(workspace.path, "notes", "logo.png"),
          ).arrayBuffer(),
        ),
      ).toEqual(pixel);
      await expect(
        context.workspaceContent.importFile({
          workspace: workspace.id,
          parentPath: "notes",
          name: "logo.png",
          base64: "",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
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
});

// The journal line generated instruction files carried before entries had a
// size, in place of the current one.
function withUnsizedJournal(workspacePath: string, current: string): string {
  const journal = join(workspacePath, "JOURNAL.md");
  return current.replace(
    /^2\. .*$/m,
    `2. \`${journal}\` contains chronological decisions, progress, blockers, questions, and handoffs. Read recent entries when prior workspace activity matters, and add meaningful updates when useful.`,
  );
}

test("a session's instructions from before journal entries had a size are upgraded", async () => {
  await withTemporaryDaedalusHome(async (home) => {
    const workspacePath = join(home, "workspace");
    const sessionPath = join(home, "session");
    await mkdir(sessionPath, { recursive: true });
    const agentsPath = join(sessionPath, "AGENTS.md");
    const current = sessionInstructionsTemplate(workspacePath);
    expect(current).toContain("at most 5 one-line bullets");
    expect(current).toContain(join(workspacePath, "journal"));
    const previous = withUnsizedJournal(workspacePath, current);
    expect(previous).not.toBe(current);

    await Bun.write(agentsPath, previous);
    await ensureSessionInstructionFiles(sessionPath, workspacePath, home, true);
    expect(await readFile(agentsPath, "utf8")).toBe(current);
  });
});

test("a workspace's AGENTS.md from before journal entries had a size is upgraded", async () => {
  await withTemporaryDaedalusHome(async (home) => {
    const workspacePath = join(home, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const agentsPath = join(workspacePath, "AGENTS.md");
    const previous = AGENTS_TEMPLATE.replace(
      /^2\. .*$/m,
      "2. \`JOURNAL.md\` contains chronological decisions, progress, blockers, questions, and handoffs. Read recent entries when prior workspace activity matters, and add meaningful updates when useful.",
    );
    expect(previous).not.toBe(AGENTS_TEMPLATE);
    await Bun.write(agentsPath, previous);
    await ensureWorkspaceContentFiles(workspacePath, home);
    expect(await readFile(agentsPath, "utf8")).toBe(AGENTS_TEMPLATE);
  });
});

test("a session's instructions from before --branch was required are upgraded, and removed when turned off", async () => {
  await withTemporaryDaedalusHome(async (home) => {
    const workspacePath = join(home, "workspace");
    const sessionPath = join(home, "session");
    await mkdir(sessionPath, { recursive: true });
    const agentsPath = join(sessionPath, "AGENTS.md");
    const current = sessionInstructionsTemplate(workspacePath);
    const previous = withUnsizedJournal(workspacePath, current).replace(
      / --branch <branch-name>`, then work in the returned path\..*$/m,
      "`, then work in the returned path.",
    );
    expect(previous).not.toContain("--branch");

    await Bun.write(agentsPath, previous);
    await ensureSessionInstructionFiles(sessionPath, workspacePath, home, true);
    expect(await readFile(agentsPath, "utf8")).toBe(current);

    await Bun.write(agentsPath, previous);
    await ensureSessionInstructionFiles(
      sessionPath,
      workspacePath,
      home,
      false,
    );
    expect(await pathExists(agentsPath)).toBe(false);
  });
});

describe("announcing repository changes", () => {
  test("a git measurement names its parts; a finished preparation names none", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const source = join(home, "source", "product");
      await createRepository(source);
      const announced: Array<string[] | undefined> = [];
      const context = await createApplicationContext({
        env: { DAEDALUS_HOME: home },
        tmux: new FakeTmux(),
        reconcile: false,
        onRepositoriesChanged: (parts) => announced.push(parts),
      });
      try {
        const workspace = await context.workspaces.create({ name: "Notes" });
        // As the window attaches one: the clone finishes in the background.
        await context.workspaceContent.beginAddAndAttachRepository({
          workspace: workspace.id,
          remoteUrl: source,
        });
        await context.workspaceContent.settlePreparations();
        // The repository's own row moved, so the window reloads in full.
        expect(announced).toContain(undefined);
        announced.length = 0;
        // Its first measured status moves only the measured parts.
        await context.workspaceContent.settleGitStatus(workspace.id);
        expect(announced).toEqual([["worktrees", "shipped"]]);
      } finally {
        context.close();
      }
    });
  }, 30_000);
});

describe("versionsAfterAnnouncing", () => {
  const previous = { workspaces: "w1", sessionActivity: "a1", worktrees: "t1" };
  const current = { workspaces: "w2", sessionActivity: "a2", worktrees: "t2" };
  test("a whole reload takes every current version", () => {
    expect(versionsAfterAnnouncing(previous, current)).toEqual(current);
  });
  test("a partial one takes only its own, so other changes still show", () => {
    expect(versionsAfterAnnouncing(previous, current, ["worktrees"])).toEqual({
      workspaces: "w1",
      sessionActivity: "a1",
      worktrees: "t2",
    });
  });
  test("a part with no version of its own is left out", () => {
    expect(versionsAfterAnnouncing(previous, current, ["shipped"])).toEqual(
      previous,
    );
  });
});

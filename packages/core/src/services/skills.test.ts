import {
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { pathExists } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { createApplicationContext } from "../index";
import { parseSkillFrontmatter, removeMarkedBlock, styleBody } from "./skills";

/**
 * Every test gets its own provider homes as well as its own Daedalus home.
 * The skill system writes into `~/.claude`, `~/.agents` and `~/.codex`, and a
 * suite that reached the real ones would rewrite the machine running it.
 */
async function withSkillHomes<T>(
  run: (input: {
    context: Awaited<ReturnType<typeof createApplicationContext>>;
    home: string;
    claudeHome: string;
    codexHome: string;
    agentsHome: string;
    cursorHome: string;
  }) => Promise<T>,
): Promise<T> {
  return withTemporaryDaedalusHome(async (root) => {
    const home = join(root, "daedalus");
    const claudeHome = join(root, "claude");
    const codexHome = join(root, "codex");
    const agentsHome = join(root, "agents");
    const cursorHome = join(root, "cursor");
    const context = await createApplicationContext({
      env: {
        DAEDALUS_HOME: home,
        CLAUDE_CONFIG_DIR: claudeHome,
        CODEX_HOME: codexHome,
        DAEDALUS_AGENTS_HOME: agentsHome,
        DAEDALUS_CURSOR_HOME: cursorHome,
      },
      reconcile: false,
    });
    try {
      return await run({
        context,
        home,
        claudeHome,
        codexHome,
        agentsHome,
        cursorHome,
      });
    } finally {
      context.close();
    }
  });
}

describe("skill frontmatter", () => {
  test("reads the keys the app acts on and reports a file it cannot read", () => {
    const parsed = parseSkillFrontmatter(
      '---\nname: unslop\ndescription: "Cut AI tells"\ndisable-model-invocation: true\n---\n\nBody\n',
    );
    expect(parsed).toEqual({
      name: "unslop",
      description: "Cut AI tells",
      disableModelInvocation: true,
    });
    expect(parseSkillFrontmatter("# No frontmatter\n")).toBeUndefined();
    expect(parseSkillFrontmatter("---\nname: unterminated\n")).toBeUndefined();
  });

  test("strips frontmatter when the style body is reused as instructions", () => {
    expect(styleBody("---\nname: Unslop\n---\n\n# Unslop\n\nRules.\n")).toBe(
      "# Unslop\n\nRules.",
    );
  });
});

describe("SkillService", () => {
  test("installs the shipped skill globally and leaves unslop off", async () => {
    await withSkillHomes(async ({ context, home, claudeHome, agentsHome }) => {
      await context.skills.sync();
      expect(
        await readFile(
          join(claudeHome, "skills", "daedalus-control", "SKILL.md"),
          "utf8",
        ),
      ).toContain("name: daedalus-control");
      expect(
        await readlink(join(agentsHome, "skills", "daedalus-control")),
      ).toBe(join(home, "skills", "daedalus-control"));
      expect(await pathExists(join(claudeHome, "skills", "unslop"))).toBe(
        false,
      );
      const managed = await context.skills.managedStatus();
      expect(managed.find((one) => one.id === "unslop")?.enabled).toBe(false);
    });
  });

  test("on-demand installs the skill only; always adds the style and the block", async () => {
    await withSkillHomes(async ({ context, claudeHome, codexHome }) => {
      await context.skills.setEnabled("unslop", true, "on-demand");
      expect(await pathExists(join(claudeHome, "skills", "unslop"))).toBe(true);
      expect(
        await pathExists(join(claudeHome, "output-styles", "Unslop.md")),
      ).toBe(false);
      expect(await pathExists(join(codexHome, "AGENTS.md"))).toBe(false);
      // The style is what makes the rules apply to every response, so it is
      // the thing that separates the two states.
      expect(context.skills.claudeSkillSettings().outputStyle).toBeUndefined();

      await context.skills.setEnabled("unslop", true, "always");
      expect(
        await readFile(join(claudeHome, "output-styles", "Unslop.md"), "utf8"),
      ).toContain("keep-coding-instructions: true");
      expect(await readFile(join(codexHome, "AGENTS.md"), "utf8")).toContain(
        "Write without AI tells",
      );
      expect(context.skills.claudeSkillSettings().outputStyle).toBe("Unslop");
    });
  });

  test("turning it off takes back only what Daedalus wrote", async () => {
    await withSkillHomes(async ({ context, claudeHome, codexHome }) => {
      await mkdir(codexHome, { recursive: true });
      const mine = "# My own Codex instructions\n\nKeep these.\n";
      await writeFile(join(codexHome, "AGENTS.md"), mine, "utf8");

      await context.skills.setEnabled("unslop", true, "always");
      expect(await readFile(join(codexHome, "AGENTS.md"), "utf8")).toContain(
        "Keep these.",
      );

      await context.skills.setEnabled("unslop", false);
      expect(await pathExists(join(claudeHome, "skills", "unslop"))).toBe(
        false,
      );
      expect(
        await pathExists(join(claudeHome, "output-styles", "Unslop.md")),
      ).toBe(false);
      // Byte for byte, because a control plane that trims a user's file while
      // cleaning up its own block has eaten something it did not own.
      expect(await readFile(join(codexHome, "AGENTS.md"), "utf8")).toBe(mine);
    });
  });

  test("never replaces or removes something the user put at a discovery path", async () => {
    await withSkillHomes(async ({ context, claudeHome }) => {
      const mine = join(claudeHome, "skills", "unslop");
      await mkdir(mine, { recursive: true });
      await writeFile(join(mine, "SKILL.md"), "# Mine\n", "utf8");

      await context.skills.setEnabled("unslop", true, "on-demand");
      expect(await readFile(join(mine, "SKILL.md"), "utf8")).toBe("# Mine\n");
      const status = (await context.skills.managedStatus()).find(
        (one) => one.id === "unslop",
      );
      expect(
        status?.artifacts.some(
          (artifact) => artifact.path === mine && artifact.blocked,
        ),
      ).toBe(true);
      const findings = await context.skills.doctor();
      expect(findings.some((one) => one.message.includes("left alone"))).toBe(
        true,
      );

      await context.skills.setEnabled("unslop", false);
      expect(await readFile(join(mine, "SKILL.md"), "utf8")).toBe("# Mine\n");
    });
  });

  test("lists skills Daedalus does not own, and says why one is unreadable", async () => {
    await withSkillHomes(async ({ context, claudeHome, cursorHome }) => {
      const good = join(claudeHome, "skills", "handwritten");
      await mkdir(good, { recursive: true });
      await writeFile(
        join(good, "SKILL.md"),
        "---\nname: handwritten\ndescription: Mine\ndisable-model-invocation: true\n---\n",
        "utf8",
      );
      const bad = join(cursorHome, "skills", "broken");
      await mkdir(bad, { recursive: true });
      await writeFile(join(bad, "SKILL.md"), "no frontmatter here\n", "utf8");

      const { discovered } = await context.skills.list();
      const handwritten = discovered.find((one) => one.name === "handwritten");
      expect(handwritten?.origin).toBe("user");
      expect(handwritten?.providers).toEqual(["claude"]);
      expect(handwritten?.invocation).toBe("user-only");
      const broken = discovered.find((one) => one.name === "broken");
      expect(broken?.problem).toBe("unreadable-frontmatter");
      expect(broken?.providers).toEqual(["cursor"]);
    });
  });

  test("reports a name answered by two different skills, not one linked twice", async () => {
    await withSkillHomes(async ({ context, claudeHome, cursorHome }) => {
      await context.skills.sync();
      // daedalus-control is linked into two provider directories. That is one
      // skill, so it is not a collision.
      expect(
        (await context.skills.doctor()).some((one) =>
          one.message.includes("answer to this name"),
        ),
      ).toBe(false);

      for (const root of [claudeHome, cursorHome]) {
        const directory = join(root, "skills", "twins");
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, "SKILL.md"),
          `---\nname: twins\ndescription: From ${root}\n---\n`,
          "utf8",
        );
      }
      expect(
        (await context.skills.doctor()).some((one) =>
          one.message.includes("2 different skills answer to this name"),
        ),
      ).toBe(true);
    });
  });

  test("marks a link whose target has gone as broken rather than dropping it", async () => {
    await withSkillHomes(async ({ context, claudeHome, home }) => {
      await mkdir(join(claudeHome, "skills"), { recursive: true });
      await symlink(
        join(home, "skills", "never-installed"),
        join(claudeHome, "skills", "ghost"),
        "dir",
      );
      const { discovered } = await context.skills.list();
      const ghost = discovered.find((one) => one.name === "ghost");
      expect(ghost?.problem).toBe("broken-link");
      expect(ghost?.origin).toBe("daedalus");
    });
  });

  test("installs a skill from a directory, links it, and removes it again", async () => {
    await withSkillHomes(async ({ context, home, claudeHome, agentsHome }) => {
      const source = join(home, "source", "note-taker");
      await mkdir(join(source, "references"), { recursive: true });
      await writeFile(
        join(source, "SKILL.md"),
        "---\nname: note-taker\ndescription: Takes notes\n---\n",
        "utf8",
      );
      await writeFile(join(source, "references", "how.md"), "How\n", "utf8");

      const installed = await context.skills.installFromPath(source);
      expect(installed.id).toBe("note-taker");
      expect(installed.source).toEqual({ kind: "path", ref: source });
      expect(
        await readFile(
          join(home, "skills", "note-taker", "references", "how.md"),
          "utf8",
        ),
      ).toBe("How\n");
      expect(await pathExists(join(agentsHome, "skills", "note-taker"))).toBe(
        true,
      );

      await context.skills.removeInstalled("note-taker");
      expect(await pathExists(join(claudeHome, "skills", "note-taker"))).toBe(
        false,
      );
      expect(await pathExists(join(home, "skills", "note-taker"))).toBe(false);
      expect(
        (await context.skills.managedStatus()).some(
          (one) => one.id === "note-taker",
        ),
      ).toBe(false);
    });
  });

  test("refuses to install over a shipped skill or to remove one", async () => {
    await withSkillHomes(async ({ context, home }) => {
      const source = join(home, "source", "unslop");
      await mkdir(source, { recursive: true });
      await writeFile(
        join(source, "SKILL.md"),
        "---\nname: unslop\ndescription: Mine\n---\n",
        "utf8",
      );
      await expect(context.skills.installFromPath(source)).rejects.toThrow(
        /Daedalus ships/,
      );
      await expect(context.skills.removeInstalled("unslop")).rejects.toThrow(
        /disable it instead/,
      );
    });
  });

  test("hands Codex an entry only for a skill the user switched off", async () => {
    await withSkillHomes(async ({ context, agentsHome }) => {
      const directory = join(agentsHome, "skills", "loud");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "SKILL.md"),
        "---\nname: loud\ndescription: Loud\n---\n",
        "utf8",
      );
      expect(await context.skills.codexSkillEntries()).toEqual([]);

      await context.skills.setVisibility("loud", "off");
      expect(await context.skills.codexSkillEntries()).toEqual([
        { path: join(directory, "SKILL.md"), enabled: false },
      ]);
      expect(context.skills.claudeSkillSettings().skillOverrides).toEqual({
        loud: "off",
      });
    });
  });

  test("rejects a mode a capability does not have, and an unknown skill", async () => {
    await withSkillHomes(async ({ context }) => {
      await expect(
        context.skills.setEnabled("daedalus-control", true, "always"),
      ).rejects.toThrow(/no 'always' mode/);
      await expect(context.skills.setEnabled("nope", true)).rejects.toThrow(
        /No Daedalus-managed skill/,
      );
      await expect(context.skills.setVisibility("nope", "off")).rejects.toThrow(
        /No skill named/,
      );
    });
  });
});

describe("marked blocks", () => {
  test("cutting a block leaves a file that never had one untouched", () => {
    const markers = { begin: "<!-- a -->", end: "<!-- b -->" };
    expect(removeMarkedBlock("# Mine\n", markers)).toBe("# Mine\n");
  });
});

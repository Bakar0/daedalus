import { join } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  deleteInstructionFile,
  readInstructionFiles,
  saveInstructionFile,
  topicName,
} from "./instruction-files";

const INDEX = `# Custom instructions

## Always

- Run every request in a workflow.

## Topics

- [git.md](git.md): branch names, commit messages
`;

describe("custom instruction files", () => {
  test("a topic is named after its heading", () => {
    expect(topicName("# Code review\n\n- Ask for one.\n")).toBe("code-review");
    expect(() => topicName("- No heading\n")).toThrow("'# Heading'");
    expect(() => topicName("# Index\n")).toThrow("does not make a file name");
  });

  test("the index lists topics as they are added, renamed and deleted", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const root = join(home, "instructions");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "INDEX.md"), INDEX);
      await writeFile(join(root, "git.md"), "# Git\n\n- Short branches.\n");
      const index = () => readFile(join(root, "INDEX.md"), "utf8");

      await saveInstructionFile(root, {
        kind: "topic",
        text: "# Code review\n\n- Ask for one.\n",
      });
      expect(await index()).toContain(
        "- [code-review.md](code-review.md): Code review",
      );
      await expect(
        saveInstructionFile(root, { kind: "topic", text: "# Git\n" }),
      ).rejects.toThrow("'git' exists");

      await saveInstructionFile(root, {
        kind: "topic",
        previousName: "git",
        text: "# Git and GitHub\n\n- Short branches.\n",
      });
      expect(await index()).toContain(
        "[git-and-github.md](git-and-github.md): branch names",
      );
      expect((await readdir(root)).sort()).toEqual([
        "INDEX.md",
        "code-review.md",
        "git-and-github.md",
      ]);

      await deleteInstructionFile(root, "code-review");
      expect(await index()).not.toContain("code-review");
      // The Always rules are left as written.
      expect(await index()).toContain("- Run every request in a workflow.");

      const files = await readInstructionFiles(root);
      expect(files.topics.map((topic) => topic.name)).toEqual([
        "git-and-github",
      ]);
      await expect(deleteInstructionFile(root, "../x")).rejects.toThrow(
        "not a topic",
      );
    });
  });

  test("a topic's line sits in its section, follows a rename, and appears for a topic an agent left unlisted", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const root = join(home, "instructions");
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, "INDEX.md"),
        `${INDEX}\n## Notes\n\nKept as written.\n`,
      );
      const index = () => readFile(join(root, "INDEX.md"), "utf8");

      // A new line goes under Topics, not after the section that follows.
      await saveInstructionFile(root, {
        kind: "topic",
        text: "# Code review\n\n- Ask for one.\n",
      });
      expect(await index()).toContain(
        "- [git.md](git.md): branch names, commit messages\n- [code-review.md](code-review.md): Code review\n\n## Notes",
      );

      // A rename takes the new heading where the line showed the old one.
      await saveInstructionFile(root, {
        kind: "topic",
        previousName: "code-review",
        text: "# Reviews\n\n- Ask for one.\n",
      });
      expect(await index()).toContain("- [reviews.md](reviews.md): Reviews\n");

      // A description someone wrote stays through a rename.
      await writeFile(join(root, "git.md"), "# Git\n\n- Branch first.\n");
      await saveInstructionFile(root, {
        kind: "topic",
        previousName: "git",
        text: "# Version control\n\n- Branch first.\n",
      });
      expect(await index()).toContain(
        "- [version-control.md](version-control.md): branch names, commit messages",
      );

      // A topic file with no line gets one when it is next saved.
      await writeFile(join(root, "style.md"), "# Style\n\n- Short.\n");
      await saveInstructionFile(root, {
        kind: "topic",
        previousName: "style",
        text: "# Style\n\n- Short sentences.\n",
      });
      expect(await index()).toContain("- [style.md](style.md): Style\n");
      expect(await index()).toContain("## Notes\n\nKept as written.");
    });
  });
});

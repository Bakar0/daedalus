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
});

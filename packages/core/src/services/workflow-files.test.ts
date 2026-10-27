import { join } from "node:path";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  deleteWorkflowFile,
  ensureWorkflowsFolder,
  parseStepFile,
  parseWorkflowFile,
  readWorkflowCatalog,
  readWorkflowFiles,
  renderStepFile,
  renderWorkflowFile,
  saveWorkflowFile,
} from "./workflow-files";

/** The example files in docs/workflows.md, each a path line and a fence. */
async function docExamples(): Promise<[string, string][]> {
  const doc = await readFile(
    new URL("../../../../docs/workflows.md", import.meta.url),
    "utf8",
  );
  return [
    ...doc.matchAll(
      /^`((?:flows|steps)\/[a-z-]+\.md)`\n\n```markdown\n([\s\S]*?)```$/gm,
    ),
  ].map((match) => [match[1]!, match[2]!]);
}

/** A folder holding the docs' examples, as a user who copied them has. */
async function copyDocExamples(folder: string, only?: string[]) {
  await ensureWorkflowsFolder(folder);
  for (const [path, text] of await docExamples()) {
    const name = path.slice(path.indexOf("/") + 1, -3);
    if (only && path.startsWith("flows/") && !only.includes(name)) continue;
    await writeFile(join(folder, path), text);
  }
}

describe("step and workflow files", () => {
  test("a step reads its fields and body; a gate is 'start', 'result' or nothing", () => {
    expect(
      parseStepFile(
        "---\ndescription: Ship it.\ngate: user\n---\n\nRun the release script.\n",
        "deploy",
      ),
    ).toEqual({
      name: "deploy",
      description: "Ship it.",
      gate: "result",
      body: "Run the release script.",
    });
    expect(() =>
      parseStepFile("---\nname: x\ngate: lead\n---\nDo it.\n"),
    ).toThrow("'gate' must be 'start'");
    // The first names, `before` and `user`, still read as the new ones.
    for (const [written, read] of [
      ["start", "start"],
      ["result", "result"],
      ["before", "start"],
      ["user", "result"],
    ])
      expect(
        parseStepFile(`---\nname: x\ngate: ${written}\n---\nDo it.\n`).gate,
      ).toBe(read);
    expect(() => parseStepFile("---\nname: x\n---\n")).toThrow(
      "no instructions",
    );
  });

  test("a workflow lists its steps once each, by valid names", () => {
    expect(
      parseWorkflowFile(
        "---\nname: tiny\nwhen: A typo.\nsteps: [do, check]\n---\n",
      ),
    ).toEqual({
      name: "tiny",
      description: "",
      when: "A typo.",
      steps: ["do", "check"],
      dynamic: false,
      loop: null,
      until: "",
      body: "",
    });
    expect(() => parseWorkflowFile("---\nname: a\nsteps: []\n---\n")).toThrow(
      "'steps' must be a list",
    );
    expect(() =>
      parseWorkflowFile("---\nname: a\nsteps: [do, do]\n---\n"),
    ).toThrow("listed twice");
    expect(() =>
      parseWorkflowFile("---\nname: a\nsteps: [Do It]\n---\n"),
    ).toThrow("lowercase");
  });

  test("a new folder holds only the choosing rules", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const folder = join(home, "workflows");
      await ensureWorkflowsFolder(folder);
      const catalog = await readWorkflowCatalog(folder);
      expect(catalog.workflows).toEqual([]);
      expect(catalog.steps).toEqual([]);
      expect(catalog.choosing).toContain("dynamic workflow");

      // The user deletes the rules; a later sync leaves them deleted.
      await rm(join(folder, "CHOOSING.md"));
      await ensureWorkflowsFolder(folder);
      expect(await readdir(folder)).not.toContain("CHOOSING.md");
    });
  });

  test("the examples in docs/workflows.md load with no problems", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const folder = join(home, "workflows");
      await copyDocExamples(folder);
      const catalog = await readWorkflowCatalog(folder);
      expect(catalog.problems).toEqual([]);
      expect(catalog.workflows.map((item) => item.name).sort()).toEqual([
        "bug",
        "change",
        "do",
        "feature",
        "research",
      ]);
      expect(
        catalog.steps
          .filter((item) => item.gate)
          .map((item) => item.name)
          .sort(),
      ).toEqual(["decide", "proof", "prototype"]);
    });
  });

  test("a broken file or a missing step is a problem; the rest still loads", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const folder = join(home, "workflows");
      await mkdir(join(folder, "steps"), { recursive: true });
      await mkdir(join(folder, "flows"), { recursive: true });
      await writeFile(
        join(folder, "steps", "do.md"),
        "---\nname: do\n---\nDo it.\n",
      );
      await writeFile(join(folder, "steps", "bad.md"), "no frontmatter");
      await writeFile(
        join(folder, "flows", "w.md"),
        "---\nname: w\nsteps: [do, review]\n---\n",
      );
      const catalog = await readWorkflowCatalog(folder);
      expect(catalog.steps.map((item) => item.name)).toEqual(["do"]);
      expect(catalog.workflows.map((item) => item.name)).toEqual(["w"]);
      expect(catalog.problems.map((item) => item.message)).toEqual([
        "A step file starts with frontmatter between two '---' lines",
        expect.stringContaining("No step file for 'review'"),
      ]);
    });
  });

  test("a loop names one of the steps, or true for the first; files render back as they parse", () => {
    expect(
      parseWorkflowFile(
        '---\nname: l\nsteps: [a, b]\nloop: true\nuntil: "Done: really"\n---\n',
      ),
    ).toMatchObject({ loop: "a", until: "Done: really" });
    expect(() =>
      parseWorkflowFile("---\nname: l\nsteps: [a, b]\nloop: c\n---\n"),
    ).toThrow("'loop' must be true or one of");
    const workflow = {
      name: "spike",
      description: "Try: then decide",
      when: "One idea, quickly",
      steps: ["try", "decide"],
      dynamic: false,
      loop: "try",
      until: "It works",
      body: "",
    };
    expect(parseWorkflowFile(renderWorkflowFile(workflow))).toEqual(workflow);
    const step = {
      name: "try",
      description: "Try it: once",
      gate: "result" as const,
      body: "Try it: once",
    };
    expect(parseStepFile(renderStepFile(step))).toEqual(step);
  });

  test("a dynamic workflow has no fixed steps and no loop, and renders back as it parses", () => {
    const dynamic = parseWorkflowFile(
      "---\nname: do\nsteps: dynamic\n---\nName your steps.\n",
    );
    expect(dynamic).toMatchObject({ steps: [], dynamic: true, loop: null });
    expect(parseWorkflowFile(renderWorkflowFile(dynamic))).toEqual(dynamic);
    expect(() =>
      parseWorkflowFile("---\nname: do\nsteps: dynamic\nloop: true\n---\n"),
    ).toThrow("no 'loop'");
    expect(() =>
      parseWorkflowFile("---\nname: do\nsteps: some\n---\n"),
    ).toThrow("or dynamic");
  });

  test("the editor saves under the frontmatter name, renames, and refuses a taken name or unreadable text", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const folder = join(home, "workflows");
      await copyDocExamples(folder, ["do", "feature"]);
      const before = await readWorkflowFiles(folder);
      expect(before.choosing.text).toContain("dynamic workflow");
      expect(before.flows.map((flow) => flow.name)).toEqual(["do", "feature"]);
      expect(before.flows.find((flow) => flow.name === "do")).toMatchObject({
        dynamic: true,
      });

      await saveWorkflowFile(folder, {
        kind: "step",
        text: "---\nname: lint\ndescription: Run the linter\n---\nRun it.\n",
      });
      await saveWorkflowFile(folder, {
        kind: "step",
        previousName: "lint",
        text: "---\nname: tidy\ndescription: Run the linter\n---\nRun it.\n",
      });
      const steps = (await readdir(join(folder, "steps"))).sort();
      expect(steps).toContain("tidy.md");
      expect(steps).not.toContain("lint.md");

      await expect(
        saveWorkflowFile(folder, {
          kind: "step",
          text: "---\nname: tidy\ndescription: Again\n---\nBody.\n",
        }),
      ).rejects.toThrow("named 'tidy' exists");
      await expect(
        saveWorkflowFile(folder, {
          kind: "flow",
          text: "---\nname: Bad Name\nsteps: [tidy]\n---\n",
        }),
      ).rejects.toThrow();
      expect(await readdir(join(folder, "flows"))).toHaveLength(2);
      // A previous name that is not a name is refused before any write.
      await expect(
        saveWorkflowFile(folder, {
          kind: "step",
          previousName: "Not A Name",
          text: "---\nname: fresh\ndescription: New\n---\nBody.\n",
        }),
      ).rejects.toThrow("lowercase");
      expect(await readdir(join(folder, "steps"))).not.toContain("fresh.md");

      await saveWorkflowFile(folder, { kind: "choosing", text: "Mine.\n" });
      expect((await readWorkflowFiles(folder)).choosing.text).toBe("Mine.\n");
    });
  });

  test("a step a workflow uses cannot be deleted; a workflow and an unused step can", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const folder = join(home, "workflows");
      await copyDocExamples(folder, ["do", "feature"]);
      const feature = (await readWorkflowFiles(folder)).flows.find(
        (flow) => flow.name === "feature",
      );
      const used = feature?.steps?.[0] ?? "";
      await expect(
        deleteWorkflowFile(folder, { kind: "step", name: used }),
      ).rejects.toThrow("take it out of them first");

      await saveWorkflowFile(folder, {
        kind: "step",
        text: "---\nname: spare\ndescription: Unused\n---\nBody.\n",
      });
      await deleteWorkflowFile(folder, { kind: "step", name: "spare" });
      await deleteWorkflowFile(folder, { kind: "flow", name: "do" });
      const files = await readWorkflowFiles(folder);
      expect(files.steps.map((item) => item.name)).not.toContain("spare");
      expect(files.flows.map((item) => item.name)).not.toContain("do");
    });
  });
});

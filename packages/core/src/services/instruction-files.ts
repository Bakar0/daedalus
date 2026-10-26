import { readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ensureDirectory,
  pathExists,
  readTextFile,
  writeFileAtomic,
} from "@daedalus/platform";
import { DaedalusError } from "../errors";

/**
 * The user's custom instructions as files, for the Workflows tab: `INDEX.md`
 * and one markdown file per topic. Agents keep them with the
 * daedalus-instructions skill; the tab lets the user read and edit them.
 */

export interface InstructionFile {
  name: string;
  path: string;
  text: string;
}

export interface InstructionFiles {
  root: string;
  index: { path: string; text: string };
  topics: InstructionFile[];
}

const INDEX = "INDEX.md";

/** A topic file is named after its heading: `# Code review` → `code-review`. */
export function topicName(text: string): string {
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  if (!heading)
    throw new DaedalusError(
      "VALIDATION",
      "A topic starts with a '# Heading' naming it, such as '# Code review'",
    );
  const name = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!name || name === "index")
    throw new DaedalusError(
      "VALIDATION",
      `The heading '${heading}' does not make a file name; use letters or digits`,
    );
  return name;
}

const linkTo = (name: string) => `](${name}.md)`;

/**
 * Keeps `INDEX.md` listing the topic files: a new topic gets a line under
 * "## Topics" (the end of the index) naming its heading, a renamed one has its link follow, and a
 * deleted one loses its line. The rest of the index is left as written.
 */
async function updateIndex(
  root: string,
  change:
    | { add: string; heading: string }
    | { rename: string; to: string }
    | { remove: string },
): Promise<void> {
  const path = join(root, INDEX);
  if (!(await pathExists(path))) return;
  const text = await readTextFile(path);
  let next = text;
  if ("remove" in change)
    next = text
      .split("\n")
      .filter((line) => !line.includes(linkTo(change.remove)))
      .join("\n");
  else if ("rename" in change)
    next = text
      .replaceAll(`[${change.rename}.md]`, `[${change.to}.md]`)
      .replaceAll(linkTo(change.rename), linkTo(change.to));
  else if (!text.includes(linkTo(change.add)))
    next = `${text.trimEnd()}\n- [${change.add}.md](${change.add}.md): ${change.heading}\n`;
  if (next !== text) await writeFileAtomic(path, next);
}

export async function readInstructionFiles(
  root: string,
): Promise<InstructionFiles> {
  const indexPath = join(root, INDEX);
  const topics: InstructionFile[] = [];
  if (await pathExists(root))
    for (const file of (await readdir(root)).sort()) {
      if (!file.endsWith(".md") || file === INDEX) continue;
      const path = join(root, file);
      topics.push({
        name: basename(file, ".md"),
        path,
        text: await readTextFile(path),
      });
    }
  return {
    root,
    index: {
      path: indexPath,
      text: (await pathExists(indexPath)) ? await readTextFile(indexPath) : "",
    },
    topics,
  };
}

/**
 * Saves the index, or a topic under the name its heading gives. A changed
 * heading renames the file; a new topic may not take a name already used.
 */
export async function saveInstructionFile(
  root: string,
  input: { kind: "index" | "topic"; text: string; previousName?: string },
): Promise<void> {
  await ensureDirectory(root);
  if (input.kind === "index") {
    await writeFileAtomic(join(root, INDEX), input.text);
    return;
  }
  const name = topicName(input.text);
  const path = join(root, `${name}.md`);
  if (input.previousName !== name && (await pathExists(path)))
    throw new DaedalusError("CONFLICT", `A topic named '${name}' exists`);
  await writeFileAtomic(path, input.text);
  if (input.previousName && input.previousName !== name) {
    await unlink(join(root, `${basename(input.previousName)}.md`)).catch(
      () => undefined,
    );
    await updateIndex(root, { rename: input.previousName, to: name });
  } else if (!input.previousName)
    await updateIndex(root, {
      add: name,
      heading: /^#\s+(.+)$/m.exec(input.text)![1]!.trim(),
    });
}

/** Deletes a topic file and its line in `INDEX.md`. */
export async function deleteInstructionFile(
  root: string,
  name: string,
): Promise<void> {
  if (basename(name) !== name || name === "INDEX")
    throw new DaedalusError("VALIDATION", `'${name}' is not a topic`);
  await unlink(join(root, `${name}.md`)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  await updateIndex(root, { remove: name });
}

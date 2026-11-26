import { readdir, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ensureDirectory,
  pathExists,
  readTextFile,
  writeFileAtomic,
} from "@daedalus/platform";
import { DaedalusError } from "../errors";
import {
  parseToolFile,
  renderToolFile,
  workflowToolsPath,
} from "./workflow-files";

/**
 * The user's custom instructions as files, for the Custom instructions tab:
 * `INDEX.md` and one markdown file per topic. Agents keep them with the
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

/** A topic's `# Heading`, or undefined when it has none. */
const topicHeading = (text: string): string | undefined =>
  /^#\s+(.+)$/m.exec(text)?.[1]?.trim();

/** A topic file is named after its heading: `# Code review` → `code-review`. */
export function topicName(text: string): string {
  const heading = topicHeading(text);
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
const topicLine = (name: string, heading: string) =>
  `- [${name}.md](${name}.md): ${heading}`;

/**
 * Keeps `INDEX.md` listing the topic files. A topic gets a line under
 * "## Topics" naming its heading when it has none, wherever the section ends.
 * A renamed topic's line follows it, and takes the new heading when it still
 * showed the old one; a description someone wrote stays. A deleted topic
 * loses its line. The rest of the index is left as written.
 */
async function updateIndex(
  root: string,
  change:
    | {
        name: string;
        heading: string;
        previous?: { name: string; heading?: string };
      }
    | { remove: string },
): Promise<void> {
  const path = join(root, INDEX);
  if (!(await pathExists(path))) return;
  const text = await readTextFile(path);
  let lines = text.split("\n");
  if ("remove" in change)
    lines = lines.filter((line) => !line.includes(linkTo(change.remove)));
  else {
    const { name, heading, previous } = change;
    if (previous && previous.name !== name)
      lines = lines.map((line) => {
        if (!line.includes(linkTo(previous.name))) return line;
        const renamed = line
          .replaceAll(`[${previous.name}.md]`, `[${name}.md]`)
          .replaceAll(linkTo(previous.name), linkTo(name));
        return previous.heading && renamed.endsWith(`: ${previous.heading}`)
          ? `${renamed.slice(0, -previous.heading.length)}${heading}`
          : renamed;
      });
    if (!lines.some((line) => line.includes(linkTo(name)))) {
      const topics = lines.findIndex((line) => /^##\s+Topics\s*$/i.test(line));
      if (topics === -1)
        lines.push("", "## Topics", "", topicLine(name, heading));
      else {
        // After the section's last non-blank line, before the next heading.
        const next = lines.findIndex(
          (line, index) => index > topics && /^#{1,2}\s/.test(line),
        );
        let at = (next === -1 ? lines.length : next) - 1;
        while (at > topics && !lines[at]!.trim()) at -= 1;
        lines.splice(at + 1, 0, topicLine(name, heading));
      }
    }
  }
  const next = lines.join("\n");
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
  const heading = topicHeading(input.text)!;
  const path = join(root, `${name}.md`);
  const previousName = input.previousName && basename(input.previousName);
  if (previousName !== name && (await pathExists(path)))
    throw new DaedalusError("CONFLICT", `A topic named '${name}' exists`);
  const previousPath = previousName && join(root, `${previousName}.md`);
  const previous = previousName
    ? {
        name: previousName,
        heading:
          previousPath && (await pathExists(previousPath))
            ? topicHeading(await readTextFile(previousPath))
            : undefined,
      }
    : undefined;
  await writeFileAtomic(path, input.text);
  if (previousPath && previousName !== name)
    await unlink(previousPath).catch(() => undefined);
  await updateIndex(root, { name, heading, ...(previous ? { previous } : {}) });
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

/** Where a topic file goes once it became a tool, so nothing is lost. */
export const MOVED_TOPICS_FOLDER = "moved-to-tools";

/**
 * Topic files became tools: each `<topic>.md` here is written as
 * `tools/<topic>.md` in the workflows folder, with what the index said it
 * covers as its description, and the topic file moves into
 * {@link MOVED_TOPICS_FOLDER}. The index loses the topic's line and names the
 * tool wherever a rule named the file. A topic whose name a tool already has,
 * or that makes no tool, stays where it is. Returns the names moved.
 */
export async function moveTopicsToTools(
  root: string,
  workflowsRoot: string,
): Promise<string[]> {
  const { index, topics } = await readInstructionFiles(root);
  const tools = workflowToolsPath(workflowsRoot);
  const movedFolder = join(root, MOVED_TOPICS_FOLDER);
  /** The index without the topic's line, naming the tool where it named the file. */
  const unlist = (text: string, name: string): string => {
    const tool = `the \`${name}\` tool (\`daedal tool show ${name}\`)`;
    return text
      .split("\n")
      .filter((item) => !item.includes(linkTo(name)))
      .join("\n")
      .replaceAll(`\`${name}.md\` in this folder`, tool)
      .replaceAll(`\`${name}.md\``, tool);
  };
  let text = index.text;
  // A move that stopped before the index was written left lines for topics
  // that are tools already. They go first, so the index never names a file
  // that is not there.
  const finished = (await pathExists(movedFolder))
    ? (await readdir(movedFolder))
        .filter((file) => file.endsWith(".md"))
        .map((file) => file.slice(0, -3))
        .filter((name) => !topics.some((topic) => topic.name === name))
    : [];
  for (const name of finished)
    if (await pathExists(join(tools, `${name}.md`))) text = unlist(text, name);
  const moved: string[] = [];
  for (const topic of topics) {
    const target = join(tools, `${topic.name}.md`);
    if (await pathExists(target)) continue;
    const line = text
      .split("\n")
      .find((item) => item.includes(linkTo(topic.name)));
    const covers = line && /\]\([^)]+\):\s*(.+)$/.exec(line)?.[1]?.trim();
    // Only a heading that opens the file is its title. A later line that
    // starts with `#` is part of the rules.
    const body = topic.text.replace(/^\s*#\s+.+\n?/, "").trim();
    let file: string;
    try {
      file = renderToolFile({
        name: topic.name,
        description: covers || topicHeading(topic.text) || topic.name,
        body,
      });
      // Read it back the way a run does: a name or body no tool can have
      // leaves the topic where it is.
      parseToolFile(file, topic.name);
    } catch {
      continue;
    }
    await ensureDirectory(tools);
    await writeFileAtomic(target, file);
    await ensureDirectory(movedFolder);
    // Another process doing the same move may have taken the file already.
    await rename(topic.path, join(movedFolder, `${topic.name}.md`)).catch(
      (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      },
    );
    moved.push(topic.name);
    text = unlist(text, topic.name);
  }
  // With every topic gone, the section that listed them says where they went.
  if (moved.length === topics.length && (moved.length || finished.length))
    text = text.replace(
      /^##\s+Topics\s*\n[\s\S]*?(?=^#{1,2}\s|(?![\s\S]))/m,
      TOOLS_SECTION,
    );
  if (text !== index.text && (await pathExists(index.path)))
    await writeFileAtomic(index.path, text);
  return moved;
}

/** What the index says in place of its topics. */
export const TOOLS_SECTION = `## Tools

Rules about one subject, such as getting access or reading logs, are tools.
\`daedal tool list\` names each with what it covers; open the ones that apply
to the task with \`daedal tool show <name>\`.
`;

/**
 * The custom instructions tab's view of the folder: read everything, save or
 * delete one file, and get everything back.
 */
export class InstructionService {
  constructor(private readonly root: string) {}

  files(): Promise<InstructionFiles> {
    return readInstructionFiles(this.root);
  }

  async save(input: {
    kind: "index" | "topic";
    text: string;
    previousName?: string;
  }): Promise<InstructionFiles> {
    await saveInstructionFile(this.root, input);
    return this.files();
  }

  async delete(name: string): Promise<InstructionFiles> {
    await deleteInstructionFile(this.root, name);
    return this.files();
  }
}

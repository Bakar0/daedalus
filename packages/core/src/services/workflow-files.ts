import { readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ensureDirectory,
  pathExists,
  readTextFile,
  writeFileAtomic,
  writeTextFile,
} from "@daedalus/platform";
import type { WorkflowDefinition, WorkflowStepDefinition } from "../domain";
import { DaedalusError } from "../errors";
import { FRONTMATTER, stringValue } from "./routine-files";

/**
 * Steps and workflows, a Daedalus capability kept apart from the user's
 * custom instructions: markdown files with YAML frontmatter in their own
 * folder. Agents and the user edit them directly; Daedalus reads them when a
 * run starts and keeps nothing of them but the copy each run takes.
 *
 *     workflows/steps/<name>.md   name, description, gate; body
 *     workflows/flows/<name>.md   name, description, when, steps, loop,
 *                                 until; body
 *     workflows/CHOOSING.md       the user's rules for picking a workflow
 *
 * `loop` makes a workflow circular: the step its run goes back to after the
 * last one (`true` for the first step), with `until` saying when to stop.
 */

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The workflows folder in a Daedalus home. */
export const workflowsHomePath = (daedalusHome: string): string =>
  join(daedalusHome, "workflows");
export const workflowStepsPath = (root: string): string => join(root, "steps");
export const workflowsPath = (root: string): string => join(root, "flows");
export const workflowChoosingPath = (root: string): string =>
  join(root, "CHOOSING.md");

export function workflowName(value: string, what = "workflow"): string {
  const name = value.trim();
  if (!NAME.test(name))
    throw new DaedalusError(
      "VALIDATION",
      `A ${what} name uses lowercase letters, digits and dashes, and starts with a letter or digit`,
    );
  return name;
}

function frontmatter(
  text: string,
  what: string,
): { fields: Record<string, unknown>; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match)
    throw new DaedalusError(
      "VALIDATION",
      `A ${what} file starts with frontmatter between two '---' lines`,
    );
  let data: unknown;
  try {
    data = Bun.YAML.parse(match[1]!);
  } catch (error) {
    throw new DaedalusError(
      "VALIDATION",
      `Frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new DaedalusError(
      "VALIDATION",
      "Frontmatter must be a set of fields",
    );
  return { fields: data as Record<string, unknown>, body: match[2]!.trim() };
}

/** `fallbackName` is the file's name, used when the frontmatter has none. */
export function parseStepFile(
  text: string,
  fallbackName?: string,
): WorkflowStepDefinition {
  const { fields, body } = frontmatter(text, "step");
  const nameText = stringValue(fields.name) ?? fallbackName;
  if (!nameText)
    throw new DaedalusError("VALIDATION", "The 'name' field is required");
  const gate = stringValue(fields.gate) ?? null;
  if (gate !== null && gate !== "user" && gate !== "before")
    throw new DaedalusError(
      "VALIDATION",
      "'gate' must be 'user' (the user approves what the step produced) or 'before' (the user approves starting it), or left out",
    );
  if (!body)
    throw new DaedalusError(
      "VALIDATION",
      "The step has no instructions below its frontmatter",
    );
  return {
    name: workflowName(nameText, "step"),
    description: stringValue(fields.description) ?? "",
    gate,
    body,
  };
}

export function parseWorkflowFile(
  text: string,
  fallbackName?: string,
): WorkflowDefinition {
  const { fields, body } = frontmatter(text, "workflow");
  const nameText = stringValue(fields.name) ?? fallbackName;
  if (!nameText)
    throw new DaedalusError("VALIDATION", "The 'name' field is required");
  const dynamic = fields.steps === "dynamic";
  if (
    !dynamic &&
    (!Array.isArray(fields.steps) ||
      fields.steps.length === 0 ||
      fields.steps.some((step) => typeof step !== "string"))
  )
    throw new DaedalusError(
      "VALIDATION",
      "'steps' must be a list of step names, such as [research, review], or dynamic",
    );
  if (dynamic && (fields.loop !== undefined || fields.until !== undefined))
    throw new DaedalusError(
      "VALIDATION",
      "A dynamic workflow has no 'loop' or 'until'; a run that needs one starts with --loop and --until",
    );
  const steps = dynamic
    ? []
    : (fields.steps as string[]).map((step) => workflowName(step, "step"));
  const repeated = steps.find((step, index) => steps.indexOf(step) !== index);
  if (repeated)
    throw new DaedalusError(
      "VALIDATION",
      `Step '${repeated}' is listed twice; a run goes back to a step by starting it again`,
    );
  let loop: string | null = null;
  if (fields.loop === true) loop = steps[0]!;
  else if (fields.loop !== undefined && fields.loop !== false) {
    const target = stringValue(fields.loop);
    if (!target || !steps.includes(target))
      throw new DaedalusError(
        "VALIDATION",
        `'loop' must be true or one of the workflow's steps: ${steps.join(", ")}`,
      );
    loop = target;
  }
  return {
    name: workflowName(nameText),
    description: stringValue(fields.description) ?? "",
    when: stringValue(fields.when) ?? "",
    steps,
    dynamic,
    loop,
    until: stringValue(fields.until) ?? "",
    body,
  };
}

/** A scalar as YAML reads it back: JSON's string syntax is valid YAML. */
const scalar = (value: string): string => JSON.stringify(value);

export function renderStepFile(step: WorkflowStepDefinition): string {
  return [
    "---",
    `name: ${step.name}`,
    `description: ${scalar(step.description)}`,
    ...(step.gate ? [`gate: ${step.gate}`] : []),
    "---",
    "",
    step.body.trim(),
    "",
  ].join("\n");
}

export function renderWorkflowFile(workflow: WorkflowDefinition): string {
  return [
    "---",
    `name: ${workflow.name}`,
    `description: ${scalar(workflow.description)}`,
    `when: ${scalar(workflow.when)}`,
    workflow.dynamic
      ? "steps: dynamic"
      : `steps: [${workflow.steps.join(", ")}]`,
    ...(workflow.loop ? [`loop: ${workflow.loop}`] : []),
    ...(workflow.until ? [`until: ${scalar(workflow.until)}`] : []),
    "---",
    ...(workflow.body.trim() ? ["", workflow.body.trim()] : []),
    "",
  ].join("\n");
}

/** A file that did not parse, and why. The rest of the catalog still loads. */
export interface WorkflowFileProblem {
  path: string;
  message: string;
}

export interface WorkflowCatalog {
  workflows: WorkflowDefinition[];
  steps: WorkflowStepDefinition[];
  problems: WorkflowFileProblem[];
  /** `CHOOSING.md` as written, or empty when there is none. */
  choosing: string;
}

/** The markdown files in a folder, in name order, each named after its file. */
async function markdownFiles(
  folder: string,
): Promise<{ name: string; path: string; text: string }[]> {
  if (!(await pathExists(folder))) return [];
  const files = (await readdir(folder))
    .filter((file) => file.endsWith(".md"))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const path = join(folder, file);
      return {
        name: basename(file, ".md"),
        path,
        text: await readTextFile(path),
      };
    }),
  );
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** What each file in a folder parses to; one that does not is a problem. */
async function readFolder<T>(
  folder: string,
  parse: (text: string, fallbackName: string) => T,
  problems: WorkflowFileProblem[],
): Promise<T[]> {
  const found: T[] = [];
  for (const { name, path, text } of await markdownFiles(folder)) {
    try {
      found.push(parse(text, name));
    } catch (error) {
      problems.push({ path, message: message(error) });
    }
  }
  return found;
}

/**
 * Every step and workflow in the folder. A workflow naming a step that has
 * no file is reported as a problem, since starting it would fail.
 */
export async function readWorkflowCatalog(
  root: string,
): Promise<WorkflowCatalog> {
  const problems: WorkflowFileProblem[] = [];
  const steps = await readFolder(
    workflowStepsPath(root),
    parseStepFile,
    problems,
  );
  const workflows = await readFolder(
    workflowsPath(root),
    parseWorkflowFile,
    problems,
  );
  const known = new Set(steps.map((step) => step.name));
  for (const workflow of workflows) {
    const missing = workflow.steps.filter((step) => !known.has(step));
    if (missing.length)
      problems.push({
        path: join(workflowsPath(root), `${workflow.name}.md`),
        message: `No step file for ${missing.map((step) => `'${step}'`).join(", ")} in ${workflowStepsPath(root)}`,
      });
  }
  const choosingPath = workflowChoosingPath(root);
  const choosing = (await pathExists(choosingPath))
    ? await readTextFile(choosingPath)
    : "";
  return { workflows, steps, problems, choosing };
}

/* -------------------------------------------------------------------------- */
/* Editing the files                                                          */
/* -------------------------------------------------------------------------- */

export type WorkflowFileKind = "flow" | "step" | "choosing";

/** One file as written, with what Daedalus reads from it or why it cannot. */
export interface WorkflowFile {
  name: string;
  path: string;
  text: string;
  description: string;
  /** For a workflow: the work it fits. */
  when?: string;
  until?: string;
  /** What follows the frontmatter: a step's instructions, a workflow's notes. */
  body?: string;
  steps?: string[];
  dynamic?: boolean;
  loop?: string | null;
  gate?: "user" | "before" | null;
  problem: string | null;
}

export interface WorkflowFiles {
  root: string;
  flows: WorkflowFile[];
  steps: WorkflowFile[];
  choosing: { path: string; text: string };
}

async function readFiles(
  folder: string,
  read: (
    text: string,
    name: string,
  ) => Omit<WorkflowFile, "path" | "text" | "problem">,
): Promise<WorkflowFile[]> {
  return (await markdownFiles(folder)).map(({ name, path, text }) => {
    try {
      return { ...read(text, name), path, text, problem: null };
    } catch (error) {
      return { name, path, text, description: "", problem: message(error) };
    }
  });
}

/** Every workflow and step file as written, for the editor. */
export async function readWorkflowFiles(root: string): Promise<WorkflowFiles> {
  const steps = await readFiles(workflowStepsPath(root), (text, name) => {
    const step = parseStepFile(text, name);
    return {
      name: step.name,
      description: step.description,
      gate: step.gate,
      body: step.body,
    };
  });
  const known = new Set(
    steps.filter((step) => !step.problem).map((step) => step.name),
  );
  const flows = await readFiles(workflowsPath(root), (text, name) => {
    const flow = parseWorkflowFile(text, name);
    return {
      name: flow.name,
      description: flow.description,
      when: flow.when,
      until: flow.until,
      body: flow.body,
      ...(flow.dynamic ? { dynamic: true } : { steps: flow.steps }),
      loop: flow.loop,
    };
  });
  for (const flow of flows) {
    const missing = (flow.steps ?? []).filter((step) => !known.has(step));
    if (!flow.problem && missing.length)
      flow.problem = `No step file for ${missing.map((step) => `'${step}'`).join(", ")}`;
  }
  const choosingPath = workflowChoosingPath(root);
  return {
    root,
    flows,
    steps,
    choosing: {
      path: choosingPath,
      text: (await pathExists(choosingPath))
        ? await readTextFile(choosingPath)
        : "",
    },
  };
}

/**
 * Saves one file from the editor. A workflow or step is parsed first and
 * refused with the reason when a run could not read it; its file is named
 * after its `name`. `previousName` is the file being edited, so a changed
 * name renames it; a new file may not take a name already used.
 */
export async function saveWorkflowFile(
  root: string,
  input: { kind: WorkflowFileKind; text: string; previousName?: string },
): Promise<void> {
  if (input.kind === "choosing") {
    await ensureDirectory(root);
    await writeFileAtomic(workflowChoosingPath(root), input.text);
    return;
  }
  const folder =
    input.kind === "flow" ? workflowsPath(root) : workflowStepsPath(root);
  // Checked before anything is written, so a bad name changes no file.
  const previous = input.previousName
    ? workflowName(
        input.previousName,
        input.kind === "flow" ? "workflow" : "step",
      )
    : undefined;
  const name =
    input.kind === "flow"
      ? parseWorkflowFile(input.text, previous).name
      : parseStepFile(input.text, previous).name;
  const path = join(folder, `${name}.md`);
  if (previous !== name && (await pathExists(path)))
    throw new DaedalusError(
      "CONFLICT",
      `A ${input.kind === "flow" ? "workflow" : "step"} named '${name}' exists`,
    );
  await ensureDirectory(folder);
  await writeFileAtomic(path, input.text);
  if (previous && previous !== name)
    await unlink(join(folder, `${previous}.md`)).catch(() => undefined);
}

/** Deletes a workflow, or a step no workflow uses. */
export async function deleteWorkflowFile(
  root: string,
  input: { kind: "flow" | "step"; name: string },
): Promise<void> {
  const name = workflowName(
    input.name,
    input.kind === "flow" ? "workflow" : "step",
  );
  if (input.kind === "step") {
    const users = (await readWorkflowFiles(root)).flows
      .filter((flow) => flow.steps?.includes(name))
      .map((flow) => flow.name);
    if (users.length)
      throw new DaedalusError(
        "CONFLICT",
        `Step '${name}' is used by ${users.join(", ")}; take it out of them first`,
      );
  }
  const folder =
    input.kind === "flow" ? workflowsPath(root) : workflowStepsPath(root);
  await unlink(join(folder, `${name}.md`)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

/* -------------------------------------------------------------------------- */
/* The starter set                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The rules a new folder starts with: nothing imposed, only what to do when
 * no workflow fits, so workflows work before the user has any.
 */
const STARTER_CHOOSING = `# Choosing a workflow

The user's rules for picking a workflow, in order. \`daedal workflow list\`
shows each workflow with when it fits.

- No workflow fits: build a dynamic workflow for this work with
  \`daedal workflow start --steps <a,b,...>\`.
- The same shape of work comes back, or two workflows fit equally: ask the
  user, and offer to save the run as a workflow and add a rule for it here.
`;

/** Two workspaces syncing at once may both write a starter; one wins. */
async function writeStarter(path: string, text: string): Promise<void> {
  try {
    await writeTextFile(path, text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/**
 * Gives a new folder its empty \`flows/\` and \`steps/\` and the starter
 * choosing rules, once. Workflows are the user's own; examples to copy are in
 * docs/workflows.md.
 */
export async function ensureWorkflowsFolder(root: string): Promise<void> {
  const flows = workflowsPath(root);
  if (await pathExists(flows)) return;
  await ensureDirectory(workflowStepsPath(root));
  await writeStarter(workflowChoosingPath(root), STARTER_CHOOSING);
  await ensureDirectory(flows);
}

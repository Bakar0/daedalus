import { readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ensureDirectory,
  pathExists,
  readTextFile,
  writeFileAtomic,
  writeTextFile,
} from "@daedalus/platform";
import {
  includedWorkflow,
  MAX_WORKFLOW_NESTING,
  parseGate,
  parseStepMemory,
  renderStepMemory,
  STEP_MEMORY_SUFFIX,
  type StepMemory,
  type StepMemoryFile,
  type WorkflowDefinition,
  type WorkflowGate,
  type ToolDefinition,
  type WorkflowStepDefinition,
} from "../domain";
import { JOB_OUTPUT_KINDS, type JobGive } from "../domain/jobs";
import { DaedalusError } from "../errors";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const stringValue = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return undefined;
};

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
export const workflowToolsPath = (root: string): string => join(root, "tools");
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

/**
 * `@release` in a `steps` or `loop` field is how a workflow includes another,
 * but YAML reserves a leading `@`. Such a token is quoted before the YAML is
 * read, in those two fields only, so the user writes it bare.
 */
export function quoteIncludes(yaml: string): string {
  let key = "";
  return yaml
    .split("\n")
    .map((line) => {
      const field = /^([A-Za-z_][\w-]*)\s*:/.exec(line);
      if (field) key = field[1]!;
      if (key !== "steps" && key !== "loop") return line;
      return line.replace(
        /(^\s*-\s+|^[\w-]+\s*:\s+|[[,]\s*)@([a-z0-9][a-z0-9-]*)(?=\s*(?:[\],#]|$))/g,
        (_all, before: string, name: string) => `${before}"@${name}"`,
      );
    })
    .join("\n");
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
    data = Bun.YAML.parse(
      what === "workflow" ? quoteIncludes(match[1]!) : match[1]!,
    );
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

const GIVES_HELP =
  "'gives' must be a list of outputs, each a name or 'name: kind', such as [branch: commit, tests: number]. The kinds are " +
  JOB_OUTPUT_KINDS.join(", ");

/** A step's `gives`: `[branch: commit, tests: number]`, or names alone. */
function parseGives(value: unknown): JobGive[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new DaedalusError("VALIDATION", GIVES_HELP);
  return value.map((entry: unknown) => {
    const pair: [string, string] | undefined =
      typeof entry === "string"
        ? [entry.split(":")[0]!.trim(), entry.split(":")[1]?.trim() || "text"]
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? Object.entries(entry as Record<string, unknown>).map(
              ([name, kind]): [string, string] => [
                name.trim(),
                stringValue(kind)?.trim() || "text",
              ],
            )[0]
          : undefined;
    const kind = JOB_OUTPUT_KINDS.find((item) => item === pair?.[1]);
    if (!pair || !/^[a-z0-9][a-z0-9_-]*$/i.test(pair[0]) || !kind)
      throw new DaedalusError("VALIDATION", GIVES_HELP);
    return { name: pair[0], kind };
  });
}

/** A step's `needs`: step names, or undefined for "the step before". */
function parseNeeds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new DaedalusError(
      "VALIDATION",
      "'needs' must be a list of step names, such as [design]. Left out, a step needs the step before it",
    );
  return (value as string[]).map((item) => workflowName(item, "step"));
}

function parseTools(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new DaedalusError(
      "VALIDATION",
      "'tools' must be a list of tool names, such as [aws-access, logs]",
    );
  return (value as string[]).map((item) => workflowName(item, "tool"));
}

/** `fallbackName` is the file's name, used when the frontmatter has none. */
export function parseToolFile(
  text: string,
  fallbackName?: string,
): ToolDefinition {
  const { fields, body } = frontmatter(text, "tool");
  const nameText = stringValue(fields.name) ?? fallbackName;
  if (!nameText)
    throw new DaedalusError("VALIDATION", "The 'name' field is required");
  if (!body)
    throw new DaedalusError(
      "VALIDATION",
      "The tool has no instructions below its frontmatter",
    );
  return {
    name: workflowName(nameText, "tool"),
    description: stringValue(fields.description) ?? "",
    body,
  };
}

export function renderToolFile(tool: ToolDefinition): string {
  return [
    "---",
    `name: ${tool.name}`,
    `description: ${JSON.stringify(tool.description)}`,
    "---",
    "",
    tool.body.trim(),
    "",
  ].join("\n");
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
  const gate = parseGate(stringValue(fields.gate));
  if (gate === undefined)
    throw new DaedalusError(
      "VALIDATION",
      "'gate' must be 'start' (the user gives the go-ahead before the step starts) or 'result' (the user approves what the step produced), or left out",
    );
  if (!body)
    throw new DaedalusError(
      "VALIDATION",
      "The step has no instructions below its frontmatter",
    );
  const needs = parseNeeds(fields.needs);
  const gives = parseGives(fields.gives);
  const tools = parseTools(fields.tools);
  return {
    name: workflowName(nameText, "step"),
    description: stringValue(fields.description) ?? "",
    gate,
    body,
    ...(needs ? { needs } : {}),
    ...(gives.length ? { gives } : {}),
    ...(tools?.length ? { tools } : {}),
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
      "'steps' must be a list of step names, such as [research, review], or dynamic; @name includes another workflow",
    );
  if (dynamic && (fields.loop !== undefined || fields.until !== undefined))
    throw new DaedalusError(
      "VALIDATION",
      "A dynamic workflow has no 'loop' or 'until'; a run that needs one starts with --loop and --until",
    );
  const steps = dynamic
    ? []
    : (fields.steps as string[]).map((step) => {
        const included = includedWorkflow(step.trim());
        return included === null
          ? workflowName(step, "step")
          : `@${workflowName(included)}`;
      });
  const repeated = steps.find((step, index) => steps.indexOf(step) !== index);
  if (repeated)
    throw new DaedalusError(
      "VALIDATION",
      includedWorkflow(repeated)
        ? `Workflow '${repeated.slice(1)}' is included twice; a run goes back to a step by starting it again`
        : `Step '${repeated}' is listed twice; a run goes back to a step by starting it again`,
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
    ...(step.needs ? [`needs: [${step.needs.join(", ")}]`] : []),
    ...(step.gives?.length
      ? [
          `gives: [${step.gives.map((give) => `${give.name}: ${give.kind}`).join(", ")}]`,
        ]
      : []),
    ...(step.tools?.length ? [`tools: [${step.tools.join(", ")}]`] : []),
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
  tools: ToolDefinition[];
  problems: WorkflowFileProblem[];
  /** `CHOOSING.md` as written, or empty when there is none. */
  choosing: string;
  /** Each step's memory file that reads; a step without one has none. */
  memories: StepMemoryFile[];
}

export const stepMemoryPath = (root: string, step: string): string =>
  join(workflowStepsPath(root), `${step}${STEP_MEMORY_SUFFIX}`);

/** The steps that have a memory file, in name order. */
async function stepMemoryNames(root: string): Promise<string[]> {
  const folder = workflowStepsPath(root);
  if (!(await pathExists(folder))) return [];
  return (await readdir(folder))
    .filter((file) => file.endsWith(STEP_MEMORY_SUFFIX))
    .map((file) => file.slice(0, -STEP_MEMORY_SUFFIX.length))
    .sort();
}

/** A step's memory; empty when it has no file yet. Throws on a bad file. */
export async function readStepMemory(
  root: string,
  step: string,
): Promise<StepMemoryFile> {
  const path = stepMemoryPath(root, step);
  if (!(await pathExists(path))) return { step, memories: [] };
  return parseStepMemory(await readTextFile(path), step);
}

/** Writes a step's memory, or removes the file when nothing is left. */
export async function writeStepMemory(
  root: string,
  file: StepMemoryFile,
): Promise<void> {
  const path = stepMemoryPath(root, file.step);
  if (file.memories.length) await writeFileAtomic(path, renderStepMemory(file));
  else if (await pathExists(path)) await unlink(path);
}

/** The markdown files in a folder, in name order, each named after its file. */
async function markdownFiles(
  folder: string,
): Promise<{ name: string; path: string; text: string }[]> {
  if (!(await pathExists(folder))) return [];
  const files = (await readdir(folder))
    // A step's memory sits beside its file and is not a step itself.
    .filter(
      (file) => file.endsWith(".md") && !file.endsWith(STEP_MEMORY_SUFFIX),
    )
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
  const tools = await readFolder(
    workflowToolsPath(root),
    parseToolFile,
    problems,
  );
  // A step that suggests a tool with no file still runs: it only says less.
  const toolNames = new Set(tools.map((tool) => tool.name));
  for (const step of steps) {
    const missing = (step.tools ?? []).filter((name) => !toolNames.has(name));
    if (missing.length)
      problems.push({
        path: join(workflowStepsPath(root), `${step.name}.md`),
        message: `No tool file for ${missing.map((name) => `'${name}'`).join(", ")} in ${workflowToolsPath(root)}`,
      });
  }
  const known = new Set(steps.map((step) => step.name));
  const byName = new Map(workflows.map((item) => [item.name, item]));
  for (const workflow of workflows) {
    const missing = missingSteps(workflow, known);
    const included = includeProblem(workflow, byName, known);
    const message = [
      missing.length
        ? `No step file for ${missing.map((step) => `'${step}'`).join(", ")} in ${workflowStepsPath(root)}`
        : "",
      included?.message ?? "",
    ]
      .filter(Boolean)
      .join(". ");
    if (message)
      problems.push({
        path: join(workflowsPath(root), `${workflow.name}.md`),
        message,
      });
  }
  const choosingPath = workflowChoosingPath(root);
  const choosing = (await pathExists(choosingPath))
    ? await readTextFile(choosingPath)
    : "";
  const memories: StepMemoryFile[] = [];
  for (const name of await stepMemoryNames(root)) {
    const path = stepMemoryPath(root, name);
    try {
      if (!known.has(name))
        throw new Error(
          `No step '${name}' to remember this for; a memory belongs to a step file`,
        );
      memories.push(parseStepMemory(await readTextFile(path), name));
    } catch (error) {
      problems.push({ path, message: message(error) });
    }
  }
  return { workflows, steps, tools, problems, choosing, memories };
}

/* -------------------------------------------------------------------------- */
/* Included workflows                                                         */
/* -------------------------------------------------------------------------- */

/** A workflow's own steps, not its included workflows, that have no file. */
const missingSteps = (
  workflow: Pick<WorkflowDefinition, "steps">,
  known: ReadonlySet<string>,
): string[] =>
  workflow.steps.filter(
    (step) => includedWorkflow(step) === null && !known.has(step),
  );

/**
 * What stops a workflow's `@name` entries from expanding: a loop of
 * workflows including each other, nesting deeper than
 * {@link MAX_WORKFLOW_NESTING}, a missing or dynamic workflow, or an
 * included workflow missing a step. `cycle` and `depth` are the shape of the
 * files themselves, which the editor refuses to save; the rest may be fixed
 * by writing the missing file, so they are only flagged.
 */
export interface WorkflowIncludeProblem {
  kind: "cycle" | "depth" | "missing" | "dynamic" | "steps";
  message: string;
}

/** Only what including needs: a name, its entries and whether it is dynamic. */
type IncludeShape = Pick<WorkflowDefinition, "name" | "steps" | "dynamic">;

export function includeProblem(
  workflow: IncludeShape,
  workflows: ReadonlyMap<string, IncludeShape>,
  knownSteps: ReadonlySet<string>,
): WorkflowIncludeProblem | null {
  const walk = (
    current: IncludeShape,
    chain: string[],
  ): WorkflowIncludeProblem | null => {
    for (const entry of current.steps) {
      const name = includedWorkflow(entry);
      if (name === null) continue;
      const path = [...chain, name];
      const seen = chain.indexOf(name);
      if (seen !== -1)
        return {
          kind: "cycle",
          message:
            path.length === 2
              ? `Workflow '${name}' includes itself`
              : `Workflows include each other in a loop: ${path.slice(seen).join(" → ")}`,
        };
      if (path.length - 1 > MAX_WORKFLOW_NESTING)
        return {
          kind: "depth",
          message: `Included workflows nest more than ${MAX_WORKFLOW_NESTING} levels deep: ${path.join(" → ")}`,
        };
      const included = workflows.get(name);
      if (!included)
        return {
          kind: "missing",
          message: `No workflow '${name}' to include as @${name}`,
        };
      if (included.dynamic)
        return {
          kind: "dynamic",
          message: `Workflow '${name}' has steps: dynamic, so it cannot be included; include a workflow with fixed steps`,
        };
      const missing = missingSteps(included, knownSteps);
      if (missing.length)
        return {
          kind: "steps",
          message: `Included workflow '${name}' has no step file for ${missing.map((step) => `'${step}'`).join(", ")}`,
        };
      const deeper = walk(included, path);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(workflow, [workflow.name]);
}

/** A step of an expanded workflow: its qualified id and its file. */
export interface ExpandedStep {
  id: string;
  step: WorkflowStepDefinition;
}

/** An included workflow in an expanded one: its group id and its file. */
export interface ExpandedGroup {
  id: string;
  workflow: WorkflowDefinition;
  /** The step id its own loop goes back to, or null. */
  loopTo: string | null;
}

/**
 * A workflow with every `@name` entry replaced by that workflow's steps,
 * their ids qualified by the group (`release/review`), and the step id its
 * own loop goes back to. Throws with the reason when it cannot expand.
 */
export function expandWorkflow(
  workflow: WorkflowDefinition,
  catalog: Pick<WorkflowCatalog, "workflows" | "steps">,
): { steps: ExpandedStep[]; groups: ExpandedGroup[]; loopTo: string | null } {
  const byName = new Map(catalog.workflows.map((item) => [item.name, item]));
  const files = new Map(catalog.steps.map((item) => [item.name, item]));
  const problem = includeProblem(workflow, byName, new Set(files.keys()));
  if (problem)
    throw new DaedalusError(
      "VALIDATION",
      `Workflow '${workflow.name}' cannot start: ${problem.message}`,
    );
  const steps: ExpandedStep[] = [];
  const groups: ExpandedGroup[] = [];
  const qualify = (prefix: string, name: string) =>
    prefix ? `${prefix}/${name}` : name;
  /** The id of an entry's first step: a step's own, or its group's first. */
  const firstIds = new Map<string, string>();
  const expand = (current: WorkflowDefinition, prefix: string) => {
    for (const entry of current.steps) {
      const included = includedWorkflow(entry);
      const start = steps.length;
      if (included === null) {
        const step = files.get(entry);
        if (!step)
          throw new DaedalusError(
            "VALIDATION",
            `Workflow '${current.name}' names step '${entry}', which has no file`,
          );
        steps.push({ id: qualify(prefix, entry), step });
      } else {
        const child = byName.get(included)!;
        const id = qualify(prefix, included);
        const group: ExpandedGroup = { id, workflow: child, loopTo: null };
        groups.push(group);
        expand(child, id);
        group.loopTo = child.loop
          ? (firstIds.get(qualify(id, child.loop)) ?? null)
          : null;
      }
      firstIds.set(qualify(prefix, entry), steps[start]!.id);
    }
  };
  expand(workflow, "");
  return {
    steps,
    groups,
    loopTo: workflow.loop ? (firstIds.get(workflow.loop) ?? null) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Editing the files                                                          */
/* -------------------------------------------------------------------------- */

export type WorkflowFileKind = "flow" | "step" | "tool" | "choosing";

/** A kind of file that has a folder and a name of its own. */
type NamedFileKind = Exclude<WorkflowFileKind, "choosing">;

const KIND_NOUN: Record<NamedFileKind, string> = {
  flow: "workflow",
  step: "step",
  tool: "tool",
};

const kindFolder = (root: string, kind: NamedFileKind): string =>
  kind === "flow"
    ? workflowsPath(root)
    : kind === "step"
      ? workflowStepsPath(root)
      : workflowToolsPath(root);

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
  gate?: WorkflowGate | null;
  /** For a step: the tools it suggests, by name. */
  tools?: string[];
  /** For a step: what it learned, proposed ones included. */
  memories?: StepMemory[];
  /** Why the step's memory file cannot be read, when it cannot. */
  memoryProblem?: string;
  problem: string | null;
}

export interface WorkflowFiles {
  root: string;
  flows: WorkflowFile[];
  steps: WorkflowFile[];
  tools: WorkflowFile[];
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

/** The workflow files that parse, as {@link includeProblem} reads them. */
const includeShapes = (flows: WorkflowFile[]) =>
  new Map(
    flows
      .filter((flow) => !flow.problem)
      .map((flow) => [
        flow.name,
        {
          name: flow.name,
          steps: flow.steps ?? [],
          dynamic: Boolean(flow.dynamic),
        },
      ]),
  );

/** Every workflow, step and tool file as written, for the editor. */
export async function readWorkflowFiles(root: string): Promise<WorkflowFiles> {
  const steps = await readFiles(workflowStepsPath(root), (text, name) => {
    const step = parseStepFile(text, name);
    return {
      name: step.name,
      description: step.description,
      gate: step.gate,
      body: step.body,
      ...(step.tools?.length ? { tools: step.tools } : {}),
    };
  });
  const tools = await readFiles(workflowToolsPath(root), (text, name) => {
    const tool = parseToolFile(text, name);
    return { name: tool.name, description: tool.description, body: tool.body };
  });
  for (const step of steps) {
    if (step.problem) continue;
    try {
      step.memories = (await readStepMemory(root, step.name)).memories;
    } catch (error) {
      step.memoryProblem = message(error);
    }
  }
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
  const shapes = includeShapes(flows);
  for (const flow of flows) {
    if (flow.problem) continue;
    const missing = missingSteps({ steps: flow.steps ?? [] }, known);
    const included = includeProblem(shapes.get(flow.name)!, shapes, known);
    flow.problem =
      [
        missing.length
          ? `No step file for ${missing.map((step) => `'${step}'`).join(", ")}`
          : "",
        included?.message ?? "",
      ]
        .filter(Boolean)
        .join(". ") || null;
  }
  const choosingPath = workflowChoosingPath(root);
  return {
    root,
    flows,
    steps,
    tools,
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
  const noun = KIND_NOUN[input.kind];
  const folder = kindFolder(root, input.kind);
  // Checked before anything is written, so a bad name changes no file.
  const previous = input.previousName
    ? workflowName(input.previousName, noun)
    : undefined;
  const flow =
    input.kind === "flow" ? parseWorkflowFile(input.text, previous) : null;
  const name = flow
    ? flow.name
    : input.kind === "tool"
      ? parseToolFile(input.text, previous).name
      : parseStepFile(input.text, previous).name;
  if (flow) await refuseIncludeShape(root, flow, previous);
  // Renaming a tool would leave the steps that suggest it naming nothing.
  if (input.kind === "tool" && previous && previous !== name) {
    const users = await toolUsers(root, previous);
    if (users.length)
      throw new DaedalusError(
        "CONFLICT",
        `Tool '${previous}' is suggested by ${users.join(", ")}; take it out of their 'tools' before renaming it`,
      );
  }
  // Renaming an included workflow would leave `@previous` naming nothing,
  // which deleting it refuses for the same reason.
  if (flow && previous && previous !== name) {
    const users = (await readWorkflowFiles(root)).flows
      .filter(
        (item) =>
          item.name !== previous && item.steps?.includes(`@${previous}`),
      )
      .map((item) => item.name);
    if (users.length)
      throw new DaedalusError(
        "CONFLICT",
        `Workflow '${previous}' is included by ${users.join(", ")}; take @${previous} out of them before renaming it`,
      );
  }
  const path = join(folder, `${name}.md`);
  if (previous !== name && (await pathExists(path)))
    throw new DaedalusError("CONFLICT", `A ${noun} named '${name}' exists`);
  await ensureDirectory(folder);
  await writeFileAtomic(path, input.text);
  if (previous && previous !== name)
    await unlink(join(folder, `${previous}.md`)).catch(() => undefined);
}

/**
 * Refuses a workflow whose saving would leave workflows including each
 * other in a loop, or nested too deep: no run could start from them. The
 * check covers every workflow, since saving one can make another too deep.
 */
async function refuseIncludeShape(
  root: string,
  flow: WorkflowDefinition,
  previous: string | undefined,
): Promise<void> {
  if (!flow.steps.some((step) => includedWorkflow(step) !== null)) return;
  const files = await readWorkflowFiles(root);
  const known = new Set(
    files.steps.filter((step) => !step.problem).map((step) => step.name),
  );
  const shapes = includeShapes(
    files.flows.filter(
      (item) => item.name !== previous && item.name !== flow.name,
    ),
  );
  const before = includeShapes(files.flows);
  shapes.set(flow.name, {
    name: flow.name,
    steps: flow.steps,
    dynamic: flow.dynamic,
  });
  for (const shape of [shapes.get(flow.name)!, ...shapes.values()]) {
    const problem = includeProblem(shape, shapes, known);
    if (!problem || (problem.kind !== "cycle" && problem.kind !== "depth"))
      continue;
    const earlier = before.get(shape.name);
    const had = earlier && includeProblem(earlier, before, known);
    if (shape.name !== flow.name && had && had.kind === problem.kind) continue;
    throw new DaedalusError(
      "VALIDATION",
      shape.name === flow.name
        ? problem.message
        : `Saving this makes workflow '${shape.name}' unusable: ${problem.message}`,
    );
  }
}

/** The steps whose `tools` name this tool. */
async function toolUsers(root: string, tool: string): Promise<string[]> {
  return (await readWorkflowFiles(root)).steps
    .filter((step) => step.tools?.includes(tool))
    .map((step) => step.name);
}

/**
 * Deletes a workflow no other workflow includes, a step no workflow uses, or
 * a tool no step suggests.
 */
export async function deleteWorkflowFile(
  root: string,
  input: { kind: NamedFileKind; name: string },
): Promise<void> {
  const name = workflowName(input.name, KIND_NOUN[input.kind]);
  if (input.kind === "tool") {
    const users = await toolUsers(root, name);
    if (users.length)
      throw new DaedalusError(
        "CONFLICT",
        `Tool '${name}' is suggested by ${users.join(", ")}; take it out of their 'tools' first`,
      );
    await unlink(join(workflowToolsPath(root), `${name}.md`)).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      },
    );
    return;
  }
  const entry = input.kind === "step" ? name : `@${name}`;
  const users = (await readWorkflowFiles(root)).flows
    .filter((flow) => flow.steps?.includes(entry))
    .map((flow) => flow.name);
  if (users.length)
    throw new DaedalusError(
      "CONFLICT",
      input.kind === "step"
        ? `Step '${name}' is used by ${users.join(", ")}; take it out of them first`
        : `Workflow '${name}' is included by ${users.join(", ")}; take @${name} out of them first`,
    );
  await unlink(join(kindFolder(root, input.kind), `${name}.md`)).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    },
  );
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

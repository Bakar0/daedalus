import {
  includedWorkflow,
  shownStepMemories,
  stepMemoryText,
  type WorkflowDefinition,
} from "../domain";
import { DaedalusError } from "../errors";
import type { JobDraft } from "./jobs";
import {
  expandWorkflow,
  workflowName,
  type WorkflowCatalog,
} from "./workflow-files";

/** The `source` of a job that stands for a whole workflow. */
export const workflowJobSource = (workflow: string): string =>
  `workflow:${workflow}`;

/** The workflow a job stands for, or null for any other job. */
export const workflowOfJobSource = (source: string | null): string | null =>
  source?.startsWith("workflow:") ? source.slice("workflow:".length) : null;

type Catalog = Pick<WorkflowCatalog, "workflows" | "steps" | "memories"> &
  Partial<Pick<WorkflowCatalog, "tools">>;

/**
 * The tools a step suggests, as the end of its instructions: what each is
 * for and how to open it. A name with no file is left out.
 */
export function suggestedToolsText(
  names: readonly string[],
  tools: Catalog["tools"],
): string {
  const found = names.flatMap(
    (name) => tools?.find((tool) => tool.name === name) ?? [],
  );
  if (!found.length) return "";
  return [
    "Tools suggested for this step. Open one with `daedal tool show <name>` when you need it; use anything else the work needs.",
    ...found.map(
      (tool) =>
        `- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`,
    ),
  ].join("\n");
}

/**
 * One step as a job done in the session of the job above it. Its
 * instructions are the step file's body with what earlier runs learned, both
 * copied now, so editing the file changes the next run only.
 */
function stepDraft(
  catalog: Catalog,
  workflow: string,
  name: string,
  before: string | null,
): JobDraft {
  const file = catalog.steps.find((item) => item.name === name);
  const memory = catalog.memories.find((item) => item.step === name);
  const learned = memory
    ? stepMemoryText(shownStepMemories(memory, workflow))
    : "";
  return {
    name,
    title: name,
    instructions: [
      file?.body.trim() ?? "",
      learned,
      suggestedToolsText(file?.tools ?? [], catalog.tools),
    ]
      .filter(Boolean)
      .join("\n\n"),
    needs: file?.needs ?? (before ? [before] : []),
    gives: file?.gives ?? [],
    gate: file?.gate ?? null,
    runner: { kind: "inline" },
    source: `step:${workflow}/${name}`,
  };
}

function flowDraft(
  catalog: Catalog,
  workflow: WorkflowDefinition,
  before: string | null,
): JobDraft {
  let last: string | null = null;
  const children = workflow.steps.map((entry) => {
    const included = includedWorkflow(entry);
    const child = included
      ? catalog.workflows.find((item) => item.name === included)
      : undefined;
    if (included && !child)
      throw new DaedalusError(
        "VALIDATION",
        `Workflow '${workflow.name}' includes '${included}', which has no file`,
      );
    const draft = child
      ? flowDraft(catalog, child, last)
      : stepDraft(catalog, workflow.name, entry, last);
    last = draft.name;
    return draft;
  });
  const loopTo = workflow.loop
    ? (includedWorkflow(workflow.loop) ?? workflow.loop)
    : null;
  return {
    name: workflow.name,
    title: workflow.name,
    instructions: workflow.body.trim(),
    needs: before ? [before] : [],
    runner: { kind: "inline" },
    // A workflow that goes round ends when its runner says so. Any other is
    // done when its last step is.
    auto: !loopTo,
    loop: loopTo ? { to: loopTo, until: workflow.until.trim() || null } : null,
    source: workflowJobSource(workflow.name),
    children,
  };
}

/**
 * A workflow file as one job with its steps under it. An included workflow
 * is a job among the steps with its own steps under it.
 */
export function workflowJobDraft(
  workflow: WorkflowDefinition,
  catalog: Catalog,
): JobDraft {
  // Refuses what cannot run: a missing step file, an include that loops.
  expandWorkflow(workflow, catalog);
  return flowDraft(catalog, workflow, null);
}

/**
 * A run built for one piece of work: the steps the agent named, each from
 * its file when it has one. A step without a file gives only its result.
 */
export function dynamicJobDraft(
  input: { label: string; steps: string[]; loop?: string; until?: string },
  catalog: Catalog,
): JobDraft {
  const names = input.steps.map((step) => workflowName(step, "step"));
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated)
    throw new DaedalusError(
      "VALIDATION",
      `Step '${repeated}' is listed twice. A job is done again with \`daedal job redo ${repeated}\`.`,
    );
  if (input.loop && !names.includes(input.loop))
    throw new DaedalusError(
      "VALIDATION",
      `--loop must name one of the steps: ${names.join(", ") || "none"}`,
    );
  return {
    name: input.label,
    title: input.label,
    runner: { kind: "inline" },
    auto: !input.loop,
    loop: input.loop
      ? { to: input.loop, until: input.until?.trim() || null }
      : null,
    source: workflowJobSource(input.label),
    children: names.map((name, index) =>
      stepDraft(catalog, input.label, name, names[index - 1] ?? null),
    ),
  };
}

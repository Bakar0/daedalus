import { join } from "node:path";
import {
  ensureDirectory,
  pathExists,
  writeFileAtomic,
  writeTextFile,
} from "@daedalus/platform";
import {
  acceptStepMemory,
  findStepMemory,
  forgetStepMemory,
  includedWorkflow,
  rememberStepMemory,
  type StepMemoryFile,
  type WorkflowGate,
  type WorkflowStepDefinition,
} from "../domain";
import { DaedalusError } from "../errors";
import {
  deleteWorkflowFile,
  ensureWorkflowsFolder,
  readWorkflowCatalog,
  readWorkflowFiles,
  saveWorkflowFile,
  type WorkflowFileKind,
  type WorkflowFiles,
  readStepMemory,
  renderStepFile,
  stepMemoryPath,
  writeStepMemory,
  renderWorkflowFile,
  workflowName,
  workflowStepsPath,
  workflowsHomePath,
  workflowsPath,
  type WorkflowCatalog,
} from "./workflow-files";

const noWorkflow = (name: string, catalog: WorkflowCatalog) =>
  `No workflow '${name}'. Workflows: ${catalog.workflows.map((item) => item.name).join(", ") || "none"}`;
export class WorkflowService {
  constructor(
    private readonly home: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get root(): string {
    return workflowsHomePath(this.home);
  }

  /** Gives the folder its starting rules first when it has none yet. */
  async catalog(): Promise<WorkflowCatalog> {
    await ensureWorkflowsFolder(this.root);
    return readWorkflowCatalog(this.root);
  }

  /** One workflow with each of its steps' files; null for a step with none. */
  async show(name: string) {
    const catalog = await this.catalog();
    const workflow = catalog.workflows.find((item) => item.name === name);
    if (!workflow)
      throw new DaedalusError("NOT_FOUND", noWorkflow(name, catalog));
    return {
      workflow,
      steps: workflow.steps.map(
        (step) => catalog.steps.find((item) => item.name === step) ?? null,
      ),
    };
  }

  /* ---------------------------- Step memory ----------------------------- */

  /** The step's file must exist: a memory belongs to a saved step. */
  private async savedStep(step: string): Promise<WorkflowStepDefinition> {
    const found = (await this.catalog()).steps.find(
      (item) => item.name === step,
    );
    if (!found)
      throw new DaedalusError(
        "NOT_FOUND",
        `No step file for '${step}'. A memory belongs to a saved step; a step made for one run has none.`,
      );
    return found;
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  /** A step's memory, proposed ones included, and where its file is. */
  async stepMemory(step: string): Promise<StepMemoryFile & { path: string }> {
    await this.savedStep(step);
    return {
      ...(await readStepMemory(this.root, step)),
      path: stepMemoryPath(this.root, step),
    };
  }

  /**
   * Proposes what a run learned about a step. It waits for the user to
   * accept it; the same instruction seen again raises its count.
   */
  async rememberStep(input: {
    step: string;
    text: string;
    why: string;
    /** The workflow the session that learned it is in. */
    workflow?: string | null;
    only?: string;
  }): Promise<StepMemoryFile> {
    await this.savedStep(input.step);
    const next = rememberStepMemory(
      await readStepMemory(this.root, input.step),
      {
        text: input.text,
        why: input.why,
        day: this.today(),
        workflow: input.workflow ?? null,
        only: input.only ?? null,
      },
    );
    await writeStepMemory(this.root, next);
    return next;
  }

  /** The user accepts a memory: from then on agents starting the step see it. */
  async acceptStepMemory(
    step: string,
    reference: string,
  ): Promise<StepMemoryFile> {
    await this.savedStep(step);
    const next = acceptStepMemory(
      await readStepMemory(this.root, step),
      reference,
      this.today(),
    );
    await writeStepMemory(this.root, next);
    return next;
  }

  async forgetStepMemory(
    step: string,
    reference: string,
  ): Promise<StepMemoryFile> {
    await this.savedStep(step);
    const next = forgetStepMemory(
      await readStepMemory(this.root, step),
      reference,
    );
    await writeStepMemory(this.root, next);
    return next;
  }

  /**
   * Moves a memory into the step's own instructions, as a last line, and
   * takes it out of the memory: it is said once, where the step says the rest.
   */
  async promoteStepMemory(
    step: string,
    reference: string,
  ): Promise<StepMemoryFile> {
    const definition = await this.savedStep(step);
    const file = await readStepMemory(this.root, step);
    const memory = findStepMemory(file, reference);
    await writeFileAtomic(
      join(workflowStepsPath(this.root), `${step}.md`),
      renderStepFile({
        ...definition,
        body: `${definition.body.trim()}\n\n${memory.text}.`.replace(
          /\.\.$/,
          ".",
        ),
      }),
    );
    const next = forgetStepMemory(file, reference);
    await writeStepMemory(this.root, next);
    return next;
  }

  /**
   * What the user does to a memory in the Workflows tab, naming it by its
   * text: accept it, forget it, or promote it into the step's instructions.
   */
  async changeStepMemory(input: {
    step: string;
    text: string;
    action: "accept" | "forget" | "promote";
  }): Promise<WorkflowFiles> {
    switch (input.action) {
      case "accept":
        await this.acceptStepMemory(input.step, input.text);
        break;
      case "forget":
        await this.forgetStepMemory(input.step, input.text);
        break;
      case "promote":
        await this.promoteStepMemory(input.step, input.text);
        break;
    }
    return this.files();
  }

  /** Everything the Workflows tab shows: workflows, steps, tools and choosing rules. */
  async files(): Promise<WorkflowFiles> {
    await ensureWorkflowsFolder(this.root);
    return readWorkflowFiles(this.root);
  }

  async saveFile(input: {
    kind: WorkflowFileKind;
    text: string;
    previousName?: string;
  }): Promise<WorkflowFiles> {
    await saveWorkflowFile(this.root, input);
    return this.files();
  }

  async deleteFile(input: {
    kind: "flow" | "step" | "tool";
    name: string;
  }): Promise<WorkflowFiles> {
    await deleteWorkflowFile(this.root, input);
    return this.files();
  }

  /**
   * Writes steps that were named for one piece of work as a maintained
   * workflow, and each step that has no file as a step file. The way a run
   * that worked becomes something the user keeps. Existing files are left
   * alone.
   */
  async saveAs(input: {
    name: string;
    when?: string;
    description?: string;
    /** In order. An entry `@name` includes that workflow and writes nothing. */
    steps: { entry: string; gate: WorkflowGate | null; text: string }[];
    loop: string | null;
    until: string;
  }): Promise<{ workflow: string; written: string[] }> {
    if (!input.steps.length)
      throw new DaedalusError("VALIDATION", "There are no steps to save");
    const name = workflowName(input.name);
    const path = join(workflowsPath(this.root), `${name}.md`);
    if (await pathExists(path))
      throw new DaedalusError(
        "CONFLICT",
        `Workflow '${name}' exists. Edit ${path}, or save under another name.`,
      );
    const written: string[] = [];
    const steps = workflowStepsPath(this.root);
    await ensureDirectory(steps);
    for (const step of input.steps) {
      if (includedWorkflow(step.entry) !== null) continue;
      const stepPath = join(steps, `${step.entry}.md`);
      if (await pathExists(stepPath)) continue;
      // What the agent did in the step this time is the best first draft of
      // its instructions.
      const text = step.text.trim() || `Do ${step.entry}.`;
      await writeTextFile(
        stepPath,
        renderStepFile({
          name: step.entry,
          description: text.split("\n")[0] ?? "",
          gate: step.gate,
          body: text,
        }),
      );
      written.push(stepPath);
    }
    await ensureDirectory(workflowsPath(this.root));
    await writeTextFile(
      path,
      renderWorkflowFile({
        name,
        description: input.description?.trim() ?? "",
        when: input.when?.trim() ?? "",
        steps: input.steps.map((step) => step.entry),
        dynamic: false,
        loop: input.loop,
        until: input.until,
        body: "",
      }),
    );
    written.push(path);
    return { workflow: name, written };
  }
}

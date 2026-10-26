import { join } from "node:path";
import { ensureDirectory, pathExists, writeTextFile } from "@daedalus/platform";
import type {
  AgentSession,
  WorkflowRun,
  WorkflowRunStep,
  WorkflowStepDefinition,
  WorkflowStepState,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { ActivityService } from "./activity";
import type { SessionChannel } from "./session-channel";
import {
  deleteWorkflowFile,
  ensureWorkflowsFolder,
  readWorkflowCatalog,
  readWorkflowFiles,
  saveWorkflowFile,
  type WorkflowFileKind,
  type WorkflowFiles,
  renderStepFile,
  renderWorkflowFile,
  workflowName,
  workflowStepsPath,
  workflowsHomePath,
  workflowsPath,
  type WorkflowCatalog,
} from "./workflow-files";

export type WorkflowStepAction = "start" | "done" | "skip";

const FINISHED: ReadonlySet<WorkflowStepState> = new Set(["done", "skipped"]);

/** A step the run is in: active, or waiting for the user's approval. */
const isLive = (step: { state: WorkflowStepState }) =>
  step.state === "active" || step.state === "waiting";

const noWorkflow = (name: string, catalog: WorkflowCatalog) =>
  `No workflow '${name}'. Workflows: ${catalog.workflows.map((item) => item.name).join(", ") || "none"}`;

/** The label of a dynamic run started without a name. */
const DYNAMIC = "dynamic";

/** What a step change did, so the caller can tell the agent what follows. */
export interface WorkflowStepOutcome {
  run: WorkflowRun;
  /** The step is gated and now waits for the user's approval. */
  waiting: boolean;
  /** The last step finished and a circular run went round again. */
  looped: boolean;
}

const runStep = (
  step: Pick<WorkflowStepDefinition, "name" | "description" | "gate">,
  dynamic: boolean,
): WorkflowRunStep => ({
  name: step.name,
  description: step.description,
  gate: step.gate,
  state: "pending",
  startedAt: null,
  endedAt: null,
  approvedAt: null,
  waitingSessionId: null,
  plan: null,
  note: null,
  dynamic,
});

/**
 * Workflow runs: which workflow a piece of work follows and where it is.
 *
 * The agent reports its own position, the way it reports attention. A run
 * belongs to the session doing the work, apart from any task: tasks are the
 * user's board, workflows are how a session works. A rebirth hands the run
 * to the successor.
 *
 * A run is the agent's own copy. Building a dynamic run, or adding and
 * removing steps in a running one, never writes a workflow file; `save` is
 * the one way a run's shape becomes a maintained workflow.
 */
export class WorkflowService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly home: string,
    private readonly activity: Pick<ActivityService, "raise" | "clear">,
    /** The user's switch for workflows, in Settings › Sessions. */
    private readonly enabled: () => boolean,
    private readonly channel?: Pick<SessionChannel, "deliver">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Off, no run starts: an agent told to use workflows is told why not. */
  private requireEnabled(): void {
    if (!this.enabled())
      throw new DaedalusError(
        "CONFLICT",
        "Workflows are off. Do the work without one; the user turns them on in Settings, under Sessions.",
      );
  }

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

  /**
   * What an agent reads when its run starts: the workflow's own notes, and
   * each step's instructions, from its file or, for a step the agent named,
   * its description.
   */
  async instructions(run: WorkflowRun): Promise<{
    notes: string;
    steps: { name: string; gate: boolean; body: string }[];
  }> {
    const catalog = await this.catalog();
    return {
      notes:
        catalog.workflows.find((item) => item.name === run.workflow)?.body ??
        "",
      steps: run.steps.map((step) => ({
        name: step.name,
        gate: step.gate === "user",
        body:
          catalog.steps.find((item) => item.name === step.name)?.body ??
          step.description,
      })),
    };
  }

  /** Everything the Workflows tab shows: workflows, steps and choosing rules. */
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
    kind: "flow" | "step";
    name: string;
  }): Promise<WorkflowFiles> {
    await deleteWorkflowFile(this.root, input);
    return this.files();
  }

  /** The newest run of each session. */
  list(): WorkflowRun[] {
    return this.repositories.workflows.listLatest();
  }

  /** The session's newest run, open or ended. */
  current(sessionId: string): WorkflowRun | undefined {
    this.requireSession(sessionId);
    return this.repositories.workflows.latestForSession(sessionId);
  }

  /**
   * Starts a maintained workflow by name, or a dynamic run: `steps` names
   * existing steps (possibly none) and `name` labels it. Dynamic steps are
   * added afterwards with `add`.
   */
  async start(input: {
    sessionId: string;
    workflow?: string;
    steps?: string[];
    name?: string;
    /** A dynamic run's loop: the step it goes back to after its last. */
    loop?: string;
    until?: string;
    /** Ends an open run and starts this one in its place. */
    replace?: boolean;
  }): Promise<WorkflowRun> {
    this.requireEnabled();
    const named = input.workflow !== undefined;
    if (named && (input.loop || input.until))
      throw new DaedalusError(
        "VALIDATION",
        "--loop and --until belong to a dynamic workflow built with --steps; a workflow file sets its own",
      );
    const label = named ? input.workflow! : workflowName(input.name ?? DYNAMIC);
    const session = this.requireSession(input.sessionId);
    const open = this.current(session.id);
    if (open && !open.endedAt) {
      if (!input.replace)
        throw new DaedalusError(
          "CONFLICT",
          `This session already runs workflow '${open.workflow}'${describePosition(open)}. Pass --replace to end it and start '${label}'.`,
          { runId: open.id },
        );
      this.save({ ...open, endNote: `Replaced by '${label}'` }, true);
    }
    const catalog = await this.catalog();
    // A step the agent names in a dynamic run need not have a file: it is
    // that run's own, and the plan note on its start says what it is.
    const ownSteps = (names: string[]): WorkflowRunStep[] =>
      names.map((text) => {
        const name = workflowName(text, "step");
        const file = catalog.steps.find((item) => item.name === name);
        return file
          ? runStep(file, false)
          : runStep({ name, description: "", gate: null }, true);
      });
    const repeated = (input.steps ?? []).find(
      (step, index, all) => all.indexOf(step) !== index,
    );
    if (repeated)
      throw new DaedalusError(
        "VALIDATION",
        `Step '${repeated}' is listed twice; a run goes back to a step by starting it again`,
      );
    let steps: WorkflowRunStep[];
    let loopTo: string | null;
    let until: string;
    let dynamic = !named;
    if (!named) {
      steps = ownSteps(input.steps ?? []);
      loopTo = input.loop ?? null;
      if (loopTo && !steps.some((step) => step.name === loopTo))
        throw new DaedalusError(
          "VALIDATION",
          `--loop must name one of the run's steps: ${steps.map((step) => step.name).join(", ") || "none yet"}`,
        );
      until = input.until?.trim() ?? "";
    } else {
      const workflow = this.runnable(catalog, label);
      if (!workflow.dynamic && input.steps)
        throw new DaedalusError(
          "VALIDATION",
          `Workflow '${label}' has its own steps; build a dynamic workflow with --steps and no name instead`,
        );
      dynamic = workflow.dynamic;
      steps = workflow.dynamic
        ? ownSteps(input.steps ?? [])
        : this.fileSteps(catalog, workflow);
      loopTo = workflow.loop;
      until = workflow.until;
    }
    const now = this.now().toISOString();
    return this.repositories.workflows.save({
      id: crypto.randomUUID(),
      workspaceId: session.workspaceId,
      sessionId: session.id,
      workflow: label,
      steps,
      dynamic,
      modified: false,
      loopTo,
      until,
      iteration: 1,
      history: [],
      endNote: null,
      startedAt: now,
      updatedAt: now,
      endedAt: null,
    });
  }

  /** A workflow file a run can start from, or why there is none. */
  private runnable(catalog: WorkflowCatalog, name: string) {
    const workflow = catalog.workflows.find((item) => item.name === name);
    if (workflow) return workflow;
    const problem = catalog.problems.find((item) =>
      item.path.endsWith(`/${name}.md`),
    );
    throw new DaedalusError(
      problem ? "VALIDATION" : "NOT_FOUND",
      problem
        ? `Workflow '${name}' cannot be read: ${problem.message}`
        : `${noWorkflow(name, catalog)}. For work none of them fits, start a dynamic workflow with --steps.`,
    );
  }

  /** A maintained workflow's steps, each from its file. */
  private fileSteps(
    catalog: WorkflowCatalog,
    workflow: WorkflowCatalog["workflows"][number],
  ): WorkflowRunStep[] {
    return workflow.steps.map((name) => {
      const step = catalog.steps.find((item) => item.name === name);
      if (!step)
        throw new DaedalusError(
          "VALIDATION",
          `Workflow '${workflow.name}' names step '${name}', which has no file`,
        );
      return runStep(step, false);
    });
  }

  /**
   * Starts a session already in a workflow, so the agent spends nothing
   * choosing one: the workflow is checked, the session spawned with one line
   * saying so, and its run started.
   */
  async spawnWith(input: {
    workflow: string;
    message?: string;
    spawn: (message: string) => Promise<AgentSession>;
  }): Promise<{ session: AgentSession; run: WorkflowRun }> {
    this.requireEnabled();
    const catalog = await this.catalog();
    // Everything `start` checks is checked before the session exists, so a
    // workflow that cannot run never leaves a session told it is in one.
    const workflow = this.runnable(catalog, input.workflow);
    if (!workflow.dynamic) this.fileSteps(catalog, workflow);
    const line = workflow.dynamic
      ? `Daedalus started workflow '${input.workflow}' for this session. It has no steps yet: add the ones you will take with \`daedal workflow add <step>\`, then report them as the daedalus-workflows skill says.`
      : `Daedalus started workflow '${input.workflow}' for this session. Run \`daedal workflow status\` for its steps and report them as the daedalus-workflows skill says.`;
    const session = await input.spawn(
      [input.message?.trim(), line].filter(Boolean).join("\n\n"),
    );
    const run = await this.start({
      sessionId: session.id,
      workflow: input.workflow,
    });
    return { session, run };
  }

  /**
   * Adds a step to the open run only. A step with a file takes its
   * description and gate from it; any other step is dynamic, and its
   * description is its instructions.
   */
  async add(input: {
    sessionId: string;
    step: string;
    after?: string;
    description?: string;
    gate?: boolean;
  }): Promise<WorkflowRun> {
    const run = this.requireOpen(this.requireSession(input.sessionId));
    const name = workflowName(input.step, "step");
    if (run.steps.some((step) => step.name === name))
      throw new DaedalusError(
        "CONFLICT",
        `The run already has step '${name}'; start it again to go back to it`,
      );
    const file = (await this.catalog()).steps.find(
      (item) => item.name === name,
    );
    const description = input.description?.trim();
    const step = file
      ? runStep(
          {
            ...file,
            ...(description ? { description } : {}),
            gate: input.gate ? "user" : file.gate,
          },
          false,
        )
      : runStep(
          {
            name,
            description: description ?? "",
            gate: input.gate ? "user" : null,
          },
          true,
        );
    const steps = [...run.steps];
    if (input.after) {
      const index = steps.findIndex((item) => item.name === input.after);
      if (index === -1) throw this.unknownStep(run, input.after);
      steps.splice(index + 1, 0, step);
    } else steps.push(step);
    return this.save({ ...run, steps, modified: !run.dynamic });
  }

  /** Takes a step that has not started out of the open run. */
  remove(input: { sessionId: string; step: string }): WorkflowRun {
    const run = this.requireOpen(this.requireSession(input.sessionId));
    const step = run.steps.find((item) => item.name === input.step);
    if (!step) throw this.unknownStep(run, input.step);
    if (step.state !== "pending")
      throw new DaedalusError(
        "CONFLICT",
        `Step '${step.name}' is ${step.state}; only a step not yet started can be removed. Skip it with a note instead.`,
      );
    const steps = run.steps.filter((item) => item !== step);
    const loopTo = run.loopTo === step.name ? null : run.loopTo;
    const finished =
      steps.length > 0 && steps.every((item) => FINISHED.has(item.state));
    return this.save(
      { ...run, steps, modified: !run.dynamic, loopTo },
      finished && !loopTo,
    );
  }

  /** Ends the open run, finished or not. The way out of a circular run. */
  end(input: { sessionId: string; note?: string }): WorkflowRun {
    const run = this.requireOpen(this.requireSession(input.sessionId));
    const note = input.note?.trim() || null;
    // Ending in the middle of a step finishes it, and what the agent says
    // then is that step's outcome; the run keeps a note of its own only
    // when it ends between steps.
    const open = run.steps.some(isLive);
    return this.save(
      {
        ...run,
        steps: run.steps.map((step) =>
          isLive(step)
            ? {
                ...step,
                state: "done",
                endedAt: this.now().toISOString(),
                note: step.note ?? note,
              }
            : step,
        ),
        endNote: open ? null : note,
      },
      true,
    );
  }

  /**
   * Moves one step. Starting a step finishes the one that was active, so an
   * agent that forgets a `done` still shows where it is. Starting a step that
   * already ended goes back to it. A gated step waits for the user instead,
   * and raises attention saying so. When every step has finished, the run
   * ends, or a circular one goes round again from its loop step.
   */
  async step(input: {
    sessionId: string;
    step: string;
    action: WorkflowStepAction;
    note?: string;
  }): Promise<WorkflowStepOutcome> {
    const session = this.requireSession(input.sessionId);
    const run = this.requireOpen(session);
    const index = run.steps.findIndex((step) => step.name === input.step);
    if (index === -1) throw this.unknownStep(run, input.step);
    const note = input.note?.trim() || null;
    if (!note)
      throw new DaedalusError(
        "VALIDATION",
        input.action === "start"
          ? 'Say what you will do in this step with --note "<one line>"'
          : input.action === "done"
            ? 'Say what came out of this step with --note "<one line>"'
            : 'Say why the step is skipped with --note "<one line>"',
      );
    const now = this.now().toISOString();
    let steps = run.steps.map((step) => ({ ...step }));
    const target = steps[index]!;
    let waiting = false;
    if (input.action === "start") {
      for (const step of steps)
        if (step !== target && step.state === "active") {
          step.state = "done";
          step.endedAt = now;
        }
      // An approval covers one pass through the step; going back needs another.
      if (FINISHED.has(target.state)) target.approvedAt = null;
      waiting = target.gate === "user" && !target.approvedAt;
      target.state = waiting ? "waiting" : "active";
      target.startedAt = now;
      target.endedAt = null;
      target.waitingSessionId = waiting ? session.id : null;
      target.plan = note;
      target.note = null;
    } else {
      if (target.state === "waiting")
        throw new DaedalusError(
          "CONFLICT",
          `Step '${target.name}' waits for the user's approval`,
        );
      // A gated step is done only after the user approved it. Skipping it
      // stays possible: that does not do what the gate guards.
      if (
        input.action === "done" &&
        target.gate === "user" &&
        !target.approvedAt
      )
        throw new DaedalusError(
          "CONFLICT",
          `Step '${target.name}' needs the user's approval; start it so they are asked`,
        );
      target.state = input.action === "done" ? "done" : "skipped";
      target.startedAt ??= now;
      target.endedAt = now;
      target.waitingSessionId = null;
      target.note = note;
    }
    const finished = steps.every((step) => FINISHED.has(step.state));
    let iteration = run.iteration;
    let history = run.history;
    const looped = finished && run.loopTo !== null;
    if (looped) {
      const from = steps.findIndex((step) => step.name === run.loopTo);
      history = [
        ...history,
        ...steps.slice(from).map((step) => ({
          iteration,
          name: step.name,
          state: step.state,
          startedAt: step.startedAt,
          endedAt: step.endedAt,
          note: step.note,
        })),
      ];
      steps = steps.map((step, position) =>
        position < from ? step : runStep(step, step.dynamic),
      );
      iteration += 1;
    }
    const saved = this.save(
      { ...run, steps, iteration, history },
      finished && !looped,
    );
    if (waiting)
      await this.activity.raise({
        sessionId: session.id,
        reason: `Approve step '${target.name}' of workflow '${run.workflow}'${note ? `: ${note}` : ""}`,
      });
    return { run: saved, waiting, looped };
  }

  /**
   * The user's approval of the step a run waits on. The waiting session's
   * attention clears and, when Daedalus can reach it, it is told to go on.
   */
  async approve(input: {
    runId: string;
    note?: string;
  }): Promise<{ run: WorkflowRun; told: boolean }> {
    const run = this.repositories.workflows.find(input.runId);
    if (!run)
      throw new DaedalusError("NOT_FOUND", `No workflow run '${input.runId}'`);
    const target = run.steps.find((step) => step.state === "waiting");
    if (!target)
      throw new DaedalusError(
        "CONFLICT",
        `Workflow '${run.workflow}' is not waiting for an approval`,
      );
    const now = this.now().toISOString();
    const waitingSessionId = target.waitingSessionId;
    const steps = run.steps.map((step) =>
      step === target
        ? {
            ...step,
            state: "active" as const,
            approvedAt: now,
            waitingSessionId: null,
          }
        : step,
    );
    const saved = this.save({ ...run, steps });
    let told = false;
    const session = waitingSessionId
      ? this.repositories.findAgent(waitingSessionId)
      : undefined;
    if (session) {
      this.activity.clear(session.id);
      if (this.channel && session.status === "running") {
        const outcome = await this.channel
          .deliver(
            session,
            `Daedalus: the user approved step '${target.name}' of workflow '${run.workflow}'${input.note?.trim() ? ` (${input.note.trim()})` : ""}. Go on with it.`,
            { when: "now" },
          )
          .catch(() => undefined);
        told = outcome?.kind === "delivered";
      }
    }
    return { run: saved, told };
  }

  /** Approval from inside a session, after the user said yes there. */
  approveFor(sessionId: string, note?: string) {
    const run = this.requireOpen(this.requireSession(sessionId));
    return this.approve({ runId: run.id, ...(note ? { note } : {}) });
  }

  /**
   * Writes the session's current run as a maintained workflow, and each of
   * its dynamic steps as a step file. The way a dynamic run that worked
   * becomes something the user keeps. Existing files are left alone.
   */
  async saveAs(input: {
    sessionId: string;
    name: string;
    when?: string;
    description?: string;
  }): Promise<{ workflow: string; written: string[] }> {
    const run = this.current(this.requireSession(input.sessionId).id);
    if (!run) throw new DaedalusError("NOT_FOUND", "There is no run to save");
    if (!run.steps.length)
      throw new DaedalusError("VALIDATION", "The run has no steps to save");
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
    for (const step of run.steps) {
      const stepPath = join(steps, `${step.name}.md`);
      if (!step.dynamic || (await pathExists(stepPath))) continue;
      // A step named at start has no description; what the agent planned
      // in it this time is the best first draft of its instructions.
      const text = step.description || step.plan || "";
      await writeTextFile(
        stepPath,
        renderStepFile({
          name: step.name,
          description: text,
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
        steps: run.steps.map((step) => step.name),
        dynamic: false,
        loop: run.loopTo,
        until: run.until,
        body: "",
      }),
    );
    written.push(path);
    return { workflow: name, written };
  }

  private save(run: WorkflowRun, end = false): WorkflowRun {
    const now = this.now().toISOString();
    return this.repositories.workflows.save({
      ...run,
      updatedAt: now,
      endedAt: end ? now : run.endedAt,
    });
  }

  private unknownStep(run: WorkflowRun, name: string): DaedalusError {
    return new DaedalusError(
      "VALIDATION",
      `Workflow '${run.workflow}' has no step '${name}'. Steps: ${run.steps.map((step) => step.name).join(", ") || "none"}`,
    );
  }

  private requireOpen(session: AgentSession): WorkflowRun {
    const run = this.current(session.id);
    if (!run || run.endedAt)
      throw new DaedalusError(
        "NOT_FOUND",
        `This session has no open workflow run. Start one with: daedal workflow start <name>`,
      );
    return run;
  }

  private requireSession(sessionId: string): AgentSession {
    const session = this.repositories.findAgent(sessionId);
    if (!session)
      throw new DaedalusError("NOT_FOUND", `No agent session '${sessionId}'`);
    return session;
  }
}

/** ` at step 'review' (3 of 8)`, or nothing before the first step starts. */
export function describePosition(run: WorkflowRun): string {
  const index = currentStepIndex(run);
  if (index === -1) return "";
  return ` at step '${run.steps[index]!.name}' (${index + 1} of ${run.steps.length})`;
}

/**
 * The step a run is at: the one waiting or active, else the one after the
 * last finished step, else -1 before anything started.
 */
export function currentStepIndex(run: WorkflowRun): number {
  const live = run.steps.findIndex(isLive);
  if (live !== -1) return live;
  const last = run.steps.findLastIndex((step) => FINISHED.has(step.state));
  return last === -1 ? -1 : Math.min(last + 1, run.steps.length - 1);
}

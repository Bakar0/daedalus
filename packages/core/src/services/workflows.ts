import { join } from "node:path";
import { ensureDirectory, pathExists, writeTextFile } from "@daedalus/platform";
import {
  includedWorkflow,
  inStepGroup,
  stepBaseName,
  stepGroupId,
  type AgentSession,
  type WorkflowGate,
  type WorkflowRun,
  type WorkflowRunGroup,
  type WorkflowRunStep,
  type WorkflowStepDefinition,
  type WorkflowStepRecord,
  type WorkflowStepState,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { ActivityService } from "./activity";
import {
  deleteWorkflowFile,
  ensureWorkflowsFolder,
  expandWorkflow,
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

/** A step done by the agent and waiting for the user to approve its result. */
const awaitsResult = (step: WorkflowRunStep) =>
  step.state === "waiting" && step.gate === "result";

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
  /**
   * The last step of an included workflow with its own loop finished, and
   * that group went round again: the group, with its new iteration.
   */
  loopedGroup: WorkflowRunGroup | null;
}

const record = (
  step: WorkflowRunStep,
  iteration: number,
): WorkflowStepRecord => ({
  iteration,
  name: step.name,
  state: step.state,
  startedAt: step.startedAt,
  endedAt: step.endedAt,
  note: step.note,
});

/** How many workflows deep a group id is: `release` 1, `a/b` 2. */
const depth = (groupId: string) => groupId.split("/").length;

/** The positions of a group's steps in the run, in order. */
const groupMembers = (steps: WorkflowRunStep[], groupId: string): number[] =>
  steps.flatMap((step, index) =>
    inStepGroup(step.name, groupId) ? [index] : [],
  );

/**
 * Finds a step by its id, or by the end of it when that names one step
 * only: `review` for `release/review`. A step's full id always works.
 */
export function resolveStepIndex(run: WorkflowRun, name: string): number {
  const exact = run.steps.findIndex((step) => step.name === name);
  if (exact !== -1) return exact;
  const matches = run.steps.flatMap((step, index) =>
    step.name.endsWith(`/${name}`) ? [index] : [],
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1)
    throw new DaedalusError(
      "VALIDATION",
      `Step '${name}' is in more than one place in workflow '${run.workflow}': ${matches.map((index) => run.steps[index]!.name).join(", ")}. Name the one you mean in full.`,
    );
  throw new DaedalusError(
    "VALIDATION",
    `Workflow '${run.workflow}' has no step '${name}'. Steps: ${run.steps.map((step) => step.name).join(", ") || "none"}`,
  );
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
    steps: { name: string; gate: WorkflowGate | null; body: string }[];
  }> {
    const catalog = await this.catalog();
    return {
      // An included workflow's own notes follow the run's, each headed with
      // the group they apply to.
      notes: [
        catalog.workflows.find((item) => item.name === run.workflow)?.body ??
          "",
        ...run.groups.map((group) => {
          const body = catalog.workflows
            .find((item) => item.name === group.workflow)
            ?.body.trim();
          return body ? `In ${group.id}:\n${body}` : "";
        }),
      ]
        .filter((text) => text.trim())
        .join("\n\n"),
      steps: run.steps.map((step) => ({
        name: step.name,
        gate: step.gate,
        body:
          catalog.steps.find((item) => item.name === stepBaseName(step.name))
            ?.body ?? step.description,
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
    let groups: WorkflowRunGroup[] = [];
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
      if (workflow.dynamic) {
        steps = ownSteps(input.steps ?? []);
        loopTo = workflow.loop;
      } else {
        const expanded = this.fileSteps(catalog, workflow);
        steps = expanded.steps;
        groups = expanded.groups;
        loopTo = expanded.loopTo;
      }
      until = workflow.until;
    }
    const now = this.now().toISOString();
    return this.repositories.workflows.save({
      id: crypto.randomUUID(),
      workspaceId: session.workspaceId,
      sessionId: session.id,
      workflow: label,
      steps,
      groups,
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

  /**
   * A maintained workflow's steps, each from its file, with included
   * workflows expanded in place under qualified ids, and its groups.
   */
  private fileSteps(
    catalog: WorkflowCatalog,
    workflow: WorkflowCatalog["workflows"][number],
  ): {
    steps: WorkflowRunStep[];
    groups: WorkflowRunGroup[];
    loopTo: string | null;
  } {
    const expanded = expandWorkflow(workflow, catalog);
    return {
      steps: expanded.steps.map(({ id, step }) =>
        runStep({ ...step, name: id }, false),
      ),
      groups: expanded.groups.map((group) => ({
        id: group.id,
        workflow: group.workflow.name,
        loopTo: group.loopTo,
        until: group.workflow.until,
        iteration: 1,
        lastRound: null,
      })),
      loopTo: expanded.loopTo,
    };
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
    const base = workflowName(input.step, "step");
    // A step added after one inside an included workflow joins its group.
    const afterIndex =
      input.after === undefined ? -1 : resolveStepIndex(run, input.after);
    const group =
      afterIndex === -1 ? "" : stepGroupId(run.steps[afterIndex]!.name);
    const name = group ? `${group}/${base}` : base;
    if (run.steps.some((step) => step.name === name))
      throw new DaedalusError(
        "CONFLICT",
        `The run already has step '${name}'; start it again to go back to it`,
      );
    const file = (await this.catalog()).steps.find(
      (item) => item.name === base,
    );
    const description = input.description?.trim();
    const step = file
      ? runStep(
          {
            ...file,
            name,
            ...(description ? { description } : {}),
            gate: input.gate ? "result" : file.gate,
          },
          false,
        )
      : runStep(
          {
            name,
            description: description ?? "",
            gate: input.gate ? "result" : null,
          },
          true,
        );
    const steps = [...run.steps];
    if (afterIndex !== -1) steps.splice(afterIndex + 1, 0, step);
    else steps.push(step);
    return this.save({ ...run, steps, modified: !run.dynamic });
  }

  /** Takes a step that has not started out of the open run. */
  remove(input: { sessionId: string; step: string }): WorkflowRun {
    const run = this.requireOpen(this.requireSession(input.sessionId));
    const step = run.steps[resolveStepIndex(run, input.step)]!;
    if (step.state !== "pending")
      throw new DaedalusError(
        "CONFLICT",
        `Step '${step.name}' is ${step.state}; only a step not yet started can be removed. Skip it with a note instead.`,
      );
    const steps = run.steps.filter((item) => item !== step);
    const loopTo = run.loopTo === step.name ? null : run.loopTo;
    // A group left with no steps goes; one whose loop step went loses it.
    const groups = run.groups
      .filter((group) => groupMembers(steps, group.id).length > 0)
      .map((group) =>
        group.loopTo === step.name ? { ...group, loopTo: null } : group,
      );
    const finished =
      steps.length > 0 && steps.every((item) => FINISHED.has(item.state));
    return this.save(
      { ...run, steps, groups, modified: !run.dynamic, loopTo },
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
   * agent that forgets a `done` still shows where it is, except one whose
   * result the user has to approve. Starting a step that already ended goes
   * back to it. Gates wait for the user and raise attention: a `start` gate
   * when its step starts, a `result` gate when its step is done, until the
   * user approves what came out; no other step starts meanwhile. When every
   * step has finished, the run ends, or a circular one goes round again from
   * its loop step.
   */
  async step(input: {
    sessionId: string;
    step: string;
    action: WorkflowStepAction;
    note?: string;
  }): Promise<WorkflowStepOutcome> {
    const session = this.requireSession(input.sessionId);
    const open = this.requireOpen(session);
    const index = resolveStepIndex(open, input.step);
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
    // Moving past an included workflow that just went round, before any of
    // its new round started, leaves its loop: its last round comes back.
    const run = leaveGroupLoops(open, index);
    const now = this.now().toISOString();
    const steps = run.steps.map((step) => ({ ...step }));
    const target = steps[index]!;
    let waiting = false;
    if (input.action === "start") {
      for (const step of steps) {
        if (step === target) continue;
        if (awaitsResult(step))
          throw new DaedalusError(
            "CONFLICT",
            `Step '${step.name}' waits for the user to approve what came out. Wait for their answer, which comes in words (in a team, through your lead); to change it first, start '${step.name}' again.`,
          );
        if (
          step.state === "active" &&
          step.gate === "result" &&
          !step.approvedAt
        )
          throw new DaedalusError(
            "CONFLICT",
            `Step '${step.name}' needs the user's approval when it is done. Finish it with 'done' and a note saying what to approve.`,
          );
        if (step.state === "active") {
          step.state = "done";
          step.endedAt = now;
        }
      }
      // An approval covers one pass through the step; going back needs another.
      if (FINISHED.has(target.state) || awaitsResult(target))
        target.approvedAt = null;
      waiting = target.gate === "start" && !target.approvedAt;
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
          awaitsResult(target)
            ? `Step '${target.name}' already waits for the user to approve what came out`
            : `Step '${target.name}' waits for the user's approval to start`,
        );
      // A step whose result the user approves waits here, holding what to
      // approve as its note. Skipping it does not: nothing came out.
      waiting =
        input.action === "done" &&
        target.gate === "result" &&
        !target.approvedAt;
      target.state = waiting
        ? "waiting"
        : input.action === "done"
          ? "done"
          : "skipped";
      target.startedAt ??= now;
      target.endedAt = waiting ? null : now;
      target.waitingSessionId = waiting ? session.id : null;
      target.note = note;
    }
    // Leaving a step that was waiting, by going back into it, takes the
    // question away.
    if (!waiting && run.steps.some((step) => step.state === "waiting"))
      this.activity.clear(session.id);
    const {
      run: saved,
      looped,
      loopedGroup,
    } = this.settle(run, steps, input.action === "start" ? index : undefined);
    if (waiting)
      await this.activity.raise({
        sessionId: session.id,
        reason:
          target.gate === "start"
            ? `Approve starting step '${target.name}' of workflow '${run.workflow}': ${note}`
            : `Approve the result of step '${target.name}' of workflow '${run.workflow}': ${note}`,
      });
    return { run: saved, waiting, looped, loopedGroup };
  }

  /**
   * Saves the run's steps, and ends it when every step has finished, or
   * starts a circular run's next iteration from its loop step.
   */
  private settle(
    run: WorkflowRun,
    changed: WorkflowRunStep[],
    /** The step this change started, if it started one. */
    started?: number,
  ): {
    run: WorkflowRun;
    looped: boolean;
    loopedGroup: WorkflowRunGroup | null;
  } {
    let steps = changed;
    let history = run.history;
    let groups = run.groups;
    // A group's loop first, the deepest first: it goes round when this
    // change finished its last step, which keeps the run from finishing.
    let loopedGroup: WorkflowRunGroup | null = null;
    for (const group of [...groups].sort((a, b) => depth(b.id) - depth(a.id))) {
      if (!group.loopTo) continue;
      const members = groupMembers(steps, group.id);
      const done = (list: WorkflowRunStep[]) =>
        members.every((position) => FINISHED.has(list[position]!.state));
      const before = groupMembers(run.steps, group.id);
      const wasDone =
        before.length === members.length &&
        before.every((position) => FINISHED.has(run.steps[position]!.state));
      if (!members.length || !done(steps) || wasDone) continue;
      const from = steps.findIndex((step) => step.name === group.loopTo);
      const last = members[members.length - 1]!;
      if (from === -1) continue;
      // Starting a step after the group finished its last step on the way:
      // that is moving on, not another round.
      if (started !== undefined && started > last) continue;
      const round = steps.slice(from, last + 1);
      history = [
        ...history,
        ...round.map((step) => record(step, group.iteration)),
      ];
      steps = steps.map((step, position) =>
        position < from || position > last ? step : runStep(step, step.dynamic),
      );
      loopedGroup = {
        ...group,
        iteration: group.iteration + 1,
        lastRound: round,
      };
      const went = loopedGroup;
      groups = groups.map((item) =>
        item.id === went.id
          ? went
          : inStepGroup(`${item.id}/`, went.id) &&
              round.some((step) => inStepGroup(step.name, item.id))
            ? { ...item, iteration: 1, lastRound: null }
            : item,
      );
      break;
    }
    const finished = steps.every((step) => FINISHED.has(step.state));
    let iteration = run.iteration;
    const looped = finished && run.loopTo !== null;
    if (looped) {
      const from = steps.findIndex((step) => step.name === run.loopTo);
      history = [
        ...history,
        ...steps.slice(from).map((step) => record(step, iteration)),
      ];
      const reset = steps.slice(from);
      steps = steps.map((step, position) =>
        position < from ? step : runStep(step, step.dynamic),
      );
      // Groups inside the part that goes round start counting again.
      groups = groups.map((group) =>
        reset.some((step) => inStepGroup(step.name, group.id))
          ? { ...group, iteration: 1, lastRound: null }
          : group,
      );
      iteration += 1;
    }
    return {
      run: this.save(
        { ...run, steps, groups, iteration, history },
        finished && !looped,
      ),
      looped,
      loopedGroup,
    };
  }

  /**
   * The user's approval, which they give in the conversation and the agent
   * records: a `before` step starts, and a `user` step is done with what
   * came out. The session's attention clears.
   */
  approve(sessionId: string, step?: string): WorkflowRun {
    const session = this.requireSession(sessionId);
    const run = this.requireOpen(session);
    const target = run.steps.find((item) => item.state === "waiting");
    if (!target)
      throw new DaedalusError(
        "CONFLICT",
        `Workflow '${run.workflow}' is not waiting for an approval`,
      );
    // Naming the step checks the approval is for the one that waits.
    if (step !== undefined) {
      const named = run.steps[resolveStepIndex(run, step)]!;
      if (named !== target)
        throw new DaedalusError(
          "CONFLICT",
          `Step '${named.name}' is not waiting for an approval; '${target.name}' is`,
        );
    }
    const now = this.now().toISOString();
    const steps = run.steps.map((step) =>
      step !== target
        ? step
        : step.gate === "start"
          ? {
              ...step,
              state: "active" as const,
              approvedAt: now,
              waitingSessionId: null,
            }
          : {
              ...step,
              state: "done" as const,
              approvedAt: now,
              endedAt: now,
              waitingSessionId: null,
            },
    );
    this.activity.clear(session.id);
    return this.settle(run, steps).run;
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
      // A step inside an included workflow is carried by its `@name`.
      if (stepGroupId(step.name)) continue;
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
        steps: savedEntries(run),
        dynamic: false,
        loop: run.loopTo && savedLoop(run, run.loopTo),
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

/**
 * A run's `steps` as a workflow file lists them: its own steps by name, and
 * each top-level group once, as `@workflow`.
 */
function savedEntries(run: WorkflowRun): string[] {
  const entries: string[] = [];
  for (const step of run.steps) {
    const group = step.name.split("/")[0]!;
    const entry =
      group === step.name
        ? step.name
        : `@${run.groups.find((item) => item.id === group)?.workflow ?? group}`;
    if (!entries.includes(entry)) entries.push(entry);
  }
  return entries;
}

/** The entry a saved workflow loops to: a step, or the group it starts. */
function savedLoop(run: WorkflowRun, loopTo: string): string {
  const group = loopTo.split("/")[0]!;
  return group === loopTo
    ? loopTo
    : `@${run.groups.find((item) => item.id === group)?.workflow ?? group}`;
}

/**
 * Puts back the last round of each included workflow that just went round
 * and has not started its new one, when the step at `index` lies after it:
 * moving on is how a run leaves a group's loop.
 */
function leaveGroupLoops(run: WorkflowRun, index: number): WorkflowRun {
  let { steps, history, groups } = run;
  for (const group of run.groups) {
    if (!group.lastRound) continue;
    const members = groupMembers(steps, group.id);
    const last = members[members.length - 1];
    const roundNames = new Set(group.lastRound.map((step) => step.name));
    const untouched = steps.every(
      (step) =>
        !roundNames.has(step.name) ||
        (step.state === "pending" && step.startedAt === null),
    );
    if (last === undefined || index <= last || !untouched) continue;
    const round = new Map(group.lastRound.map((step) => [step.name, step]));
    steps = steps.map((step) => round.get(step.name) ?? step);
    // The records the loop wrote for that round go: it is current again.
    const remaining = [...history];
    for (const name of roundNames) {
      const at = remaining.findLastIndex(
        (item) => item.name === name && item.iteration === group.iteration - 1,
      );
      if (at !== -1) remaining.splice(at, 1);
    }
    history = remaining;
    groups = groups.map((item) =>
      item.id === group.id
        ? { ...item, iteration: item.iteration - 1, lastRound: null }
        : item,
    );
  }
  return steps === run.steps ? run : { ...run, steps, history, groups };
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

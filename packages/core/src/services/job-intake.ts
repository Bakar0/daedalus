import { isAbsolute, join } from "node:path";
import { pathExists, runCommand } from "@daedalus/platform";
import type { AgentSession } from "../domain";
import {
  isTerminalJob,
  jobBrief,
  jobChildren,
  type Job,
  type JobTree,
} from "../domain/jobs";
import { parsePlanFlow } from "../domain/plan-flow";
import {
  findPlanTask,
  planTasks,
  resolvePlanOwner,
  sessionPlanHandle,
} from "../domain/plans";
import { DaedalusError } from "../errors";
import type { JobDraft, JobPorts, JobService } from "./jobs";
import {
  planJobDrafts,
  planJobSource,
  planMarkOf,
  planTaskOfJob,
} from "./plan-jobs";
import type { PlanFile, PlanService } from "./plans";
import type { WorkflowCatalog } from "./workflow-files";
import { workflowName } from "./workflow-files";
import {
  dynamicJobDraft,
  workflowJobDraft,
  workflowOfJobSource,
} from "./workflow-jobs";

/** What the engine's ports are made from. */
export interface JobPortSources {
  spawn(input: {
    workspace: string;
    name: string;
    message: string;
    spawnedBy?: string;
    /** The id the engine recorded for the session before it exists. */
    id: string;
  }): Promise<AgentSession>;
  send(sessionId: string, text: string): Promise<unknown>;
  raise(sessionId: string, reason: string): Promise<unknown>;
  clear(sessionId: string): unknown;
  session(sessionId: string): AgentSession | undefined;
  archive(sessionId: string): Promise<unknown>;
  /** A workspace's folder, and the folders of its repositories. */
  places(
    workspaceId: string,
  ): Promise<{ path: string; repositories: string[] }>;
  plans: Pick<PlanService, "find" | "read" | "setState">;
  now(): Date;
}

/** The ref a commit output names: `team/api@a155b14` names `a155b14`. */
const commitRef = (value: string): string =>
  value.includes("@") ? value.slice(value.lastIndexOf("@") + 1) : value;

/**
 * Puts a job's state on its plan task's line. A task the user closed by
 * hand keeps their mark when the engine skips its job for it.
 */
async function markPlanTask(sources: JobPortSources, job: Job): Promise<void> {
  const task = planTaskOfJob(job.source);
  const mark = planMarkOf(job);
  if (!task || !mark) return;
  const file = await sources.plans.find(undefined, task.planPath);
  const { plan } = await sources.plans.read(file);
  const now = findPlanTask(plan, `^${task.taskId}`);
  if (now.state === mark) return;
  if (job.state === "skipped" && now.state === "done") return;
  const runner =
    // An agent started for the task is written on its line as its owner.
    job.state === "running" && job.runner.kind === "agent" && job.sessionId
      ? sources.session(job.sessionId)
      : undefined;
  await sources.plans.setState(
    file,
    `^${task.taskId}`,
    mark,
    runner && !now.owner ? sessionPlanHandle(runner) : undefined,
  );
}

/** The job engine's ports, over the app's own services. */
export function createJobPorts(sources: JobPortSources): JobPorts {
  return {
    spawn: async ({ workspaceId, job, brief, parentSessionId, sessionId }) =>
      (
        await sources.spawn({
          id: sessionId,
          workspace: workspaceId,
          name: job.title.slice(0, 80) || "Job",
          message: brief,
          ...(parentSessionId ? { spawnedBy: parentSessionId } : {}),
        })
      ).id,
    tell: async (sessionId, text) => {
      await sources.send(sessionId, text);
    },
    raise: async (sessionId, message) => {
      await sources.raise(sessionId, message);
    },
    clear: (sessionId) => {
      sources.clear(sessionId);
    },
    alive: (sessionId) => {
      const session = sources.session(sessionId);
      // A session the app starts again when it opens still has its agent:
      // its jobs must not fail in the seconds before it is back.
      return (
        !!session &&
        !session.archivedAt &&
        (session.status === "running" ||
          session.status === "starting" ||
          session.resumeOnStart)
      );
    },
    retire: async (sessionId) => {
      await sources.archive(sessionId);
    },
    verify: async (workspaceId, kind, value) => {
      const places = await sources.places(workspaceId);
      if (kind === "file")
        return (await pathExists(
          isAbsolute(value) ? value : join(places.path, value),
        ))
          ? null
          : "does not exist";
      for (const repository of places.repositories) {
        const found = await runCommand(
          "git",
          ["rev-parse", "--verify", "--quiet", `${commitRef(value)}^{commit}`],
          { cwd: repository },
        ).then(
          (result) => result.exitCode === 0,
          () => false,
        );
        if (found) return null;
      }
      return "is in none of the workspace's repositories";
    },
    changed: async (jobs) => {
      for (const job of jobs)
        // A plan that moved or lost the task keeps its marks as they are.
        await markPlanTask(sources, job).catch(() => undefined);
    },
    newId: () => crypto.randomUUID(),
    now: () => sources.now().toISOString(),
  };
}

/** What starting a workflow gives its session back. */
export interface StartedWorkflow {
  /** The job that stands for the workflow. */
  job: Job;
  tree: JobTree;
  /** The workflow file's own notes. */
  notes: string;
  /** The brief of the step the session is on now, when it is on one. */
  brief: string | null;
}

/**
 * Where jobs come from: a workflow file, steps named for one piece of work,
 * and a plan file. Each becomes jobs under the job its session is on.
 */
export class JobIntakeService {
  constructor(
    private readonly sources: {
      jobs: JobService;
      catalog(): Promise<WorkflowCatalog>;
      plans: Pick<PlanService, "read" | "pinTask">;
      session(sessionId: string): AgentSession | undefined;
      sessions(workspaceId: string): Promise<AgentSession[]>;
      leads(): ReadonlySet<string>;
      /** The user's switch for workflows. */
      enabled(): boolean;
    },
  ) {}

  private session(sessionId: string): AgentSession {
    const session = this.sources.session(sessionId);
    if (!session)
      throw new DaedalusError("NOT_FOUND", "There is no such session.");
    return session;
  }

  /**
   * The job a session adds work under: the one it is on, or a new root job
   * named after the session when it has none.
   */
  async standing(sessionId: string): Promise<Job> {
    const current = this.sources.jobs.current(sessionId);
    if (current) return current.job;
    const session = this.session(sessionId);
    return this.sources.jobs.open(session.workspaceId, sessionId, {
      name: "work",
      title: session.name,
    });
  }

  /** The workflow a session is in: the nearest one over the job it is on. */
  workflowOf(sessionId: string): { job: Job; tree: JobTree } | undefined {
    const current = this.sources.jobs.current(sessionId);
    if (!current) return undefined;
    const { tree } = current;
    for (
      let at: Job | undefined = current.job;
      at;
      at = at.parentId ? tree.jobs.get(at.parentId) : undefined
    )
      if (workflowOfJobSource(at.source)) return { job: at, tree };
    // Between two steps the session stands on the job the workflow is under.
    const under = jobChildren(tree, current.job.id).find(
      (job) =>
        workflowOfJobSource(job.source) &&
        (job.state === "running" || job.state === "held"),
    );
    return under ? { job: under, tree } : undefined;
  }

  /**
   * Starts a workflow for a session: a workflow file by name, or the steps
   * the agent names for this piece of work.
   */
  async startWorkflow(input: {
    sessionId: string;
    workflow?: string;
    steps?: string[];
    name?: string;
    loop?: string;
    until?: string;
    /** Skips the workflow the session is in and starts this one. */
    replace?: boolean;
    /** Starts it under the step the session is on, as part of that step. */
    inside?: boolean;
  }): Promise<StartedWorkflow> {
    if (!this.sources.enabled())
      throw new DaedalusError(
        "CONFLICT",
        "Workflows are off. Do the work without one; the user turns them on in Settings, under Sessions.",
      );
    const catalog = await this.sources.catalog();
    const file =
      input.workflow === undefined
        ? undefined
        : catalog.workflows.find((item) => item.name === input.workflow);
    if (input.workflow !== undefined && !file) {
      const problem = catalog.problems.find((item) =>
        item.path.endsWith(`/${input.workflow}.md`),
      );
      throw new DaedalusError(
        problem ? "VALIDATION" : "NOT_FOUND",
        problem
          ? `Workflow '${input.workflow}' cannot be read: ${problem.message}`
          : `There is no workflow '${input.workflow}'. There are: ${catalog.workflows.map((item) => item.name).join(", ") || "none"}. For work none of them fits, name your own steps with --steps.`,
      );
    }
    if (file && !file.dynamic && (input.steps || input.loop || input.until))
      throw new DaedalusError(
        "VALIDATION",
        `Workflow '${file.name}' has its own steps. Name your own with --steps and no workflow name instead.`,
      );
    const draft =
      file && !file.dynamic
        ? workflowJobDraft(file, catalog)
        : dynamicJobDraft(
            {
              label: file?.name ?? workflowName(input.name ?? "dynamic"),
              steps: input.steps ?? [],
              ...(input.loop ? { loop: input.loop } : {}),
              ...(input.until ? { until: input.until } : {}),
            },
            catalog,
          );
    const open = this.workflowOf(input.sessionId);
    if (open && !input.replace && !input.inside)
      throw new DaedalusError(
        "CONFLICT",
        `This session is in workflow '${open.job.title}'. Pass --replace to skip what is left of it and start '${draft.name}', or --inside to start '${draft.name}' as part of the step you are on.`,
        { jobId: open.job.id },
      );
    if (open && input.replace)
      await this.sources.jobs.skip(
        open.job.id,
        input.sessionId,
        `Replaced by '${draft.name}'.`,
      );
    const parent = await this.standing(input.sessionId);
    // A name is one job's among those beside it, and a session may run the
    // same workflow again.
    const beside = jobChildren(
      this.sources.jobs.tree(this.sources.jobs.rootOf(parent.id)).tree,
      parent.id,
    ).filter(
      (job) => job.name === draft.name || job.name.startsWith(`${draft.name}-`),
    ).length;
    const [job] = await this.sources.jobs.add(
      parent.id,
      [beside ? { ...draft, name: `${draft.name}-${beside + 1}` } : draft],
      input.sessionId,
    );
    if (!job)
      throw new DaedalusError("INTERNAL", "The workflow was not added.");
    const now = this.sources.jobs.current(input.sessionId);
    const { tree } = this.sources.jobs.tree(this.sources.jobs.rootOf(job.id));
    return {
      job: tree.jobs.get(job.id) ?? job,
      tree,
      notes: file?.body.trim() ?? "",
      brief:
        now && now.job.id !== parent.id ? jobBrief(now.tree, now.job.id) : null,
    };
  }

  /**
   * Starts a session already in a workflow, so the agent spends nothing
   * choosing one: the workflow is checked before the session exists, the
   * session is told in one line, and the workflow starts under its job.
   */
  async spawnWith(input: {
    workflow: string;
    message?: string;
    spawn: (message: string) => Promise<AgentSession>;
  }): Promise<{ session: AgentSession; started: StartedWorkflow }> {
    if (!this.sources.enabled())
      throw new DaedalusError(
        "CONFLICT",
        "Workflows are off. The user turns them on in Settings, under Sessions.",
      );
    const catalog = await this.sources.catalog();
    const file = catalog.workflows.find((item) => item.name === input.workflow);
    if (!file)
      throw new DaedalusError(
        "NOT_FOUND",
        `There is no workflow '${input.workflow}'. There are: ${catalog.workflows.map((item) => item.name).join(", ") || "none"}.`,
      );
    if (!file.dynamic) workflowJobDraft(file, catalog);
    const line = file.dynamic
      ? `Daedalus started workflow '${file.name}' for this session. It has no steps yet: name yours with \`daedal workflow start ${file.name} --steps <a,b,...> --replace\`.`
      : `Daedalus started workflow '${file.name}' for this session. Run \`daedal job next\` for your first step, and finish each step with \`daedal job done\`.`;
    const session = await input.spawn(
      [input.message?.trim(), line].filter(Boolean).join("\n\n"),
    );
    const started = await this.startWorkflow({
      sessionId: session.id,
      workflow: file.name,
    });
    return { session, started };
  }

  /**
   * Starts one task of a plan by hand, as the plan view's button does: a
   * piece of work of its own, with a new agent, whatever the flow says.
   */
  async startPlanTask(file: PlanFile, task: string): Promise<Job> {
    if (!file.workspaceId)
      throw new DaedalusError(
        "VALIDATION",
        "A Home plan's task starts in a workspace; start the agent there",
      );
    const id = await this.sources.plans.pinTask(file, task);
    const existing = this.planJob(file.workspaceId, file.absolutePath, id);
    if (existing && !isTerminalJob(existing))
      throw new DaedalusError(
        "CONFLICT",
        `"${existing.title}" is a job already, and it is ${existing.state}.`,
      );
    if (existing)
      return this.sources.jobs.redo(
        existing.id,
        null,
        "Started again from the plan.",
      );
    const { source, plan } = await this.sources.plans.read(file);
    const find = (drafts: JobDraft[]): JobDraft | undefined =>
      drafts
        .flatMap((draft) => [draft, ...(draft.children ?? [])])
        .find((draft) => draft.name === id) ??
      (drafts.some((draft) => draft.children?.length)
        ? find(drafts.flatMap((draft) => draft.children ?? []))
        : undefined);
    const draft = find(
      planJobDrafts({
        plan,
        flow: parsePlanFlow(source),
        planPath: file.absolutePath,
        // Started by hand, it gets a new agent whoever its line names.
        owner: () => null,
      }),
    );
    if (!draft) {
      const found = findPlanTask(plan, `^${id}`);
      throw new DaedalusError(
        "CONFLICT",
        found.owner
          ? `"${found.title}" has an owner, @${found.owner}. Take the owner off its line to start a new agent on it.`
          : `"${found.title}" is ${found.state}. Mark it [ ] in the plan first.`,
      );
    }
    return this.sources.jobs.plant(
      file.workspaceId,
      {
        ...draft,
        needs: [],
        runner: { kind: "agent" },
        auto: false,
        children: [],
      },
      null,
    );
  }

  /**
   * Adds a plan's tasks as jobs under the job a session is on. Every task
   * gets an id in the file first, so it is found after lines move. Adding
   * the plan again adds only the tasks that are no jobs yet.
   */
  async addPlan(input: { sessionId: string; file: PlanFile }): Promise<Job[]> {
    const { file } = input;
    const session = this.session(input.sessionId);
    if (!file.workspaceId || file.workspaceId !== session.workspaceId)
      throw new DaedalusError(
        "VALIDATION",
        "A plan's tasks are done in the plan's own workspace. Add it from a session there.",
      );
    for (;;) {
      const { plan } = await this.sources.plans.read(file);
      const bare = planTasks(plan).find(
        (task) => !task.id && task.state !== "draft",
      );
      if (!bare) break;
      await this.sources.plans.pinTask(file, bare.key);
    }
    const { source, plan } = await this.sources.plans.read(file);
    const flow = parsePlanFlow(source);
    if (flow.errors.length)
      throw new DaedalusError(
        "VALIDATION",
        `The plan's flow does not read: ${flow.errors.join("; ")}`,
      );
    const parent = await this.standing(input.sessionId);
    const known = new Set(
      [...this.sources.jobs.page(file.workspaceId).tree.jobs.values()].flatMap(
        (job) => {
          const task = planTaskOfJob(job.source);
          return task?.planPath === file.absolutePath ? [task.taskId] : [];
        },
      ),
    );
    const sessions = await this.sources.sessions(file.workspaceId);
    const drafts = planJobDrafts({
      plan,
      flow,
      planPath: file.absolutePath,
      owner: (handle) =>
        resolvePlanOwner(handle, sessions, this.sources.leads())?.id ?? null,
      known,
    });
    if (!drafts.length) return [];
    const added = await this.sources.jobs.add(
      parent.id,
      drafts,
      input.sessionId,
    );
    // A session started by hand for a task has a job from its first
    // message. The task is that work, so the first job closes and the
    // session shows once.
    const { tree } = this.sources.jobs.page(file.workspaceId);
    for (const task of tree.jobs.values()) {
      if (
        task.runner.kind !== "session" ||
        planTaskOfJob(task.source)?.planPath !== file.absolutePath
      )
        continue;
      const owner = task.runner.sessionId;
      for (const first of tree.jobs.values())
        if (
          first.sessionId === owner &&
          !first.source &&
          !isTerminalJob(first) &&
          (first.parentId === null || first.parentId === task.parentId) &&
          !jobChildren(tree, first.id).length
        )
          await this.sources.jobs.skip(
            first.id,
            input.sessionId,
            `It is the plan task "${task.title}" now.`,
          );
    }
    return added;
  }

  /** The job of a plan's task, when the plan was added. */
  planJob(
    workspaceId: string,
    planPath: string,
    taskId: string,
  ): Job | undefined {
    const source = planJobSource(planPath, taskId);
    return [...this.sources.jobs.page(workspaceId).tree.jobs.values()].find(
      (job) => job.source === source,
    );
  }
}

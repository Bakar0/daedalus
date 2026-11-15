import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ensureDirectory,
  pathExists,
  writeFileAtomic,
} from "@daedalus/platform";
import type { AgentActivity, AgentSession } from "../domain";
import {
  addPlanTaskQuestion,
  ensurePlanTaskId,
  findPlanTask,
  isPlanPath,
  parsePlan,
  PLAN_SUFFIX,
  planAskMessage,
  planOwnerState,
  planProgress,
  planQuestions,
  planSlug,
  planTaskBrief,
  planTaskDetails,
  planTasks,
  renderNewPlan,
  resolvePlanOwner,
  sessionPlanHandle,
  setPlanTaskOwner,
  setPlanTaskState,
  type PlanDocument,
  type PlanOwnerState,
  type PlanTaskState,
} from "../domain/plans";
import { DaedalusError } from "../errors";

/**
 * Where a plan lives: a workspace's `plans/` folder, or Home's, the
 * workspaces root, which the main agent will use. Home's owners may be
 * sessions in any workspace.
 */
export type PlanScope = { workspace: string } | { home: true };

export const PLANS_FOLDER = "plans";

/** What the plan service needs from the rest of the core. */
export interface PlanPorts {
  /** The folder holding every workspace: Home. */
  workspaceRoot: string;
  workspace(reference: string): Promise<{
    id: string;
    slug: string;
    name: string;
    path: string;
    defaultProvider: "claude" | "codex" | null;
  }>;
  /** Every workspace, to place an absolute path in one. */
  workspaces(): Promise<{ id: string; path: string }[]>;
  /** Sessions owners may name: one workspace's, or all for Home. */
  sessions(workspaceId: string | undefined): Promise<AgentSession[]>;
  activity(sessionId: string): AgentActivity | undefined;
  needsAttention(sessionId: string): boolean;
  spawn(input: {
    workspace: string;
    provider: string;
    name: string;
    message: string;
    spawnedBy?: string;
  }): Promise<AgentSession>;
  send(
    sessionId: string,
    text: string,
    from: AgentSession | undefined,
  ): Promise<AgentSession>;
}

/** A plan's file, where it is and what scope it belongs to. */
export interface PlanFile {
  scope: PlanScope;
  workspaceId: string | null;
  /** The folder its paths are relative to: the workspace, or Home. */
  root: string;
  /** Relative to `root`, with forward slashes. */
  path: string;
  absolutePath: string;
}

export interface PlanOwnerView {
  handle: string;
  sessionId: string | null;
  sessionName: string | null;
  state: PlanOwnerState;
}

export interface PlanSummary extends PlanFile {
  title: string;
  owner: string | null;
  done: number;
  total: number;
  questions: number;
}

export interface PlanOutline {
  title: string;
  owner: string | null;
  done: number;
  total: number;
  tasks: {
    key: string;
    title: string;
    state: PlanTaskState;
    owner: string | null;
    line: number;
  }[];
}

const slash = (path: string) => path.split(sep).join("/");

export class PlanService {
  constructor(private readonly ports: PlanPorts) {}

  /** The folder a scope's plans are in, and the folder they are relative to. */
  async root(
    scope: PlanScope,
  ): Promise<{ root: string; folder: string; workspaceId: string | null }> {
    if ("home" in scope)
      return {
        root: this.ports.workspaceRoot,
        folder: join(this.ports.workspaceRoot, PLANS_FOLDER),
        workspaceId: null,
      };
    const workspace = await this.ports.workspace(scope.workspace);
    return {
      root: workspace.path,
      folder: join(workspace.path, PLANS_FOLDER),
      workspaceId: workspace.id,
    };
  }

  private file(
    scope: PlanScope,
    root: string,
    workspaceId: string | null,
    absolutePath: string,
  ): PlanFile {
    return {
      scope,
      workspaceId,
      root,
      path: slash(relative(root, absolutePath)),
      absolutePath,
    };
  }

  async create(
    scope: PlanScope,
    input: { title: string; owner?: string | null; body?: string },
  ): Promise<PlanFile> {
    const { root, folder, workspaceId } = await this.root(scope);
    const absolutePath = join(folder, `${planSlug(input.title)}${PLAN_SUFFIX}`);
    if (await pathExists(absolutePath))
      throw new DaedalusError(
        "CONFLICT",
        `${slash(relative(root, absolutePath))} already exists; pick another title or open that plan`,
      );
    await ensureDirectory(folder);
    await writeFileAtomic(absolutePath, renderNewPlan(input));
    return this.file(scope, root, workspaceId, absolutePath);
  }

  async list(scope: PlanScope): Promise<PlanSummary[]> {
    const { root, folder, workspaceId } = await this.root(scope);
    const names = await readdir(folder).catch(() => [] as string[]);
    const out: PlanSummary[] = [];
    for (const name of names.filter(isPlanPath).sort()) {
      const absolutePath = join(folder, name);
      const plan = parsePlan(await readFile(absolutePath, "utf8"));
      out.push({
        ...this.file(scope, root, workspaceId, absolutePath),
        title: plan.title ?? name.slice(0, -PLAN_SUFFIX.length),
        owner: plan.owner,
        ...planProgress(plan),
        questions: planQuestions(plan).length,
      });
    }
    return out;
  }

  /**
   * A plan file's title, progress and tasks, for search: whatever folder it
   * is in, not only `plans/`.
   */
  async outline(absolutePath: string): Promise<PlanOutline> {
    const plan = parsePlan(await readFile(absolutePath, "utf8"));
    return {
      title: plan.title ?? basename(absolutePath).slice(0, -PLAN_SUFFIX.length),
      owner: plan.owner,
      ...planProgress(plan),
      tasks: planTasks(plan).map((task) => ({
        key: task.key,
        title: task.title,
        state: task.state,
        owner: task.owner,
        line: task.line,
      })),
    };
  }

  /**
   * A plan by slug (`cart-api-v2`), file name, path relative to the scope's
   * root, or absolute path. An absolute path belongs to the workspace that
   * holds it, else to Home.
   */
  async find(
    scope: PlanScope | undefined,
    reference: string,
  ): Promise<PlanFile> {
    const wanted = reference.trim();
    if (!wanted)
      throw new DaedalusError("VALIDATION", "Name a plan: its slug or path");
    if (isAbsolute(wanted)) {
      const absolutePath = resolve(wanted);
      if (!isPlanPath(absolutePath) || !(await pathExists(absolutePath)))
        throw new DaedalusError(
          "NOT_FOUND",
          `No plan at ${absolutePath}; a plan's file ends in ${PLAN_SUFFIX}`,
        );
      const owner = (await this.ports.workspaces())
        .filter((item) => absolutePath.startsWith(item.path + sep))
        .sort((a, b) => b.path.length - a.path.length)[0];
      const placed: PlanScope = owner
        ? { workspace: owner.id }
        : { home: true };
      return this.file(
        placed,
        owner?.path ?? this.ports.workspaceRoot,
        owner?.id ?? null,
        absolutePath,
      );
    }
    if (!scope)
      throw new DaedalusError(
        "VALIDATION",
        "Name the plan by its full path, or say which workspace it is in",
      );
    const { root, folder, workspaceId } = await this.root(scope);
    const name = isPlanPath(wanted) ? wanted : `${wanted}${PLAN_SUFFIX}`;
    for (const candidate of [join(root, name), join(folder, basename(name))]) {
      const absolutePath = resolve(candidate);
      if (!absolutePath.startsWith(root + sep)) continue;
      if (await pathExists(absolutePath))
        return this.file(scope, root, workspaceId, absolutePath);
    }
    throw new DaedalusError(
      "NOT_FOUND",
      `No plan '${wanted}' in ${slash(relative(this.ports.workspaceRoot, folder)) || PLANS_FOLDER}; 'daedal plan list' shows them`,
    );
  }

  async read(file: PlanFile): Promise<{ source: string; plan: PlanDocument }> {
    const source = await readFile(file.absolutePath, "utf8");
    return { source, plan: parsePlan(source) };
  }

  private async edit(
    file: PlanFile,
    change: (source: string) => string,
  ): Promise<PlanDocument> {
    const { source } = await this.read(file);
    const next = change(source);
    if (next !== source) await writeFileAtomic(file.absolutePath, next);
    return parsePlan(next);
  }

  /** Sets a task's state; `owner` also puts that handle on its line. */
  setState(
    file: PlanFile,
    task: string,
    state: PlanTaskState,
    owner?: string,
  ): Promise<PlanDocument> {
    return this.edit(file, (source) => {
      let next = setPlanTaskState(source, task, state);
      if (owner) next = setPlanTaskOwner(next, task, owner);
      return next;
    });
  }

  /** Adds a question for the user under a task. */
  ask(file: PlanFile, task: string, question: string): Promise<PlanDocument> {
    return this.edit(file, (source) =>
      addPlanTaskQuestion(source, task, question),
    );
  }

  /** Each owner the plan names, with the session it resolves to now. */
  async owners(file: PlanFile, plan: PlanDocument): Promise<PlanOwnerView[]> {
    const handles = new Set<string>();
    if (plan.owner) handles.add(plan.owner);
    for (const task of planTasks(plan)) if (task.owner) handles.add(task.owner);
    const sessions = await this.ports.sessions(file.workspaceId ?? undefined);
    return [...handles].map((handle) => {
      const session = resolvePlanOwner(handle, sessions);
      return {
        handle,
        sessionId: session?.id ?? null,
        sessionName: session?.name ?? null,
        state: planOwnerState(
          session,
          session ? this.ports.activity(session.id) : undefined,
          session ? this.ports.needsAttention(session.id) : false,
        ),
      };
    });
  }

  /**
   * Starts an agent on a task: in the plan's workspace, on the workspace's
   * default provider, else Claude. The task gets an id if it had none, `[/]`
   * and the new session's handle.
   */
  async startTask(
    file: PlanFile,
    task: string,
    options: { provider?: string; spawnedBy?: string } = {},
  ): Promise<{ session: AgentSession; plan: PlanDocument }> {
    if (!file.workspaceId)
      throw new DaedalusError(
        "VALIDATION",
        "A Home plan's task starts in a workspace; start the agent there",
      );
    const workspace = await this.ports.workspace(file.workspaceId);
    // The id goes in first, so the task is found by it whatever else
    // changes in the file while the session starts.
    let id = "";
    const plan = await this.edit(file, (source) => {
      const withId = ensurePlanTaskId(source, task);
      id = withId.id;
      return withId.source;
    });
    const target = findPlanTask(plan, `^${id}`);
    if (target.state === "done" || target.state === "dropped")
      throw new DaedalusError(
        "CONFLICT",
        `"${target.title}" is ${target.state}; reopen it in the plan first`,
      );
    const session = await this.ports.spawn({
      workspace: workspace.id,
      provider: options.provider ?? workspace.defaultProvider ?? "claude",
      name: target.title.replace(/[`*_~]/g, "").slice(0, 80) || "Plan task",
      message: planTaskBrief({
        planPath: file.absolutePath,
        planTitle: plan.title,
        task: target,
        details: planTaskDetails(target),
      }),
      ...(options.spawnedBy ? { spawnedBy: options.spawnedBy } : {}),
    });
    const next = await this.setState(
      file,
      `^${id}`,
      "doing",
      sessionPlanHandle(session),
    );
    return { session, plan: next };
  }

  /**
   * Sends the user's question about lines of the plan to whoever owns them:
   * `owner`, or the plan's owner when the part has none.
   */
  async askOwner(
    file: PlanFile,
    input: {
      owner: string | null;
      question: string;
      startLine: number;
      endLine: number;
      quote: string;
      from?: AgentSession;
    },
  ): Promise<{ session: AgentSession; message: string }> {
    const { plan } = await this.read(file);
    const handle = input.owner ?? plan.owner;
    if (!handle)
      throw new DaedalusError(
        "VALIDATION",
        "Nobody owns this part of the plan; give a task an @owner or the plan an owner",
      );
    if (!input.question.trim())
      throw new DaedalusError("VALIDATION", "Write a question first");
    const session = resolvePlanOwner(
      handle,
      await this.ports.sessions(file.workspaceId ?? undefined),
    );
    if (!session)
      throw new DaedalusError(
        "NOT_FOUND",
        `No session answers to @${handle}; start one or change the owner`,
      );
    const message = planAskMessage({
      question: input.question,
      path: file.absolutePath,
      startLine: input.startLine,
      endLine: input.endLine,
      quote: input.quote,
    });
    return {
      session: await this.ports.send(session.id, message, input.from),
      message,
    };
  }
}

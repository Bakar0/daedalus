import { Database } from "bun:sqlite";
import { readFile, rm } from "node:fs/promises";
import {
  parseGate,
  type WorkflowRun,
  type WorkflowRunGroup,
  type WorkflowRunStep,
  type WorkflowStepRecord,
} from "../domain";
import {
  emptyJobTree,
  jobChildren,
  settleJobs,
  type Job,
  type JobEvent,
  type JobSpec,
  type JobTree,
} from "../domain/jobs";
import { findPlanTask, parsePlan } from "../domain/plans";
import type { SqliteRepositories } from "../repositories/sqlite";
import { planJobSource } from "./plan-jobs";
import { workflowJobSource } from "./workflow-jobs";

/**
 * Turns what was recorded before the job engine into jobs: workflow runs,
 * and the links between plan tasks and the sessions started on them. It
 * runs once. The old tables are dropped in the same transaction that writes
 * the jobs, so either everything converted or nothing changed.
 */

export interface OldSession {
  id: string;
  workspaceId: string;
  name: string;
  startedAt: string;
  spawnedBy: string | null;
  /** Archived: the user put it away, and nobody works in it again. */
  over: boolean;
}

export interface OldLink {
  planPath: string;
  taskId: string;
  sessionId: string;
  createdAt: string;
}

export interface OldResult {
  planPath: string;
  taskId: string;
  sessionId: string | null;
  result: string;
  submittedAt: string;
}

/** One event of a converted tree, with when it happened and who did it. */
export interface ConvertedEvent {
  event: JobEvent;
  at: string;
  sessionId: string | null;
}

export interface ConvertedTree {
  workspaceId: string;
  rootId: string;
  events: ConvertedEvent[];
  /** The job each session was started for. */
  sessionJobs: Map<string, string>;
}

const BEFORE = "Finished before the job engine.";

/**
 * The trees the old records make. Each session gets one job to stand on:
 * the plan task it was started for when it had one, else a job named after
 * the session. It hangs under the step its starter was on. The session's
 * workflow runs are jobs under it, with a job per step.
 */
export function convertedJobs(input: {
  sessions: OldSession[];
  runs: WorkflowRun[];
  links: OldLink[];
  results: OldResult[];
  /** A plan task's title, when its file still reads. */
  taskTitle: (planPath: string, taskId: string) => string | null;
  newId: () => string;
}): ConvertedTree[] {
  const trees = new Map<string, ConvertedTree>();
  const rootOf = new Map<string, string>();
  /** Where work a session hands on hangs: its open step, else its own job. */
  const attach = new Map<string, string>();
  const names = new Map<string, Set<string>>();
  const sessions = new Map(input.sessions.map((item) => [item.id, item]));
  // A result belongs to the session that handed it in. A task started again
  // in another session is still open there, whatever the earlier one said.
  const result = (link: OldLink) =>
    input.results.find(
      (item) =>
        item.planPath === link.planPath &&
        item.taskId === link.taskId &&
        item.sessionId === link.sessionId,
    );

  const unique = (parentId: string, wanted: string): string => {
    const used = names.get(parentId) ?? new Set<string>();
    names.set(parentId, used);
    let name = wanted;
    for (let n = 2; used.has(name); n += 1) name = `${wanted}-${n}`;
    used.add(name);
    return name;
  };
  const positions = new Map<string, number>();
  const spec = (
    parentId: string | null,
    fields: Pick<JobSpec, "name" | "title"> & Partial<JobSpec>,
  ): JobSpec => {
    const id = input.newId();
    const position = parentId ? (positions.get(parentId) ?? 0) : 0;
    if (parentId) positions.set(parentId, position + 1);
    return {
      id,
      parentId,
      instructions: "",
      needs: [],
      gives: [],
      gate: null,
      runner: { kind: "inline" },
      auto: false,
      loop: null,
      source: null,
      position,
      ...fields,
      name: parentId ? unique(parentId, fields.name) : fields.name,
    };
  };

  /** Adds a job, to its parent's tree or as the root of a new one. */
  const add = (
    workspaceId: string,
    job: JobSpec,
    at: string,
    sessionId: string | null,
  ): ConvertedTree => {
    const rootId = job.parentId ? (rootOf.get(job.parentId) ?? job.id) : job.id;
    rootOf.set(job.id, rootId);
    const tree: ConvertedTree = trees.get(rootId) ?? {
      workspaceId,
      rootId,
      events: [],
      sessionJobs: new Map(),
    };
    trees.set(rootId, tree);
    tree.events.push({
      event: { jobId: job.id, type: "added", spec: job },
      at,
      sessionId,
    });
    return tree;
  };

  const convertRun = (
    tree: ConvertedTree,
    topId: string,
    run: WorkflowRun,
    sessionId: string,
  ): void => {
    const push = (event: JobEvent, at: string | null) =>
      tree.events.push({ event, at: at ?? run.updatedAt, sessionId });
    const container = spec(topId, {
      name: run.workflow,
      title: run.workflow,
      auto: !run.loopTo,
      loop: run.loopTo
        ? { to: run.loopTo.split("/")[0]!, until: run.until || null }
        : null,
      source: workflowJobSource(run.workflow),
    });
    add(tree.workspaceId, container, run.startedAt, sessionId);
    push({ jobId: container.id, type: "started", sessionId }, run.startedAt);
    // An included workflow is a job among the steps, by its group id.
    const groups = new Map<string, string>([["", container.id]]);
    const last = new Map<string, string>();
    const groupJob = (groupId: string): string => {
      const found = groups.get(groupId);
      if (found) return found;
      const slash = groupId.lastIndexOf("/");
      const parent = groupJob(slash === -1 ? "" : groupId.slice(0, slash));
      const group = run.groups.find((item) => item.id === groupId);
      const name = groupId.slice(slash + 1);
      const job = spec(parent, {
        name,
        title: group?.workflow ?? name,
        needs: last.has(parent) ? [last.get(parent)!] : [],
        auto: !group?.loopTo,
        loop: group?.loopTo
          ? {
              to: group.loopTo.slice(groupId.length + 1).split("/")[0]!,
              until: group.until || null,
            }
          : null,
        source: workflowJobSource(group?.workflow ?? name),
      });
      last.set(parent, job.name);
      add(tree.workspaceId, job, run.startedAt, sessionId);
      groups.set(groupId, job.id);
      return job.id;
    };
    const started = new Set<string>();
    const markStarted = (groupId: string, at: string | null) => {
      for (let id = groupId; id; id = id.slice(0, id.lastIndexOf("/"))) {
        if (started.has(id)) break;
        started.add(id);
        push({ jobId: groupJob(id), type: "started", sessionId }, at);
        if (!id.includes("/")) break;
      }
    };
    for (const step of run.steps) {
      const slash = step.name.lastIndexOf("/");
      const groupId = slash === -1 ? "" : step.name.slice(0, slash);
      const parent = groupJob(groupId);
      const job = spec(parent, {
        name: step.name.slice(slash + 1),
        title: step.name.slice(slash + 1),
        instructions: step.description,
        needs: last.has(parent) ? [last.get(parent)!] : [],
        gate: step.gate,
        source: `step:${run.workflow}/${step.name}`,
      });
      last.set(parent, job.name);
      add(tree.workspaceId, job, run.startedAt, sessionId);
      const said = step.note ?? step.plan;
      const finish = (
        state: string,
        note: string | null,
        startedAt: string | null,
        endedAt: string | null,
        approvedAt: string | null,
      ) => {
        if (state === "skipped") {
          push(
            { jobId: job.id, type: "skipped", why: note ?? "Skipped." },
            endedAt,
          );
          return;
        }
        if (groupId) markStarted(groupId, startedAt ?? endedAt);
        push(
          { jobId: job.id, type: "started", sessionId },
          startedAt ?? endedAt,
        );
        if (step.gate === "result") {
          push(
            {
              jobId: job.id,
              type: "held",
              reason: "result-gate",
              why: null,
              result: note ?? "Done.",
            },
            endedAt,
          );
          push(
            { jobId: job.id, type: "released", answer: null },
            approvedAt ?? endedAt,
          );
        } else
          push(
            { jobId: job.id, type: "done", result: note ?? "Done." },
            endedAt,
          );
      };
      // Each earlier time round a loop is a round of the job.
      for (const record of run.history.filter(
        (item: WorkflowStepRecord) => item.name === step.name,
      )) {
        if (record.state === "done" || record.state === "skipped")
          finish(
            record.state,
            record.note,
            record.startedAt,
            record.endedAt,
            null,
          );
        push(
          { jobId: job.id, type: "reopened", why: "next round" },
          record.endedAt ?? record.startedAt,
        );
      }
      if (step.state === "done" || step.state === "skipped")
        finish(step.state, said, step.startedAt, step.endedAt, step.approvedAt);
      else if (run.endedAt)
        push(
          {
            jobId: job.id,
            type: "skipped",
            why: run.endNote ?? "The run was ended.",
          },
          run.endedAt,
        );
      else if (step.state === "active" || step.state === "waiting") {
        attach.set(sessionId, job.id);
        if (step.state === "waiting" && step.gate === "start") {
          push(
            {
              jobId: job.id,
              type: "held",
              reason: "start-gate",
              why: null,
            },
            step.startedAt,
          );
          continue;
        }
        if (groupId) markStarted(groupId, step.startedAt);
        push({ jobId: job.id, type: "started", sessionId }, step.startedAt);
        if (step.state === "waiting")
          push(
            {
              jobId: job.id,
              type: "held",
              reason: "result-gate",
              why: null,
              result: said ?? "",
            },
            step.startedAt,
          );
      }
    }
    if (!run.endedAt) return;
    for (const [groupId, jobId] of groups) {
      if (!groupId) continue;
      const steps = run.steps.filter((step) =>
        step.name.startsWith(`${groupId}/`),
      );
      const finished = steps.every(
        (step) => step.state === "done" || step.state === "skipped",
      );
      push(
        finished && started.has(groupId)
          ? { jobId, type: "done", result: "Done." }
          : {
              jobId,
              type: "skipped",
              why: run.endNote ?? "The run was ended.",
            },
        run.endedAt,
      );
    }
    const finished = run.steps.every(
      (step) => step.state === "done" || step.state === "skipped",
    );
    const lastDone = [...run.steps]
      .reverse()
      .find((step) => step.state === "done");
    push(
      finished || !run.endNote
        ? {
            jobId: container.id,
            type: "done",
            result: lastDone?.note ?? run.endNote ?? "Done.",
          }
        : { jobId: container.id, type: "skipped", why: run.endNote },
      run.endedAt,
    );
  };

  const owners = [
    ...new Set([
      ...input.runs.flatMap((run) => (run.sessionId ? [run.sessionId] : [])),
      ...input.links.map((link) => link.sessionId),
    ]),
  ].sort((a, b) =>
    (sessions.get(a)?.startedAt ?? "9").localeCompare(
      sessions.get(b)?.startedAt ?? "9",
    ),
  );
  for (const sessionId of owners) {
    const session = sessions.get(sessionId);
    // Runs keep a workspace of their own; a session that is gone has none.
    const runs = input.runs
      .filter((run) => run.sessionId === sessionId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const links = input.links
      .filter((link) => link.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const workspaceId = session?.workspaceId ?? runs[0]?.workspaceId;
    if (!workspaceId) continue;
    const [link, ...more] = links;
    const startedAt = [session?.startedAt, runs[0]?.startedAt, link?.createdAt]
      .flatMap((time) => (time ? [time] : []))
      .sort()[0]!;
    const above = session?.spawnedBy ? attach.get(session.spawnedBy) : null;
    const parentId =
      above && sessions.get(session!.spawnedBy!)?.workspaceId === workspaceId
        ? above
        : null;
    const top = spec(parentId, {
      name: link?.taskId ?? "work",
      title:
        (link && input.taskTitle(link.planPath, link.taskId)) ??
        link?.taskId ??
        session?.name ??
        runs[0]?.workflow ??
        "Work",
      runner: { kind: "session", sessionId },
      source: link ? planJobSource(link.planPath, link.taskId) : null,
    });
    const tree = add(workspaceId, top, startedAt, sessionId);
    tree.sessionJobs.set(sessionId, top.id);
    tree.events.push({
      event: { jobId: top.id, type: "started", sessionId },
      at: startedAt,
      sessionId,
    });
    attach.set(sessionId, top.id);
    for (const other of more) {
      const job = spec(top.id, {
        name: other.taskId,
        title: input.taskTitle(other.planPath, other.taskId) ?? other.taskId,
        source: planJobSource(other.planPath, other.taskId),
      });
      add(workspaceId, job, other.createdAt, sessionId);
      tree.events.push({
        event: { jobId: job.id, type: "started", sessionId },
        at: other.createdAt,
        sessionId,
      });
      const handed = result(other);
      if (!handed) continue;
      tree.events.push({
        event: { jobId: job.id, type: "done", result: handed.result },
        at: handed.submittedAt,
        sessionId,
      });
    }
    for (const run of runs) convertRun(tree, top.id, run, sessionId);
    const handed = link ? result(link) : undefined;
    const lastAt =
      [...runs.map((run) => run.endedAt ?? run.updatedAt), startedAt]
        .sort()
        .at(-1) ?? startedAt;
    if (handed)
      tree.events.push({
        event: { jobId: top.id, type: "done", result: handed.result },
        at: handed.submittedAt,
        sessionId,
      });
    else if (!session || session.over)
      tree.events.push({
        event: runs.some((run) => !run.endedAt)
          ? { jobId: top.id, type: "failed", why: "Its agent is gone." }
          : { jobId: top.id, type: "done", result: BEFORE },
        at: lastAt,
        sessionId: null,
      });
  }
  // A run whose session was deleted stands alone and is over. A result with
  // no session's link has no workspace to go to: it stays in the backup.
  for (const run of input.runs.filter((item) => !item.sessionId)) {
    const top = spec(null, {
      name: "work",
      title: run.workflow,
      runner: { kind: "session", sessionId: run.id },
    });
    const tree = add(run.workspaceId, top, run.startedAt, null);
    tree.events.push({
      event: { jobId: top.id, type: "started", sessionId: run.id },
      at: run.startedAt,
      sessionId: null,
    });
    convertRun(
      tree,
      top.id,
      { ...run, endedAt: run.endedAt ?? run.updatedAt },
      run.id,
    );
    tree.events.push({
      event: { jobId: top.id, type: "done", result: BEFORE },
      at: run.endedAt ?? run.updatedAt,
      sessionId: null,
    });
  }
  // Jobs are added first, in the order they were made, so each one's
  // parent is there before it. Everything else follows by its time.
  for (const tree of trees.values()) {
    const added = tree.events.filter((item) => item.event.type === "added");
    const rest = tree.events
      .filter((item) => item.event.type !== "added")
      .map((item, index) => ({ item, index }))
      .sort((a, b) => a.item.at.localeCompare(b.item.at) || a.index - b.index)
      .map(({ item }) => item);
    // Events of one job stay in the order they were written: a time that
    // was never recorded must not put a job's end before its start.
    const perJob = new Map<string, ConvertedEvent[]>();
    for (const item of tree.events.filter(
      (entry) => entry.event.type !== "added",
    ))
      perJob.set(item.event.jobId, [
        ...(perJob.get(item.event.jobId) ?? []),
        item,
      ]);
    const ordered = rest.map((item) => perJob.get(item.event.jobId)!.shift()!);
    tree.events = [...added, ...ordered];
  }
  return [...trees.values()];
}

interface RunRow {
  id: string;
  workspace_id: string;
  session_id: string | null;
  workflow: string;
  steps: string;
  groups: string | null;
  dynamic: number;
  modified: number;
  loop_to: string | null;
  until_text: string;
  iteration: number;
  history: string;
  end_note: string | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
}

const OLD_TABLES = [
  "workflow_runs",
  "plan_task_links",
  "plan_task_results",
  "plan_task_claims",
];

const hasTable = (database: Database, name: string): boolean =>
  !!database
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);

/** What the old tables hold, read with the names they were written under. */
function readOld(database: Database): {
  sessions: OldSession[];
  runs: WorkflowRun[];
  links: OldLink[];
  results: OldResult[];
} {
  const all = <T>(table: string, sql: string): T[] =>
    hasTable(database, table) ? (database.query(sql).all() as T[]) : [];
  return {
    sessions: (
      database
        .query(
          "SELECT id, workspace_id, name, started_at, spawned_by, archived_at FROM agent_sessions",
        )
        .all() as {
        id: string;
        workspace_id: string;
        name: string;
        started_at: string;
        spawned_by: string | null;
        archived_at: string | null;
      }[]
    ).map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      startedAt: row.started_at,
      spawnedBy: row.spawned_by,
      // Every session from before was started by the user. Stopped or lost,
      // it keeps its work until the user archives it.
      over: !!row.archived_at,
    })),
    runs: all<RunRow>("workflow_runs", "SELECT * FROM workflow_runs").map(
      (row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        sessionId: row.session_id,
        workflow: row.workflow,
        // Steps stored before a step had a plan read as having none, and
        // the first gate names (`before`, `user`) read as `start` and
        // `result`.
        steps: (JSON.parse(row.steps) as WorkflowRunStep[]).map((step) => ({
          ...step,
          plan: step.plan ?? null,
          gate: parseGate(step.gate) ?? null,
        })),
        // Runs stored before a workflow could include another have none.
        groups: JSON.parse(row.groups ?? "[]") as WorkflowRunGroup[],
        dynamic: row.dynamic === 1,
        modified: row.modified === 1,
        loopTo: row.loop_to,
        until: row.until_text,
        iteration: row.iteration,
        history: JSON.parse(row.history) as WorkflowStepRecord[],
        endNote: row.end_note,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        endedAt: row.ended_at,
      }),
    ),
    links: all<{
      plan_path: string;
      task_id: string;
      session_id: string;
      created_at: string;
    }>("plan_task_links", "SELECT * FROM plan_task_links").map((row) => ({
      planPath: row.plan_path,
      taskId: row.task_id,
      sessionId: row.session_id,
      createdAt: row.created_at,
    })),
    results: all<{
      plan_path: string;
      task_id: string;
      session_id: string | null;
      result: string;
      submitted_at: string;
    }>("plan_task_results", "SELECT * FROM plan_task_results").map((row) => ({
      planPath: row.plan_path,
      taskId: row.task_id,
      sessionId: row.session_id,
      result: row.result,
      submittedAt: row.submitted_at,
    })),
  };
}

/**
 * What closes the jobs left open under a failed one. An agent that is gone
 * fails its own job; the workflow and the step it was in would otherwise
 * read as running for good.
 */
export function abandonedJobEvents(tree: JobTree): JobEvent[] {
  const events: JobEvent[] = [];
  const under = (job: Job, why: string): void => {
    for (const child of jobChildren(tree, job.id)) {
      if (child.state === "running" || child.state === "held")
        events.push({ jobId: child.id, type: "failed", why });
      else if (child.state === "pending" || child.state === "ready")
        events.push({ jobId: child.id, type: "skipped", why });
      under(child, why);
    }
  };
  for (const job of tree.jobs.values()) {
    const parent = job.parentId ? tree.jobs.get(job.parentId) : undefined;
    // Start at the topmost failed job, so nothing is closed twice.
    if (job.state === "failed" && parent?.state !== "failed")
      under(job, job.why ?? "The job above it failed.");
  }
  return events;
}

export interface JobConversion {
  /** False when there was nothing from before the engine. */
  ran: boolean;
  trees: number;
  /** The copy of the database made before anything changed. */
  backup: string | null;
  /** Why nothing was converted. The old tables are as they were. */
  error: string | null;
}

/**
 * Converts the old records once, after a copy of the database is put beside
 * it. One transaction writes every job and drops the old tables, so a row
 * that does not convert leaves everything as it was.
 */
export async function convertOldWork(
  repositories: SqliteRepositories,
  databasePath: string,
  now: () => Date = () => new Date(),
): Promise<JobConversion> {
  const { database } = repositories;
  if (!OLD_TABLES.some((table) => hasTable(database, table)))
    return { ran: false, trees: 0, backup: null, error: null };
  let backup: string | null = null;
  try {
    const old = readOld(database);
    const titles = new Map<string, string | null>();
    for (const link of old.links) {
      const key = `${link.planPath}#${link.taskId}`;
      titles.set(
        key,
        await readFile(link.planPath, "utf8").then(
          (source) => {
            try {
              return findPlanTask(parsePlan(source), `^${link.taskId}`).title;
            } catch {
              return null;
            }
          },
          () => null,
        ),
      );
    }
    const trees = convertedJobs({
      ...old,
      taskTitle: (planPath, taskId) =>
        titles.get(`${planPath}#${taskId}`) ?? null,
      newId: () => crypto.randomUUID(),
    });
    // The copy is made whenever a row from before is about to go, converted
    // into a job or not.
    if (trees.length || old.links.length || old.results.length) {
      backup = `${databasePath}.before-jobs-${now().toISOString().slice(0, 10)}`;
      for (let n = 2; await Bun.file(backup).exists(); n += 1)
        backup = `${databasePath}.before-jobs-${now().toISOString().slice(0, 10)}-${n}`;
      database.query("VACUUM INTO ?").run(backup);
    }
    repositories.immediateTransaction(() => {
      // Another process converted while this one read: nothing is left.
      if (!OLD_TABLES.some((table) => hasTable(database, table))) return;
      for (const converted of trees) {
        const tree = emptyJobTree();
        for (const item of converted.events)
          repositories.jobs.append(converted.workspaceId, tree, [item.event], {
            sessionId: item.sessionId,
            at: item.at,
          });
        const left = abandonedJobEvents(tree);
        if (left.length)
          repositories.jobs.append(converted.workspaceId, tree, left, {
            sessionId: null,
            at: now().toISOString(),
          });
        // What the engine's rules say follows: the step after a finished
        // one starts, a workflow whose steps are done is done.
        const follows = settleJobs(tree);
        if (follows.length)
          repositories.jobs.append(converted.workspaceId, tree, follows, {
            sessionId: null,
            at: now().toISOString(),
          });
        for (const [sessionId, jobId] of converted.sessionJobs)
          repositories.jobs.setJobOfSession(sessionId, jobId);
      }
      for (const table of OLD_TABLES)
        database.exec(`DROP TABLE IF EXISTS ${table}`);
    });
    return { ran: true, trees: trees.length, backup, error: null };
  } catch (error) {
    // Nothing changed, so the copy is of no use, and every start would
    // otherwise leave another one.
    if (backup) await rm(backup, { force: true });
    backup = null;
    return {
      ran: true,
      trees: 0,
      backup,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

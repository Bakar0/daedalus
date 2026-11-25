import type {
  WorkflowRun,
  WorkflowRunGroup,
  WorkflowRunStep,
  WorkflowStepState,
} from "../domain";
import {
  isContainerJob,
  jobChildren,
  type Job,
  type JobState,
  type JobTree,
} from "../domain/jobs";
import type { JobRecord, StoredJobTree } from "../repositories/jobs";
import { workflowOfJobSource } from "./workflow-jobs";

const STEP_STATE: Record<JobState, WorkflowStepState> = {
  pending: "pending",
  ready: "pending",
  running: "active",
  held: "waiting",
  done: "done",
  failed: "skipped",
  skipped: "skipped",
};

/**
 * A workflow job as the run the Workflow pane draws: its steps in order,
 * an included workflow's steps under ids qualified by it.
 */
export function workflowRunOfJob(
  tree: JobTree,
  records: ReadonlyMap<string, JobRecord>,
  job: Job,
): WorkflowRun {
  const steps: WorkflowRunStep[] = [];
  const groups: WorkflowRunGroup[] = [];
  const walk = (parent: Job, prefix: string) => {
    for (const child of jobChildren(tree, parent.id)) {
      const id = prefix ? `${prefix}/${child.name}` : child.name;
      if (isContainerJob(child) && workflowOfJobSource(child.source)) {
        groups.push({
          id,
          workflow: workflowOfJobSource(child.source) ?? child.name,
          loopTo: child.loop ? `${id}/${child.loop.to}` : null,
          until: child.loop?.until ?? "",
          iteration: Math.max(
            1,
            ...jobChildren(tree, child.id).map((item) => item.round),
          ),
          lastRound: null,
        });
        walk(child, id);
        continue;
      }
      const record = records.get(child.id);
      steps.push({
        name: id,
        description: child.instructions,
        gate: child.gate,
        state: STEP_STATE[child.state],
        startedAt: record?.startedAt ?? null,
        endedAt: record?.endedAt ?? null,
        approvedAt:
          child.state === "done" && child.approved.result
            ? (record?.endedAt ?? null)
            : null,
        waitingSessionId: child.state === "held" ? child.sessionId : null,
        plan: null,
        note: child.hold?.why ?? child.result ?? child.why,
        dynamic: !child.instructions.trim(),
      });
    }
  };
  walk(job, "");
  const record = records.get(job.id);
  const times = [...records.entries()]
    .filter(([id]) => {
      for (
        let at = tree.jobs.get(id);
        at;
        at = at.parentId ? tree.jobs.get(at.parentId) : undefined
      )
        if (at.id === job.id) return true;
      return false;
    })
    .map(([, item]) => item.updatedAt)
    .sort();
  return {
    id: job.id,
    workspaceId: record?.workspaceId ?? "",
    sessionId: job.sessionId,
    workflow: workflowOfJobSource(job.source) ?? job.title,
    steps,
    groups,
    dynamic: steps.every((step) => step.dynamic),
    modified: false,
    loopTo: job.loop?.to ?? null,
    until: job.loop?.until ?? "",
    iteration: Math.max(
      1,
      ...jobChildren(tree, job.id).map((item) => item.round),
    ),
    history: [],
    endNote: job.state === "skipped" || job.state === "failed" ? job.why : null,
    startedAt: record?.startedAt ?? record?.createdAt ?? "",
    updatedAt: times.at(-1) ?? record?.updatedAt ?? "",
    endedAt: record?.endedAt ?? null,
  };
}

/**
 * Each session's newest workflow, as a run. A workflow started inside a
 * step of another belongs to that one and is no run of its own.
 */
export function workflowRunsOfJobs(stored: StoredJobTree): WorkflowRun[] {
  const { tree, records } = stored;
  const newest = new Map<string, Job>();
  for (const job of tree.jobs.values()) {
    if (!job.sessionId || !workflowOfJobSource(job.source)) continue;
    let inside = false;
    for (
      let at = job.parentId ? tree.jobs.get(job.parentId) : undefined;
      at;
      at = at.parentId ? tree.jobs.get(at.parentId) : undefined
    )
      if (workflowOfJobSource(at.source) && at.sessionId === job.sessionId)
        inside = true;
    if (inside) continue;
    const known = newest.get(job.sessionId);
    const made = (item: Job) => records.get(item.id)?.createdAt ?? "";
    if (
      !known ||
      made(job) > made(known) ||
      (made(job) === made(known) && job.position > known.position)
    )
      newest.set(job.sessionId, job);
  }
  return [...newest.values()].map((job) =>
    workflowRunOfJob(tree, records, job),
  );
}

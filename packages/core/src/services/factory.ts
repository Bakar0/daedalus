import type { AgentActivity, AgentSession } from "../domain";
import {
  buildFactoryRows,
  type FactoryAgentRow,
  type FactoryLevel,
} from "../domain/factory";
import type { StoredJobTree } from "../repositories/jobs";
import { planTaskOfJob } from "./plan-jobs";

/** What the factory page reads. */
export interface FactoryPorts {
  /** Every job of a workspace. */
  jobs(workspaceId: string): StoredJobTree;
  /** A workspace's sessions, archived ones too. */
  sessions(workspaceId: string): Promise<AgentSession[]>;
  activity(sessionId: string): AgentActivity | undefined;
  needsAttention(sessionId: string): boolean;
  /** The task ids of the open threads pinned to a plan's tasks. */
  threadTasks(planPath: string): string[];
}

export interface FactoryPage {
  /**
   * Every piece of work of the workspace that is not over: a root job, with
   * the jobs under it. The newest first, so a row keeps its place while its
   * state changes.
   */
  agents: FactoryAgentRow[];
  /** Kept for the page's shape. Every plan's tasks are jobs under a row. */
  plans: never[];
  /** Sessions working on some block now. */
  working: number;
  /** Blocks waiting for the user. */
  waiting: number;
  /** Rows whose work is done, or with every block under them closed. */
  finished: number;
}

const workingSessions = (level: FactoryLevel, into: Set<string>): void => {
  if (level.owner?.sessionId && level.owner.state === "working")
    into.add(level.owner.sessionId);
  for (const block of level.blocks) {
    if (block.owner?.sessionId && block.owner.state === "working")
      into.add(block.owner.sessionId);
    if (block.inside) workingSessions(block.inside, into);
  }
};

export class FactoryService {
  constructor(private readonly ports: FactoryPorts) {}

  async page(workspace: string): Promise<FactoryPage> {
    const { tree, records } = this.ports.jobs(workspace);
    const sessions = await this.ports.sessions(workspace);
    const pinned = new Map<string, string[]>();
    const agents = buildFactoryRows({
      tree,
      times: (jobId) => {
        const record = records.get(jobId);
        return {
          createdAt: record?.createdAt ?? "",
          startedAt: record?.startedAt ?? null,
        };
      },
      sessions: sessions.map((session) => ({
        id: session.id,
        name: session.name,
        teamHandle: session.teamHandle,
        status: session.status,
        archivedAt: session.archivedAt,
        startedAt: session.startedAt,
        activity: this.ports.activity(session.id),
        needsAttention: this.ports.needsAttention(session.id),
      })),
      threads: (job) => {
        const task = planTaskOfJob(job.source);
        if (!task) return 0;
        const tasks =
          pinned.get(task.planPath) ?? this.ports.threadTasks(task.planPath);
        pinned.set(task.planPath, tasks);
        return tasks.filter((id) => id === task.taskId).length;
      },
    });
    const working = new Set<string>();
    for (const row of agents) workingSessions(row.level, working);
    return {
      agents,
      plans: [],
      working: working.size,
      waiting: agents.reduce((count, row) => count + row.waiting, 0),
      // A session's own job stays open while the session lives, so a row
      // also counts once every block under it is closed.
      finished: agents.filter(
        (row) =>
          row.state === "done" ||
          (row.state === "idle" &&
            row.level.blocks.length > 0 &&
            row.level.blocks.every(
              (block) => block.state === "done" || block.state === "dropped",
            )),
      ).length,
    };
  }
}

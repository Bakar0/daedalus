import type { Database } from "bun:sqlite";
import {
  evolve,
  type Job,
  type JobEvent,
  type JobOutput,
  type JobTree,
} from "../domain/jobs";

interface JobRow {
  id: string;
  workspace_id: string;
  root_id: string;
  parent_id: string | null;
  name: string;
  title: string;
  instructions: string;
  needs: string;
  gives: string;
  gate: string | null;
  runner: string;
  auto: number;
  loop: string | null;
  source: string | null;
  position: number;
  state: string;
  round: number;
  session_id: string | null;
  hold: string | null;
  approved: string;
  result: string | null;
  why: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
}

/** What the tables keep about a job that the rules do not use. */
export interface JobRecord {
  workspaceId: string;
  rootId: string;
  createdAt: string;
  updatedAt: string;
  /** When this round started running. */
  startedAt: string | null;
  /** When the job was done, failed or skipped. */
  endedAt: string | null;
}

/** A stored event: the event, its place in the log, who asked and when. */
export interface StoredJobEvent {
  seq: number;
  rootId: string;
  event: JobEvent;
  sessionId: string | null;
  at: string;
}

const jobFromRow = (row: JobRow, outputs: JobOutput[]): Job => ({
  id: row.id,
  parentId: row.parent_id,
  name: row.name,
  title: row.title,
  instructions: row.instructions,
  needs: JSON.parse(row.needs) as Job["needs"],
  gives: JSON.parse(row.gives) as Job["gives"],
  gate: row.gate as Job["gate"],
  runner: JSON.parse(row.runner) as Job["runner"],
  auto: row.auto === 1,
  loop: row.loop ? (JSON.parse(row.loop) as Job["loop"]) : null,
  source: row.source,
  position: row.position,
  state: row.state as Job["state"],
  round: row.round,
  sessionId: row.session_id,
  hold: row.hold ? (JSON.parse(row.hold) as Job["hold"]) : null,
  approved: JSON.parse(row.approved) as Job["approved"],
  outputs,
  result: row.result,
  why: row.why,
});

const recordFromRow = (row: JobRow): JobRecord => ({
  workspaceId: row.workspace_id,
  rootId: row.root_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at,
  endedAt: row.ended_at,
});

/** A tree as read: the jobs for the rules, and each one's record. */
export interface StoredJobTree {
  tree: JobTree;
  records: Map<string, JobRecord>;
}

/**
 * The job log and the tables that mirror it. Shares the one connection
 * `SqliteRepositories` opens, so its writes join that class's transactions.
 */
export class JobRepository {
  constructor(private readonly database: Database) {}

  private read(rows: JobRow[]): StoredJobTree {
    const tree: JobTree = { jobs: new Map() };
    const records = new Map<string, JobRecord>();
    if (!rows.length) return { tree, records };
    const outputs = new Map<string, JobOutput[]>();
    const roots = [...new Set(rows.map((row) => row.root_id))];
    for (const root of roots)
      for (const output of this.database
        .query<
          { job_id: string; name: string; kind: string; value: string },
          [string]
        >(
          `SELECT job_outputs.job_id, job_outputs.name, job_outputs.kind,
                  job_outputs.value
           FROM job_outputs JOIN jobs ON jobs.id = job_outputs.job_id
           WHERE jobs.root_id = ? ORDER BY job_outputs.rowid`,
        )
        .all(root))
        outputs.set(output.job_id, [
          ...(outputs.get(output.job_id) ?? []),
          {
            name: output.name,
            kind: output.kind as JobOutput["kind"],
            value: output.value,
          },
        ]);
    for (const row of rows) {
      tree.jobs.set(row.id, jobFromRow(row, outputs.get(row.id) ?? []));
      records.set(row.id, recordFromRow(row));
    }
    return { tree, records };
  }

  /** One piece of work: the root and everything under it. */
  tree(rootId: string): StoredJobTree {
    return this.read(
      this.database
        .query<JobRow, [string]>("SELECT * FROM jobs WHERE root_id = ?")
        .all(rootId),
    );
  }

  /** Every job of a workspace, over all its trees. */
  workspace(workspaceId: string): StoredJobTree {
    return this.read(
      this.database
        .query<JobRow, [string]>("SELECT * FROM jobs WHERE workspace_id = ?")
        .all(workspaceId),
    );
  }

  /** Every job there is. */
  all(): StoredJobTree {
    return this.read(
      this.database.query<JobRow, []>("SELECT * FROM jobs").all(),
    );
  }

  /** Changes with every event: what a reader compares to know it is stale. */
  version(): string {
    return String(
      this.database
        .query<{ seq: number | null }, []>(
          "SELECT MAX(seq) AS seq FROM job_events",
        )
        .get()?.seq ?? 0,
    );
  }

  /** The sessions the engine started for a job. */
  agentSessionIds(): string[] {
    return this.database
      .query<{ session_id: string }, []>(
        `SELECT DISTINCT session_id FROM jobs
         WHERE session_id IS NOT NULL AND runner = '{"kind":"agent"}'`,
      )
      .all()
      .map((row) => row.session_id);
  }

  /** The root of the tree a job is in. */
  rootOf(jobId: string): string | undefined {
    return this.database
      .query<{ root_id: string }, [string]>(
        "SELECT root_id FROM jobs WHERE id = ?",
      )
      .get(jobId)?.root_id;
  }

  /** The roots of the trees a session does a job in, the newest first. */
  rootsOfSession(sessionId: string): string[] {
    return this.database
      .query<{ root_id: string }, [string]>(
        `SELECT root_id FROM jobs WHERE session_id = ?
         GROUP BY root_id ORDER BY MAX(updated_at) DESC, MAX(rowid) DESC`,
      )
      .all(sessionId)
      .map((row) => row.root_id);
  }

  /** A tree's log, in order. */
  events(rootId: string): StoredJobEvent[] {
    return this.database
      .query<
        {
          seq: number;
          root_id: string;
          job_id: string;
          type: string;
          data: string;
          session_id: string | null;
          at: string;
        },
        [string]
      >("SELECT * FROM job_events WHERE root_id = ? ORDER BY seq")
      .all(rootId)
      .map((row) => ({
        seq: row.seq,
        rootId: row.root_id,
        event: {
          ...(JSON.parse(row.data) as object),
          jobId: row.job_id,
          type: row.type,
        } as JobEvent,
        sessionId: row.session_id,
        at: row.at,
      }));
  }

  /**
   * Appends events and brings the tables up to them. `tree` is the tree the
   * events were decided on; it is changed to what it is after them. The
   * caller holds the transaction.
   */
  append(
    workspaceId: string,
    tree: JobTree,
    events: readonly JobEvent[],
    by: { sessionId: string | null; at: string },
  ): void {
    const rootOf = (jobId: string): string => {
      let at = tree.jobs.get(jobId);
      while (at?.parentId && tree.jobs.has(at.parentId))
        at = tree.jobs.get(at.parentId);
      return at?.id ?? jobId;
    };
    const insert = this.database.query(
      `INSERT INTO job_events (root_id, job_id, type, data, session_id, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const started = new Set<string>();
    const ended = new Set<string>();
    const reopened = new Set<string>();
    const touched = new Set<string>();
    for (const event of events) {
      evolve(tree, event);
      const { jobId, type, ...data } = event;
      insert.run(
        rootOf(jobId),
        jobId,
        type,
        JSON.stringify(data),
        by.sessionId,
        by.at,
      );
      touched.add(jobId);
      if (type === "started") started.add(jobId);
      if (type === "reopened") {
        reopened.add(jobId);
        started.delete(jobId);
        ended.delete(jobId);
      }
      if (
        type === "done" ||
        type === "failed" ||
        type === "skipped" ||
        type === "released"
      )
        ended.add(jobId);
    }
    const upsert = this.database.query(
      `INSERT INTO jobs (
         id, workspace_id, root_id, parent_id, name, title, instructions,
         needs, gives, gate, runner, auto, loop, source, position, state,
         round, session_id, hold, approved, result, why, created_at,
         updated_at, started_at, ended_at
       ) VALUES (
         $id, $workspace, $root, $parent, $name, $title, $instructions,
         $needs, $gives, $gate, $runner, $auto, $loop, $source, $position,
         $state, $round, $session, $hold, $approved, $result, $why, $at,
         $at, $started, $ended
       )
       ON CONFLICT(id) DO UPDATE SET
         runner = excluded.runner,
         state = excluded.state,
         round = excluded.round,
         session_id = excluded.session_id,
         hold = excluded.hold,
         approved = excluded.approved,
         result = excluded.result,
         why = excluded.why,
         updated_at = excluded.updated_at,
         started_at = CASE
           WHEN $restarted = 1 THEN excluded.started_at
           WHEN excluded.started_at IS NOT NULL THEN excluded.started_at
           ELSE jobs.started_at END,
         ended_at = CASE
           WHEN $restarted = 1 THEN excluded.ended_at
           WHEN excluded.ended_at IS NOT NULL THEN excluded.ended_at
           ELSE jobs.ended_at END`,
    );
    const clear = this.database.query(
      "DELETE FROM job_outputs WHERE job_id = ?",
    );
    const output = this.database.query(
      "INSERT INTO job_outputs (job_id, name, kind, value) VALUES (?, ?, ?, ?)",
    );
    for (const id of touched) {
      const job = tree.jobs.get(id);
      if (!job) continue;
      const finished =
        job.state === "done" ||
        job.state === "failed" ||
        job.state === "skipped";
      upsert.run({
        $id: job.id,
        $workspace: workspaceId,
        $root: rootOf(job.id),
        $parent: job.parentId,
        $name: job.name,
        $title: job.title,
        $instructions: job.instructions,
        $needs: JSON.stringify(job.needs),
        $gives: JSON.stringify(job.gives),
        $gate: job.gate,
        $runner: JSON.stringify(job.runner),
        $auto: job.auto ? 1 : 0,
        $loop: job.loop ? JSON.stringify(job.loop) : null,
        $source: job.source,
        $position: job.position,
        $state: job.state,
        $round: job.round,
        $session: job.sessionId,
        $hold: job.hold ? JSON.stringify(job.hold) : null,
        $approved: JSON.stringify(job.approved),
        $result: job.result,
        $why: job.why,
        $at: by.at,
        $started: started.has(id) ? by.at : null,
        $ended: ended.has(id) && finished ? by.at : null,
        $restarted: reopened.has(id) ? 1 : 0,
      });
      clear.run(id);
      for (const item of job.outputs)
        output.run(id, item.name, item.kind, item.value);
    }
  }

  /** The job a session was started for. */
  jobOfSession(sessionId: string): string | undefined {
    return (
      this.database
        .query<{ job_id: string | null }, [string]>(
          "SELECT job_id FROM agent_sessions WHERE id = ?",
        )
        .get(sessionId)?.job_id ?? undefined
    );
  }

  setJobOfSession(sessionId: string, jobId: string | null): void {
    this.database
      .query("UPDATE agent_sessions SET job_id = ? WHERE id = ?")
      .run(jobId, sessionId);
  }
}

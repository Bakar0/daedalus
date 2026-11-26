import {
  currentJob,
  decide,
  jobBrief,
  jobChildren,
  isTerminalJob,
  type Job,
  type JobActor,
  type JobCommand,
  type JobEvent,
  type JobGate,
  type JobGive,
  type JobRunner,
  type JobSpec,
  type JobTree,
} from "../domain/jobs";
import { DaedalusError } from "../errors";
import type { StoredJobTree } from "../repositories/jobs";
import type { SqliteRepositories } from "../repositories/sqlite";

/** What the engine needs from the rest of the app. */
export interface JobPorts {
  /**
   * Starts an agent for a job with the brief as its first message, and
   * returns its session id. `sessionId` is the id the engine recorded for it;
   * a port that cannot use it returns the id it made.
   */
  spawn(input: {
    workspaceId: string;
    job: Job;
    brief: string;
    /** The session doing the job this one is under. */
    parentSessionId: string | null;
    sessionId: string;
  }): Promise<string>;
  /** Delivers a message to a session. */
  tell(sessionId: string, text: string): Promise<void> | void;
  /** Shows the user that a session waits for them. */
  raise(sessionId: string, message: string): Promise<void> | void;
  clear(sessionId: string): Promise<void> | void;
  /** Whether a session still has an agent that can work. */
  alive(sessionId: string): Promise<boolean> | boolean;
  /**
   * Whether a session is still the user's to open again: it exists and is
   * not archived, whether or not its agent runs now.
   */
  kept(sessionId: string): Promise<boolean> | boolean;
  /** Archives a session whose job is finished. */
  retire(sessionId: string): Promise<void> | void;
  /**
   * What is wrong with a file or a commit handed over, or null when it
   * exists.
   */
  verify(
    workspaceId: string,
    kind: "file" | "commit",
    value: string,
  ): Promise<string | null> | string | null;
  /**
   * Told the jobs a command changed, as they are after it: what mirrors
   * them elsewhere, such as a plan file's marks, follows.
   */
  changed?(jobs: Job[]): Promise<void> | void;
  newId(): string;
  /** The time, as an ISO string. */
  now(): string;
}

/** A job to add. The engine gives it its id and its place. */
export interface JobDraft {
  name: string;
  title?: string;
  instructions?: string;
  needs?: string[];
  gives?: JobGive[];
  gate?: JobGate | null;
  /** A new agent when left out. */
  runner?: JobRunner;
  auto?: boolean;
  loop?: Job["loop"];
  source?: string | null;
  /** Jobs under this one, added with it. */
  children?: JobDraft[];
}

/** What a command changed: the tree after it, and the events it recorded. */
interface Ran {
  tree: JobTree;
  events: JobEvent[];
}

/** What a session gets back when it finishes or releases a job. */
export interface JobHandover {
  job: Job;
  /** The brief of the job this session was started on by the command. */
  next: string | null;
}

/** New agents doing the jobs of one parent at the same time. */
export const JOB_AGENT_LIMIT = 3;

/**
 * How long a started job is left alone before a missing session fails it:
 * an agent is recorded as its runner before it exists.
 */
const START_GRACE_MS = 120_000;

/**
 * Runs the job engine: each command is decided and recorded in one
 * transaction, and what follows outside the database (starting agents,
 * telling sessions, attention) happens after it committed.
 */
export class JobService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly ports: JobPorts,
    private readonly agentLimit = JOB_AGENT_LIMIT,
  ) {}

  /** Decides a command on a tree and records it, or throws the refusal. */
  private run(
    rootId: string,
    command: JobCommand,
    by: string | null,
    workspaceId?: string,
  ): Ran {
    return this.repositories.immediateTransaction(() => {
      const stored = this.repositories.jobs.tree(rootId);
      const workspace =
        workspaceId ?? stored.records.values().next().value?.workspaceId;
      if (!workspace) throw new DaedalusError("NOT_FOUND", "No such job.");
      const decision = decide(stored.tree, command);
      if (!decision.ok) throw new DaedalusError("CONFLICT", decision.reason);
      this.repositories.jobs.append(workspace, stored.tree, decision.events, {
        sessionId: by,
        at: this.ports.now(),
      });
      return { tree: stored.tree, events: decision.events };
    });
  }

  /** A port call that must not undo a command that is already recorded. */
  private async safely(call: () => Promise<void> | void): Promise<void> {
    try {
      await call();
    } catch {
      // The log holds the change. `job next` and the tick recover the rest.
    }
  }

  /**
   * Does what the events ask for outside the database. `by` is the session
   * that ran the command, which needs no telling about its own doing.
   */
  private async notify(ran: Ran, by: string | null): Promise<void> {
    const { tree, events } = ran;
    for (const event of events) {
      const job = tree.jobs.get(event.jobId);
      if (!job) continue;
      const parent = job.parentId ? tree.jobs.get(job.parentId) : undefined;
      const above =
        parent?.sessionId &&
        parent.sessionId !== job.sessionId &&
        parent.sessionId !== by
          ? parent.sessionId
          : null;
      const waiter = job.sessionId ?? parent?.sessionId ?? null;
      const label = `"${job.title}"`;
      switch (event.type) {
        case "started": {
          // A new agent gets its brief as its first message.
          if (job.runner.kind === "agent" || job.state !== "running") break;
          const session = job.sessionId;
          if (session && session !== by)
            await this.safely(() =>
              this.ports.tell(session, jobBrief(tree, job.id)),
            );
          break;
        }
        case "held": {
          const message =
            event.reason === "hold"
              ? (event.why ?? "")
              : event.reason === "result-gate"
                ? `Approve ${label}: ${event.result ?? ""}`
                : `Approve starting ${label}.`;
          if (waiter)
            await this.safely(() => this.ports.raise(waiter, message));
          if (above && event.reason !== "start-gate")
            await this.safely(() =>
              this.ports.tell(
                above,
                event.reason === "hold"
                  ? `${label} waits for the user: ${event.why ?? ""}`
                  : `${label} waits for the user's approval: ${event.result ?? ""}`,
              ),
            );
          break;
        }
        case "released": {
          if (waiter) await this.safely(() => this.ports.clear(waiter));
          const session = job.sessionId;
          if (session && session !== by)
            await this.safely(() =>
              this.ports.tell(
                session,
                `The user released ${label}${event.answer ? `: ${event.answer}` : "."}`,
              ),
            );
          if (above && job.state === "done")
            await this.safely(() => this.ports.tell(above, doneNote(job)));
          break;
        }
        case "done":
          if (above)
            await this.safely(() => this.ports.tell(above, doneNote(job)));
          break;
        case "failed":
          if (above)
            await this.safely(() =>
              this.ports.tell(
                above,
                `${label} failed: ${event.why} Run it again with \`daedal job retry ${job.name}\`, or skip it with \`daedal job skip ${job.name} --why "<why>"\`.`,
              ),
            );
          break;
        default:
          break;
      }
    }
    const touched = [...new Set(events.map((event) => event.jobId))].flatMap(
      (id) => tree.jobs.get(id) ?? [],
    );
    const changed = this.ports.changed?.bind(this.ports);
    if (changed && touched.length) await this.safely(() => changed(touched));
  }

  /**
   * Tells who needs telling, then starts what became ready. What it started
   * for the session that asked comes back with the command's own events, so
   * that session reads its next brief in the command's answer and is not
   * sent it again as a message it would get after the work.
   */
  private async after(
    rootId: string,
    ran: Ran,
    by: string | null,
  ): Promise<Ran> {
    await this.notify(ran, by);
    const started = await this.schedule(rootId, by);
    return started.length
      ? {
          ...ran,
          tree: this.repositories.jobs.tree(rootId).tree,
          events: [...ran.events, ...started],
        }
      : ran;
  }

  /** Runs a command and everything that follows from it. */
  private async command(
    rootId: string,
    command: JobCommand,
    by: string | null,
  ): Promise<Ran> {
    return this.after(rootId, this.run(rootId, command, by), by);
  }

  /**
   * Starts what is ready and not done in its parent's session: a job of a
   * named session is handed to it, and a job for a new agent gets one while
   * its parent has fewer than the limit at work.
   */
  private async schedule(
    rootId: string,
    by: string | null = null,
  ): Promise<JobEvent[]> {
    const passed = new Set<string>();
    const mine: JobEvent[] = [];
    for (;;) {
      const { tree, records } = this.repositories.jobs.tree(rootId);
      const job = [...tree.jobs.values()].find((item) => {
        if (item.state !== "ready" || passed.has(item.id)) return false;
        if (item.runner.kind === "session") return true;
        if (item.runner.kind !== "agent") return false;
        const busy = jobChildren(tree, item.parentId).filter(
          (other) =>
            other.runner.kind === "agent" &&
            (other.state === "running" || other.state === "held"),
        );
        return busy.length < this.agentLimit;
      });
      if (!job) return mine;
      passed.add(job.id);
      const workspaceId = records.get(job.id)?.workspaceId;
      if (!workspaceId) continue;
      const sessionId =
        job.runner.kind === "session"
          ? job.runner.sessionId
          : this.ports.newId();
      let ran: Ran;
      try {
        // Recording the start is the lock: of two processes that see the job
        // ready, the second is refused here.
        ran = this.run(
          rootId,
          { type: "start", jobId: job.id, sessionId },
          null,
        );
      } catch (error) {
        if (error instanceof DaedalusError && error.code === "CONFLICT")
          continue;
        throw error;
      }
      if (job.runner.kind === "agent") {
        const parent = job.parentId ? ran.tree.jobs.get(job.parentId) : null;
        try {
          const made = await this.ports.spawn({
            workspaceId,
            job: ran.tree.jobs.get(job.id) ?? job,
            brief: jobBrief(ran.tree, job.id),
            parentSessionId: parent?.sessionId ?? null,
            sessionId,
          });
          if (made !== sessionId)
            this.run(rootId, { type: "move", from: sessionId, to: made }, null);
          this.repositories.jobs.setJobOfSession(made, job.id);
          // What is told from here on names the session the agent really has.
          ran = { ...ran, tree: this.repositories.jobs.tree(rootId).tree };
        } catch (error) {
          const failed = this.run(
            rootId,
            {
              type: "fail",
              jobId: job.id,
              actor: { kind: "engine" },
              why: `Its agent did not start: ${error instanceof Error ? error.message : String(error)}`,
            },
            null,
          );
          await this.notify(failed, null);
        }
      }
      if (by && sessionId === by) mine.push(...ran.events);
      await this.notify(ran, by);
    }
  }

  private actor(sessionId: string | null): JobActor {
    return sessionId ? { kind: "session", sessionId } : { kind: "user" };
  }

  /** The root of the tree a job is in. */
  rootOf(jobId: string): string {
    const root = this.repositories.jobs.rootOf(jobId);
    if (!root) throw new DaedalusError("NOT_FOUND", "There is no such job.");
    return root;
  }

  private specs(
    parentId: string | null,
    drafts: readonly JobDraft[],
    from: number,
  ): JobSpec[] {
    return drafts.flatMap((draft, index) => {
      const id = this.ports.newId();
      return [
        {
          id,
          parentId,
          name: draft.name,
          title: draft.title?.trim() || draft.name,
          instructions: draft.instructions ?? "",
          needs: draft.needs ?? [],
          gives: draft.gives ?? [],
          gate: draft.gate ?? null,
          runner: draft.runner ?? { kind: "agent" },
          auto: draft.auto ?? false,
          loop: draft.loop ?? null,
          source: draft.source ?? null,
          position: from + index,
        },
        ...this.specs(id, draft.children ?? [], 0),
      ];
    });
  }

  /** The tree a job is in. */
  tree(rootId: string): StoredJobTree {
    return this.repositories.jobs.tree(rootId);
  }

  /** Every job of a workspace. */
  page(workspaceId: string): StoredJobTree {
    return this.repositories.jobs.workspace(workspaceId);
  }

  /** The job a session is on, with its tree. */
  current(sessionId: string): { job: Job; tree: JobTree } | undefined {
    for (const rootId of this.repositories.jobs.rootsOfSession(sessionId)) {
      const { tree } = this.repositories.jobs.tree(rootId);
      const job = currentJob(tree, sessionId);
      if (job) return { job, tree };
    }
    return undefined;
  }

  private mine(sessionId: string): { job: Job; tree: JobTree } {
    const found = this.current(sessionId);
    if (!found)
      throw new DaedalusError(
        "NOT_FOUND",
        "This session has no open job. `daedal job tree` shows what there is.",
      );
    return found;
  }

  /** What the session's current job tells its runner. */
  brief(sessionId: string): string {
    const { job, tree } = this.mine(sessionId);
    return jobBrief(tree, job.id);
  }

  /**
   * A job named from where a session stands: by id, or by name among the
   * jobs under its current one, then beside it, then anywhere in its tree.
   */
  find(sessionId: string, ref: string): Job {
    const byId = this.repositories.jobs.rootOf(ref);
    if (byId) {
      const job = this.repositories.jobs.tree(byId).tree.jobs.get(ref);
      if (job) return job;
    }
    const { job, tree } = this.mine(sessionId);
    const named = (jobs: Job[]) => jobs.filter((item) => item.name === ref);
    const found = [
      named(jobChildren(tree, job.id)),
      named(jobChildren(tree, job.parentId)),
      named([...tree.jobs.values()]),
    ].find((list) => list.length > 0);
    if (!found)
      throw new DaedalusError("NOT_FOUND", `There is no job named "${ref}".`);
    if (found.length > 1 || !found[0])
      throw new DaedalusError(
        "CONFLICT",
        `"${ref}" names ${found.length} jobs. Use an id: ${found.map((item) => item.id).join(", ")}.`,
      );
    return found[0];
  }

  /**
   * Gives a session a job it starts on at once: a root job, or with
   * `parentId` a job under another session's. The session is not told a
   * brief, because whoever calls this has told it what to do.
   */
  async open(
    workspaceId: string,
    sessionId: string,
    draft: Omit<JobDraft, "runner">,
    parentId: string | null = null,
  ): Promise<Job> {
    const last = parentId
      ? jobChildren(
          this.repositories.jobs.tree(this.rootOf(parentId)).tree,
          parentId,
        ).at(-1)
      : undefined;
    const specs = this.specs(
      parentId,
      [{ ...draft, runner: { kind: "session", sessionId } }],
      (last?.position ?? -1) + 1,
    );
    const first = specs[0];
    if (!first) throw new DaedalusError("INTERNAL", "No job was made.");
    const rootId = parentId ? this.rootOf(parentId) : first.id;
    this.run(rootId, { type: "add", specs }, sessionId, workspaceId);
    const ran = this.run(
      rootId,
      { type: "start", jobId: first.id, sessionId },
      sessionId,
    );
    if (!this.repositories.jobs.jobOfSession(sessionId))
      this.repositories.jobs.setJobOfSession(sessionId, first.id);
    await this.after(rootId, ran, sessionId);
    const job = this.repositories.jobs.tree(rootId).tree.jobs.get(first.id);
    if (!job) throw new DaedalusError("INTERNAL", "The job was not stored.");
    return job;
  }

  /**
   * Starts a piece of work nobody is on yet: a root job the engine finds a
   * runner for, a new agent unless the draft names one.
   */
  async plant(
    workspaceId: string,
    draft: JobDraft,
    by: string | null,
  ): Promise<Job> {
    const specs = this.specs(null, [draft], 0);
    const first = specs[0];
    if (!first) throw new DaedalusError("INTERNAL", "No job was made.");
    const ran = this.run(first.id, { type: "add", specs }, by, workspaceId);
    await this.after(first.id, ran, by);
    const job = this.repositories.jobs.tree(first.id).tree.jobs.get(first.id);
    if (!job) throw new DaedalusError("INTERNAL", "The job was not stored.");
    return job;
  }

  /** Adds jobs under a job. Returns the ones directly under it. */
  async add(
    parentId: string,
    drafts: readonly JobDraft[],
    by: string | null,
  ): Promise<Job[]> {
    const rootId = this.rootOf(parentId);
    const { tree } = this.repositories.jobs.tree(rootId);
    const last = jobChildren(tree, parentId).at(-1);
    const specs = this.specs(parentId, drafts, (last?.position ?? -1) + 1);
    const ran = await this.command(rootId, { type: "add", specs }, by);
    const after = this.repositories.jobs.tree(rootId).tree;
    return specs
      .filter((spec) => spec.parentId === parentId)
      .flatMap(
        (spec) => after.jobs.get(spec.id) ?? ran.tree.jobs.get(spec.id) ?? [],
      );
  }

  private async verified(
    job: Job,
    outputs: readonly { name: string; value: string }[],
  ): Promise<void> {
    const workspaceId = this.repositories.jobs
      .tree(this.rootOf(job.id))
      .records.get(job.id)?.workspaceId;
    if (!workspaceId) return;
    for (const output of outputs) {
      const kind = job.gives.find((give) => give.name === output.name)?.kind;
      if (kind !== "file" && kind !== "commit") continue;
      const problem = await this.ports.verify(
        workspaceId,
        kind,
        output.value.trim(),
      );
      if (problem)
        throw new DaedalusError(
          "VALIDATION",
          `The output "${output.name}" (${kind}) ${problem}.`,
        );
    }
  }

  private handover(ran: Ran, job: Job, sessionId: string): JobHandover {
    const after = ran.tree.jobs.get(job.id) ?? job;
    const next = currentJob(ran.tree, sessionId);
    const started =
      next &&
      // The job itself, when a start gate was passed and it began.
      next.state === "running" &&
      ran.events.some(
        (event) => event.type === "started" && event.jobId === next.id,
      );
    return { job: after, next: started ? jobBrief(ran.tree, next.id) : null };
  }

  /** Hands outputs over without finishing. */
  async output(
    sessionId: string,
    outputs: { name: string; value: string }[],
  ): Promise<Job> {
    const { job } = this.mine(sessionId);
    await this.verified(job, outputs);
    const ran = await this.command(
      this.rootOf(job.id),
      { type: "output", jobId: job.id, actor: this.actor(sessionId), outputs },
      sessionId,
    );
    return ran.tree.jobs.get(job.id) ?? job;
  }

  /**
   * Finishes the session's current job. A job with a result gate is held for
   * the user instead, which the job returned shows.
   */
  async done(
    sessionId: string,
    input: {
      result: string;
      outputs?: { name: string; value: string }[];
      /** A job of this session other than its current one, such as a loop. */
      jobId?: string;
    },
  ): Promise<JobHandover> {
    const job = input.jobId
      ? this.find(sessionId, input.jobId)
      : this.mine(sessionId).job;
    const outputs = input.outputs ?? [];
    await this.verified(job, outputs);
    const ran = await this.command(
      this.rootOf(job.id),
      {
        type: "done",
        jobId: job.id,
        actor: this.actor(sessionId),
        result: input.result,
        outputs,
      },
      sessionId,
    );
    return this.handover(ran, job, sessionId);
  }

  /** Stops the session's current job until the user decides. */
  async hold(sessionId: string, why: string): Promise<Job> {
    const { job } = this.mine(sessionId);
    const ran = await this.command(
      this.rootOf(job.id),
      { type: "hold", jobId: job.id, actor: this.actor(sessionId), why },
      sessionId,
    );
    return ran.tree.jobs.get(job.id) ?? job;
  }

  /**
   * Passes a gate or answers a hold, on the user's word. `by` is the session
   * that carries the word, which gets the next brief back.
   */
  async release(
    jobId: string,
    by: string | null,
    answer?: string,
  ): Promise<JobHandover> {
    const rootId = this.rootOf(jobId);
    const ran = await this.command(
      rootId,
      { type: "release", jobId, actor: { kind: "user" }, answer },
      by,
    );
    const job = ran.tree.jobs.get(jobId);
    if (!job) throw new DaedalusError("NOT_FOUND", "There is no such job.");
    return by ? this.handover(ran, job, by) : { job, next: null };
  }

  /** The job of a session that waits for the user, if one does. */
  held(sessionId: string): Job | undefined {
    for (const rootId of this.repositories.jobs.rootsOfSession(sessionId)) {
      const { tree } = this.repositories.jobs.tree(rootId);
      const mine = [...tree.jobs.values()].filter(
        (job) => job.sessionId === sessionId,
      );
      const found = [...tree.jobs.values()].find(
        (job) =>
          job.state === "held" &&
          (job.sessionId === sessionId ||
            mine.some((own) => own.id === job.parentId)),
      );
      if (found) return found;
    }
    return undefined;
  }

  async skip(jobId: string, by: string | null, why: string): Promise<Job> {
    return this.decided(
      { type: "skip", jobId, actor: this.actor(by), why },
      by,
    );
  }

  /** Puts finished work and what needs it back to be done again. */
  async redo(jobId: string, by: string | null, why: string): Promise<Job> {
    return this.decided(
      { type: "redo", jobId, actor: this.actor(by), why },
      by,
    );
  }

  async fail(jobId: string, by: string | null, why: string): Promise<Job> {
    return this.decided(
      { type: "fail", jobId, actor: this.actor(by), why },
      by,
    );
  }

  private async decided(
    command: Extract<JobCommand, { jobId: string; actor: JobActor }>,
    by: string | null,
  ): Promise<Job> {
    const ran = await this.command(this.rootOf(command.jobId), command, by);
    const job = ran.tree.jobs.get(command.jobId);
    if (!job) throw new DaedalusError("NOT_FOUND", "There is no such job.");
    return job;
  }

  /** Gives every job of a session to the session that continues it. */
  moveSession(from: string, to: string): void {
    for (const rootId of this.repositories.jobs.rootsOfSession(from))
      this.run(rootId, { type: "move", from, to }, null);
    const jobId = this.repositories.jobs.jobOfSession(from);
    if (jobId) this.repositories.jobs.setJobOfSession(to, jobId);
  }

  /**
   * The engine's housekeeping for a workspace: fails the jobs of sessions
   * that are gone, archives agents whose job is finished, and starts what is
   * ready.
   *
   * An agent the engine started is gone when it stops running: nobody else
   * would notice, and the work above it would wait for good. A session the
   * user started is gone only when it is archived. Stopped or lost, it keeps
   * its jobs, so that it goes on from the same step when the user opens it
   * again.
   */
  async tick(workspaceId: string): Promise<void> {
    const { tree, records } = this.repositories.jobs.workspace(workspaceId);
    const now = Date.parse(this.ports.now());
    const alive = new Map<string, boolean>();
    const isAlive = async (sessionId: string): Promise<boolean> => {
      const known = alive.get(sessionId);
      if (known !== undefined) return known;
      const answer = await this.ports.alive(sessionId);
      alive.set(sessionId, answer);
      return answer;
    };
    const depth = (job: Job): number =>
      job.parentId && tree.jobs.has(job.parentId)
        ? 1 + depth(tree.jobs.get(job.parentId)!)
        : 0;
    const engineStarted = new Set(
      [...tree.jobs.values()]
        .filter((job) => job.runner.kind === "agent" && job.sessionId)
        .map((job) => job.sessionId!),
    );
    const kept = new Map<string, boolean>();
    const isGone = async (sessionId: string): Promise<boolean> => {
      if (engineStarted.has(sessionId)) return !(await isAlive(sessionId));
      const known = kept.get(sessionId);
      if (known !== undefined) return !known;
      const answer = await this.ports.kept(sessionId);
      kept.set(sessionId, answer);
      return !answer;
    };
    const open = [...tree.jobs.values()]
      .filter(
        (job) =>
          job.sessionId && (job.state === "running" || job.state === "held"),
      )
      .sort((a, b) => depth(b) - depth(a));
    const roots = new Set<string>();
    for (const record of records.values()) roots.add(record.rootId);
    for (const job of open) {
      const record = records.get(job.id);
      const started = Date.parse(record?.startedAt ?? record?.updatedAt ?? "");
      if (Number.isFinite(started) && now - started < START_GRACE_MS) continue;
      if (!record || !(await isGone(job.sessionId!))) continue;
      try {
        const ran = this.run(
          record.rootId,
          {
            type: "fail",
            jobId: job.id,
            actor: { kind: "engine" },
            why: "Its agent is gone.",
          },
          null,
        );
        await this.notify(ran, null);
      } catch (error) {
        // Finished by someone else since the tree was read.
        if (!(error instanceof DaedalusError)) throw error;
      }
    }
    const after = this.repositories.jobs.workspace(workspaceId).tree;
    const busy = new Set(
      [...after.jobs.values()]
        .filter((job) => job.sessionId && !isTerminalJob(job))
        .map((job) => job.sessionId),
    );
    const finished = new Set(
      [...after.jobs.values()]
        .filter(
          (job) =>
            job.runner.kind === "agent" &&
            job.sessionId &&
            isTerminalJob(job) &&
            !busy.has(job.sessionId),
        )
        .map((job) => job.sessionId!),
    );
    for (const sessionId of finished)
      if (await isAlive(sessionId))
        await this.safely(() => this.ports.retire(sessionId));
    for (const rootId of roots) await this.schedule(rootId);
  }
}

function doneNote(job: Job): string {
  return [
    `"${job.title}" is done: ${job.result ?? ""}`,
    ...job.outputs.map((output) => `  ${output.name} = ${output.value}`),
  ].join("\n");
}

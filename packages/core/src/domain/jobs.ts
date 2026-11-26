/**
 * The job engine's rules. A job is one piece of work with an owner: a
 * workflow step, a plan task, a prompt, a message to a team member. Jobs form
 * a tree, and every change to one is an event appended to a log.
 *
 * Nothing here touches a database or a clock. `decide` says whether a command
 * may happen and which events record it; `evolve` says what the tree is after
 * an event. The service around them appends the events and keeps tables that
 * mirror the tree for reading.
 */

export type JobState =
  "pending" | "ready" | "running" | "held" | "done" | "failed" | "skipped";

/** The kinds of value a job hands over. */
export type JobOutputKind =
  "text" | "file" | "commit" | "url" | "number" | "flag";

export const JOB_OUTPUT_KINDS: readonly JobOutputKind[] = [
  "text",
  "file",
  "commit",
  "url",
  "number",
  "flag",
];

/** An output a job must hand over before it is done. */
export interface JobGive {
  name: string;
  kind: JobOutputKind;
}

export interface JobOutput extends JobGive {
  value: string;
}

/**
 * Where a job waits for the user: `start` before it runs, `result` after its
 * runner finished it.
 */
export type JobGate = "start" | "result";

/** Why a job is held: at one of its gates, or its runner asked to stop. */
export type JobHoldReason = "start-gate" | "result-gate" | "hold";

/**
 * Who does a job: the session doing its parent, a new agent the engine
 * starts for it, or one session named when the job was added.
 */
export type JobRunner =
  | { kind: "inline" }
  | { kind: "agent" }
  | { kind: "session"; sessionId: string };

/** A job as it is added. Nothing in it changes afterwards. */
export interface JobSpec {
  id: string;
  parentId: string | null;
  /** Unique among the jobs of one parent; what `needs` refers to. */
  name: string;
  title: string;
  /** What to do, copied when the job is added. */
  instructions: string;
  /** Names of jobs of the same parent that must finish first. */
  needs: string[];
  gives: JobGive[];
  gate: JobGate | null;
  runner: JobRunner;
  /**
   * Done by the engine when its children are: a workflow's steps as one job.
   * Its result is its last child's.
   */
  auto: boolean;
  /**
   * Its children repeat: when the last one finishes, those from `to` on
   * start a new round, until the job itself is finished.
   */
  loop: { to: string; until: string | null } | null;
  /** Where it was declared, such as `step:feature/build`. */
  source: string | null;
  /** Its place among the jobs of its parent. */
  position: number;
}

export interface Job extends JobSpec {
  state: JobState;
  /** Counts from 1; a redo or a loop starts the next. */
  round: number;
  /** The session doing it, once it was started. */
  sessionId: string | null;
  hold: { reason: JobHoldReason; why: string | null } | null;
  /** The gates the user passed in this round. */
  approved: { start: boolean; result: boolean };
  /** What it handed over in this round. */
  outputs: JobOutput[];
  /** What came out, in a few words. */
  result: string | null;
  /** Why it failed, was skipped or was reopened. */
  why: string | null;
}

export interface JobTree {
  jobs: Map<string, Job>;
}

export const emptyJobTree = (): JobTree => ({ jobs: new Map() });

export type JobEvent = { jobId: string } & (
  | { type: "added"; spec: JobSpec }
  | { type: "ready" }
  | { type: "started"; sessionId: string }
  | { type: "output"; name: string; kind: JobOutputKind; value: string }
  | {
      type: "held";
      reason: JobHoldReason;
      why: string | null;
      /** At a result gate: what the runner said came out. */
      result?: string;
    }
  | { type: "released"; answer: string | null }
  | { type: "done"; result: string }
  | { type: "failed"; why: string }
  | { type: "skipped"; why: string }
  | { type: "reopened"; why: string }
  | { type: "moved"; sessionId: string }
);

/** Who asks. The user and the engine may do what a job's runner may not. */
export type JobActor =
  | { kind: "session"; sessionId: string }
  | { kind: "user" }
  | { kind: "engine" };

export type JobCommand =
  | { type: "add"; specs: JobSpec[] }
  | { type: "start"; jobId: string; sessionId: string }
  | {
      type: "output";
      jobId: string;
      actor: JobActor;
      outputs: { name: string; value: string }[];
    }
  | {
      type: "done";
      jobId: string;
      actor: JobActor;
      result: string;
      outputs: { name: string; value: string }[];
    }
  | { type: "hold"; jobId: string; actor: JobActor; why: string }
  | { type: "release"; jobId: string; actor: JobActor; answer?: string }
  | { type: "fail"; jobId: string; actor: JobActor; why: string }
  | { type: "skip"; jobId: string; actor: JobActor; why: string }
  | { type: "redo"; jobId: string; actor: JobActor; why: string }
  | { type: "move"; from: string; to: string };

export type JobDecision =
  { ok: true; events: JobEvent[] } | { ok: false; reason: string };

const TERMINAL: readonly JobState[] = ["done", "failed", "skipped"];
/** Finished as far as what comes after is concerned. */
const SETTLED: readonly JobState[] = ["done", "skipped"];

export const isTerminalJob = (job: Job): boolean =>
  TERMINAL.includes(job.state);

/**
 * A job that only holds others: the engine finishes it, or it goes round.
 * Its session works on what is under it, never on the job itself.
 */
export const isContainerJob = (job: Pick<JobSpec, "auto" | "loop">): boolean =>
  job.auto || !!job.loop;

/** A job's children, in their order. */
export function jobChildren(tree: JobTree, parentId: string | null): Job[] {
  return [...tree.jobs.values()]
    .filter((job) => job.parentId === parentId)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/** What the tree is after an event. Returns the same tree, changed. */
export function evolve(tree: JobTree, event: JobEvent): JobTree {
  if (event.type === "added") {
    tree.jobs.set(event.spec.id, {
      ...event.spec,
      state: "pending",
      round: 1,
      sessionId: null,
      hold: null,
      approved: { start: false, result: false },
      outputs: [],
      result: null,
      why: null,
    });
    return tree;
  }
  const job = tree.jobs.get(event.jobId);
  if (!job) return tree;
  switch (event.type) {
    case "ready":
      job.state = "ready";
      job.hold = null;
      break;
    case "started":
      job.state = "running";
      job.sessionId = event.sessionId;
      break;
    case "output":
      job.outputs = [
        ...job.outputs.filter((output) => output.name !== event.name),
        { name: event.name, kind: event.kind, value: event.value },
      ];
      break;
    case "held":
      job.state = "held";
      job.hold = { reason: event.reason, why: event.why };
      if (event.result !== undefined) job.result = event.result;
      break;
    case "released": {
      const reason = job.hold?.reason;
      job.hold = null;
      if (reason === "start-gate") {
        job.approved.start = true;
        job.state = "ready";
      } else if (reason === "result-gate") {
        job.approved.result = true;
        job.state = "done";
      } else job.state = "running";
      break;
    }
    case "done":
      job.state = "done";
      job.result = event.result;
      break;
    case "failed":
      job.state = "failed";
      job.why = event.why;
      job.hold = null;
      break;
    case "skipped":
      job.state = "skipped";
      job.why = event.why;
      job.hold = null;
      break;
    case "reopened":
      job.state = "pending";
      job.round += 1;
      // A job a named session does stays with it. Any other gets its runner
      // again when it is started.
      job.sessionId =
        job.runner.kind === "session" ? job.runner.sessionId : null;
      job.hold = null;
      job.approved = { start: false, result: false };
      job.outputs = [];
      job.result = null;
      job.why = event.why;
      break;
    case "moved":
      job.sessionId = event.sessionId;
      if (job.runner.kind === "session")
        job.runner = { kind: "session", sessionId: event.sessionId };
      break;
  }
  return tree;
}

/** The tree a list of events makes, from nothing. */
export const replayJobs = (events: readonly JobEvent[]): JobTree =>
  events.reduce(evolve, emptyJobTree());

const cloneTree = (tree: JobTree): JobTree => ({
  jobs: new Map(
    [...tree.jobs].map(([id, job]) => [
      id,
      {
        ...job,
        approved: { ...job.approved },
        outputs: [...job.outputs],
        hold: job.hold ? { ...job.hold } : null,
        runner: { ...job.runner },
      },
    ]),
  ),
});

/** What is wrong with a value of a kind, as far as its text tells. */
export function jobOutputProblem(
  kind: JobOutputKind,
  value: string,
): string | null {
  const text = value.trim();
  if (!text) return "is empty";
  switch (kind) {
    case "number":
      return Number.isFinite(Number(text)) ? null : "is not a number";
    case "flag":
      return text === "true" || text === "false"
        ? null
        : "is neither true nor false";
    case "url":
      return /^https?:\/\/\S+$/.test(text) ? null : "is not a URL";
    case "commit":
      return /^\S+$/.test(text) ? null : "is not one branch or commit";
    case "text":
    case "file":
      return null;
  }
}

const sessionOf = (actor: JobActor): string | null =>
  actor.kind === "session" ? actor.sessionId : null;

/** Whether the actor is the job's runner, or stands above every runner. */
const runs = (job: Job, actor: JobActor): boolean =>
  actor.kind !== "session" || job.sessionId === actor.sessionId;

/**
 * Whether the actor may decide about the job: its runner, the runner of the
 * job it is under, the user or the engine.
 */
const decides = (tree: JobTree, job: Job, actor: JobActor): boolean => {
  if (runs(job, actor)) return true;
  const parent = job.parentId ? tree.jobs.get(job.parentId) : undefined;
  return !!parent && parent.sessionId === sessionOf(actor);
};

/**
 * The events that follow by the rules alone, applied to the tree as they are
 * found: a job whose needs are finished becomes ready, a ready job done in
 * its parent's session starts, a job the engine finishes is finished, and a
 * loop goes round.
 */
function settle(tree: JobTree): JobEvent[] {
  const events: JobEvent[] = [];
  const emit = (event: JobEvent) => {
    events.push(event);
    evolve(tree, event);
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const job of [...tree.jobs.values()]) {
      const parent = job.parentId ? tree.jobs.get(job.parentId) : undefined;
      const siblings = jobChildren(tree, job.parentId);
      if (job.state === "pending") {
        const open = !job.parentId || parent?.state === "running";
        const met = job.needs.every((need) => {
          const needed = siblings.find((item) => item.name === need);
          // A need that names no job holds nothing back.
          return !needed || SETTLED.includes(needed.state);
        });
        if (open && met) {
          emit(
            job.gate === "start" && !job.approved.start
              ? {
                  jobId: job.id,
                  type: "held",
                  reason: "start-gate",
                  why: null,
                }
              : { jobId: job.id, type: "ready" },
          );
          changed = true;
        }
      }
      if (
        job.state === "ready" &&
        job.runner.kind === "inline" &&
        parent?.state === "running" &&
        parent.sessionId &&
        // A job that only holds others takes none of the session's time.
        (isContainerJob(job) ||
          // One session does one job of a parent at a time, and a result
          // that waits for approval holds the next one back.
          (!siblings.some(
            (item) =>
              item.id !== job.id &&
              item.runner.kind === "inline" &&
              !isContainerJob(item) &&
              (item.state === "running" ||
                (item.state === "held" && item.hold?.reason !== "start-gate")),
          ) &&
            // The first ready one in order.
            siblings.find(
              (item) =>
                item.state === "ready" &&
                item.runner.kind === "inline" &&
                !isContainerJob(item),
            )?.id === job.id))
      ) {
        emit({ jobId: job.id, type: "started", sessionId: parent.sessionId });
        changed = true;
      }
      if (job.state === "running" && (job.auto || job.loop)) {
        const children = jobChildren(tree, job.id);
        const finished =
          children.length > 0 &&
          children.every((child) => isTerminalJob(child));
        if (finished && job.loop) {
          const from = Math.max(
            0,
            children.findIndex((child) => child.name === job.loop!.to),
          );
          for (const child of children.slice(from))
            emit({ jobId: child.id, type: "reopened", why: "next round" });
          changed = true;
        } else if (finished && job.auto) {
          const last = [...children]
            .reverse()
            .find((child) => child.state === "done");
          emit({
            jobId: job.id,
            type: "done",
            result: last?.result ?? "Nothing was done.",
          });
          changed = true;
        }
      }
    }
  }
  return events;
}

/**
 * The events that follow by the rules alone from a tree as it stands, such
 * as one put together from older records. The tree given is not changed.
 */
export const settleJobs = (tree: JobTree): JobEvent[] =>
  settle(cloneTree(tree));

/** The job and every job of its parent that needs it, through others too. */
function withDependents(tree: JobTree, job: Job): Job[] {
  const siblings = jobChildren(tree, job.parentId);
  const found = new Map<string, Job>([[job.id, job]]);
  for (let grew = true; grew;) {
    grew = false;
    for (const item of siblings) {
      if (found.has(item.id)) continue;
      const names = [...found.values()].map((one) => one.name);
      if (item.needs.some((need) => names.includes(need))) {
        found.set(item.id, item);
        grew = true;
      }
    }
  }
  return [...found.values()];
}

/** A cycle among the needs of one parent's jobs, as the names on it. */
function needCycle(jobs: readonly Pick<JobSpec, "name" | "needs">[]): string[] {
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const state = new Map<string, "open" | "closed">();
  const walk = (name: string, path: string[]): string[] => {
    if (state.get(name) === "closed") return [];
    if (state.get(name) === "open") return [...path, name];
    state.set(name, "open");
    for (const need of byName.get(name)?.needs ?? []) {
      if (!byName.has(need)) continue;
      const cycle = walk(need, [...path, name]);
      if (cycle.length) return cycle;
    }
    state.set(name, "closed");
    return [];
  };
  for (const job of jobs) {
    const cycle = walk(job.name, []);
    if (cycle.length) return cycle;
  }
  return [];
}

const refuse = (reason: string): JobDecision => ({ ok: false, reason });

/**
 * Whether a command may happen, and the events that record it together with
 * everything that follows by the rules. The tree given is not changed.
 */
export function decide(given: JobTree, command: JobCommand): JobDecision {
  const tree = cloneTree(given);
  const events: JobEvent[] = [];
  const emit = (event: JobEvent) => {
    events.push(event);
    evolve(tree, event);
  };
  const finish = (): JobDecision => {
    events.push(...settle(tree));
    return { ok: true, events };
  };
  const named = (id: string) => tree.jobs.get(id);

  if (command.type === "add") {
    if (!command.specs.length) return refuse("No job to add.");
    for (const spec of command.specs) {
      if (tree.jobs.has(spec.id) || !spec.id)
        return refuse(`The job id "${spec.id}" is taken.`);
      if (!spec.name.trim()) return refuse("A job needs a name.");
      const parent = spec.parentId ? named(spec.parentId) : undefined;
      if (spec.parentId && !parent)
        return refuse(`"${spec.name}" is under a job that does not exist.`);
      if (parent && isTerminalJob(parent))
        return refuse(
          `"${parent.title}" is ${parent.state}. Redo it before adding "${spec.name}" under it.`,
        );
      if (parent?.hold?.reason === "result-gate")
        return refuse(
          `"${parent.title}" waits for the user's approval. Nothing is added under it until then.`,
        );
      if (
        jobChildren(tree, spec.parentId).some((job) => job.name === spec.name)
      )
        return refuse(
          `"${parent?.title ?? "The top"}" already has a job named "${spec.name}".`,
        );
      const names = new Set(spec.gives.map((give) => give.name));
      if (names.size !== spec.gives.length || names.has("result"))
        return refuse(
          `"${spec.name}" gives one output twice, or one named "result", which every job gives.`,
        );
      emit({ jobId: spec.id, type: "added", spec });
    }
    for (const parentId of new Set(
      command.specs.map((spec) => spec.parentId),
    )) {
      const cycle = needCycle(jobChildren(tree, parentId));
      if (cycle.length)
        return refuse(`These jobs need each other: ${cycle.join(" -> ")}.`);
    }
    return finish();
  }

  if (command.type === "move") {
    for (const job of tree.jobs.values())
      if (job.sessionId === command.from)
        emit({ jobId: job.id, type: "moved", sessionId: command.to });
    return finish();
  }

  const job = named(command.jobId);
  if (!job) return refuse("There is no such job.");
  const label = `"${job.title}"`;

  switch (command.type) {
    case "start":
      if (job.state !== "ready")
        return refuse(`${label} is ${job.state}, not ready to start.`);
      emit({ jobId: job.id, type: "started", sessionId: command.sessionId });
      return finish();

    case "output":
    case "done": {
      if (job.state !== "running")
        return refuse(
          job.hold?.reason === "result-gate"
            ? `${label} waits for the user's approval.`
            : `${label} is ${job.state}, not running.`,
        );
      if (!runs(job, command.actor))
        return refuse(`${label} is another session's job.`);
      for (const output of command.outputs) {
        const give = job.gives.find((item) => item.name === output.name);
        const kind = give?.kind ?? "text";
        if (!output.name.trim() || output.name === "result")
          return refuse(
            `An output needs a name, and "result" is given with the result text.`,
          );
        const problem = jobOutputProblem(kind, output.value);
        if (problem)
          return refuse(`The output "${output.name}" (${kind}) ${problem}.`);
        emit({
          jobId: job.id,
          type: "output",
          name: output.name,
          kind,
          value: output.value.trim(),
        });
      }
      if (command.type === "output") return finish();
      if (!command.result.trim())
        return refuse(`Say what came out of ${label}: its result.`);
      const missing = job.gives.filter(
        (give) => !job.outputs.some((output) => output.name === give.name),
      );
      if (missing.length)
        return refuse(
          `${label} must hand over ${missing
            .map((give) => `${give.name} (${give.kind})`)
            .join(", ")}.`,
        );
      const children = jobChildren(tree, job.id);
      if (job.loop) {
        // Finishing a job that loops is how its rounds end.
        for (const child of children)
          if (!isTerminalJob(child))
            emit({ jobId: child.id, type: "skipped", why: "The loop ended." });
      } else {
        const open = children.filter((child) => !SETTLED.includes(child.state));
        if (open.length)
          return refuse(
            `${label} is not done while these are not: ${open
              .map((child) => `${child.title} (${child.state})`)
              .join(", ")}. Wait for them, skip them or retry them.`,
          );
      }
      emit(
        job.gate === "result" && !job.approved.result
          ? {
              jobId: job.id,
              type: "held",
              reason: "result-gate",
              why: null,
              result: command.result.trim(),
            }
          : { jobId: job.id, type: "done", result: command.result.trim() },
      );
      return finish();
    }

    case "hold":
      if (job.state !== "running")
        return refuse(`${label} is ${job.state}, not running.`);
      if (!runs(job, command.actor))
        return refuse(`${label} is another session's job.`);
      if (!command.why.trim()) return refuse("Say what you need decided.");
      emit({
        jobId: job.id,
        type: "held",
        reason: "hold",
        why: command.why.trim(),
      });
      return finish();

    case "release":
      if (job.state !== "held")
        return refuse(`${label} is ${job.state}. Nothing waits there.`);
      if (command.actor.kind === "session")
        return refuse(
          `Only the user releases ${label}. Ask them in the conversation.`,
        );
      emit({
        jobId: job.id,
        type: "released",
        answer: command.answer?.trim() || null,
      });
      return finish();

    case "fail":
      if (isTerminalJob(job))
        return refuse(`${label} is already ${job.state}.`);
      if (!decides(tree, job, command.actor))
        return refuse(`${label} is another session's job.`);
      emit({ jobId: job.id, type: "failed", why: command.why.trim() });
      return finish();

    case "skip": {
      if (SETTLED.includes(job.state))
        return refuse(`${label} is already ${job.state}.`);
      if (!decides(tree, job, command.actor))
        return refuse(`${label} is another session's job.`);
      if (!command.why.trim()) return refuse(`Say why ${label} is skipped.`);
      const under = (id: string): Job[] =>
        jobChildren(tree, id).flatMap((child) => [child, ...under(child.id)]);
      for (const item of [job, ...under(job.id)])
        if (!SETTLED.includes(item.state))
          emit({
            jobId: item.id,
            type: "skipped",
            why:
              item.id === job.id
                ? command.why.trim()
                : `"${job.title}" was skipped.`,
          });
      return finish();
    }

    case "redo": {
      const waits = job.hold?.reason === "result-gate";
      if (!isTerminalJob(job) && !waits)
        return refuse(
          `${label} is ${job.state}. Only finished work is redone.`,
        );
      if (!decides(tree, job, command.actor))
        return refuse(`${label} is another session's job.`);
      if (!command.why.trim()) return refuse(`Say why ${label} is redone.`);
      const reopened = new Set<string>();
      const reopen = (from: Job, why: string): void => {
        // What is over a redone job is no longer finished either.
        const parent = from.parentId ? named(from.parentId) : undefined;
        if (
          parent &&
          !reopened.has(parent.id) &&
          (isTerminalJob(parent) || parent.hold?.reason === "result-gate")
        )
          reopen(parent, `"${from.title}" under it is redone.`);
        for (const item of withDependents(tree, from)) {
          if (reopened.has(item.id)) continue;
          if (item.id !== from.id && item.state === "pending") continue;
          reopened.add(item.id);
          emit({
            jobId: item.id,
            type: "reopened",
            why: item.id === from.id ? why : `"${from.title}" is redone.`,
          });
        }
      };
      reopen(job, command.why.trim());
      return finish();
    }
  }
}

/**
 * The job a session is on: the deepest one it runs, or one of its own that
 * is held. A job that only holds others is never it. Undefined when it has
 * none open.
 */
export function currentJob(tree: JobTree, sessionId: string): Job | undefined {
  const depth = (job: Job): number => {
    let count = 0;
    for (
      let at = job.parentId ? tree.jobs.get(job.parentId) : undefined;
      at;
      at = at.parentId ? tree.jobs.get(at.parentId) : undefined
    )
      count += 1;
    return count;
  };
  const mine = [...tree.jobs.values()].filter(
    (job) =>
      job.sessionId === sessionId &&
      !isContainerJob(job) &&
      (job.state === "running" || job.state === "held"),
  );
  // What is held under a running job is where the session stands.
  return mine.sort((a, b) => depth(b) - depth(a))[0];
}

/** The jobs a job is given the outputs of: the ones it needs, in order. */
export function jobInputs(tree: JobTree, job: Job): Job[] {
  const siblings = jobChildren(tree, job.parentId);
  return job.needs.flatMap((need) => {
    const found = siblings.find((item) => item.name === need);
    return found && found.state === "done" ? [found] : [];
  });
}

/**
 * What a job's runner is told: what to do, what it is given, and what it
 * hands over. The whole of it comes from the tree, so it reads the same to
 * an agent that takes the job over.
 */
export function jobBrief(tree: JobTree, jobId: string): string {
  const job = tree.jobs.get(jobId);
  if (!job) return "";
  const parent = job.parentId ? tree.jobs.get(job.parentId) : undefined;
  const siblings = jobChildren(tree, job.parentId);
  const place = parent
    ? ` (${siblings.findIndex((item) => item.id === job.id) + 1} of ${siblings.length} in "${parent.title}")`
    : "";
  const lines = [
    `Your job: ${job.title}${place}.`,
    ...(job.round > 1 ? [`This is round ${job.round}: ${job.why ?? ""}`] : []),
    "",
    job.instructions.trim() || "(no further instructions)",
  ];
  const inputs = jobInputs(tree, job);
  if (inputs.length) {
    lines.push("", "What you are given:");
    for (const input of inputs) {
      lines.push(`  from ${input.name}:`);
      for (const output of input.outputs)
        lines.push(`    ${output.name} = ${output.value}`);
      lines.push(`    result = ${input.result ?? ""}`);
    }
  }
  const outs = job.gives.map((give) => `--out ${give.name}=<${give.kind}>`);
  lines.push(
    "",
    job.gives.length
      ? `Hand over when done: ${job.gives.map((give) => `${give.name} (${give.kind})`).join(", ")}.`
      : "When done, say what came out.",
    `  daedal job done ${[...outs, '--result "<what came out>"'].join(" ")}`,
    "Stuck, or a decision is not yours:",
    '  daedal job hold --why "<what you need>"',
  );
  if (job.gate === "result")
    lines.push(
      "The user approves this job's result. After `job done`, show them what to approve and stop.",
    );
  return lines.join("\n");
}

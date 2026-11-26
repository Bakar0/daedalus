import { readFile } from "node:fs/promises";
import {
  DaedalusError,
  JOB_OUTPUT_KINDS,
  jobChildren,
  type ApplicationContext,
  type Job,
  type JobDraft,
  type JobGive,
  type JobState,
  type JobTree,
} from "@daedalus/core";
import { expectPositionals, parseArguments, printResult } from "./arguments";

export const jobHelp = `Job commands. A job is one piece of work with an owner: a workflow step, a
plan task, something you were asked to do. Jobs form a tree, and Daedalus
hands you one at a time.

  daedal job next
  daedal job done --result "<what came out>" [--out <name>=<value> ...] [--job <name>]
  daedal job hold --why "<what you need decided>"
  daedal job add "<title>" [--name <name>] [--needs <a,b>] [--gives <x:kind,y>]
                 [--instructions "<text>" | --file <path>] [--gate start|result]
                 [--me | --to <session>] [--under <job>]
  daedal job add --plan <plan>
  daedal job skip <job> --why "<why>"
  daedal job redo <job> --why "<why>"
  daedal job retry <job>
  daedal job fail --why "<why>"
  daedal job tree
  daedal job approve
  daedal job release [<job>] [--answer "<the user's answer>"]

Every command takes --session <id> to act for another session, as a lead
does for a team member, and --json.

'next' prints your current job's brief again: what to do, what the jobs
before it handed you, and what you hand over.
'done' finishes your current job. Every output the brief lists goes in an
--out; --result says in a line what came out. It prints your next job's
brief when you run the next one. A job the user approves is held instead
(exit code 4): show them the result, ask in the conversation, and stop.
--job names another job of yours, which is how a workflow that goes round
is ended.
'hold' stops your job until the user decides something, and shows them
that you wait.
'add' puts a job under the one you are on. A new agent is started for it
unless --me keeps it in this session or --to gives it to a session that
runs already. --needs names jobs beside it that must finish first. --plan
adds every task of a plan file; its '## Flow' says which task needs which.
'skip' closes a job that will not be done, with everything under it.
'redo' puts finished work back to be done again, together with what needed
it. 'retry' is 'redo' for a job that failed.
'approve' passes the gate your session waits at, and 'release' answers a
hold. Run either only on the user's word.

<job> is a name as 'daedal job tree' prints it in brackets, or an id.
Kinds of output: ${JOB_OUTPUT_KINDS.join(", ")}.`;

const MARK: Record<JobState, string> = {
  pending: "·",
  ready: "○",
  running: "▶",
  held: "⏸",
  done: "✓",
  failed: "✗",
  skipped: "-",
};

/**
 * A job tree as lines: a mark, the title, the name in brackets, who does
 * it, and what came out. `here` is the job the reader is on.
 */
export function jobTreeLines(
  tree: JobTree,
  options: { here?: string; sessionName?: (id: string) => string } = {},
): string[] {
  const lines: string[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const job of jobChildren(tree, parentId)) {
      const parent = job.parentId ? tree.jobs.get(job.parentId) : undefined;
      const indent = "  ".repeat(depth);
      const tags = [
        job.gate ? `gate: ${job.gate}` : "",
        job.round > 1 ? `round ${job.round}` : "",
        job.loop ? "goes round" : "",
        job.state === "held"
          ? job.hold?.reason === "hold"
            ? "waits for the user"
            : "waits for approval"
          : "",
        // Named only where another session does it than the job above.
        job.sessionId && job.sessionId !== parent?.sessionId
          ? `@${options.sessionName?.(job.sessionId) ?? job.sessionId.slice(0, 8)}`
          : "",
      ]
        .filter(Boolean)
        .map((tag) => ` (${tag})`)
        .join("");
      const said =
        job.state === "held"
          ? (job.hold?.why ?? job.result)
          : job.state === "done"
            ? job.result
            : job.state === "failed" || job.state === "skipped"
              ? job.why
              : null;
      lines.push(
        `${indent}${MARK[job.state]} ${job.title}${job.name === job.title ? "" : ` [${job.name}]`}${tags}${said ? ` — ${said}` : ""}${job.id === options.here ? "  ←" : ""}`,
      );
      if (job.state === "done")
        for (const output of job.outputs)
          lines.push(`${indent}    ${output.name} = ${output.value}`);
      walk(job.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines;
}

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

function gives(value: string | undefined): JobGive[] {
  return list(value).map((entry) => {
    const [name = "", kindText = "text"] = entry
      .split(":")
      .map((part) => part.trim());
    const kind = JOB_OUTPUT_KINDS.find((item) => item === kindText);
    if (!name || !kind)
      throw new DaedalusError(
        "VALIDATION",
        `--gives takes names with a kind, such as branch:commit,tests:number. The kinds are ${JOB_OUTPUT_KINDS.join(", ")}.`,
      );
    return { name, kind };
  });
}

/** Takes every `--out name=value` out of the arguments. */
function takeOutputs(args: string[]): { name: string; value: string }[] {
  const outputs: { name: string; value: string }[] = [];
  for (let index = 0; index < args.length;) {
    if (args[index] !== "--out") {
      index += 1;
      continue;
    }
    const pair = args[index + 1] ?? "";
    const equals = pair.indexOf("=");
    if (equals < 1)
      throw new DaedalusError(
        "VALIDATION",
        "--out takes <name>=<value>, such as --out tests=57",
      );
    outputs.push({
      name: pair.slice(0, equals).trim(),
      value: pair.slice(equals + 1),
    });
    args.splice(index, 2);
  }
  return outputs;
}

/** What an agent is told when its job waits at its result gate. */
const approvalText = (job: Job, member: boolean): string =>
  member
    ? `"${job.title}" waits for the user's approval. Tag @lead with what to approve and stop. The lead runs \`daedal job approve --session <your id>\` on the user's word.`
    : `"${job.title}" waits for the user's approval. Show them what came out, ask in the conversation, and end your turn. When they approve, run \`daedal job approve\`. When they want changes, run \`daedal job redo ${job.name} --why "<what to change>"\`.`;

export async function jobCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
  currentSessionId: (explicit?: string) => Promise<string>,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help" || action === "--help") {
    console.log(jobHelp);
    return 0;
  }
  const outputs = takeOutputs(args);
  const parsed = parseArguments(
    args,
    [
      "session",
      "result",
      "why",
      "job",
      "name",
      "needs",
      "gives",
      "instructions",
      "file",
      "gate",
      "to",
      "under",
      "plan",
      "answer",
    ],
    ["me"],
  );
  const { jobs } = context;
  const sessionId = await currentSessionId(parsed.values.session);
  const sessionName = (id: string) =>
    context.repositories.findAgent(id)?.name ?? id.slice(0, 8);
  const why = (usage: string): string => {
    const text = parsed.values.why?.trim();
    if (!text) throw new DaedalusError("VALIDATION", `Usage: ${usage}`);
    return text;
  };
  const printTree = (tree: JobTree) => {
    const here = jobs.current(sessionId)?.job.id;
    for (const line of jobTreeLines(tree, {
      sessionName,
      ...(here ? { here } : {}),
    }))
      console.log(line);
  };

  if (action === "next") {
    expectPositionals(parsed.positionals, 0, "daedal job next");
    const current = jobs.current(sessionId);
    const held = jobs.held(sessionId);
    printResult({ job: current?.job ?? null, held: held ?? null }, json, () => {
      if (held)
        console.log(
          held.hold?.reason === "hold"
            ? `"${held.title}" waits for the user: ${held.hold.why ?? ""}`
            : approvalText(held, Boolean(context.teams.memberOf(sessionId))),
        );
      else if (current) console.log(jobs.brief(sessionId));
      else
        console.log(
          "This session has no open job. Start a workflow with `daedal workflow start`, or add a job with `daedal job add`.",
        );
    });
    return 0;
  }

  if (action === "done") {
    const usage =
      'daedal job done --result "<what came out>" [--out <name>=<value> ...]';
    expectPositionals(parsed.positionals, 0, usage);
    const result = parsed.values.result?.trim();
    if (!result) throw new DaedalusError("VALIDATION", `Usage: ${usage}`);
    const handed = await jobs.done(sessionId, {
      result,
      outputs,
      ...(parsed.values.job ? { jobId: parsed.values.job } : {}),
    });
    if (handed.job.state === "held") {
      // A waiting gate fails the command, so whatever was chained after it
      // with && does not run.
      throw new DaedalusError(
        "CONFLICT",
        approvalText(handed.job, Boolean(context.teams.memberOf(sessionId))),
        { jobId: handed.job.id },
      );
    }
    printResult(handed, json, () => {
      console.log(`✓ ${handed.job.title}`);
      if (handed.next) console.log(`\n${handed.next}`);
      else {
        const current = jobs.current(sessionId);
        console.log(
          current
            ? `You are back on "${current.job.title}". \`daedal job tree\` shows what is left under it.`
            : "This session has no open job left.",
        );
      }
    });
    return 0;
  }

  if (action === "hold") {
    expectPositionals(parsed.positionals, 0, "daedal job hold --why <text>");
    const job = await jobs.hold(
      sessionId,
      why('daedal job hold --why "<what you need decided>"'),
    );
    printResult({ job }, json, () =>
      console.log(
        `"${job.title}" waits for the user. Ask them in the conversation and end your turn. On their answer, run \`daedal job release --answer "<their answer>"\`.`,
      ),
    );
    return 0;
  }

  if (action === "fail") {
    expectPositionals(parsed.positionals, 0, "daedal job fail --why <text>");
    const current = jobs.current(sessionId);
    if (!current)
      throw new DaedalusError("NOT_FOUND", "This session has no open job.");
    const job = await jobs.fail(
      current.job.id,
      sessionId,
      why('daedal job fail --why "<why it cannot be done>"'),
    );
    printResult({ job }, json, () => console.log(`✗ ${job.title}`));
    return 0;
  }

  if (action === "add") {
    if (parsed.values.plan !== undefined) {
      expectPositionals(parsed.positionals, 0, "daedal job add --plan <plan>");
      const session = await context.agents.get(sessionId);
      const file = await context.plans.find(
        { workspace: session.workspaceId },
        parsed.values.plan,
      );
      const added = await context.jobIntake.addPlan({ sessionId, file });
      printResult({ jobs: added }, json, () => {
        if (!added.length)
          console.log(
            "Every task of the plan is a job already, or is a draft, closed, or owned by no session.",
          );
        for (const job of added)
          console.log(`${MARK[job.state]} ${job.title} [${job.name}]`);
        if (added.length)
          console.log(
            "Daedalus starts each task when what it needs is done, and tells you when one finishes, fails or waits.",
          );
        // A task of the caller's own that started: its brief, since no
        // message brings it.
        if (
          added.some(
            (job) => job.state === "running" && job.sessionId === sessionId,
          )
        )
          console.log(`\n${jobs.brief(sessionId)}`);
      });
      return 0;
    }
    const usage = 'daedal job add "<title>" [--needs <a,b>] [--me]';
    expectPositionals(parsed.positionals, 1, usage);
    const title = parsed.positionals[0]!.trim();
    if (parsed.flags.has("me") && parsed.values.to)
      throw new DaedalusError("VALIDATION", "Pass --me or --to, not both");
    const gate = parsed.values.gate;
    if (gate !== undefined && gate !== "start" && gate !== "result")
      throw new DaedalusError("VALIDATION", "--gate is start or result");
    const name =
      parsed.values.name?.trim() ||
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) ||
      "job";
    const draft: JobDraft = {
      name,
      title,
      instructions: parsed.values.file
        ? await readFile(parsed.values.file, "utf8")
        : (parsed.values.instructions ?? ""),
      needs: list(parsed.values.needs),
      gives: gives(parsed.values.gives),
      gate: gate ?? null,
      runner: parsed.flags.has("me")
        ? { kind: "inline" }
        : parsed.values.to
          ? {
              kind: "session",
              sessionId: (await context.agents.get(parsed.values.to)).id,
            }
          : { kind: "agent" },
    };
    const parent = parsed.values.under
      ? jobs.find(sessionId, parsed.values.under)
      : await context.jobIntake.standing(sessionId);
    const [job] = await jobs.add(parent.id, [draft], sessionId);
    printResult({ job: job ?? null }, json, () => {
      if (!job) return;
      console.log(
        `${MARK[job.state]} ${job.title} [${job.name}] under "${parent.title}"${job.sessionId && job.sessionId !== sessionId ? `, done by @${sessionName(job.sessionId)}` : ""}`,
      );
      if (job.state === "running" && job.sessionId === sessionId)
        console.log(`\n${jobs.brief(sessionId)}`);
    });
    return 0;
  }

  if (action === "skip" || action === "redo" || action === "retry") {
    const usage =
      action === "retry"
        ? "daedal job retry <job>"
        : `daedal job ${action} <job> --why "<why>"`;
    expectPositionals(parsed.positionals, 1, usage);
    const target = jobs.find(sessionId, parsed.positionals[0]!);
    if (action === "retry" && target.state !== "failed")
      throw new DaedalusError(
        "CONFLICT",
        `"${target.title}" is ${target.state}, not failed. Finished work is done again with \`daedal job redo ${target.name} --why "<why>"\`.`,
      );
    const job =
      action === "skip"
        ? await jobs.skip(target.id, sessionId, why(usage))
        : await jobs.redo(
            target.id,
            sessionId,
            action === "retry"
              ? parsed.values.why?.trim() || "Run again after it failed."
              : why(usage),
          );
    const after = jobs.tree(jobs.rootOf(job.id)).tree.jobs.get(job.id) ?? job;
    printResult({ job: after }, json, () => {
      console.log(`${MARK[after.state]} ${after.title} is ${after.state}`);
      if (after.state === "running" && after.sessionId === sessionId)
        console.log(`\n${jobs.brief(sessionId)}`);
    });
    return 0;
  }

  if (action === "tree") {
    expectPositionals(parsed.positionals, 0, "daedal job tree");
    const current = jobs.current(sessionId);
    const started = context.repositories.jobs.jobOfSession(sessionId);
    const rootId = current
      ? jobs.rootOf(current.job.id)
      : (context.repositories.jobs.rootsOfSession(sessionId)[0] ??
        (started ? jobs.rootOf(started) : undefined));
    if (!rootId) {
      printResult({ jobs: [] }, json, () =>
        console.log("This session has no jobs."),
      );
      return 0;
    }
    const { tree } = jobs.tree(rootId);
    printResult({ jobs: [...tree.jobs.values()] }, json, () => printTree(tree));
    return 0;
  }

  if (action === "approve" || action === "release") {
    const usage =
      action === "approve"
        ? "daedal job approve [--session <id>]"
        : 'daedal job release [<job>] [--answer "<the user\'s answer>"]';
    expectPositionals(
      parsed.positionals,
      action === "release" && parsed.positionals.length ? 1 : 0,
      usage,
    );
    const target = parsed.positionals[0]
      ? jobs.find(sessionId, parsed.positionals[0])
      : jobs.held(sessionId);
    if (!target || target.state !== "held")
      throw new DaedalusError(
        "CONFLICT",
        "Nothing of this session waits for the user.",
      );
    if (action === "approve" && target.hold?.reason === "hold")
      throw new DaedalusError(
        "CONFLICT",
        `"${target.title}" waits for an answer, not an approval: ${target.hold.why ?? ""} Pass it on with \`daedal job release --answer "<the user's answer>"\`.`,
      );
    const handed = await jobs.release(
      target.id,
      sessionId,
      parsed.values.answer,
    );
    printResult(handed, json, () => {
      console.log(
        `${MARK[handed.job.state]} ${handed.job.title} is ${handed.job.state}`,
      );
      if (handed.next) console.log(`\n${handed.next}`);
      else if (
        handed.job.state === "running" &&
        handed.job.sessionId === sessionId
      )
        console.log(`\n${jobs.brief(sessionId)}`);
    });
    return 0;
  }

  throw new DaedalusError(
    "VALIDATION",
    `Unknown job command '${action}'. Run \`daedal job help\`.`,
  );
}

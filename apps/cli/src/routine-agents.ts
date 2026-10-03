import { resolve } from "node:path";
import {
  DaedalusError,
  formatDuration,
  parseDuration,
  type ApplicationContext,
  type RoutineAgent,
  type RoutineReport,
  type RoutineReportState,
  type RoutineRun,
  type RoutineView,
  type Task,
} from "@daedalus/core";
import {
  expectPositionals,
  parseArguments,
  printResult,
  required,
} from "./arguments";

export const routineAgentHelp = {
  "routine-agent": `Routine agent commands:
  daedal agent spawn --workspace <workspace> --routine-agent --name <name> [--model <model>]
  daedal routine-agent list [--workspace <workspace>]
  daedal routine-agent get [<agent>] [--workspace <workspace>]
  daedal routine-agent pause|resume [<agent>] [--workspace <workspace>]
  daedal routine-agent update [<agent>] [--name <name>] [--model <model>|none]
      [--auto-handoff <percent>] [--workspace <workspace>]
  daedal routine-agent remove <agent> --force [--workspace <workspace>]

A routine agent is a Claude session in an ordinary workspace that runs
routines on a clock the desktop app keeps. The user names it and gives it its
purpose by asking it for routines. It lives in
<workspace>/worktrees/agents/<name>, with AGENT.md, its routines/ folder and
its skills, and that folder never moves, so its memory carries across
handoffs. Its reports become tasks on the workspace's board.
'pause' stops delivery and 'resume' starts it again; archiving the agent's
session pauses it, and restoring the session resumes it. It hands off at
--auto-handoff percent of its context (60 by default). 'remove' forgets the
agent and archives its session; its folder and its tasks stay. Routines run
only while the app is open.`,
  routine: `Routine commands:
  daedal routine add [--agent <a>] --file <path|-> [--replace]
  daedal routine add [--agent <a>] --from <template> [--name <name>]
      [--var <key>=<value>]... [--until <+60m|date>] [--schedule <schedule>] [--disabled]
  daedal routine list [--agent <a>]
  daedal routine get <name> [--agent <a>]
  daedal routine enable|disable|run|remove <name> [--agent <a>]
  daedal routine runs [--routine <name>] [--limit <n>] [--agent <a>]
  daedal routine start <run-id>
  daedal routine done <run-id> --outcome quiet|notified|task --summary <text>
  daedal routine fail <run-id> --summary <text>
  daedal routine report --run <run-id> --key <key> --title <title> [--urgent]
      [--url <url>] [--same-as <key>] (--body <text> | --body-file <path|->)
  daedal routine resolve <key> [--agent <a>]
  daedal routine reports [--state open|resolved|closed|all] [--since <7d>] [--agent <a>]
  daedal routine feedback <task-ref> useful|noise|none [--note <text>]

Every command takes --workspace <workspace> to tell two agents of the same
name apart. Inside a routine agent's own session, --agent defaults to it.

A routine is a Markdown file in the agent's routines/ folder: frontmatter with
name, schedule (every <n>m, cron "<5 fields>", at <date and time>), until,
model, timeout, output (task, notify or none), enabled and vars, and the
prompt as the body. Files in routines/templates/ never fire; 'add --from'
copies one with its vars filled in. 'run' queues a run now. 'start', 'done',
'fail', 'report' and 'resolve' are for the agent itself, when Daedalus types
/daedalus-routine <run-id>.

'report' is the only way a routine raises something. The key identifies what
is reported, so a key that is open becomes an update to its task and sends no
second notification; one that comes back within 14 days reopens its task;
--same-as adds the report to another open report's task. A routine with
output: task opens a task on the workspace's board; output: notify only
notifies. --urgent gets through Focus mode.
'resolve' marks a key gone. A resolved report closes after 24 hours, and its
task moves to done if no agent was ever started on it.
'feedback noise' closes the task's reports and stops their keys from raising
anything again; 'feedback none' undoes it. A task the user moves to done
counts as useful. 'reports --since 7d --state all' is what a weekly review
reads.`,
};

async function agentFor(
  context: ApplicationContext,
  values: Record<string, string>,
  reference = values.agent,
): Promise<RoutineAgent> {
  const workspaceId = values.workspace
    ? (await context.workspaces.get(values.workspace)).id
    : undefined;
  return context.routineAgents.resolve(
    reference,
    process.env.DAEDALUS_SESSION_ID,
    workspaceId,
  );
}

async function textOption(
  values: Record<string, string>,
  name: string,
): Promise<string | undefined> {
  const file = values[`${name}-file`];
  if (file === undefined) return values[name];
  if (values[name] !== undefined)
    throw new DaedalusError(
      "VALIDATION",
      `Use either --${name} or --${name}-file, not both`,
    );
  if (file === "-") return Bun.stdin.text();
  const source = Bun.file(resolve(file));
  if (!(await source.exists()))
    throw new DaedalusError("NOT_FOUND", `File '${file}' was not found`);
  return source.text();
}

function runId(value: string | undefined, usage: string): number {
  const id = Number(value);
  if (!value || !Number.isInteger(id) || id < 1)
    throw new DaedalusError("VALIDATION", `Usage: ${usage}`);
  return id;
}

/** `--var` repeats, which the shared parser refuses, so it is taken first. */
function takeVars(args: string[]): {
  rest: string[];
  vars: Record<string, string>;
} {
  const rest: string[] = [];
  const vars: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--var") {
      rest.push(args[index]!);
      continue;
    }
    const pair = args[index + 1];
    const split = pair?.indexOf("=") ?? -1;
    if (!pair || split < 1)
      throw new DaedalusError("VALIDATION", "--var takes <key>=<value>");
    vars[pair.slice(0, split)] = pair.slice(split + 1);
    index += 1;
  }
  return { rest, vars };
}

const localTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const agentLine = (agent: RoutineAgent, workspaceSlug?: string) =>
  `${agent.name}\t${agent.state}\t${workspaceSlug ?? agent.workspaceId}\tsession ${agent.sessionId ?? "—"}`;

const runLine = (run: RoutineRun) =>
  `${run.id}\t${run.routine}\t${run.status}${run.outcome ? ` (${run.outcome})` : ""}\t${localTime(run.queuedAt)}${run.summary ? `\t${run.summary}` : ""}`;

const reportLine = (report: RoutineReport, taskNumber?: number) =>
  `${report.id}\t${report.state}${report.urgent ? "\turgent" : ""}\t${report.verdict ?? "—"}\t${report.key}${taskNumber ? `\ttask #${taskNumber}` : ""}\t${report.title}`;

function routineLine(view: RoutineView): string {
  const { routine, state, lastRun } = view;
  return [
    routine.name,
    routine.enabled ? "on" : "off",
    routine.schedule.text,
    `next ${routine.enabled ? localTime(state?.nextRunAt) : "—"}`,
    `last ${lastRun ? `${localTime(lastRun.queuedAt)} ${lastRun.status}${lastRun.outcome ? ` (${lastRun.outcome})` : ""}` : "never"}`,
  ].join("\t");
}

export async function routineAgentCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help") {
    console.log(routineAgentHelp["routine-agent"]);
    return 0;
  }
  const slugOf = (workspaceId: string) =>
    context.repositories.findWorkspace(workspaceId)?.slug;
  if (action === "list") {
    const parsed = parseArguments(args, ["workspace"]);
    expectPositionals(parsed.positionals, 0, "daedal routine-agent list");
    const workspaceId = parsed.values.workspace
      ? (await context.workspaces.get(parsed.values.workspace)).id
      : undefined;
    const agents = context.routineAgents.list(workspaceId);
    printResult({ routineAgents: agents }, json, () => {
      if (!agents.length) console.log("No routine agents.");
      for (const agent of agents)
        console.log(agentLine(agent, slugOf(agent.workspaceId)));
    });
    return 0;
  }
  if (action === "get") {
    const parsed = parseArguments(args, ["workspace"]);
    const agent = await agentFor(context, parsed.values, parsed.positionals[0]);
    const folder = await context.routineAgents.folder(agent);
    const inFlight = context.routines.inFlightRuns(agent);
    const open = context.repositories.routineAgents.listRoutineReports(
      agent.id,
      { states: ["open"] },
    );
    printResult(
      { routineAgent: agent, folder, inFlight, openReports: open.length },
      json,
      () => {
        console.log(agentLine(agent, slugOf(agent.workspaceId)));
        console.log(folder);
        console.log(
          `runs in flight ${inFlight.filter((run) => run.deliveredAt).length} · queued ${inFlight.filter((run) => !run.deliveredAt).length} · open reports ${open.length} · hands off at ${agent.autoHandoffPercent}%`,
        );
      },
    );
    return 0;
  }
  if (action === "pause" || action === "resume") {
    const parsed = parseArguments(args, ["workspace"]);
    const reference = (
      await agentFor(context, parsed.values, parsed.positionals[0])
    ).id;
    const agent =
      action === "pause"
        ? context.routineAgents.pause(reference)
        : await context.routineAgents.resume(reference);
    printResult({ routineAgent: agent }, json, () =>
      console.log(agentLine(agent, slugOf(agent.workspaceId))),
    );
    return 0;
  }
  if (action === "remove") {
    const parsed = parseArguments(args, ["workspace"], ["force"]);
    expectPositionals(
      parsed.positionals,
      1,
      "daedal routine-agent remove <agent> --force",
    );
    const reference = (
      await agentFor(context, parsed.values, parsed.positionals[0])
    ).id;
    const agent = await context.routineAgents.remove(reference, {
      force: parsed.flags.has("force"),
    });
    printResult({ routineAgent: agent }, json, () =>
      console.log(
        `Removed routine agent ${agent.name}; its folder and tasks are kept`,
      ),
    );
    return 0;
  }
  if (action === "update") {
    const parsed = parseArguments(args, [
      "workspace",
      "name",
      "model",
      "auto-handoff",
    ]);
    const reference = (
      await agentFor(context, parsed.values, parsed.positionals[0])
    ).id;
    const percent = parsed.values["auto-handoff"];
    const agent = context.routineAgents.update(reference, {
      ...(parsed.values.name ? { name: parsed.values.name } : {}),
      ...(parsed.values.model !== undefined
        ? { model: parsed.values.model === "none" ? null : parsed.values.model }
        : {}),
      ...(percent !== undefined ? { autoHandoffPercent: Number(percent) } : {}),
    });
    printResult({ routineAgent: agent }, json, () =>
      console.log(agentLine(agent, slugOf(agent.workspaceId))),
    );
    return 0;
  }
  throw new DaedalusError(
    "VALIDATION",
    `Unknown routine-agent command '${action}'`,
  );
}

export async function routineCommand(
  context: ApplicationContext,
  inputArgs: string[],
  json: boolean,
  resolveTask: (reference: string) => Promise<Task>,
): Promise<number> {
  const action = inputArgs.shift();
  if (!action || action === "help") {
    console.log(routineAgentHelp.routine);
    return 0;
  }
  if (action === "add") {
    const { rest, vars } = takeVars(inputArgs);
    const parsed = parseArguments(
      rest,
      ["agent", "workspace", "file", "from", "name", "until", "schedule"],
      ["replace", "disabled"],
    );
    expectPositionals(parsed.positionals, 0, "daedal routine add ...");
    const agent = await agentFor(context, parsed.values);
    const file = parsed.values.file;
    const template = parsed.values.from;
    if (Boolean(file) === Boolean(template))
      throw new DaedalusError(
        "VALIDATION",
        "Pass exactly one of --file <path|-> or --from <template>",
      );
    const routine = file
      ? await context.routines.add(agent, {
          text:
            file === "-"
              ? await Bun.stdin.text()
              : await Bun.file(resolve(file)).text(),
          replace: parsed.flags.has("replace"),
        })
      : await context.routines.add(agent, {
          template: template!,
          ...(parsed.values.name ? { name: parsed.values.name } : {}),
          vars,
          ...(parsed.values.until ? { until: parsed.values.until } : {}),
          ...(parsed.values.schedule
            ? { schedule: parsed.values.schedule }
            : {}),
          enabled: !parsed.flags.has("disabled"),
        });
    printResult({ routine }, json, () =>
      console.log(
        `Added routine ${routine.name} (${routine.schedule.text}, ${routine.enabled ? "enabled" : "disabled"}) at ${routine.path}`,
      ),
    );
    return 0;
  }
  if (action === "list") {
    const parsed = parseArguments(inputArgs, ["agent", "workspace"]);
    expectPositionals(parsed.positionals, 0, "daedal routine list");
    const agent = await agentFor(context, parsed.values);
    await context.routines.schedule(agent, { queue: false });
    const result = await context.routines.list(agent);
    printResult(result, json, () => {
      for (const view of result.routines) console.log(routineLine(view));
      for (const error of result.errors)
        console.log(`${error.name}\tinvalid\t${error.error}`);
    });
    return 0;
  }
  if (action === "runs") {
    const parsed = parseArguments(inputArgs, [
      "agent",
      "workspace",
      "routine",
      "limit",
    ]);
    expectPositionals(parsed.positionals, 0, "daedal routine runs");
    const agent = await agentFor(context, parsed.values);
    const runs = context.routines.runs(agent, {
      ...(parsed.values.routine ? { routine: parsed.values.routine } : {}),
      limit: parsed.values.limit ? Number(parsed.values.limit) : 30,
    });
    printResult({ runs }, json, () => {
      for (const run of runs) console.log(runLine(run));
    });
    return 0;
  }
  if (action === "start") {
    const parsed = parseArguments(inputArgs, []);
    const usage = "daedal routine start <run-id>";
    expectPositionals(parsed.positionals, 1, usage);
    const id = runId(parsed.positionals[0], usage);
    const run = context.routines.requireRun(id);
    const agent = context.routineAgents.get(run.routineAgentId);
    const started = await context.routines.start(agent, id);
    const workspace = await context.workspaces.get(agent.workspaceId);
    const tasks = new Map(
      context.repositories
        .listTasks({ workspaceId: workspace.id })
        .map((task) => [task.id, task.number]),
    );
    printResult(started, json, () => {
      const { routine } = started;
      console.log(
        `Run ${id} · routine ${routine.name} · model ${routine.model ?? "the agent's"} · timeout ${formatDuration(routine.timeoutMs)} · output ${routine.output}`,
      );
      console.log("");
      console.log("--- prompt ---");
      console.log(started.prompt);
      console.log("--- end of prompt ---");
      console.log("");
      console.log(
        started.openReports.length
          ? "Open reports, every routine:"
          : "No reports are open.",
      );
      for (const report of started.openReports)
        console.log(
          `- ${report.key} [${report.routine}${report.urgent ? ", urgent" : ""}]${report.taskId ? ` ${workspace.slug}#${tasks.get(report.taskId) ?? "?"}` : ""}: ${report.title}`,
        );
    });
    return 0;
  }
  if (action === "done" || action === "fail") {
    const parsed = parseArguments(
      inputArgs,
      action === "done" ? ["outcome", "summary"] : ["summary"],
    );
    const usage =
      action === "done"
        ? "daedal routine done <run-id> --outcome quiet|notified|task --summary <text>"
        : "daedal routine fail <run-id> --summary <text>";
    expectPositionals(parsed.positionals, 1, usage);
    const id = runId(parsed.positionals[0], usage);
    const agent = context.routineAgents.get(
      context.routines.requireRun(id).routineAgentId,
    );
    const summary = required(parsed.values.summary, "--summary");
    const run =
      action === "done"
        ? await context.routines.done(
            agent,
            id,
            required(parsed.values.outcome, "--outcome"),
            summary,
          )
        : await context.routines.fail(agent, id, summary);
    printResult({ run }, json, () => console.log(runLine(run)));
    return 0;
  }
  if (action === "report") {
    const parsed = parseArguments(
      inputArgs,
      ["run", "key", "same-as", "title", "url", "body", "body-file"],
      ["urgent"],
    );
    expectPositionals(parsed.positionals, 0, "daedal routine report ...");
    const id = runId(
      parsed.values.run,
      "daedal routine report --run <run-id> ...",
    );
    const run = context.routines.requireRun(id);
    const agent = context.routineAgents.get(run.routineAgentId);
    const workspace = await context.workspaces.getActive(agent.workspaceId);
    const routine = (await context.routines.read(agent)).routines.find(
      (item) => item.name === run.routine,
    );
    const result = await context.routineReports.report({
      agent,
      workspace,
      routine: run.routine,
      // A one-shot routine's file can be gone by the time it reports.
      output: routine?.output ?? "notify",
      runId: id,
      key: required(parsed.values.key, "--key"),
      ...(parsed.values["same-as"] ? { sameAs: parsed.values["same-as"] } : {}),
      urgent: parsed.flags.has("urgent"),
      title: required(parsed.values.title, "--title"),
      ...(parsed.values.url ? { url: parsed.values.url } : {}),
      body: (await textOption(parsed.values, "body")) ?? "",
    });
    printResult(result, json, () => {
      const where = result.task
        ? ` ${workspace.slug}#${result.task.number}`
        : "";
      console.log(`Report ${result.action}${where}: ${result.report.key}`);
      if (result.notified) console.log(`  ${result.notified}`);
    });
    return 0;
  }
  if (action === "reports") {
    const parsed = parseArguments(inputArgs, [
      "agent",
      "workspace",
      "state",
      "since",
    ]);
    expectPositionals(parsed.positionals, 0, "daedal routine reports");
    const since = parsed.values.since
      ? new Date(Date.now() - parseDuration(parsed.values.since)).toISOString()
      : undefined;
    const agent = await agentFor(context, parsed.values);
    const state = parsed.values.state ?? "open";
    if (!["open", "resolved", "closed", "all"].includes(state))
      throw new DaedalusError(
        "VALIDATION",
        "--state is one of open, resolved, closed, all",
      );
    const reports = context.repositories.routineAgents.listRoutineReports(
      agent.id,
      {
        ...(state === "all" ? {} : { states: [state as RoutineReportState] }),
        ...(since ? { seenSince: since } : {}),
      },
    );
    const tasks = new Map(
      context.repositories
        .listTasks({ workspaceId: agent.workspaceId })
        .map((task) => [task.id, task.number]),
    );
    printResult({ reports }, json, () => {
      for (const report of reports)
        console.log(
          reportLine(
            report,
            report.taskId ? tasks.get(report.taskId) : undefined,
          ),
        );
    });
    return 0;
  }
  if (action === "resolve") {
    const parsed = parseArguments(inputArgs, ["agent", "workspace"]);
    expectPositionals(parsed.positionals, 1, "daedal routine resolve <key>");
    const agent = await agentFor(context, parsed.values);
    const report = context.routineReports.resolve(
      agent,
      parsed.positionals[0]!,
    );
    printResult({ report }, json, () =>
      console.log(
        report ? `Resolved ${report.key}` : "No open report has that key",
      ),
    );
    return 0;
  }
  if (action === "feedback") {
    const parsed = parseArguments(inputArgs, ["note"]);
    const usage = "daedal routine feedback <task-ref> useful|noise|none";
    expectPositionals(parsed.positionals, 2, usage);
    const value = parsed.positionals[1];
    if (value !== "useful" && value !== "noise" && value !== "none")
      throw new DaedalusError("VALIDATION", `Usage: ${usage}`);
    const task = await resolveTask(parsed.positionals[0]!);
    const reports = context.routineReports.feedbackForTask(
      task.id,
      value === "none" ? null : value,
      parsed.values.note,
    );
    printResult({ reports }, json, () =>
      console.log(
        value === "none"
          ? `Removed the feedback on task #${task.number}`
          : `Marked task #${task.number} ${value} (${reports.map((report) => report.key).join(", ")})`,
      ),
    );
    return 0;
  }
  if (["get", "enable", "disable", "run", "remove"].includes(action)) {
    const parsed = parseArguments(inputArgs, ["agent", "workspace"]);
    const usage = `daedal routine ${action} <name>`;
    expectPositionals(parsed.positionals, 1, usage);
    const agent = await agentFor(context, parsed.values);
    const name = parsed.positionals[0]!;
    if (action === "get") {
      await context.routines.schedule(agent, { queue: false });
      const view = await context.routines.get(agent, name);
      printResult(view, json, () => {
        console.log(routineLine(view));
        console.log(
          `model ${view.routine.model ?? "the agent's"} · timeout ${formatDuration(view.routine.timeoutMs)} · output ${view.routine.output}${view.routine.until ? ` · until ${localTime(view.routine.until)}` : ""}`,
        );
        console.log(view.routine.path);
      });
      return 0;
    }
    if (action === "run") {
      const run = await context.routines.runNow(agent, name);
      printResult({ run }, json, () =>
        console.log(
          run.alreadyQueued
            ? `Run ${run.id} is already queued; the app delivers it when ${agent.name} is idle`
            : `Queued run ${run.id}; the app delivers it when ${agent.name} is idle`,
        ),
      );
      return 0;
    }
    const routine =
      action === "remove"
        ? await context.routines.remove(agent, name)
        : await context.routines.setEnabled(agent, name, action === "enable");
    printResult({ routine }, json, () =>
      console.log(
        action === "remove"
          ? `Removed routine ${routine.name}`
          : `Routine ${routine.name} ${action === "enable" ? "enabled" : "disabled"}`,
      ),
    );
    return 0;
  }
  throw new DaedalusError("VALIDATION", `Unknown routine command '${action}'`);
}

import { resolve } from "node:path";
import {
  DaedalusError,
  findingSeverity,
  formatDuration,
  parseDuration,
  type ApplicationContext,
  type Finding,
  type FindingState,
  type Resident,
  type RoutineRun,
  type RoutineView,
} from "@daedalus/core";
import {
  expectPositionals,
  parseArguments,
  printResult,
  required,
} from "./arguments";

export const residentHelp = {
  resident: `Resident commands:
  daedal resident create <slug> [--name <name>] [--model <model>]
  daedal resident list
  daedal resident get [<resident>]
  daedal resident start|stop|pause|resume [<resident>]
  daedal resident update [<resident>] [--name <name>] [--model <model>|none]
      [--auto-handoff <percent>]
  daedal resident remove <resident> [--delete-files] --force

Resident workspaces live under <DAEDALUS_HOME>/residents, apart from projects.
A resident is a named, long-lived agent that owns a workspace and runs
routines on a clock the desktop app keeps. 'create' makes the workspace with
its CHARTER.md, SERVICES.md, TOOLS.md, routines/ folder and skills; 'start'
puts it on duty. 'pause' keeps the session but delivers no routines; 'stop'
archives the session and keeps routines, tasks and memory. A resident drains
and hands off at --auto-handoff percent of its context (60 by default) and
once a day at 04:00. Routines run only while the app is open.`,
  routine: `Routine commands:
  daedal routine add [--resident <r>] --file <path|-> [--replace]
  daedal routine add [--resident <r>] --from <template> [--name <name>]
      [--var <key>=<value>]... [--until <+60m|date>] [--schedule <schedule>] [--disabled]
  daedal routine list [--resident <r>]
  daedal routine get <name> [--resident <r>]
  daedal routine enable|disable|run|remove <name> [--resident <r>]
  daedal routine runs [--routine <name>] [--limit <n>] [--resident <r>]
  daedal routine start <run-id>
  daedal routine done <run-id> --outcome quiet|notified|task --summary <text>
  daedal routine fail <run-id> --summary <text>

A routine is a Markdown file in the resident's routines/ folder: frontmatter
with name, schedule (every <n>m, cron "<5 fields>", at <date and time>),
until, model, timeout, findings (task, notify or none), enabled and vars, and
the prompt as the body. Files in routines/templates/ never fire; 'add --from'
copies one with its vars filled in. 'run' queues a run now. 'start', 'done'
and 'fail' are for the resident itself, when Daedalus types
/daedalus-routine <run-id>.`,
  finding: `Finding commands:
  daedal finding report --run <run-id> --key <key> --severity info|warn|urgent
      --title <title> [--url <url>] [--same-as <key>] (--body <text> | --body-file <path|->)
  daedal finding list [--state open|cleared|closed|all] [--since <7d>] [--resident <r>]
  daedal finding clear <key> [--resident <r>]
  daedal finding verdict <finding-id> useful|noise|none [--note <text>] [--resident <r>]

'report' is the only way a resident raises an issue. The key identifies the
issue, so a key that is open becomes an update to its task and sends no second
notification; one that comes back within 14 days reopens its task; --same-as
adds the finding to another open finding's task. A routine with findings: task
opens a task on the resident's board; findings: notify only notifies.
'clear' marks a key gone. A cleared finding closes after 24 hours, and its
task moves to done if no agent was ever started on it.
'verdict noise' closes a finding and stops its key from raising anything
again; 'verdict none' undoes it. A finding task the user moves to done counts
as useful. 'list --since 7d --state all' is what a weekly review reads.`,
};

function residentFor(
  context: ApplicationContext,
  reference?: string,
): Resident {
  return context.residents.resolve(reference, process.env.DAEDALUS_SESSION_ID);
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

const residentLine = (resident: Resident) =>
  `${resident.slug}\t${resident.state}\t${resident.name}\tsession ${resident.sessionId ?? "—"}`;

const runLine = (run: RoutineRun) =>
  `${run.id}\t${run.routine}\t${run.status}${run.outcome ? ` (${run.outcome})` : ""}\t${localTime(run.queuedAt)}${run.summary ? `\t${run.summary}` : ""}`;

const findingLine = (finding: Finding, taskNumber?: number) =>
  `${finding.id}\t${finding.state}\t${finding.severity}\t${finding.verdict ?? "—"}\t${finding.key}${taskNumber ? `\ttask #${taskNumber}` : ""}\t${finding.title}`;

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

export async function residentCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help") {
    console.log(residentHelp.resident);
    return 0;
  }
  if (action === "create") {
    const parsed = parseArguments(args, ["name", "model"]);
    expectPositionals(parsed.positionals, 1, "daedal resident create <slug>");
    const resident = await context.residents.create({
      slug: parsed.positionals[0]!,
      ...(parsed.values.name ? { name: parsed.values.name } : {}),
      ...(parsed.values.model ? { model: parsed.values.model } : {}),
    });
    const workspace = await context.workspaces.get(resident.workspaceId);
    printResult({ resident, workspace }, json, () => {
      console.log(`Created resident ${resident.name} in ${workspace.path}`);
      console.log(`Start it with: daedal resident start ${resident.slug}`);
    });
    return 0;
  }
  if (action === "list") {
    const parsed = parseArguments(args, []);
    expectPositionals(parsed.positionals, 0, "daedal resident list");
    const residents = context.residents.list();
    printResult({ residents }, json, () => {
      for (const resident of residents) console.log(residentLine(resident));
    });
    return 0;
  }
  if (action === "get") {
    const parsed = parseArguments(args, []);
    const resident = residentFor(context, parsed.positionals[0]);
    const inFlight = context.routines.inFlightRuns(resident);
    const open = context.repositories.residents.listFindings(resident.id, {
      states: ["open"],
    });
    printResult({ resident, inFlight, openFindings: open.length }, json, () => {
      console.log(residentLine(resident));
      console.log(
        `runs in flight ${inFlight.filter((run) => run.deliveredAt).length} · queued ${inFlight.filter((run) => !run.deliveredAt).length} · open findings ${open.length} · hands off at ${resident.autoHandoffPercent}%`,
      );
    });
    return 0;
  }
  if (["start", "stop", "pause", "resume"].includes(action)) {
    const parsed = parseArguments(args, []);
    const reference = residentFor(context, parsed.positionals[0]).id;
    const resident =
      action === "start"
        ? await context.residents.start(reference)
        : action === "stop"
          ? await context.residents.stop(reference)
          : action === "pause"
            ? context.residents.pause(reference)
            : await context.residents.resume(reference);
    printResult({ resident }, json, () => console.log(residentLine(resident)));
    return 0;
  }
  if (action === "remove") {
    const parsed = parseArguments(args, [], ["delete-files", "force"]);
    expectPositionals(
      parsed.positionals,
      1,
      "daedal resident remove <resident> [--delete-files] --force",
    );
    const result = await context.residents.remove(parsed.positionals[0]!, {
      deleteFiles: parsed.flags.has("delete-files"),
      force: parsed.flags.has("force"),
    });
    printResult(result, json, () =>
      console.log(
        `Removed resident ${result.resident.name}${result.filesDeleted ? " and its files" : "; its files are kept"}`,
      ),
    );
    return 0;
  }
  if (action === "update") {
    const parsed = parseArguments(args, ["name", "model", "auto-handoff"]);
    const reference = residentFor(context, parsed.positionals[0]).id;
    const percent = parsed.values["auto-handoff"];
    const resident = context.residents.update(reference, {
      ...(parsed.values.name ? { name: parsed.values.name } : {}),
      ...(parsed.values.model !== undefined
        ? { model: parsed.values.model === "none" ? null : parsed.values.model }
        : {}),
      ...(percent !== undefined ? { autoHandoffPercent: Number(percent) } : {}),
    });
    printResult({ resident }, json, () => console.log(residentLine(resident)));
    return 0;
  }
  throw new DaedalusError("VALIDATION", `Unknown resident command '${action}'`);
}

export async function routineCommand(
  context: ApplicationContext,
  inputArgs: string[],
  json: boolean,
): Promise<number> {
  const action = inputArgs.shift();
  if (!action || action === "help") {
    console.log(residentHelp.routine);
    return 0;
  }
  if (action === "add") {
    const { rest, vars } = takeVars(inputArgs);
    const parsed = parseArguments(
      rest,
      ["resident", "file", "from", "name", "until", "schedule"],
      ["replace", "disabled"],
    );
    expectPositionals(parsed.positionals, 0, "daedal routine add ...");
    const resident = residentFor(context, parsed.values.resident);
    const file = parsed.values.file;
    const template = parsed.values.from;
    if (Boolean(file) === Boolean(template))
      throw new DaedalusError(
        "VALIDATION",
        "Pass exactly one of --file <path|-> or --from <template>",
      );
    const routine = file
      ? await context.routines.add(resident, {
          text:
            file === "-"
              ? await Bun.stdin.text()
              : await Bun.file(resolve(file)).text(),
          replace: parsed.flags.has("replace"),
        })
      : await context.routines.add(resident, {
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
    const parsed = parseArguments(inputArgs, ["resident"]);
    expectPositionals(parsed.positionals, 0, "daedal routine list");
    const resident = residentFor(context, parsed.values.resident);
    await context.routines.schedule(resident, { queue: false });
    const result = await context.routines.list(resident);
    printResult(result, json, () => {
      for (const view of result.routines) console.log(routineLine(view));
      for (const error of result.errors)
        console.log(`${error.name}\tinvalid\t${error.error}`);
    });
    return 0;
  }
  if (action === "runs") {
    const parsed = parseArguments(inputArgs, ["resident", "routine", "limit"]);
    expectPositionals(parsed.positionals, 0, "daedal routine runs");
    const resident = residentFor(context, parsed.values.resident);
    const runs = context.routines.runs(resident, {
      ...(parsed.values.routine ? { routine: parsed.values.routine } : {}),
      limit: parsed.values.limit ? Number(parsed.values.limit) : 30,
    });
    printResult({ runs }, json, () => {
      for (const run of runs) console.log(runLine(run));
    });
    return 0;
  }
  if (action === "start") {
    const parsed = parseArguments(inputArgs, ["resident"]);
    const usage = "daedal routine start <run-id>";
    expectPositionals(parsed.positionals, 1, usage);
    const id = runId(parsed.positionals[0], usage);
    const run = context.routines.requireRun(id);
    const resident = context.residents.get(run.residentId);
    const started = await context.routines.start(resident, id);
    const workspace = await context.workspaces.get(resident.workspaceId);
    const tasks = new Map(
      context.repositories
        .listTasks({ workspaceId: workspace.id })
        .map((task) => [task.id, task.number]),
    );
    printResult(started, json, () => {
      const { routine } = started;
      console.log(
        `Run ${id} · routine ${routine.name} · model ${routine.model ?? "the resident's"} · timeout ${formatDuration(routine.timeoutMs)} · findings ${routine.findings}`,
      );
      console.log("");
      console.log("--- prompt ---");
      console.log(started.prompt);
      console.log("--- end of prompt ---");
      console.log("");
      console.log(
        started.openFindings.length
          ? "Open findings, every routine:"
          : "No findings are open.",
      );
      for (const finding of started.openFindings)
        console.log(
          `- ${finding.key} [${finding.routine}, ${finding.severity}]${finding.taskId ? ` ${workspace.slug}#${tasks.get(finding.taskId) ?? "?"}` : ""}: ${finding.title}`,
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
    const resident = context.residents.get(
      context.routines.requireRun(id).residentId,
    );
    const summary = required(parsed.values.summary, "--summary");
    const run =
      action === "done"
        ? await context.routines.done(
            resident,
            id,
            required(parsed.values.outcome, "--outcome"),
            summary,
          )
        : await context.routines.fail(resident, id, summary);
    printResult({ run }, json, () => console.log(runLine(run)));
    return 0;
  }
  if (["get", "enable", "disable", "run", "remove"].includes(action)) {
    const parsed = parseArguments(inputArgs, ["resident"]);
    const usage = `daedal routine ${action} <name>`;
    expectPositionals(parsed.positionals, 1, usage);
    const resident = residentFor(context, parsed.values.resident);
    const name = parsed.positionals[0]!;
    if (action === "get") {
      await context.routines.schedule(resident, { queue: false });
      const view = await context.routines.get(resident, name);
      printResult(view, json, () => {
        console.log(routineLine(view));
        console.log(
          `model ${view.routine.model ?? "the resident's"} · timeout ${formatDuration(view.routine.timeoutMs)} · findings ${view.routine.findings}${view.routine.until ? ` · until ${localTime(view.routine.until)}` : ""}`,
        );
        console.log(view.routine.path);
      });
      return 0;
    }
    if (action === "run") {
      const run = await context.routines.runNow(resident, name);
      printResult({ run }, json, () =>
        console.log(
          run.alreadyQueued
            ? `Run ${run.id} is already queued; the app delivers it when ${resident.name} is idle`
            : `Queued run ${run.id}; the app delivers it when ${resident.name} is idle`,
        ),
      );
      return 0;
    }
    const routine =
      action === "remove"
        ? await context.routines.remove(resident, name)
        : await context.routines.setEnabled(
            resident,
            name,
            action === "enable",
          );
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

export async function findingCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help") {
    console.log(residentHelp.finding);
    return 0;
  }
  if (action === "report") {
    const parsed = parseArguments(args, [
      "run",
      "key",
      "same-as",
      "severity",
      "title",
      "url",
      "body",
      "body-file",
    ]);
    expectPositionals(parsed.positionals, 0, "daedal finding report ...");
    const id = runId(
      parsed.values.run,
      "daedal finding report --run <run-id> ...",
    );
    const run = context.routines.requireRun(id);
    const resident = context.residents.get(run.residentId);
    const workspace = await context.workspaces.getActive(resident.workspaceId);
    const routine = (await context.routines.read(resident)).routines.find(
      (item) => item.name === run.routine,
    );
    const result = await context.findings.report({
      resident,
      workspace,
      routine: run.routine,
      // A one-shot routine's file can be gone by the time it reports.
      findings: routine?.findings ?? "notify",
      runId: id,
      key: required(parsed.values.key, "--key"),
      ...(parsed.values["same-as"] ? { sameAs: parsed.values["same-as"] } : {}),
      severity: findingSeverity(required(parsed.values.severity, "--severity")),
      title: required(parsed.values.title, "--title"),
      ...(parsed.values.url ? { url: parsed.values.url } : {}),
      body: (await textOption(parsed.values, "body")) ?? "",
    });
    printResult(result, json, () => {
      const where = result.task
        ? ` ${workspace.slug}#${result.task.number}`
        : "";
      console.log(`Finding ${result.action}${where}: ${result.finding.key}`);
      if (result.notified) console.log(`  ${result.notified}`);
    });
    return 0;
  }
  if (action === "list") {
    const parsed = parseArguments(args, ["resident", "state", "since"]);
    expectPositionals(parsed.positionals, 0, "daedal finding list");
    const since = parsed.values.since
      ? new Date(Date.now() - parseDuration(parsed.values.since)).toISOString()
      : undefined;
    const resident = residentFor(context, parsed.values.resident);
    const state = parsed.values.state ?? "open";
    if (!["open", "cleared", "closed", "all"].includes(state))
      throw new DaedalusError(
        "VALIDATION",
        "--state is one of open, cleared, closed, all",
      );
    const findings = context.repositories.residents.listFindings(resident.id, {
      ...(state === "all" ? {} : { states: [state as FindingState] }),
      ...(since ? { seenSince: since } : {}),
    });
    const tasks = new Map(
      context.repositories
        .listTasks({ workspaceId: resident.workspaceId })
        .map((task) => [task.id, task.number]),
    );
    printResult({ findings }, json, () => {
      for (const finding of findings)
        console.log(
          findingLine(
            finding,
            finding.taskId ? tasks.get(finding.taskId) : undefined,
          ),
        );
    });
    return 0;
  }
  if (action === "clear") {
    const parsed = parseArguments(args, ["resident"]);
    expectPositionals(parsed.positionals, 1, "daedal finding clear <key>");
    const resident = residentFor(context, parsed.values.resident);
    const finding = context.findings.clear(resident, parsed.positionals[0]!);
    printResult({ finding }, json, () =>
      console.log(
        finding ? `Cleared ${finding.key}` : "No open finding has that key",
      ),
    );
    return 0;
  }
  if (action === "verdict") {
    const parsed = parseArguments(args, ["resident", "note"]);
    const usage = "daedal finding verdict <finding-id> useful|noise|none";
    expectPositionals(parsed.positionals, 2, usage);
    const value = parsed.positionals[1];
    if (value !== "useful" && value !== "noise" && value !== "none")
      throw new DaedalusError("VALIDATION", `Usage: ${usage}`);
    const resident = residentFor(context, parsed.values.resident);
    const finding = context.findings.verdict(
      resident,
      parsed.positionals[0]!,
      value === "none" ? null : value,
      parsed.values.note,
    );
    printResult({ finding }, json, () =>
      console.log(
        value === "none"
          ? `Removed the verdict on ${finding.key}`
          : `Marked ${finding.key} ${value}`,
      ),
    );
    return 0;
  }
  throw new DaedalusError("VALIDATION", `Unknown finding command '${action}'`);
}

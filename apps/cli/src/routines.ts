import { callerSession } from "./caller";
import { basename, resolve } from "node:path";
import {
  ABILITY_IDS,
  DaedalusError,
  formatDuration,
  parseDuration,
  SESSION_COLORS,
  type AgentSession,
  type ApplicationContext,
  type Routine,
  type RoutineReport,
  type RoutineReportState,
  type RoutineRun,
  type RoutineView,
  type SessionAbility,
  type Task,
} from "@daedalus/core";
import {
  expectPositionals,
  parseArguments,
  printResult,
  required,
} from "./arguments";

export const routineHelp = {
  session: `Session commands:
  daedal session rename <session> <name>
  daedal session pin|unpin <session>
  daedal session color <session> <${SESSION_COLORS.join("|")}|none>
  daedal session abilities <session>
  daedal session grant <session> <ability>
  daedal session revoke <session> <ability>

<session> is a session id, or a session's name when only one live session
has it. Pinned sessions sit at the top of their workspace's list. The color
marks the session's card, its World figure and the tasks its routines file.

Abilities: ${ABILITY_IDS.join(", ")}. 'grant' gives a running session an
ability; Daedalus tells it with one typed line once it is idle, its input box
is empty and nobody typed in it for 2 minutes. To start a session that holds
one, use 'daedal agent spawn --ability <ability>'. 'revoke' stops what the
ability does and keeps its data, so a later grant brings it back. A handoff
moves the abilities, the name, the pin and the color to the successor.
Archiving a session pauses its abilities; restoring it resumes them.`,
  routine: `Routine commands:
  daedal routine add --file <path|-> [--template] [--replace] [--session <s>]
  daedal routine add --from <template> [--name <name>] [--var <key>=<value>]...
      [--until <+60m|date>] [--schedule <schedule>] [--disabled] [--session <s>]
  daedal routine list [--session <s>]
  daedal routine get <name> [--template] [--text] [--session <s>]
  daedal routine enable|disable|run <name> [--session <s>]
  daedal routine remove <name> [--template] [--session <s>]
  daedal routine purpose [<text>] [--session <s>]
  daedal routine pause|resume [--session <s>]
  daedal routine runs [--routine <name>] [--limit <n>] [--session <s>]
  daedal routine start <run-id>
  daedal routine done <run-id> --outcome quiet|notified|task --summary <text>
  daedal routine fail <run-id> --summary <text>
  daedal routine report --run <run-id> --key <key> --title <title> [--urgent]
      [--url <url>] [--same-as <key>] (--body <text> | --body-file <path|->)
  daedal routine resolve <key> [--run <run-id> | --session <s>]
  daedal routine reports [--state open|resolved|closed|all] [--since <7d>] [--session <s>]
  daedal routine feedback <task-ref> useful|noise|none [--note <text>]

These work on a session that holds the routines ability. Inside that
session, --session defaults to it.

A routine is written as Markdown: frontmatter with name, schedule
(every <n>m|h, cron "<5 fields>", at <date and time>), until, model, timeout,
output (task, notify or none), enabled and vars, and the prompt as the body.
'add --file' stores it in Daedalus; nothing is written into the session's
folder. 'get --text' prints it back in the same form, so a change is
'get --text', edit, then 'add --file - --replace'. A template (--template)
never fires; 'add --from' copies one with its vars filled in.
'purpose' sets what the session's routines are for; every run prints it.

The desktop app keeps the clock: routines run only while it is open. A due
run is typed into the session as '/daedalus-routine <run-id>' once the
session is idle, its input box is empty, and nobody typed in it for 2
minutes. Until then it waits, at most one per routine, and the bar above the
session's terminal says why. 'run' queues a run now. 'start', 'done', 'fail',
'report' and 'resolve' are for the session itself, during a run.

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

/**
 * A session by id, or by name when exactly one live session has it. Names
 * are what people use; ids are what agents pass.
 */
export async function resolveSession(
  context: ApplicationContext,
  reference: string,
): Promise<AgentSession> {
  const byId = context.repositories.findAgent(reference);
  if (byId) return byId;
  const matches = context.repositories
    .listAgents()
    .filter(
      (session) =>
        !session.archivedAt &&
        session.name.toLowerCase() === reference.trim().toLowerCase(),
    );
  if (matches.length === 1) return matches[0]!;
  throw new DaedalusError(
    matches.length ? "VALIDATION" : "NOT_FOUND",
    matches.length
      ? `More than one session is called '${reference}'; pass its id`
      : `Session '${reference}' was not found`,
  );
}

/** The routines ability of the session named, or of the one running this. */
async function routinesFor(
  context: ApplicationContext,
  values: Record<string, string>,
): Promise<{ session: AgentSession; ability: SessionAbility }> {
  const session = values.session
    ? await resolveSession(context, values.session)
    : await callerSession(context);
  if (!session)
    throw new DaedalusError(
      "VALIDATION",
      "Pass --session <session>; outside a session there is no default",
    );
  return {
    session,
    ability: context.abilities.require(session.id, "routines"),
  };
}

/** The ability a run belongs to, which must still be granted. */
function abilityForRun(
  context: ApplicationContext,
  run: RoutineRun,
): SessionAbility {
  const ability = context.repositories.abilities.find(run.abilityId);
  if (!ability?.enabled)
    throw new DaedalusError(
      "CONFLICT",
      "The routines ability this run belongs to was revoked",
    );
  return ability;
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
  return readTextFile(file);
}

async function readTextFile(file: string): Promise<string> {
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

const sessionLine = (session: AgentSession) =>
  `${session.id}\t${session.name}\t${session.pinnedAt ? "pinned" : "—"}\t${session.color ?? "—"}`;

const abilityLine = (ability: SessionAbility) =>
  `${ability.ability}\t${ability.enabled ? (ability.paused ? "paused" : "on") : "revoked"}\tgranted ${localTime(ability.grantedAt)}${ability.pendingNote ? "\tnote waiting to be typed" : ""}`;

const runLine = (run: RoutineRun) =>
  `${run.id}\t${run.routine}\t${run.status}${run.outcome ? ` (${run.outcome})` : ""}\t${localTime(run.queuedAt)}${run.summary ? `\t${run.summary}` : ""}`;

const reportLine = (report: RoutineReport, taskNumber?: number) =>
  `${report.id}\t${report.state}${report.urgent ? "\turgent" : ""}\t${report.verdict ?? "—"}\t${report.key}${taskNumber ? `\ttask #${taskNumber}` : ""}\t${report.title}`;

function routineLine({ routine, lastRun }: RoutineView): string {
  return [
    routine.name,
    routine.enabled ? "on" : "off",
    routine.schedule.text,
    `next ${routine.enabled ? localTime(routine.nextRunAt) : "—"}`,
    `last ${lastRun ? `${localTime(lastRun.queuedAt)} ${lastRun.status}${lastRun.outcome ? ` (${lastRun.outcome})` : ""}` : "never"}`,
  ].join("\t");
}

const routineSummary = (routine: Routine) =>
  `${routine.name} (${routine.schedule.text}, ${routine.isTemplate ? "template" : routine.enabled ? "enabled" : "disabled"})`;

export async function sessionCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help") {
    console.log(routineHelp.session);
    return 0;
  }
  const parsed = parseArguments(args, []);
  const reference = parsed.positionals[0];
  if (action === "rename") {
    const usage = "daedal session rename <session> <name>";
    expectPositionals(parsed.positionals, 2, usage);
    const session = await context.agents.rename(
      (await resolveSession(context, reference!)).id,
      parsed.positionals[1]!,
    );
    printResult({ session }, json, () => console.log(sessionLine(session)));
    return 0;
  }
  if (action === "pin" || action === "unpin") {
    expectPositionals(
      parsed.positionals,
      1,
      `daedal session ${action} <session>`,
    );
    const session = await context.agents.setPinned(
      (await resolveSession(context, reference!)).id,
      action === "pin",
    );
    printResult({ session }, json, () => console.log(sessionLine(session)));
    return 0;
  }
  if (action === "color") {
    const usage = `daedal session color <session> <${SESSION_COLORS.join("|")}|none>`;
    expectPositionals(parsed.positionals, 2, usage);
    const value = parsed.positionals[1]!;
    const session = await context.agents.setColor(
      (await resolveSession(context, reference!)).id,
      value === "none" ? null : value,
    );
    printResult({ session }, json, () => console.log(sessionLine(session)));
    return 0;
  }
  if (action === "abilities") {
    expectPositionals(
      parsed.positionals,
      1,
      "daedal session abilities <session>",
    );
    const session = await resolveSession(context, reference!);
    const abilities = context.abilities.list(session.id);
    printResult({ abilities }, json, () => {
      if (!abilities.length) console.log("No abilities.");
      for (const ability of abilities) console.log(abilityLine(ability));
    });
    return 0;
  }
  if (action === "grant" || action === "revoke") {
    const usage = `daedal session ${action} <session> <ability>`;
    expectPositionals(parsed.positionals, 2, usage);
    const session = await resolveSession(context, reference!);
    const ability =
      action === "grant"
        ? context.abilities.grant(session.id, parsed.positionals[1]!, {
            live: true,
          })
        : context.abilities.revoke(session.id, parsed.positionals[1]!);
    printResult({ ability }, json, () =>
      console.log(
        `${action === "grant" ? "Granted" : "Revoked"} ${ability.ability} ${action === "grant" ? "to" : "from"} ${session.name}${ability.pendingNote ? "; the app tells the session once it is idle and nobody is typing" : ""}`,
      ),
    );
    return 0;
  }
  throw new DaedalusError("VALIDATION", `Unknown session command '${action}'`);
}

export async function routineCommand(
  context: ApplicationContext,
  inputArgs: string[],
  json: boolean,
  resolveTask: (reference: string) => Promise<Task>,
): Promise<number> {
  const action = inputArgs.shift();
  if (!action || action === "help") {
    console.log(routineHelp.routine);
    return 0;
  }
  if (action === "add") {
    const { rest, vars } = takeVars(inputArgs);
    const parsed = parseArguments(
      rest,
      ["session", "file", "from", "name", "until", "schedule"],
      ["replace", "disabled", "template"],
    );
    expectPositionals(parsed.positionals, 0, "daedal routine add ...");
    const { ability } = await routinesFor(context, parsed.values);
    const file = parsed.values.file;
    const template = parsed.values.from;
    if (Boolean(file) === Boolean(template))
      throw new DaedalusError(
        "VALIDATION",
        "Pass exactly one of --file <path|-> or --from <template>",
      );
    const routine = file
      ? context.routines.add(ability, {
          text: await readTextFile(file),
          replace: parsed.flags.has("replace"),
          template: parsed.flags.has("template"),
          // A file named after its routine needs no `name:` line.
          ...(file === "-"
            ? {}
            : { name: basename(file).replace(/\.md$/, "") }),
        })
      : context.routines.add(ability, {
          from: template!,
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
        `Added ${routineSummary(routine)}${routine.nextRunAt ? `; next run ${localTime(routine.nextRunAt)}` : ""}`,
      ),
    );
    return 0;
  }
  if (action === "list") {
    const parsed = parseArguments(inputArgs, ["session"]);
    expectPositionals(parsed.positionals, 0, "daedal routine list");
    const { ability } = await routinesFor(context, parsed.values);
    const result = context.routines.list(ability);
    printResult(
      { ...result, purpose: ability.config.purpose ?? null },
      json,
      () => {
        if (ability.config.purpose)
          console.log(`Purpose: ${ability.config.purpose}`);
        if (ability.paused) console.log("Paused.");
        if (!result.routines.length) console.log("No routines.");
        for (const view of result.routines) console.log(routineLine(view));
        for (const template of result.templates)
          console.log(`${template.name}\ttemplate\t${template.schedule.text}`);
      },
    );
    return 0;
  }
  if (action === "purpose") {
    const parsed = parseArguments(inputArgs, ["session"]);
    const { session, ability } = await routinesFor(context, parsed.values);
    const text = parsed.positionals.join(" ");
    const updated = text
      ? context.abilities.configure(session.id, "routines", "purpose", text)
      : ability;
    printResult({ purpose: updated.config.purpose ?? null }, json, () =>
      console.log(updated.config.purpose ?? "No purpose is set."),
    );
    return 0;
  }
  if (action === "pause" || action === "resume") {
    const parsed = parseArguments(inputArgs, ["session"]);
    expectPositionals(parsed.positionals, 0, `daedal routine ${action}`);
    const { session } = await routinesFor(context, parsed.values);
    const ability = context.abilities.setPaused(
      session.id,
      "routines",
      action === "pause",
    );
    printResult({ ability }, json, () =>
      console.log(
        `Routines ${action === "pause" ? "paused" : "resumed"} for ${session.name}`,
      ),
    );
    return 0;
  }
  if (action === "runs") {
    const parsed = parseArguments(inputArgs, ["session", "routine", "limit"]);
    expectPositionals(parsed.positionals, 0, "daedal routine runs");
    const { ability } = await routinesFor(context, parsed.values);
    const runs = context.routines.runs(ability, {
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
    const ability = abilityForRun(context, context.routines.requireRun(id));
    const started = context.routines.start(ability, id);
    const session = context.repositories.findAgent(ability.sessionId);
    const workspace = session
      ? context.repositories.findWorkspace(session.workspaceId)
      : undefined;
    const tasks = new Map(
      context.repositories
        .listTasks(workspace ? { workspaceId: workspace.id } : {})
        .map((task) => [task.id, task.number]),
    );
    printResult(started, json, () => {
      const { routine } = started;
      console.log(
        `Run ${id} · routine ${routine.name} · model ${routine.model ?? "the session's"} · timeout ${formatDuration(routine.timeoutMs)} · output ${routine.output}`,
      );
      console.log(
        started.purpose
          ? `Purpose: ${started.purpose}`
          : "No purpose is set; ask the user what these routines are for when they are next here.",
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
          `- ${report.key} [${report.routine}${report.urgent ? ", urgent" : ""}]${report.taskId ? ` ${workspace?.slug ?? ""}#${tasks.get(report.taskId) ?? "?"}` : ""}: ${report.title}`,
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
    const ability = abilityForRun(context, context.routines.requireRun(id));
    const summary = required(parsed.values.summary, "--summary");
    const run =
      action === "done"
        ? await context.routines.done(
            ability,
            id,
            required(parsed.values.outcome, "--outcome"),
            summary,
          )
        : await context.routines.fail(ability, id, summary);
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
    const ability = abilityForRun(context, run);
    const session = await context.agents.get(ability.sessionId);
    const workspace = await context.workspaces.getActive(session.workspaceId);
    const routine = context.repositories.routines.find(ability.id, run.routine);
    const result = await context.routineReports.report({
      ability,
      workspace,
      routine: run.routine,
      // A one-shot routine is gone by the time its run reports.
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
    const parsed = parseArguments(inputArgs, ["session", "state", "since"]);
    expectPositionals(parsed.positionals, 0, "daedal routine reports");
    const since = parsed.values.since
      ? new Date(Date.now() - parseDuration(parsed.values.since)).toISOString()
      : undefined;
    const { session, ability } = await routinesFor(context, parsed.values);
    const state = parsed.values.state ?? "open";
    if (!["open", "resolved", "closed", "all"].includes(state))
      throw new DaedalusError(
        "VALIDATION",
        "--state is one of open, resolved, closed, all",
      );
    const reports = context.repositories.routines.listReports(ability.id, {
      ...(state === "all" ? {} : { states: [state as RoutineReportState] }),
      ...(since ? { seenSince: since } : {}),
    });
    const tasks = new Map(
      context.repositories
        .listTasks({ workspaceId: session.workspaceId })
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
    const parsed = parseArguments(inputArgs, ["session", "run"]);
    const usage =
      "daedal routine resolve <key> [--run <run-id> | --session <s>]";
    expectPositionals(parsed.positionals, 1, usage);
    // During a run, the run names the session; nothing in the environment has
    // to be right for it.
    const ability = parsed.values.run
      ? abilityForRun(
          context,
          context.routines.requireRun(runId(parsed.values.run, usage)),
        )
      : (await routinesFor(context, parsed.values)).ability;
    const report = context.routineReports.resolve(
      ability,
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
    const parsed = parseArguments(inputArgs, ["session"], ["template", "text"]);
    const usage = `daedal routine ${action} <name>`;
    expectPositionals(parsed.positionals, 1, usage);
    const { session, ability } = await routinesFor(context, parsed.values);
    const name = parsed.positionals[0]!;
    const template = parsed.flags.has("template");
    if (action === "get") {
      const routine = context.routines.get(ability, name, { template });
      const text = context.routines.text(routine);
      printResult({ routine, text }, json, () => {
        if (parsed.flags.has("text")) {
          process.stdout.write(text);
          return;
        }
        console.log(routineSummary(routine));
        console.log(
          `model ${routine.model ?? "the session's"} · timeout ${formatDuration(routine.timeoutMs)} · output ${routine.output}${routine.until ? ` · until ${localTime(routine.until)}` : ""}`,
        );
        if (!routine.isTemplate)
          console.log(
            `next ${routine.enabled ? localTime(routine.nextRunAt) : "—"} · last ${localTime(routine.lastRunAt)} · failures in a row ${routine.consecutiveFailures}`,
          );
      });
      return 0;
    }
    if (action === "run") {
      const run = context.routines.runNow(ability, name);
      printResult({ run }, json, () =>
        console.log(
          `${run.alreadyQueued ? `Run ${run.id} is already queued` : `Queued run ${run.id}`}; the app types it into ${session.name} once it is idle, its input box is empty and nobody typed in it for 2 minutes`,
        ),
      );
      return 0;
    }
    const routine =
      action === "remove"
        ? context.routines.remove(ability, name, { template })
        : context.routines.setEnabled(ability, name, action === "enable");
    printResult({ routine }, json, () =>
      console.log(
        action === "remove"
          ? `Removed ${routine.isTemplate ? "template" : "routine"} ${routine.name}`
          : `Routine ${routine.name} ${action === "enable" ? "enabled" : "disabled"}`,
      ),
    );
    return 0;
  }
  throw new DaedalusError("VALIDATION", `Unknown routine command '${action}'`);
}

import { resolve } from "node:path";
import {
  DaedalusError,
  describeSchedule,
  localTime,
  parseWhen,
  type ApplicationContext,
  type Routine,
  type RoutineRun,
  type RoutineView,
} from "@daedalus/core";
import { callerSession } from "./caller";
import {
  expectPositionals,
  parseArguments,
  printResult,
  required,
} from "./arguments";

export const routineHelp = `Routine commands:
  daedal routine add --when <when> (--prompt <text> | --prompt-file <path|->)
      [--name <name>] [--workspace <workspace> | --all] [--model <model>]
  daedal routine list
  daedal routine get <routine>
  daedal routine edit <routine> [--when <when>] [--prompt <text> | --prompt-file <path|->]
      [--name <name>] [--workspace <workspace> | --all] [--model <model>|default]
  daedal routine pause|resume <routine>
  daedal routine run <routine>
  daedal routine remove|rm <routine>
  daedal routine runs [<routine>] [--limit <n>]
  daedal routine log <run-id>
  daedal routine when <when>

A routine is a time and a prompt. Each run is a headless Claude session
(claude -p) in the routine's workspace folder, or in the workspaces root
with --all, for chores across every workspace. A run has no Daedalus
session, so it skips workflows and attention; its last reply is its result,
and its first line is what the Routines page shows. Each run is told what
the previous one said. Open a run on the Routines page to read it or carry
on from it in a session.

<when> is plain words: "every 30m", "every 2h", "every day at 9:00",
"weekdays 9:00", "sun to thu at 8, 10, 13, 16", "mondays at 7:30", a
5-field cron such as "cron 0 9 * * 1-5", or "at 2026-11-02 14:00" for once.
'when' prints how a <when> reads without saving anything.

--workspace defaults to the workspace of the session running the command.
<routine> is a routine's name or id.

The desktop app keeps the clock: routines run only while it is open, at
most 2 at once, each stopped after 30 minutes. 'run' asks the app for a run
now, which starts within a few seconds and leaves the schedule alone, even
for a paused routine. A run keeps going when the app quits, and the app
picks it up again when it opens. A due run while the previous one is still going is
skipped.`;

/** The workspace the flags name: an id or slug, null for --all, or none. */
function workspaceFlag(
  values: Record<string, string>,
  flags: Set<string>,
): string | null | undefined {
  if (!flags.has("all")) return values.workspace;
  if (values.workspace)
    throw new DaedalusError(
      "VALIDATION",
      "Use either --workspace or --all, not both",
    );
  return null;
}

/** A new routine's workspace: the flags, else the calling session's. */
async function newRoutineWorkspace(
  context: ApplicationContext,
  values: Record<string, string>,
  flags: Set<string>,
): Promise<string | null> {
  const named = workspaceFlag(values, flags);
  if (named !== undefined) return named;
  const session = await callerSession(context).catch(() => undefined);
  if (session) return session.workspaceId;
  throw new DaedalusError(
    "VALIDATION",
    "Pass --workspace <workspace> or --all; outside a session there is no default",
  );
}

async function promptOption(
  values: Record<string, string>,
): Promise<string | undefined> {
  const file = values["prompt-file"];
  if (file === undefined) return values.prompt;
  if (values.prompt !== undefined)
    throw new DaedalusError(
      "VALIDATION",
      "Use either --prompt or --prompt-file, not both",
    );
  if (file === "-") return Bun.stdin.text();
  const source = Bun.file(resolve(file));
  if (!(await source.exists()))
    throw new DaedalusError("NOT_FOUND", `File '${file}' was not found`);
  return source.text();
}

function runId(value: string | undefined): number {
  const id = Number(value);
  if (!value || !Number.isInteger(id) || id < 1)
    throw new DaedalusError("VALIDATION", "Usage: daedal routine log <run-id>");
  return id;
}

const view = (context: ApplicationContext, routine: Routine): RoutineView =>
  context.routines.view(routine.id);

const runLine = (run: RoutineRun, routineName: string) =>
  [
    run.id,
    routineName,
    run.status,
    run.trigger === "manual" ? "run now" : "scheduled",
    localTime(run.startedAt),
    run.summary ?? "",
  ].join("\t");

function routineLine(item: RoutineView): string {
  const { routine } = item;
  const last = item.recentRuns.at(-1);
  return [
    routine.name,
    routine.enabled ? "on" : "paused",
    item.workspaceName ?? "All workspaces",
    item.scheduleText,
    `next ${routine.enabled && routine.nextRunAt ? localTime(routine.nextRunAt) : "—"}`,
    `last ${last ? `${localTime(last.startedAt)} ${last.status}` : "never"}`,
  ].join("\t");
}

function printRoutine(item: RoutineView): void {
  const { routine } = item;
  console.log(`${routine.name}\t${routine.id}`);
  console.log(`Workspace: ${item.workspaceName ?? "All workspaces"}`);
  console.log(`When: ${item.scheduleText} (${routine.schedule})`);
  console.log(`Model: ${routine.model ?? "default"}`);
  console.log(
    routine.enabled
      ? `Next run: ${routine.nextRunAt ? localTime(routine.nextRunAt) : "—"}`
      : "Paused",
  );
  console.log(`\n${routine.prompt}`);
}

export async function routineCommand(
  context: ApplicationContext,
  inputArgs: string[],
  json: boolean,
): Promise<number> {
  const action = inputArgs.shift();
  if (!action || action === "help") {
    console.log(routineHelp);
    return 0;
  }
  const service = context.routines;
  if (action === "add") {
    const parsed = parseArguments(
      inputArgs,
      ["when", "prompt", "prompt-file", "name", "workspace", "model"],
      ["all"],
    );
    expectPositionals(parsed.positionals, 0, "daedal routine add ...");
    const routine = service.add({
      when: required(parsed.values.when, "--when"),
      prompt: required(
        await promptOption(parsed.values),
        "--prompt or --prompt-file",
      ),
      workspace: await newRoutineWorkspace(
        context,
        parsed.values,
        parsed.flags,
      ),
      ...(parsed.values.name ? { name: parsed.values.name } : {}),
      ...(parsed.values.model ? { model: parsed.values.model } : {}),
    });
    const added = view(context, routine);
    printResult({ routine: added }, json, () =>
      console.log(
        `Added ${routine.name}: ${added.scheduleText} in ${added.workspaceName ?? "all workspaces"}; next run ${localTime(routine.nextRunAt)}`,
      ),
    );
    return 0;
  }
  if (action === "list") {
    const parsed = parseArguments(inputArgs, []);
    expectPositionals(parsed.positionals, 0, "daedal routine list");
    const routines = service.list();
    printResult({ routines }, json, () => {
      if (!routines.length) console.log("No routines.");
      for (const item of routines) console.log(routineLine(item));
    });
    return 0;
  }
  if (action === "get") {
    const parsed = parseArguments(inputArgs, []);
    expectPositionals(parsed.positionals, 1, "daedal routine get <routine>");
    const found = view(context, service.get(parsed.positionals[0]!));
    printResult({ routine: found }, json, () => printRoutine(found));
    return 0;
  }
  if (action === "edit") {
    const parsed = parseArguments(
      inputArgs,
      ["when", "prompt", "prompt-file", "name", "workspace", "model"],
      ["all"],
    );
    expectPositionals(
      parsed.positionals,
      1,
      "daedal routine edit <routine> ...",
    );
    const workspace = workspaceFlag(parsed.values, parsed.flags);
    const prompt = await promptOption(parsed.values);
    const model = parsed.values.model;
    const routine = service.update(parsed.positionals[0]!, {
      ...(parsed.values.when !== undefined ? { when: parsed.values.when } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(parsed.values.name !== undefined ? { name: parsed.values.name } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      ...(model !== undefined
        ? { model: model === "default" ? null : model }
        : {}),
    });
    const edited = view(context, routine);
    printResult({ routine: edited }, json, () => printRoutine(edited));
    return 0;
  }
  if (action === "pause" || action === "resume") {
    const parsed = parseArguments(inputArgs, []);
    expectPositionals(
      parsed.positionals,
      1,
      `daedal routine ${action} <routine>`,
    );
    const routine = service.update(parsed.positionals[0]!, {
      enabled: action === "resume",
    });
    printResult({ routine }, json, () =>
      console.log(
        action === "pause"
          ? `Paused ${routine.name}`
          : `Resumed ${routine.name}; next run ${localTime(routine.nextRunAt)}`,
      ),
    );
    return 0;
  }
  if (action === "run") {
    const parsed = parseArguments(inputArgs, []);
    expectPositionals(parsed.positionals, 1, "daedal routine run <routine>");
    const routine = service.requestRun(parsed.positionals[0]!);
    printResult({ routine }, json, () =>
      console.log(
        `Asked the app to run ${routine.name}; it starts within a few seconds while the app is open`,
      ),
    );
    return 0;
  }
  if (action === "remove" || action === "rm") {
    const parsed = parseArguments(inputArgs, []);
    expectPositionals(parsed.positionals, 1, "daedal routine remove <routine>");
    const routine = service.get(parsed.positionals[0]!);
    service.remove(routine.id);
    printResult({ removed: routine.name }, json, () =>
      console.log(`Removed ${routine.name} and its runs`),
    );
    return 0;
  }
  if (action === "runs") {
    const parsed = parseArguments(inputArgs, ["limit"]);
    const limit = parsed.values.limit ? Number(parsed.values.limit) : 20;
    if (!Number.isInteger(limit) || limit < 1)
      throw new DaedalusError("VALIDATION", "--limit takes a positive number");
    const names = new Map(
      service.list().map((item) => [item.routine.id, item.routine.name]),
    );
    const only = parsed.positionals[0]
      ? service.get(parsed.positionals[0]).id
      : undefined;
    const runs = context.repositories.routines.listRuns({
      ...(only ? { routineId: only } : {}),
      limit,
    });
    printResult({ runs }, json, () => {
      if (!runs.length) console.log("No runs.");
      for (const run of runs)
        console.log(runLine(run, names.get(run.routineId) ?? ""));
    });
    return 0;
  }
  if (action === "log") {
    const parsed = parseArguments(inputArgs, []);
    expectPositionals(parsed.positionals, 1, "daedal routine log <run-id>");
    const entries = await service.transcript(runId(parsed.positionals[0]));
    printResult({ entries }, json, () => {
      if (!entries.length) console.log("Nothing in this run's log yet.");
      for (const entry of entries)
        console.log(
          entry.kind === "text" || entry.kind === "result"
            ? entry.text
            : `[${entry.kind}] ${entry.text}`,
        );
    });
    return 0;
  }
  if (action === "when") {
    const text = inputArgs.join(" ").trim();
    if (!text)
      throw new DaedalusError(
        "VALIDATION",
        "Usage: daedal routine when <when>",
      );
    const schedule = parseWhen(text);
    printResult({ schedule, text: describeSchedule(schedule) }, json, () =>
      console.log(`${describeSchedule(schedule)}\t${schedule}`),
    );
    return 0;
  }
  throw new DaedalusError("VALIDATION", `Unknown routine command '${action}'`);
}

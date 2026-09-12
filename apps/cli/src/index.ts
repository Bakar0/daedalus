#!/usr/bin/env bun
import {
  createApplicationContext,
  DaedalusError,
  normalizeError,
  type ApplicationContext,
} from "@daedalus/core";
import { probeVersion } from "@daedalus/platform";
import type { DoctorCheck } from "@daedalus/protocol";

const VERSION = "0.1.0";
const MINIMUM_TMUX = "3.7c";
const VERIFIED_BUN = "1.4.2";

function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (version: string) => {
    const match = version.match(/(\d+)\.(\d+)([a-z]?)/i);
    return match
      ? [
          Number(match[1]),
          Number(match[2]),
          match[3] ? match[3].toLowerCase().charCodeAt(0) - 96 : 0,
        ]
      : undefined;
  };
  const left = parse(actual);
  const right = parse(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0))
      return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
}

const help = `daedal ${VERSION} — local-first control plane for coding agents

Usage:
  daedal doctor [--json]
  daedal workspace <create|list|get|update|remove> ... [--json]
  daedal task <create|list|get|update|status|remove> ... [--json]
  daedal agent <spawn|list|get|attach|send|stop|remove> ... [--json]

Run 'daedal <command> --help' for command details.`;

const commandHelp: Record<string, string> = {
  workspace: `Workspace commands:
  daedal workspace create <name> [--slug <slug>] [--path <path>]
  daedal workspace list
  daedal workspace get <workspace>
  daedal workspace update <workspace> [--name <name>] [--slug <slug>]
  daedal workspace remove <workspace> [--delete-files] --force`,
  task: `Task commands:
  daedal task create --workspace <workspace> --title <title> [--description <text>] [--priority <priority>]
  daedal task list [--workspace <workspace>] [--status <status>]
  daedal task get <task-id>
  daedal task update <task-id> [--title <title>] [--description <text>] [--priority <priority>]
  daedal task status <task-id> <status>
  daedal task remove <task-id> --force`,
  agent: `Agent commands:
  daedal agent spawn --workspace <workspace> (--provider <codex|claude> | --command <name>) [--task <task-id>]
  daedal agent list [--workspace <workspace>] [--running]
  daedal agent get <agent-id>
  daedal agent attach <agent-id>
  daedal agent send <agent-id> <text>
  daedal agent stop <agent-id> [--force]
  daedal agent remove <agent-id>`,
};

interface ParsedArguments {
  positionals: string[];
  values: Record<string, string>;
  flags: Set<string>;
}

function parseArguments(
  args: string[],
  valueOptions: string[],
  booleanOptions: string[] = [],
): ParsedArguments {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (booleanOptions.includes(name)) {
      flags.add(name);
      continue;
    }
    if (!valueOptions.includes(name))
      throw new DaedalusError("VALIDATION", `Unknown option '--${name}'`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new DaedalusError(
        "VALIDATION",
        `Option '--${name}' requires a value`,
      );
    if (values[name] !== undefined)
      throw new DaedalusError(
        "VALIDATION",
        `Option '--${name}' was provided more than once`,
      );
    values[name] = value;
    index += 1;
  }
  return { positionals, values, flags };
}

function required(value: string | undefined, description: string): string {
  if (value === undefined)
    throw new DaedalusError("VALIDATION", `${description} is required`);
  return value;
}

function expectPositionals(
  values: string[],
  count: number,
  usage: string,
): void {
  if (values.length !== count)
    throw new DaedalusError("VALIDATION", `Usage: ${usage}`);
}

function printResult(data: unknown, json: boolean, human: () => void): void {
  if (json) console.log(JSON.stringify({ ok: true, data }));
  else human();
}

async function doctor(json: boolean): Promise<number> {
  const context = await createApplicationContext();
  try {
    const bunVersion = Bun.version;
    const tmuxVersion = await probeVersion("tmux", ["-V"]);
    const tmuxCompatible = Boolean(
      tmuxVersion && versionAtLeast(tmuxVersion, MINIMUM_TMUX),
    );
    const checks: DoctorCheck[] = [
      {
        name: "bun",
        ok: bunVersion === VERIFIED_BUN,
        version: bunVersion,
        detail:
          bunVersion === VERIFIED_BUN
            ? "verified runtime"
            : `expected verified version ${VERIFIED_BUN}`,
      },
      {
        name: "tmux",
        ok: tmuxCompatible,
        version: tmuxVersion,
        detail: tmuxVersion
          ? `verified minimum ${MINIMUM_TMUX}`
          : "tmux is not available on PATH",
      },
      { name: "home", ok: true, detail: context.config.home },
      { name: "database", ok: true, detail: context.config.databasePath },
    ];
    const ok = checks.every((check) => check.ok);
    if (json) console.log(JSON.stringify({ ok, data: { checks } }));
    else
      for (const check of checks) {
        console.log(
          `${check.ok ? "✓" : "✗"} ${check.name}: ${check.version || check.detail}`,
        );
        if (check.version) console.log(`  ${check.detail}`);
      }
    return ok ? 0 : 5;
  } finally {
    context.close();
  }
}

async function workspaceCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help") {
    console.log(commandHelp.workspace);
    return 0;
  }
  if (action === "create") {
    const parsed = parseArguments(args, ["slug", "path"]);
    expectPositionals(
      parsed.positionals,
      1,
      "daedal workspace create <name> [--slug <slug>] [--path <path>]",
    );
    const result = await context.workspaces.create({
      name: parsed.positionals[0]!,
      slug: parsed.values.slug,
      path: parsed.values.path,
    });
    printResult(result, json, () =>
      console.log(
        `Created workspace ${result.slug} (${result.id}) at ${result.path}`,
      ),
    );
    return 0;
  }
  if (action === "list") {
    const parsed = parseArguments(args, []);
    expectPositionals(parsed.positionals, 0, "daedal workspace list");
    const result = await context.workspaces.list();
    printResult(result, json, () => {
      if (!result.length) console.log("No workspaces.");
      for (const item of result)
        console.log(`${item.slug}\t${item.name}\t${item.path}\t${item.id}`);
    });
    return 0;
  }
  if (action === "get") {
    const parsed = parseArguments(args, []);
    expectPositionals(
      parsed.positionals,
      1,
      "daedal workspace get <workspace>",
    );
    const result = await context.workspaces.get(parsed.positionals[0]!);
    printResult(result, json, () =>
      console.log(
        `${result.slug}\t${result.name}\t${result.path}\t${result.id}`,
      ),
    );
    return 0;
  }
  if (action === "update") {
    const parsed = parseArguments(args, ["name", "slug"]);
    expectPositionals(
      parsed.positionals,
      1,
      "daedal workspace update <workspace> [--name <name>] [--slug <slug>]",
    );
    const result = await context.workspaces.update(parsed.positionals[0]!, {
      name: parsed.values.name,
      slug: parsed.values.slug,
    });
    printResult(result, json, () =>
      console.log(`Updated workspace ${result.slug} (${result.id})`),
    );
    return 0;
  }
  if (action === "remove") {
    const parsed = parseArguments(args, [], ["delete-files", "force"]);
    expectPositionals(
      parsed.positionals,
      1,
      "daedal workspace remove <workspace> [--delete-files] --force",
    );
    const result = await context.workspaces.remove(parsed.positionals[0]!, {
      deleteFiles: parsed.flags.has("delete-files"),
      force: parsed.flags.has("force"),
    });
    printResult(result, json, () =>
      console.log(
        `Removed workspace ${result.workspace.slug}; files ${result.filesDeleted ? "deleted" : "preserved"}`,
      ),
    );
    return 0;
  }
  throw new DaedalusError(
    "VALIDATION",
    `Unknown workspace command '${action}'`,
  );
}

async function taskCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help") {
    console.log(commandHelp.task);
    return 0;
  }
  if (action === "create") {
    const parsed = parseArguments(args, [
      "workspace",
      "title",
      "description",
      "priority",
    ]);
    expectPositionals(
      parsed.positionals,
      0,
      "daedal task create --workspace <workspace> --title <title>",
    );
    const result = await context.tasks.create({
      workspace: required(parsed.values.workspace, "--workspace"),
      title: required(parsed.values.title, "--title"),
      description: parsed.values.description,
      priority: parsed.values.priority,
    });
    printResult(result, json, () =>
      console.log(`Created task ${result.id}: ${result.title}`),
    );
    return 0;
  }
  if (action === "list") {
    const parsed = parseArguments(args, ["workspace", "status"]);
    expectPositionals(
      parsed.positionals,
      0,
      "daedal task list [--workspace <workspace>] [--status <status>]",
    );
    const result = await context.tasks.list({
      workspace: parsed.values.workspace,
      status: parsed.values.status,
    });
    printResult(result, json, () => {
      if (!result.length) console.log("No tasks.");
      for (const item of result)
        console.log(
          `${item.id}\t${item.status}\t${item.priority}\t${item.title}`,
        );
    });
    return 0;
  }
  if (action === "get") {
    const parsed = parseArguments(args, []);
    expectPositionals(parsed.positionals, 1, "daedal task get <task-id>");
    const result = context.tasks.get(parsed.positionals[0]!);
    printResult(result, json, () =>
      console.log(
        `${result.id}\t${result.status}\t${result.priority}\t${result.title}`,
      ),
    );
    return 0;
  }
  if (action === "update") {
    const parsed = parseArguments(args, ["title", "description", "priority"]);
    expectPositionals(
      parsed.positionals,
      1,
      "daedal task update <task-id> [--title <title>] [--description <text>] [--priority <priority>]",
    );
    const result = context.tasks.update(parsed.positionals[0]!, {
      title: parsed.values.title,
      description: parsed.values.description,
      priority: parsed.values.priority,
    });
    printResult(result, json, () =>
      console.log(`Updated task ${result.id}: ${result.title}`),
    );
    return 0;
  }
  if (action === "status") {
    const parsed = parseArguments(args, []);
    expectPositionals(
      parsed.positionals,
      2,
      "daedal task status <task-id> <status>",
    );
    const result = context.tasks.setStatus(
      parsed.positionals[0]!,
      parsed.positionals[1]!,
    );
    printResult(result, json, () =>
      console.log(`Task ${result.id} is ${result.status}`),
    );
    return 0;
  }
  if (action === "remove") {
    const parsed = parseArguments(args, [], ["force"]);
    expectPositionals(
      parsed.positionals,
      1,
      "daedal task remove <task-id> --force",
    );
    const result = await context.tasks.remove(
      parsed.positionals[0]!,
      parsed.flags.has("force"),
    );
    printResult(result, json, () => console.log(`Removed task ${result.id}`));
    return 0;
  }
  throw new DaedalusError("VALIDATION", `Unknown task command '${action}'`);
}

async function agentCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help") {
    console.log(commandHelp.agent);
    return 0;
  }
  if (action === "spawn") {
    const parsed = parseArguments(args, [
      "workspace",
      "provider",
      "command",
      "task",
    ]);
    expectPositionals(
      parsed.positionals,
      0,
      "daedal agent spawn --workspace <workspace> (--provider <provider> | --command <name>)",
    );
    const result = await context.agents.spawn({
      workspace: required(parsed.values.workspace, "--workspace"),
      provider: parsed.values.provider,
      command: parsed.values.command,
      taskId: parsed.values.task,
    });
    printResult(result, json, () =>
      console.log(
        `Spawned ${result.provider} agent ${result.id} in ${result.tmuxSession}`,
      ),
    );
    return 0;
  }
  if (action === "list") {
    const parsed = parseArguments(args, ["workspace"], ["running"]);
    expectPositionals(
      parsed.positionals,
      0,
      "daedal agent list [--workspace <workspace>] [--running]",
    );
    const result = await context.agents.list({
      workspace: parsed.values.workspace,
      running: parsed.flags.has("running"),
    });
    printResult(result, json, () => {
      if (!result.length) console.log("No agent sessions.");
      for (const item of result)
        console.log(
          `${item.id}\t${item.status}\t${item.provider}\t${item.tmuxSession}`,
        );
    });
    return 0;
  }
  const parsed = parseArguments(args, [], action === "stop" ? ["force"] : []);
  if (action === "get") {
    expectPositionals(parsed.positionals, 1, "daedal agent get <agent-id>");
    const result = await context.agents.get(parsed.positionals[0]!);
    printResult(result, json, () =>
      console.log(
        `${result.id}\t${result.status}\t${result.provider}\t${result.tmuxSession}`,
      ),
    );
    return 0;
  }
  if (action === "attach") {
    if (json)
      throw new DaedalusError(
        "VALIDATION",
        "--json is not supported for interactive agent attach",
      );
    expectPositionals(parsed.positionals, 1, "daedal agent attach <agent-id>");
    return context.agents.attach(parsed.positionals[0]!);
  }
  if (action === "send") {
    if (parsed.positionals.length < 2)
      throw new DaedalusError(
        "VALIDATION",
        "Usage: daedal agent send <agent-id> <text>",
      );
    const result = await context.agents.send(
      parsed.positionals[0]!,
      parsed.positionals.slice(1).join(" "),
    );
    printResult(result, json, () =>
      console.log(`Sent input to agent ${result.id}`),
    );
    return 0;
  }
  if (action === "stop") {
    expectPositionals(
      parsed.positionals,
      1,
      "daedal agent stop <agent-id> [--force]",
    );
    const result = await context.agents.stop(
      parsed.positionals[0]!,
      parsed.flags.has("force"),
    );
    printResult(result, json, () => console.log(`Stopped agent ${result.id}`));
    return 0;
  }
  if (action === "remove") {
    expectPositionals(parsed.positionals, 1, "daedal agent remove <agent-id>");
    const result = await context.agents.remove(parsed.positionals[0]!);
    printResult(result, json, () => console.log(`Removed agent ${result.id}`));
    return 0;
  }
  throw new DaedalusError("VALIDATION", `Unknown agent command '${action}'`);
}

export async function runCli(inputArgs: string[]): Promise<number> {
  const json = inputArgs.includes("--json");
  const args = inputArgs.filter((argument) => argument !== "--json");
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(help);
    return 0;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(VERSION);
    return 0;
  }
  if (args.includes("--help") || args.includes("-h")) {
    const topic = args[0];
    console.log((topic && commandHelp[topic]) || help);
    return 0;
  }
  if (args[0] === "doctor") {
    if (args.length !== 1)
      throw new DaedalusError("VALIDATION", "Usage: daedal doctor [--json]");
    return doctor(json);
  }
  if (!["workspace", "task", "agent"].includes(args[0]!))
    throw new DaedalusError("VALIDATION", `Unknown command '${args[0]}'`);
  const context = await createApplicationContext();
  try {
    if (args[0] === "workspace")
      return await workspaceCommand(context, args.slice(1), json);
    if (args[0] === "task")
      return await taskCommand(context, args.slice(1), json);
    return await agentCommand(context, args.slice(1), json);
  } finally {
    context.close();
  }
}

if (import.meta.main) {
  const json = Bun.argv.slice(2).includes("--json");
  try {
    process.exitCode = await runCli(Bun.argv.slice(2));
  } catch (error) {
    const normalized = normalizeError(error);
    if (json)
      console.error(
        JSON.stringify({
          ok: false,
          error: {
            code: normalized.code,
            message: normalized.message,
            details: normalized.details,
          },
        }),
      );
    else console.error(`${normalized.code}: ${normalized.message}`);
    process.exitCode = normalized.exitCode;
  }
}

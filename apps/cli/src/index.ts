#!/usr/bin/env bun
import {
  createApplicationContext,
  DaedalusError,
  normalizeError,
  type ApplicationContext,
} from "@daedalus/core";
import { probeVersion } from "@daedalus/platform";
import type { DoctorCheck } from "@daedalus/protocol";
import packageJson from "../../../package.json";

const VERSION = packageJson.version;
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
  daedal workspace <create|list|get|update|archive|restore|remove> ... [--json]
  daedal task <create|list|get|current|update|status|remove> ... [--json]
  daedal repo <library|list|attach|sync|detach|worktree> ... [--json]
  daedal agent <spawn|list|get|attach|send|archive|restore|stop|remove> ... [--json]

Run 'daedal <command> --help' for command details.`;

const commandHelp: Record<string, string> = {
  workspace: `Workspace commands:
  daedal workspace create <name> [--slug <slug>] [--path <path>]
  daedal workspace list [--archived]
  daedal workspace get <workspace>
  daedal workspace update <workspace> [--name <name>] [--slug <slug>]
  daedal workspace archive <workspace>
  daedal workspace restore <workspace>
  daedal workspace remove <workspace> [--delete-files] --force`,
  task: `Task commands:
  daedal task create --workspace <workspace> --title <title> [--description <text>] [--priority <priority>]
  daedal task list [--workspace <workspace>] [--status <status>]
  daedal task get <task-ref> [--workspace <workspace>]
  daedal task current
  daedal task update <task-ref> [--workspace <workspace>] [--title <title>] [--description <text>] [--priority <priority>]
  daedal task status <task-ref> <status> [--workspace <workspace>]
  daedal task remove <task-ref> [--workspace <workspace>] --force`,
  repo: `Repository commands:
  daedal repo library list
  daedal repo library add <url-or-absolute-path> [--name <name>]
  daedal repo list --workspace <workspace>
  daedal repo attach --workspace <workspace> --repository <library-id>
  daedal repo sync <attachment-id>
  daedal repo detach <attachment-id>
  daedal repo worktree create --session <agent-id> --repository <name-or-id>`,
  agent: `Agent commands:
  daedal agent models <codex|claude>
  daedal agent spawn --workspace <workspace> (--provider <codex|claude> | --command <command>) [--task <task-ref>] [--name <name>] [--model <model>] [--message <text>]
  daedal agent list [--workspace <workspace>] [--running|--archived]
  daedal agent get <agent-id>
  daedal agent attach <agent-id>
  daedal agent send <agent-id> <text>
  daedal agent archive <agent-id> [--force]
  daedal agent restore <agent-id>
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

async function doctor(
  json: boolean,
  migrationsDirectory?: string,
): Promise<number> {
  const context = await createApplicationContext({ migrationsDirectory });
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
    const parsed = parseArguments(args, [], ["archived"]);
    expectPositionals(
      parsed.positionals,
      0,
      "daedal workspace list [--archived]",
    );
    const result = parsed.flags.has("archived")
      ? (await context.workspaces.listWithHealth())
          .filter((item) => item.workspace.archivedAt)
          .map((item) => item.workspace)
      : await context.workspaces.list();
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
  if (action === "archive" || action === "restore") {
    const parsed = parseArguments(args, []);
    expectPositionals(
      parsed.positionals,
      1,
      `daedal workspace ${action} <workspace>`,
    );
    const result = await context.workspaces[action](parsed.positionals[0]!);
    printResult(result, json, () =>
      console.log(
        `${action === "archive" ? "Archived" : "Restored"} workspace ${result.slug}`,
      ),
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

async function currentSessionTask(context: ApplicationContext) {
  const taskId = process.env.DAEDALUS_TASK_ID;
  if (taskId) return context.tasks.get(taskId);
  const sessionId = process.env.DAEDALUS_SESSION_ID;
  if (sessionId) {
    const session = await context.agents.get(sessionId);
    if (session.taskId) return context.tasks.get(session.taskId);
  }
  throw new DaedalusError(
    "VALIDATION",
    "No task is assigned to the current Daedalus session",
  );
}

async function resolveTaskReference(
  context: ApplicationContext,
  reference: string,
  workspaceReference?: string,
) {
  const exact = context.repositories.findTask(reference);
  if (exact) return exact;

  const scoped = /^(.+)#([1-9]\d*)$/.exec(reference);
  const numeric = /^#?([1-9]\d*)$/.exec(reference);
  if (!scoped && !numeric) return context.tasks.get(reference);

  const number = Number(scoped?.[2] ?? numeric?.[1]);
  let workspace = scoped?.[1] ?? workspaceReference;
  if (!workspace) workspace = process.env.DAEDALUS_WORKSPACE_ID;
  if (!workspace && process.env.DAEDALUS_SESSION_ID) {
    const session = await context.agents.get(process.env.DAEDALUS_SESSION_ID);
    workspace = session.workspaceId;
  }
  if (!workspace && process.env.DAEDALUS_TASK_ID) {
    workspace = context.tasks.get(process.env.DAEDALUS_TASK_ID).workspaceId;
  }
  if (!workspace)
    throw new DaedalusError(
      "VALIDATION",
      "A numeric task reference requires --workspace outside a Daedalus session",
    );
  const resolvedWorkspace = await context.workspaces.get(workspace);
  return context.tasks.getByNumber(resolvedWorkspace.id, number);
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
      console.log(`Created task #${result.number}: ${result.title}`),
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
          `#${item.number}\t${item.status}\t${item.priority}\t${item.title}`,
        );
    });
    return 0;
  }
  if (action === "current") {
    const parsed = parseArguments(args, []);
    expectPositionals(parsed.positionals, 0, "daedal task current");
    const result = await currentSessionTask(context);
    printResult(result, json, () =>
      console.log(
        `#${result.number}\t${result.status}\t${result.priority}\t${result.title}`,
      ),
    );
    return 0;
  }
  if (action === "get") {
    const parsed = parseArguments(args, ["workspace"]);
    expectPositionals(
      parsed.positionals,
      1,
      "daedal task get <task-ref> [--workspace <workspace>]",
    );
    const result = await resolveTaskReference(
      context,
      parsed.positionals[0]!,
      parsed.values.workspace,
    );
    printResult(result, json, () =>
      console.log(
        `#${result.number}\t${result.status}\t${result.priority}\t${result.title}`,
      ),
    );
    return 0;
  }
  if (action === "update") {
    const parsed = parseArguments(args, [
      "workspace",
      "title",
      "description",
      "priority",
    ]);
    expectPositionals(
      parsed.positionals,
      1,
      "daedal task update <task-ref> [--workspace <workspace>] [--title <title>] [--description <text>] [--priority <priority>]",
    );
    const task = await resolveTaskReference(
      context,
      parsed.positionals[0]!,
      parsed.values.workspace,
    );
    const result = context.tasks.update(task.id, {
      title: parsed.values.title,
      description: parsed.values.description,
      priority: parsed.values.priority,
    });
    printResult(result, json, () =>
      console.log(`Updated task #${result.number}: ${result.title}`),
    );
    return 0;
  }
  if (action === "status") {
    const parsed = parseArguments(args, ["workspace"]);
    expectPositionals(
      parsed.positionals,
      2,
      "daedal task status <task-ref> <status> [--workspace <workspace>]",
    );
    const task = await resolveTaskReference(
      context,
      parsed.positionals[0]!,
      parsed.values.workspace,
    );
    const result = context.tasks.setStatus(task.id, parsed.positionals[1]!);
    printResult(result, json, () =>
      console.log(`Task #${result.number} is ${result.status}`),
    );
    return 0;
  }
  if (action === "remove") {
    const parsed = parseArguments(args, ["workspace"], ["force"]);
    expectPositionals(
      parsed.positionals,
      1,
      "daedal task remove <task-ref> [--workspace <workspace>] --force",
    );
    const task = await resolveTaskReference(
      context,
      parsed.positionals[0]!,
      parsed.values.workspace,
    );
    const result = await context.tasks.remove(
      task.id,
      parsed.flags.has("force"),
    );
    printResult(result, json, () =>
      console.log(`Removed task #${result.number}`),
    );
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
  if (action === "models") {
    const parsed = parseArguments(args, []);
    expectPositionals(
      parsed.positionals,
      1,
      "daedal agent models <codex|claude>",
    );
    const provider = parsed.positionals[0];
    if (provider !== "codex" && provider !== "claude")
      throw new DaedalusError(
        "VALIDATION",
        "Provider must be 'codex' or 'claude'",
      );
    const result = await context.agents.models(provider);
    printResult(result, json, () => {
      console.log(
        `Provider default${result.defaultModel ? `: ${result.defaultModel}` : ""}`,
      );
      for (const model of result.models)
        console.log(
          `${model.id}\t${model.label}${model.resolvedModel ? `\t${model.resolvedModel}` : ""}`,
        );
    });
    return 0;
  }
  if (action === "spawn") {
    const parsed = parseArguments(args, [
      "workspace",
      "provider",
      "command",
      "task",
      "name",
      "model",
      "message",
    ]);
    expectPositionals(
      parsed.positionals,
      0,
      "daedal agent spawn --workspace <workspace> (--provider <provider> | --command <name>)",
    );
    const workspace = required(parsed.values.workspace, "--workspace");
    const task = parsed.values.task
      ? await resolveTaskReference(context, parsed.values.task, workspace)
      : undefined;
    const result = await context.agents.spawn({
      workspace,
      provider: parsed.values.provider,
      command: parsed.values.command,
      taskId: task?.id,
      name: parsed.values.name,
      model: parsed.values.model,
      message: parsed.values.message,
    });
    printResult(result, json, () =>
      console.log(
        `Spawned ${result.name} (${result.provider}) in ${result.tmuxSession}`,
      ),
    );
    return 0;
  }
  if (action === "list") {
    const parsed = parseArguments(args, ["workspace"], ["running", "archived"]);
    if (parsed.flags.has("running") && parsed.flags.has("archived"))
      throw new DaedalusError(
        "VALIDATION",
        "Choose either --running or --archived, not both",
      );
    expectPositionals(
      parsed.positionals,
      0,
      "daedal agent list [--workspace <workspace>] [--running|--archived]",
    );
    const result = await context.agents.list({
      workspace: parsed.values.workspace,
      running: parsed.flags.has("running"),
      archived: parsed.flags.has("archived"),
    });
    printResult(result, json, () => {
      if (!result.length) console.log("No agent sessions.");
      for (const item of result)
        console.log(
          `${item.id}\t${item.status}\t${item.provider}\t${item.name}\t${item.tmuxSession}`,
        );
    });
    return 0;
  }
  const parsed = parseArguments(
    args,
    [],
    action === "stop" || action === "archive" ? ["force"] : [],
  );
  if (action === "get") {
    expectPositionals(parsed.positionals, 1, "daedal agent get <agent-id>");
    const result = await context.agents.get(parsed.positionals[0]!);
    printResult(result, json, () =>
      console.log(
        `${result.id}\t${result.status}\t${result.provider}\t${result.name}\t${result.tmuxSession}`,
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
  if (action === "archive") {
    expectPositionals(
      parsed.positionals,
      1,
      "daedal agent archive <agent-id> [--force]",
    );
    const result = await context.agents.archive(
      parsed.positionals[0]!,
      parsed.flags.has("force"),
    );
    printResult(result, json, () => console.log(`Archived agent ${result.id}`));
    return 0;
  }
  if (action === "restore") {
    expectPositionals(parsed.positionals, 1, "daedal agent restore <agent-id>");
    const result = await context.agents.restore(parsed.positionals[0]!);
    printResult(result, json, () =>
      console.log(`Restored and resumed agent ${result.id}`),
    );
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

async function repositoryCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help") {
    console.log(commandHelp.repo);
    return 0;
  }
  if (action === "library") {
    const libraryAction = args.shift();
    if (libraryAction === "list") {
      const parsed = parseArguments(args, []);
      expectPositionals(parsed.positionals, 0, "daedal repo library list");
      const result = context.workspaceContent.listRepositoryLibrary();
      printResult(result, json, () => {
        if (!result.length) console.log("No repositories in the library.");
        for (const repository of result)
          console.log(
            `${repository.id}\t${repository.name}\t${repository.defaultBranch}\t${repository.remoteUrl}`,
          );
      });
      return 0;
    }
    if (libraryAction === "add") {
      const parsed = parseArguments(args, ["name"]);
      expectPositionals(
        parsed.positionals,
        1,
        "daedal repo library add <url-or-absolute-path> [--name <name>]",
      );
      const result = await context.workspaceContent.addRepositoryToLibrary({
        remoteUrl: parsed.positionals[0]!,
        name: parsed.values.name,
      });
      printResult(result, json, () =>
        console.log(
          `Added repository ${result.name} (${result.id}) on ${result.defaultBranch}`,
        ),
      );
      return 0;
    }
    throw new DaedalusError(
      "VALIDATION",
      "Usage: daedal repo library <list|add> ...",
    );
  }
  if (action === "list") {
    const parsed = parseArguments(args, ["workspace"]);
    expectPositionals(
      parsed.positionals,
      0,
      "daedal repo list --workspace <workspace>",
    );
    const workspace = await context.workspaces.get(
      required(parsed.values.workspace, "--workspace"),
    );
    const result = context.repositories.listWorkspaceRepositories(workspace.id);
    printResult(result, json, () => {
      if (!result.length) console.log("No attached repositories.");
      for (const repository of result)
        console.log(
          `${repository.name}\t${repository.access}\t${repository.referencePath ?? repository.canonicalPath}`,
        );
    });
    return 0;
  }
  if (action === "attach") {
    const parsed = parseArguments(args, ["workspace", "repository"]);
    expectPositionals(
      parsed.positionals,
      0,
      "daedal repo attach --workspace <workspace> --repository <library-id>",
    );
    const result = await context.workspaceContent.attachRepository({
      workspace: required(parsed.values.workspace, "--workspace"),
      libraryRepositoryId: required(parsed.values.repository, "--repository"),
    });
    printResult(result, json, () =>
      console.log(
        `Attached repository ${result.name} (${result.id}) at ${result.referencePath}`,
      ),
    );
    return 0;
  }
  if (action === "sync") {
    const parsed = parseArguments(args, []);
    expectPositionals(
      parsed.positionals,
      1,
      "daedal repo sync <attachment-id>",
    );
    const result = await context.workspaceContent.syncRepository(
      parsed.positionals[0]!,
    );
    printResult(result, json, () =>
      console.log(
        `Synchronized repository ${result.name} at ${result.baseCommit}`,
      ),
    );
    return 0;
  }
  if (action === "detach") {
    const parsed = parseArguments(args, []);
    expectPositionals(
      parsed.positionals,
      1,
      "daedal repo detach <attachment-id>",
    );
    const result = context.workspaceContent.detachRepository(
      parsed.positionals[0]!,
    );
    printResult(result, json, () =>
      console.log(`Detached repository ${result.name} (${result.id})`),
    );
    return 0;
  }
  if (action === "worktree") {
    const worktreeAction = args.shift();
    if (worktreeAction !== "create")
      throw new DaedalusError(
        "VALIDATION",
        "Usage: daedal repo worktree create --session <agent-id> --repository <name-or-id>",
      );
    const parsed = parseArguments(args, ["session", "repository"]);
    expectPositionals(
      parsed.positionals,
      0,
      "daedal repo worktree create --session <agent-id> --repository <name-or-id>",
    );
    const result = await context.workspaceContent.createSessionWorktree({
      session: required(parsed.values.session, "--session"),
      repository: required(parsed.values.repository, "--repository"),
    });
    printResult(result, json, () => console.log(result.path));
    return 0;
  }
  throw new DaedalusError(
    "VALIDATION",
    `Unknown repository command '${action}'`,
  );
}

export async function runCli(
  inputArgs: string[],
  options: { migrationsDirectory?: string } = {},
): Promise<number> {
  const json = inputArgs.includes("--json");
  const args = inputArgs.filter((argument) => argument !== "--json");
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(help);
    return 0;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    if (json)
      console.log(JSON.stringify({ ok: true, data: { version: VERSION } }));
    else console.log(VERSION);
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
    return doctor(json, options.migrationsDirectory);
  }
  if (!["workspace", "task", "repo", "agent"].includes(args[0]!))
    throw new DaedalusError("VALIDATION", `Unknown command '${args[0]}'`);
  const context = await createApplicationContext({
    migrationsDirectory: options.migrationsDirectory,
  });
  try {
    if (args[0] === "workspace")
      return await workspaceCommand(context, args.slice(1), json);
    if (args[0] === "task")
      return await taskCommand(context, args.slice(1), json);
    if (args[0] === "repo")
      return await repositoryCommand(context, args.slice(1), json);
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

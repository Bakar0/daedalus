import { realpath } from "node:fs/promises";
import { constants } from "node:os";
import { relative, sep } from "node:path";
import {
  DaedalusError,
  MIN_MASKED_LENGTH,
  SecretMasker,
  type ApplicationContext,
  type Workspace,
} from "@daedalus/core";
import { callerSession } from "./caller";
import { expectPositionals, parseArguments, printResult } from "./arguments";

export const secretHelp = `Secret commands:
  daedal secret list [--workspace <workspace>]
  daedal secret set <NAME> [--workspace <workspace>]   (the value on stdin)
  daedal secret remove <NAME> [--workspace <workspace>]
  daedal exec [--secret <NAME>]... [--workspace <workspace>] -- <command> [<args>...]

A workspace's secrets are values its agents' tools need, like API keys and
tokens, stored once so nobody pastes them into a prompt. An agent runs
'daedal secret list' to see the names, then gives a tool the ones it needs:

  daedal exec --secret GH_TOKEN -- gh pr list

'exec' starts the command with each named secret in its environment, under
its own name. Output that goes to a pipe, as an agent's tool calls do, has
each value replaced with ***; output to a terminal is passed through as it
is. Values shorter than ${MIN_MASKED_LENGTH} characters are not masked. The exit code is the
command's. A secret that is not set stops the command before it starts, with
exit code 3.

This keeps values out of prompts and transcripts by default; it is not a
security boundary. Any command the agent runs with a secret can read it.

'secret set' reads the value from standard input; at a terminal it asks for
it without echoing. The value goes to the macOS login Keychain, and Daedalus
keeps only the name. No command prints a value. The workspace's settings in
the app do the same.

Without --workspace, the workspace is the one of the session the command runs
in, else the one whose folder holds the current directory, else
DAEDALUS_WORKSPACE_ID.`;

/** The workspace a secret command is about. */
async function secretWorkspace(
  context: ApplicationContext,
  reference: string | undefined,
): Promise<Workspace> {
  if (reference) return context.workspaces.get(reference);
  const caller = await callerSession(context).catch(() => undefined);
  if (caller) return context.workspaces.get(caller.workspaceId);
  const here = await realpath(process.cwd()).catch(() => process.cwd());
  for (const workspace of await context.workspaces.list()) {
    const folder = await realpath(workspace.path).catch(() => workspace.path);
    const between = relative(folder, here);
    if (
      between === "" ||
      (!between.startsWith("..") && !between.startsWith(sep))
    )
      return workspace;
  }
  const fromEnvironment = process.env.DAEDALUS_WORKSPACE_ID;
  if (fromEnvironment) return context.workspaces.get(fromEnvironment);
  throw new DaedalusError(
    "VALIDATION",
    "Outside a Daedalus session or workspace folder, pass --workspace <workspace>",
  );
}

/**
 * A secret's value from standard input. At a terminal it is asked for with
 * echo off and ends at Return; from a pipe it is everything, less one
 * trailing newline.
 */
async function readSecretValue(name: string): Promise<string> {
  if (!process.stdin.isTTY)
    return (await Bun.stdin.text()).replace(/\r?\n$/, "");
  process.stderr.write(`Value for ${name}: `);
  Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  try {
    for await (const line of console) return line;
    return "";
  } finally {
    Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
    process.stderr.write("\n");
  }
}

export async function secretCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "help") {
    console.log(secretHelp);
    return 0;
  }
  const parsed = parseArguments(rest, ["workspace"]);
  const workspace = await secretWorkspace(context, parsed.values.workspace);
  if (action === "list") {
    expectPositionals(parsed.positionals, 0, "daedal secret list");
    const secrets = await context.secrets.list(workspace.id);
    printResult(secrets, json, () => {
      if (!secrets.length) {
        console.log(`Workspace '${workspace.slug}' has no secrets`);
        return;
      }
      for (const secret of secrets)
        console.log(`${secret.name}\tset ${secret.updatedAt}`);
    });
    return 0;
  }
  if (action === "set") {
    expectPositionals(parsed.positionals, 1, "daedal secret set <NAME>");
    const name = parsed.positionals[0]!;
    const value = await readSecretValue(name);
    const secret = await context.secrets.set(workspace.id, name, value);
    printResult(secret, json, () => {
      console.log(`Set ${secret.name} for workspace '${workspace.slug}'`);
      if (value.length < MIN_MASKED_LENGTH)
        console.error(
          `Note: values shorter than ${MIN_MASKED_LENGTH} characters are not masked in 'daedal exec' output`,
        );
    });
    return 0;
  }
  if (action === "remove") {
    expectPositionals(parsed.positionals, 1, "daedal secret remove <NAME>");
    const name = parsed.positionals[0]!;
    await context.secrets.remove(workspace.id, name);
    printResult({ workspaceId: workspace.id, name }, json, () =>
      console.log(`Removed ${name} from workspace '${workspace.slug}'`),
    );
    return 0;
  }
  throw new DaedalusError("VALIDATION", `Unknown secret command '${action}'`);
}

/** `daedal exec`'s own options and the command after `--`. */
export function parseExecArguments(args: string[]): {
  secrets: string[];
  workspace?: string;
  command: string[];
} {
  const separator = args.indexOf("--");
  if (separator === -1 || separator === args.length - 1)
    throw new DaedalusError(
      "VALIDATION",
      "Usage: daedal exec [--secret <NAME>]... -- <command> [<args>...]",
    );
  const secrets: string[] = [];
  let workspace: string | undefined;
  const own = args.slice(0, separator);
  for (let index = 0; index < own.length; index += 1) {
    const option = own[index]!;
    const value = own[index + 1];
    if (option !== "--secret" && option !== "--workspace")
      throw new DaedalusError(
        "VALIDATION",
        option.startsWith("--")
          ? `Unknown option '${option}'`
          : `Put the command after '--': daedal exec [--secret <NAME>]... -- ${option}`,
      );
    if (value === undefined || value.startsWith("--"))
      throw new DaedalusError(
        "VALIDATION",
        `Option '${option}' requires a value`,
      );
    if (option === "--secret") secrets.push(value);
    else workspace = value;
    index += 1;
  }
  return {
    secrets: [...new Set(secrets)],
    ...(workspace !== undefined ? { workspace } : {}),
    command: args.slice(separator + 1),
  };
}

/** Copies a child's output to ours, masking secret values on the way. */
async function pipeMasked(
  from: ReadableStream<Uint8Array>,
  to: NodeJS.WriteStream,
  values: string[],
): Promise<void> {
  const masker = new SecretMasker(values);
  const write = (chunk: Uint8Array) =>
    new Promise<void>((done) => {
      if (chunk.length === 0) done();
      else to.write(chunk, () => done());
    });
  for await (const chunk of from) await write(masker.push(chunk));
  await write(masker.flush());
}

/**
 * Runs a command with workspace secrets in its environment. Everything that
 * can fail is checked before the command starts, so a missing secret never
 * leaves a command half run.
 */
export async function execCommand(
  context: ApplicationContext,
  args: string[],
): Promise<number> {
  const parsed = parseExecArguments(args);
  const values = parsed.secrets.length
    ? await context.secrets.values(
        (await secretWorkspace(context, parsed.workspace)).id,
        parsed.secrets,
      )
    : {};
  const secretValues = Object.values(values);
  // A terminal is passed through untouched, so an interactive tool keeps it;
  // only output read by a program, like an agent's tool call, is masked.
  const mask = (stream: NodeJS.WriteStream) =>
    secretValues.length > 0 && !stream.isTTY;
  const maskOut = mask(process.stdout);
  const maskErr = mask(process.stderr);
  let child: Bun.Subprocess<"inherit", "pipe" | "inherit", "pipe" | "inherit">;
  try {
    child = Bun.spawn(parsed.command, {
      env: { ...process.env, ...values },
      stdin: "inherit",
      stdout: maskOut ? "pipe" : "inherit",
      stderr: maskErr ? "pipe" : "inherit",
    });
  } catch {
    throw new DaedalusError(
      "DEPENDENCY",
      `Command not found: ${parsed.command[0]}`,
    );
  }
  // Ctrl-C reaches the child itself, through the terminal's process group;
  // staying alive lets its last output still be masked and copied. A signal
  // sent to this process alone is passed on.
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(
    (signal) => [signal, forward(signal)] as const,
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    await Promise.all([
      maskOut
        ? pipeMasked(
            child.stdout as ReadableStream<Uint8Array>,
            process.stdout,
            secretValues,
          )
        : undefined,
      maskErr
        ? pipeMasked(
            child.stderr as ReadableStream<Uint8Array>,
            process.stderr,
            secretValues,
          )
        : undefined,
      child.exited,
    ]);
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  if (child.exitCode !== null) return child.exitCode;
  const signal = child.signalCode as keyof typeof constants.signals | null;
  return 128 + (signal ? (constants.signals[signal] ?? 0) : 0);
}

/**
 * Whether `--json` was given to daedal itself. For `exec`, one after `--`
 * belongs to the command it runs.
 */
export function execJsonFlag(args: string[]): boolean {
  const separator = args[0] === "exec" ? args.indexOf("--") : -1;
  return (separator === -1 ? args : args.slice(0, separator)).includes(
    "--json",
  );
}

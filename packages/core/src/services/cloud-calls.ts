import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runCommand } from "@daedalus/platform";
import type { CommandResult, DaedalCall } from "@daedalus/remote-protocol";
import type { SqliteRepositories } from "../repositories";
import {
  CLOUD_CALLER_VARIABLE,
  CLOUD_MARK_VARIABLE,
  cloudHostWorkspace,
} from "./cloud-launch";
import { cloudMark, markBlock, markOneLine } from "./cloud-mark";

/**
 * `daedal` run inside a cloud workspace's pod, answered on this Mac.
 *
 * The pod runs agent code this Mac does not trust, and a `daedal` command run
 * here can start processes, read secret values and reach every workspace. So
 * a call runs only when its arguments match the allowlist below, which keeps
 * it to the session reporting on itself and reading or updating its own
 * workspace's tasks and sessions. Everything else is refused with exit code
 * 77 before anything runs.
 *
 * An allowed call runs the Mac's own `daedal` as a child process, in the
 * workspace's folder on this Mac, with `DAEDALUS_HOME` set to this Mac's home
 * and `CLOUD_CALLER_VARIABLE` naming the host, so the command acts as the
 * session only when that session runs on this host.
 */

export const REFUSED_EXIT_CODE = 77;
export const REFUSED_MESSAGE = "not allowed from a cloud session";

/** A refusal, or the arguments to run, rewritten to pin the workspace. */
export type CallDecision =
  | {
      allowed: true;
      argv: string[];
      sessionId: string | undefined;
      /** Marks the standard input, a description read from it, as a block. */
      stdinMark?: string;
    }
  | { allowed: false; reason: string };

interface Spec {
  /** Flags that take a value. */
  values?: readonly string[];
  /** Flags that take none. */
  flags?: readonly string[];
  positionals: { min: number; max: number };
}

const SESSION_FLAG = "session";

/**
 * The commands a cloud session may run. A flag left out of a spec is refused,
 * which is how `--user`, `--team`, a local `--description-file` path and
 * every other way out of the session's own workspace stay closed.
 */
const ALLOWED: Record<string, Spec> = {
  "agent event": {
    values: [SESSION_FLAG],
    positionals: { min: 1, max: 1 },
  },
  attention: {
    values: [SESSION_FLAG],
    flags: ["clear"],
    positionals: { min: 0, max: Number.POSITIVE_INFINITY },
  },
  "team say": { positionals: { min: 1, max: Number.POSITIVE_INFINITY } },
  "team chat": {
    values: ["limit"],
    flags: ["all"],
    positionals: { min: 0, max: 0 },
  },
  "team list": { positionals: { min: 0, max: 0 } },
  "task list": {
    values: ["workspace", "status"],
    positionals: { min: 0, max: 0 },
  },
  "task get": { values: ["workspace"], positionals: { min: 1, max: 1 } },
  "task update": {
    values: [
      "workspace",
      "title",
      "description",
      "description-file",
      "priority",
    ],
    positionals: { min: 1, max: 1 },
  },
  "task status": { values: ["workspace"], positionals: { min: 2, max: 2 } },
  "agent list": {
    values: ["workspace"],
    flags: ["running", "archived"],
    positionals: { min: 0, max: 0 },
  },
  "agent get": { positionals: { min: 1, max: 1 } },
  // The session's own worktrees, made in its pod; pushed from this Mac.
  "repo worktree create": {
    values: [SESSION_FLAG, "repository", "branch"],
    positionals: { min: 0, max: 0 },
  },
  "repo worktree push": {
    values: [SESSION_FLAG, "repository"],
    positionals: { min: 0, max: 0 },
  },
  "repo worktree remove": {
    values: [SESSION_FLAG, "repository"],
    flags: ["force"],
    positionals: { min: 0, max: 0 },
  },
  "repo worktree list": {
    values: [SESSION_FLAG],
    positionals: { min: 0, max: 0 },
  },
  // Its own rebirth, its note read from standard input.
  "agent continue": {
    values: ["note-file", "model", "message"],
    flags: ["self"],
    positionals: { min: 0, max: 1 },
  },
  // The pod's BROWSER. Never run as a command: see `CloudCallOptions.openUrl`.
  "open-url": { positionals: { min: 1, max: 1 } },
};

/** Commands whose workspace is pinned with `--workspace`. */
const WORKSPACE_PINNED = new Set([
  "task list",
  "task get",
  "task update",
  "task status",
  "agent list",
]);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOOK_EVENT = /^[A-Za-z]{1,64}$/;
const TASK_NUMBER = /^#?[1-9]\d{0,8}$/;

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
}

function parse(args: string[], spec: Spec): Parsed | string {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      if (argument.startsWith("-") && argument !== "-")
        return `option ${argument}`;
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    if (spec.values?.includes(name)) {
      const value = equals === -1 ? args[++index] : argument.slice(equals + 1);
      if (value === undefined) return `option --${name} without a value`;
      // A value that looks like an option could be read as one.
      if (value.startsWith("-") && value !== "-")
        return `option --${name} with the value ${value}`;
      if (values.has(name)) return `option --${name} twice`;
      values.set(name, value);
    } else if (spec.flags?.includes(name) && equals === -1) flags.add(name);
    else return `option --${name}`;
  }
  if (
    positionals.length < spec.positionals.min ||
    positionals.length > spec.positionals.max
  )
    return "the arguments";
  return { values, flags, positionals };
}

/**
 * Decides whether a call may run, and how. `hostId` is the host the call
 * arrived from, which the relay and the secure channel vouch for; nothing in
 * the call itself is believed.
 */
export function decideCall(
  repositories: Pick<
    SqliteRepositories,
    "findAgent" | "findTask" | "findWorkspace" | "workspaceForCloud"
  >,
  hostId: string,
  call: Pick<DaedalCall, "argv" | "env">,
): CallDecision {
  const refuse = (reason: string): CallDecision => ({
    allowed: false,
    reason,
  });
  const cloudId = cloudHostWorkspace(hostId);
  const workspaceId = cloudId && repositories.workspaceForCloud(cloudId);
  if (!workspaceId) return refuse("an unknown host");
  const argv = call.argv.filter((argument) => argument !== "--json");
  const json = argv.length !== call.argv.length;
  const command =
    argv[0] === "repo" && argv[1] === "worktree"
      ? `repo worktree ${argv[2] ?? ""}`
      : argv[0] === "agent" || argv[0] === "team" || argv[0] === "task"
        ? `${argv[0]} ${argv[1] ?? ""}`
        : (argv[0] ?? "");
  const spec = ALLOWED[command];
  if (!spec) return refuse(`'${command.trim() || "daedal"}'`);
  const rest = argv.slice(command.split(" ").length);
  const parsed = parse(rest, spec);
  if (typeof parsed === "string") return refuse(parsed);

  // The session is the one the pod names, and only if it runs on this host.
  const named = parsed.values.get(SESSION_FLAG) ?? call.env.DAEDALUS_SESSION_ID;
  const session =
    named && UUID.test(named) ? repositories.findAgent(named) : undefined;
  if (named && session?.hostId !== hostId)
    return refuse("a session on another host");
  if (parsed.values.has(SESSION_FLAG) && !session)
    return refuse("an unknown session");

  if (command.startsWith("repo worktree ") && !session)
    return refuse("a worktree without its session");
  if (command === "agent continue") {
    if (!session) return refuse("a rebirth without its session");
    const named = parsed.positionals[0];
    if (named !== undefined && named !== session.id)
      return refuse("another session's rebirth");
  }
  if (command === "agent event" && !HOOK_EVENT.test(parsed.positionals[0]!))
    return refuse("the hook event");
  if (command === "attention" && !session)
    return refuse("attention without a session");
  if (command === "open-url" && !session)
    return refuse("open-url without a session");
  if (
    (command === "team say" ||
      command === "team chat" ||
      command === "team list") &&
    !session
  )
    return refuse("team commands without a session");
  if (
    parsed.values.has("workspace") &&
    parsed.values.get("workspace") !== workspaceId
  )
    return refuse("another workspace");
  if (
    parsed.values.has("description-file") &&
    parsed.values.get("description-file") !== "-"
  )
    return refuse("a description file on this Mac");
  if (parsed.values.has("note-file") && parsed.values.get("note-file") !== "-")
    return refuse("a note file on this Mac");
  if (
    command === "task get" ||
    command === "task update" ||
    command === "task status"
  ) {
    const reference = parsed.positionals[0]!;
    if (UUID.test(reference)) {
      if (repositories.findTask(reference)?.workspaceId !== workspaceId)
        return refuse("a task in another workspace");
    } else if (!TASK_NUMBER.test(reference))
      return refuse("the task reference");
  }
  if (command === "agent get") {
    const id = parsed.positionals[0]!;
    if (
      !UUID.test(id) ||
      repositories.findAgent(id)?.workspaceId !== workspaceId
    )
      return refuse("a session in another workspace");
  }

  // Text a cloud session writes where agents and the user read it is marked
  // as coming from the cloud, on every line, so nobody takes it for the user
  // or a local agent (M-4, N-1). A team message is marked in its header when
  // it is shown, from its author's session, so it is passed on as written.
  const mark = cloudMark(repositories.findWorkspace(workspaceId)?.name);
  let stdinMark: string | undefined;
  if (command === "attention" && parsed.positionals.length)
    parsed.positionals = [markOneLine(mark, parsed.positionals.join(" "))];
  if (command === "task update") {
    const title = parsed.values.get("title");
    if (title !== undefined)
      parsed.values.set("title", markOneLine(mark, title));
    const description = parsed.values.get("description");
    if (description !== undefined)
      parsed.values.set("description", markBlock(mark, description));
    if (parsed.values.has("description-file")) stdinMark = mark;
  }

  const pinned =
    WORKSPACE_PINNED.has(command) && !parsed.values.has("workspace")
      ? ["--workspace", workspaceId]
      : command.startsWith("repo worktree ") && !parsed.values.has(SESSION_FLAG)
        ? ["--session", session!.id]
        : [];
  // Rebuilt from what was parsed, so the command reads exactly what was
  // checked whatever its own parser makes of an unusual spelling.
  return {
    allowed: true,
    argv: [
      ...command.split(" "),
      ...parsed.positionals,
      ...[...parsed.values].flatMap(([name, value]) => [`--${name}`, value]),
      ...[...parsed.flags].map((name) => `--${name}`),
      ...pinned,
      ...(json ? ["--json"] : []),
    ],
    sessionId: session?.id,
    ...(stdinMark ? { stdinMark } : {}),
  };
}

/**
 * Where a pod's working directory is on this Mac, or undefined when it would
 * leave the workspace's folder, symbolic links resolved.
 */
export async function mapCloudDirectory(
  workspacePath: string,
  podDirectory: string,
): Promise<string | undefined> {
  if (isAbsolute(podDirectory) || podDirectory.includes("\0")) return undefined;
  const root = await realpath(workspacePath).catch(() => undefined);
  if (!root) return undefined;
  const inside = (path: string) => {
    const between = relative(root, path);
    return (
      between === "" ||
      (!between.startsWith(`..${sep}`) &&
        between !== ".." &&
        !isAbsolute(between))
    );
  };
  const lexical = resolve(root, podDirectory);
  if (!inside(lexical)) return undefined;
  // The folder may not exist on this Mac; the nearest one that does decides.
  let existing = lexical;
  for (;;) {
    const real = await realpath(existing).catch(() => undefined);
    if (real) return inside(real) ? lexical : undefined;
    const parent = resolve(existing, "..");
    if (parent === existing) return undefined;
    existing = parent;
  }
}

/** Drops what in a hook's input names a file, which here is a path in the pod. */
function sanitizeHookInput(stdin: string | undefined): string | undefined {
  if (stdin === undefined) return undefined;
  try {
    const payload = JSON.parse(stdin) as Record<string, unknown>;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return undefined;
    delete payload.transcript_path;
    delete payload.agent_transcript_path;
    return JSON.stringify(payload);
  } catch {
    return undefined;
  }
}

const OUTPUT_LIMIT = 1024 * 1024;
const tail = (text: string) =>
  text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text;

export interface CloudCallOptions {
  repositories: Pick<
    SqliteRepositories,
    "findAgent" | "findTask" | "findWorkspace" | "workspaceForCloud"
  >;
  home: string;
  /** The Mac's own `daedal`, as executable and leading arguments. */
  daedal: string[];
  run?: typeof runCommand;
  timeoutMs?: number;
  /**
   * Answers `daedal open-url` from a session on a host: offers the page for
   * a click rather than running anything. Without it, open-url is refused.
   */
  openUrl?: (
    hostId: string,
    sessionId: string,
    url: string,
  ) => CommandResult | Promise<CommandResult>;
}

/**
 * Answers `daedal.call` for every host. A call id that host already had
 * answered gets the same answer without running anything, which makes the
 * runner's replay of its queue safe.
 */
export class CloudCalls {
  readonly #answered = new Map<string, CommandResult>();

  constructor(private readonly options: CloudCallOptions) {}

  async answer(hostId: string, call: DaedalCall): Promise<CommandResult> {
    // Keyed by host too: a call id is only unique within one runner's calls,
    // and one runner must never get an answer made for another.
    const key = `${hostId}\n${String(call.callId)}`;
    const known = this.#answered.get(key);
    if (known) return known;
    const result = await this.#run(hostId, call);
    this.#answered.set(key, result);
    // Enough to cover a replayed queue; the oldest answers go first.
    if (this.#answered.size > 4096)
      this.#answered.delete(this.#answered.keys().next().value!);
    return result;
  }

  async #run(hostId: string, call: DaedalCall): Promise<CommandResult> {
    const refused = (reason: string): CommandResult => ({
      exitCode: REFUSED_EXIT_CODE,
      stdout: "",
      stderr: `daedal: ${REFUSED_MESSAGE}: ${reason}\n`,
    });
    if (
      !Array.isArray(call.argv) ||
      !call.argv.every((a) => typeof a === "string")
    )
      return refused("the arguments");
    const decision = decideCall(this.options.repositories, hostId, {
      argv: call.argv,
      env: call.env ?? {},
    });
    if (!decision.allowed) return refused(decision.reason);
    if (decision.argv[0] === "open-url")
      return this.options.openUrl && decision.sessionId
        ? this.options.openUrl(hostId, decision.sessionId, decision.argv[1]!)
        : refused("'open-url'");
    const workspaceId = this.options.repositories.workspaceForCloud(
      cloudHostWorkspace(hostId)!,
    )!;
    const workspace = this.options.repositories.findWorkspace(workspaceId);
    if (!workspace) return refused("a workspace this Mac does not have");
    const cwd = await mapCloudDirectory(workspace.path, String(call.cwd));
    if (!cwd) return refused("a folder outside the workspace");
    const session = decision.sessionId
      ? this.options.repositories.findAgent(decision.sessionId)
      : undefined;
    const task = session?.taskId
      ? this.options.repositories.findTask(session.taskId)
      : undefined;
    const isEvent =
      decision.argv[0] === "agent" && decision.argv[1] === "event";
    const stdin = isEvent
      ? sanitizeHookInput(call.stdin)
      : decision.stdinMark
        ? markBlock(decision.stdinMark, call.stdin ?? "")
        : call.stdin;
    const [executable, ...leading] = this.options.daedal;
    const result = await (this.options.run ?? runCommand)(
      executable!,
      [...leading, ...decision.argv],
      {
        cwd: (await realpath(cwd).catch(() => undefined)) ?? workspace.path,
        // Nothing of this process's environment but the basics, so no
        // variable of the app's own reaches the command.
        replaceEnvironment: true,
        env: {
          ...inherited(),
          DAEDALUS_HOME: this.options.home,
          DAEDALUS_WORKSPACE_ID: workspaceId,
          [CLOUD_CALLER_VARIABLE]: hostId,
          [CLOUD_MARK_VARIABLE]: cloudMark(workspace.name),
          ...(session ? { DAEDALUS_SESSION_ID: session.id } : {}),
          ...(task
            ? {
                DAEDALUS_TASK_ID: task.id,
                DAEDALUS_TASK_NUMBER: String(task.number),
              }
            : {}),
        },
        ...(stdin !== undefined ? { stdin } : {}),
        timeoutMs: this.options.timeoutMs ?? 60_000,
      },
    );
    return {
      exitCode: result.exitCode,
      stdout: tail(result.stdout),
      stderr: tail(result.stderr),
    };
  }
}

export const cloudDaedal = (home: string): string[] => [
  join(home, "bin", "daedal"),
];

const INHERITED = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "DAEDALUS_TMUX",
] as const;

const inherited = (): Record<string, string> =>
  Object.fromEntries(
    INHERITED.flatMap((name) =>
      process.env[name] ? [[name, process.env[name]!]] : [],
    ),
  );

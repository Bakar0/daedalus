import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  runCommand,
  type CommandOptions,
  type CommandResult as ProcessResult,
  type TmuxClient,
} from "@daedalus/platform";
import type { CommandResult, RunnerMethods } from "@daedalus/remote-protocol";
import { RunnerError } from "./errors";
import { resolveWorkspacePath } from "./paths";

export const MAX_READ_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;

/**
 * Variables the Mac must not set: its values describe a macOS machine, and
 * the runner's own win.
 */
const RUNNER_OWNED_VARIABLES = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  "BROWSER",
  "XDG_RUNTIME_DIR",
  "DISABLE_AUTOUPDATER",
]);

/** What `sessiond` serves: every Mac method but those the runner answers. */
export type RunnerHandlers = {
  [M in Exclude<keyof RunnerMethods, "auth.callback">]: (
    params: RunnerMethods[M]["params"],
  ) => Promise<RunnerMethods[M]["result"]>;
};

export interface HandlerDeps {
  root: string;
  tmux: TmuxClient;
  version: string;
  /** What every session and command gets: PATH, HOME and the like. */
  baseEnv: Record<string, string>;
  run?: (
    executable: string,
    args: string[],
    options: CommandOptions,
  ) => Promise<ProcessResult>;
  /** Called after a session starts, so the runner can watch it end. */
  onSessionStarted?: (session: string, keepOnExit: boolean) => void;
}

const tail = (text: string): string => {
  const bytes = Buffer.from(text);
  return bytes.length <= MAX_OUTPUT_BYTES
    ? text
    : bytes.subarray(bytes.length - MAX_OUTPUT_BYTES).toString("utf8");
};

const need = (ok: boolean, message: string): void => {
  if (!ok) throw new RunnerError("VALIDATION", message);
};

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const stringMap = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every((item) => typeof item === "string");

const sessionName = (value: unknown): string => {
  need(
    typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value),
    "Invalid session name",
  );
  return value as string;
};

export function createHandlers(deps: HandlerDeps): RunnerHandlers {
  const run = deps.run ?? runCommand;

  const environment = (
    env: Record<string, string> | undefined,
    secrets: Record<string, string> | undefined,
  ): Record<string, string> => {
    need(env === undefined || stringMap(env), "env must map strings");
    need(
      secrets === undefined || stringMap(secrets),
      "secrets must map strings",
    );
    const requested = Object.fromEntries(
      Object.entries({ ...env, ...secrets }).filter(
        ([key]) => !RUNNER_OWNED_VARIABLES.has(key),
      ),
    );
    return { ...requested, ...deps.baseEnv };
  };

  return {
    "host.probe": async () => {
      const tmux = await deps.tmux.probe();
      if (!tmux) throw new RunnerError("NO_TMUX", "tmux is not available");
      return { version: `${deps.version} ${tmux}` };
    },

    "host.start": async (launch) => {
      need(typeof launch?.executable === "string", "executable is required");
      need(strings(launch.args), "args must be strings");
      const cwd = resolveWorkspacePath(deps.root, launch.cwd);
      mkdirSync(cwd, { recursive: true });
      await deps.tmux.createSession({
        session: sessionName(launch.session),
        cwd,
        executable: launch.executable,
        args: launch.args,
        // Secrets reach tmux as process arguments and live in its memory;
        // nothing here writes them down.
        env: environment(launch.env, launch.secrets),
        // Always keep the pane, so the runner can read its exit status before
        // it removes the session (see `Runner.tick`).
        keepOnExit: true,
      });
      deps.onSessionStarted?.(launch.session, launch.keepOnExit === true);
      return null;
    },

    "host.isLive": ({ session }) => deps.tmux.hasSession(sessionName(session)),
    "host.listLive": () => deps.tmux.listSessions(),
    "host.capture": ({ session, styled }) =>
      deps.tmux.capture(sessionName(session), { styled: styled === true }),
    "host.sendKeys": async ({ session, keys }) => {
      need(strings(keys), "keys must be strings");
      await deps.tmux.sendKeys(sessionName(session), keys);
      return null;
    },
    "host.send": async ({ session, text }) => {
      need(typeof text === "string", "text must be a string");
      await deps.tmux.send(sessionName(session), text);
      return null;
    },
    "host.stop": async ({ session, force }) => {
      await deps.tmux.stop(sessionName(session), force === true);
      return null;
    },

    "host.run": async (command): Promise<CommandResult> => {
      need(typeof command?.executable === "string", "executable is required");
      need(strings(command.args), "args must be strings");
      const cwd = resolveWorkspacePath(deps.root, command.cwd);
      const result = await run(command.executable, command.args, {
        cwd,
        env: environment(command.env, command.secrets),
        replaceEnvironment: true,
        timeoutMs: command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      });
      return {
        exitCode: result.exitCode,
        stdout: tail(result.stdout),
        stderr: tail(result.stderr),
      };
    },

    "fs.write": async ({ files }) => {
      need(Array.isArray(files), "files must be a list");
      // Check every path before writing any, so a bad one writes nothing.
      const targets = files.map((file) => {
        need(typeof file?.base64 === "string", "base64 is required");
        return {
          path: resolveWorkspacePath(deps.root, file.path),
          bytes: Buffer.from(file.base64, "base64"),
        };
      });
      for (const { path, bytes } of targets) {
        mkdirSync(dirname(path), { recursive: true });
        const temporary = `${path}.daedalus-tmp`;
        writeFileSync(temporary, bytes);
        renameSync(temporary, path);
      }
      return null;
    },

    "fs.read": async ({ path }) => {
      const absolute = resolveWorkspacePath(deps.root, path);
      let size: number;
      try {
        const stats = statSync(absolute);
        if (!stats.isFile()) return null;
        size = stats.size;
      } catch {
        return null;
      }
      if (size > MAX_READ_BYTES)
        throw new RunnerError(
          "TOO_LARGE",
          `${path} is ${size} bytes; the limit is ${MAX_READ_BYTES}`,
        );
      return { base64: readFileSync(absolute).toString("base64") };
    },
  };
}

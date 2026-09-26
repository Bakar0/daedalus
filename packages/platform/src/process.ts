import { accessSync, constants } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when `timeoutMs` elapsed and the child was killed; `exitCode` is 124. */
  timedOut?: boolean;
}

/** The exit code a timed-out command reports, as `timeout(1)` does. */
export const TIMED_OUT_EXIT_CODE = 124;

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /**
   * Treat `env` as the child's whole environment instead of overlaying it on
   * this process's. The only way to keep an inherited variable out of a child.
   */
  replaceEnvironment?: boolean;
  stdin?: "ignore" | "inherit" | string;
  stdout?: "pipe" | "inherit";
  stderr?: "pipe" | "inherit";
  /**
   * Kill the child and give up after this long. A child that never exits
   * otherwise holds its caller's promise forever, and in the desktop host
   * that caller is the one thread everything else runs on.
   */
  timeoutMs?: number;
}

export async function runCommand(
  executable: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const process = Bun.spawn([executable, ...args], {
    cwd: options.cwd,
    env: options.env
      ? options.replaceEnvironment
        ? options.env
        : { ...Bun.env, ...options.env }
      : undefined,
    stdin:
      typeof options.stdin === "string" ? "pipe" : (options.stdin ?? "ignore"),
    stdout: options.stdout ?? "pipe",
    stderr: options.stderr ?? "pipe",
  });
  if (
    typeof options.stdin === "string" &&
    process.stdin !== undefined &&
    typeof process.stdin !== "number"
  ) {
    process.stdin.write(options.stdin);
    process.stdin.end();
  }
  let timedOut = false;
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          process.kill();
        }, options.timeoutMs);
  try {
    const [stdout, stderr, exited] = await Promise.all([
      process.stdout === undefined || typeof process.stdout === "number"
        ? ""
        : new Response(process.stdout).text(),
      process.stderr === undefined || typeof process.stderr === "number"
        ? ""
        : new Response(process.stderr).text(),
      process.exited,
    ]);
    if (timedOut)
      return { exitCode: TIMED_OUT_EXIT_CODE, stdout, stderr, timedOut: true };
    // A child ended by a signal has no exit code; that is still a failure.
    return {
      exitCode: typeof exited === "number" ? exited : 1,
      stdout,
      stderr,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Whether a process exists. `kill(pid, 0)` delivers nothing and fails only
 * when there is no such process; EPERM means it exists but is someone else's.
 */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A packaged macOS app is launched by Launch Services, not by a login shell, so
// it inherits `/usr/bin:/bin:/usr/sbin:/sbin` and nothing a package manager
// installed. Probing the standard install directories by absolute path is what
// keeps Homebrew-provided executables visible inside the bundle.
const STANDARD_EXECUTABLE_DIRECTORIES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

export function standardExecutableFallbacks(name: string): string[] {
  return STANDARD_EXECUTABLE_DIRECTORIES.map((directory) =>
    join(directory, name),
  );
}

export function findExecutable(
  executable: string,
  fallbacks: string[] = [],
  which: (candidate: string) => string | null = Bun.which,
  isExecutable: (candidate: string) => boolean = (candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
): string | undefined {
  for (const candidate of [executable, ...fallbacks]) {
    if (isAbsolute(candidate) && isExecutable(candidate)) return candidate;
    const resolved = which(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

export async function probeVersion(
  executable: string,
  args: string[],
): Promise<string | undefined> {
  try {
    const result = await runCommand(executable, args);
    return result.exitCode === 0
      ? result.stdout.trim() || result.stderr.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

const SHELL_PATH_MARKER = "__DAEDALUS_SHELL_PATH__";

/**
 * How long a login shell may take to report its PATH. An interactive
 * configuration that loads a plugin manager takes a second or so; one that
 * waits for input would otherwise hold the launch forever.
 */
export const SHELL_PATH_TIMEOUT_MS = 10_000;

/**
 * The PATH the user's own terminal would have. A packaged app gets
 * `/usr/bin:/bin:/usr/sbin:/sbin` from Launch Services, so everything Homebrew,
 * nvm, pipx or a `.zshrc` adds is missing from whatever the app starts. The
 * shell runs as a login shell, which is what applies `/etc/paths.d` through
 * `path_helper`, and as an interactive one, which is what reads `.zshrc`. That
 * is how editors resolve the same thing. The value is printed between markers
 * because an interactive configuration may print its own output around it.
 *
 * `undefined` when there is no shell or it does not answer; callers keep the
 * PATH they had.
 */
export async function readLoginShellPath(
  shell: string | undefined,
  run: typeof runCommand = runCommand,
): Promise<string | undefined> {
  if (!shell || !isAbsolute(shell)) return undefined;
  const result = await run(
    shell,
    [
      "-i",
      "-l",
      "-c",
      `printf '\\n%s%s%s\\n' ${SHELL_PATH_MARKER} "$PATH" ${SHELL_PATH_MARKER}`,
    ],
    { stdin: "ignore", timeoutMs: SHELL_PATH_TIMEOUT_MS },
  ).catch(() => undefined);
  if (!result || result.exitCode !== 0) return undefined;
  const start = result.stdout.lastIndexOf(`\n${SHELL_PATH_MARKER}`);
  if (start < 0) return undefined;
  const value = result.stdout.slice(start + SHELL_PATH_MARKER.length + 1);
  const end = value.indexOf(SHELL_PATH_MARKER);
  const path = end < 0 ? "" : value.slice(0, end);
  return path.includes("/") && !path.includes("\n") ? path : undefined;
}

let loginShellPathOnce: Promise<string | undefined> | undefined;

/**
 * `readLoginShellPath` for `$SHELL`, asked once per process. A change to the
 * user's shell configuration reaches sessions started after the app restarts.
 */
export function loginShellPath(): Promise<string | undefined> {
  loginShellPathOnce ??= readLoginShellPath(process.env.SHELL);
  return loginShellPathOnce;
}

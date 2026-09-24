import { accessSync, constants } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

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
  const [stdout, stderr, exitCode] = await Promise.all([
    process.stdout === undefined || typeof process.stdout === "number"
      ? ""
      : new Response(process.stdout).text(),
    process.stderr === undefined || typeof process.stderr === "number"
      ? ""
      : new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
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

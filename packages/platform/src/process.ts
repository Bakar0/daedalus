import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: "ignore" | "inherit";
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
    env: options.env ? { ...Bun.env, ...options.env } : undefined,
    stdin: options.stdin ?? "ignore",
    stdout: options.stdout ?? "pipe",
    stderr: options.stderr ?? "pipe",
  });
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

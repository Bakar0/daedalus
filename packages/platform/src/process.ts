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

export function findExecutable(executable: string): string | undefined {
  return Bun.which(executable) ?? undefined;
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

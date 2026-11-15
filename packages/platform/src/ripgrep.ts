import { isAbsolute } from "node:path";
import { findExecutable, standardExecutableFallbacks } from "./process";

/**
 * The ripgrep Daedalus.app carries in its bundle, as an absolute path
 * (`scripts/fetch-ripgrep.ts`, copied into `Contents/MacOS` next to tmux).
 * The app and its bundled CLI set it. Unset, or pointing at nothing
 * executable, the search falls back to PATH and the standard install
 * locations, and without any ripgrep content search says so.
 */
export const BUNDLED_RIPGREP_VARIABLE = "DAEDALUS_RG";

export const RIPGREP_EXECUTABLE_FALLBACKS = standardExecutableFallbacks("rg");

export const findRipgrepExecutable = (
  environment: NodeJS.ProcessEnv = process.env,
  find: typeof findExecutable = findExecutable,
): string | undefined => {
  const bundled = environment[BUNDLED_RIPGREP_VARIABLE];
  const fallbacks = ["rg", ...RIPGREP_EXECUTABLE_FALLBACKS];
  if (bundled && isAbsolute(bundled)) {
    const found = find(bundled, []);
    if (found) return found;
  }
  return find(fallbacks[0]!, fallbacks.slice(1));
};

export interface LineStreamResult {
  exitCode: number;
  /** The caller stopped reading, or the signal fired, and the child was killed. */
  stopped: boolean;
  stderr: string;
}

/**
 * Runs a command and hands its stdout to `onLine` one line at a time, as it
 * arrives. `onLine` returning false, or `signal` aborting, kills the child:
 * a search with enough results, or one the user has typed past, stops at
 * once instead of reading the whole tree. Arguments are an array; nothing
 * goes through a shell.
 */
export async function streamCommandLines(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    onLine: (line: string) => boolean | void;
  },
): Promise<LineStreamResult> {
  const child = Bun.spawn([executable, ...args], {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    child.kill();
  };
  if (options.signal?.aborted) stop();
  options.signal?.addEventListener("abort", stop, { once: true });
  const stderr = new Response(child.stderr).text();
  try {
    const decoder = new TextDecoder();
    let pending = "";
    const reader = child.stdout.getReader();
    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0 && !stopped) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (options.onLine(line) === false) stop();
        newline = pending.indexOf("\n");
      }
    }
    if (!stopped && pending) options.onLine(pending);
    if (stopped) await reader.cancel().catch(() => undefined);
    const exited = await child.exited;
    return {
      exitCode: typeof exited === "number" ? exited : 1,
      stopped,
      stderr: await stderr,
    };
  } finally {
    options.signal?.removeEventListener("abort", stop);
  }
}

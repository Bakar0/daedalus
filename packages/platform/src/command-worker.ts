import type { CommandOptions, CommandResult } from "./process";

/**
 * Runs `runCommand`'s children from a worker thread instead of the caller's.
 *
 * Launching a child blocks the launching thread inside `posix_spawn` until
 * the child has started. With endpoint security inspecting every exec that
 * was measured at a median of about 1 ms and up to 8 ms here, and at seconds
 * on a loaded machine. In the desktop host the launching thread is the one
 * that relays terminal output to the window, so every git, gh and tmux call
 * the status passes make was a pause in the terminal. From a worker the
 * pause lands on a thread nothing is waiting on.
 *
 * The worker is built from the source below rather than from a file, so it
 * survives bundling unchanged. It has no imports and does what `runCommand`
 * does, with the environment resolved on the calling side: the caller's
 * `process.env` is the one that is kept up to date.
 */
const WORKER_SOURCE = `
self.onmessage = async ({ data }) => {
  const { id, argv, cwd, env, stdin, timeoutMs } = data;
  let child;
  try {
    child = Bun.spawn(argv, {
      cwd,
      env,
      stdin: typeof stdin === "string" ? "pipe" : (stdin ?? "ignore"),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    postMessage({
      id,
      error: { message: String(error?.message ?? error), code: error?.code },
    });
    return;
  }
  if (typeof stdin === "string") {
    child.stdin.write(stdin);
    child.stdin.end();
  }
  let timedOut = false;
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs);
  try {
    const [stdout, stderr, exited] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    postMessage({
      id,
      result: timedOut
        ? { exitCode: 124, stdout, stderr, timedOut: true }
        : { exitCode: typeof exited === "number" ? exited : 1, stdout, stderr },
    });
  } catch (error) {
    postMessage({ id, error: { message: String(error?.message ?? error) } });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
`;

/** What `runCommand` hands a worker: a command whose output it collects. */
export type CommandRunner = (
  executable: string,
  args: string[],
  options: CommandOptions,
) => Promise<CommandResult>;

type Reply =
  | { id: number; result: CommandResult }
  | { id: number; error: { message: string; code?: string } };

/**
 * Starts the worker and returns a runner for it. `onFailure` is called once
 * if the worker dies; the calls it was running reject, and the runner then
 * reports itself unusable through `available()` so callers go back to
 * launching on their own thread.
 */
export function startCommandWorker(onFailure?: (error: Error) => void): {
  run: CommandRunner;
  available: () => boolean;
  stop: () => void;
} {
  const url = URL.createObjectURL(
    new Blob([WORKER_SOURCE], { type: "application/javascript" }),
  );
  const worker = new Worker(url);
  // The worker must never be what keeps a process alive.
  // Bun's Worker has `unref`, which its DOM-shaped type leaves out.
  (worker as Worker & { unref?: () => void }).unref?.();
  let alive = true;
  let next = 0;
  const pending = new Map<
    number,
    { resolve: (result: CommandResult) => void; reject: (error: Error) => void }
  >();
  const fail = (error: Error) => {
    if (!alive) return;
    alive = false;
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    worker.terminate();
    URL.revokeObjectURL(url);
    onFailure?.(error);
  };
  worker.addEventListener("message", (event: MessageEvent<Reply>) => {
    const reply = event.data;
    const call = pending.get(reply.id);
    if (!call) return;
    pending.delete(reply.id);
    if ("result" in reply) call.resolve(reply.result);
    else
      call.reject(
        Object.assign(new Error(reply.error.message), {
          ...(reply.error.code ? { code: reply.error.code } : {}),
        }),
      );
  });
  worker.addEventListener("error", (event) =>
    fail(new Error(`Command worker failed: ${event.message}`)),
  );
  worker.addEventListener("close", () =>
    fail(new Error("Command worker exited")),
  );
  return {
    available: () => alive,
    stop: () => fail(new Error("Command worker stopped")),
    run: (executable, args, options) =>
      new Promise((resolve, reject) => {
        if (!alive) {
          reject(new Error("Command worker is not running"));
          return;
        }
        const id = ++next;
        pending.set(id, { resolve, reject });
        const merged = options.env
          ? options.replaceEnvironment
            ? options.env
            : { ...Bun.env, ...options.env }
          : { ...Bun.env };
        const env: Record<string, string> = {};
        for (const [name, value] of Object.entries(merged))
          if (value !== undefined) env[name] = value;
        worker.postMessage({
          id,
          argv: [executable, ...args],
          cwd: options.cwd,
          env,
          stdin: options.stdin,
          timeoutMs: options.timeoutMs,
        });
      }),
  };
}

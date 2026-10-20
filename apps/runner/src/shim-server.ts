import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandResult, DaedalCall } from "@daedalus/remote-protocol";
import { isQueueable } from "./shim-protocol";

/**
 * The runner's side of the `daedal` shim socket. Every uid in the pod may
 * connect, so a request is read as untrusted (N-4).
 */

/** The longest request line, stdin included. A description fits easily. */
export const MAX_SHIM_REQUEST_BYTES = 1024 * 1024;

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((item) => typeof item === "string");

/**
 * The call a request line makes, or a reason it is refused. Whether the call
 * may wait in the queue comes from its arguments, never from the request.
 */
export function callFromRequest(
  line: string,
  at: Date,
): DaedalCall | { refused: string } {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return { refused: "The request is not JSON" };
  }
  const { argv, cwd, env, stdin } = (request ?? {}) as Record<string, unknown>;
  if (
    !Array.isArray(argv) ||
    !argv.every((item) => typeof item === "string") ||
    typeof cwd !== "string" ||
    !isStringRecord(env) ||
    (stdin !== undefined && typeof stdin !== "string")
  )
    return { refused: "The request is malformed" };
  return {
    callId: crypto.randomUUID(),
    argv,
    cwd,
    env,
    ...(stdin === undefined ? {} : { stdin }),
    queueable: isQueueable(argv),
    at: at.toISOString(),
  };
}

/**
 * Makes the socket's folder the runner's own, mode 0755, inside the shared
 * folder both containers can write. The shared folder is sticky, so the
 * session container can neither remove this folder nor put anything in it,
 * and cannot take the socket's path before the runner listens on it.
 */
export function prepareShimSocket(path: string): void {
  const folder = dirname(path);
  try {
    mkdirSync(folder, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(folder);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.())
    throw new Error(`${folder} is not a folder the runner owns`);
  chmodSync(folder, 0o755);
  rmSync(path, { force: true });
}

const refusal = (message: string): CommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr: `${message}\n`,
});

/**
 * At most this many connections are open at once, so requests that never
 * end hold at most 32 MiB of the runner's 256 MiB between them.
 */
export const MAX_SHIM_CONNECTIONS = 32;

/** A request must arrive within this many seconds of connecting. */
export const SHIM_READ_TIMEOUT_SECONDS = 10;

const reply = (
  socket: { write(data: string): number; end(): void },
  result: CommandResult,
) => {
  socket.write(`${JSON.stringify(result)}\n`);
  socket.end();
};

/** Answers one request per connection, read up to its first newline. */
export function listenForShim(
  path: string,
  call: (call: DaedalCall) => Promise<CommandResult>,
  limits: {
    bytes?: number;
    connections?: number;
    readTimeoutSeconds?: number;
  } = {},
) {
  const bytes = limits.bytes ?? MAX_SHIM_REQUEST_BYTES;
  const connections = limits.connections ?? MAX_SHIM_CONNECTIONS;
  let open = 0;
  return Bun.listen<{
    chunks: Buffer[];
    bytes: number;
    done: boolean;
    counted: boolean;
  }>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { chunks: [], bytes: 0, done: false, counted: false };
        if (open >= connections) {
          socket.data.done = true;
          reply(socket, refusal("The runner is busy; try again"));
          return;
        }
        open += 1;
        socket.data.counted = true;
        socket.timeout(limits.readTimeoutSeconds ?? SHIM_READ_TIMEOUT_SECONDS);
      },
      timeout(socket) {
        if (socket.data.done) return;
        socket.data.done = true;
        socket.data.chunks = [];
        reply(socket, refusal("The request did not arrive in time"));
      },
      close(socket) {
        if (socket.data.counted) open -= 1;
        socket.data.counted = false;
        socket.data.chunks = [];
      },
      async data(socket, chunk) {
        const state = socket.data;
        if (state.done) return;
        const newline = chunk.indexOf(10);
        const kept = newline === -1 ? chunk : chunk.subarray(0, newline);
        state.chunks.push(Buffer.from(kept));
        state.bytes += kept.byteLength;
        if (state.bytes > bytes) {
          state.done = true;
          state.chunks = [];
          reply(socket, refusal(`The request is over ${bytes} bytes`));
          return;
        }
        if (newline === -1) return;
        state.done = true;
        // The call itself may wait on the Mac for a minute.
        socket.timeout(0);
        const line = Buffer.concat(state.chunks).toString("utf8");
        state.chunks = [];
        const made = callFromRequest(line, new Date());
        let result: CommandResult;
        try {
          result = "refused" in made ? refusal(made.refused) : await call(made);
        } catch (error) {
          result = refusal((error as Error).message);
        }
        reply(socket, result);
      },
    },
  });
}

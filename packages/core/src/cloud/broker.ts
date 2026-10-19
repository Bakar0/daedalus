import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RunnerMethod, RunnerMethods } from "@daedalus/remote-protocol";
import { DaedalusError, type ErrorCode } from "../errors";
import type { RunnerTransport } from "./link";

/**
 * The gateway takes one connection per Mac, so only one process holds the
 * cloud link: the app when it runs. Other processes on this Mac, such as a
 * `daedal` command, reach runners through it over this Unix socket, which
 * lives in the Daedalus home and only the user can open (0600 in a 0700
 * folder). Requests are newline-delimited JSON, one per connection.
 *
 * Only `RunnerMethods` cross it. Terminals do not: they open in the app.
 */

export const brokerSocketPath = (home: string): string =>
  join(home, "cloud", "broker.sock");

const METHODS = new Set<string>([
  "host.probe",
  "host.start",
  "host.isLive",
  "host.listLive",
  "host.capture",
  "host.sendKeys",
  "host.send",
  "host.stop",
  "host.run",
  "fs.write",
  "fs.read",
]);

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

type BrokerRequest =
  | { kind: "unavailable"; workspaceId: string }
  | {
      kind: "request";
      workspaceId: string;
      method: RunnerMethod;
      params: unknown;
      timeoutMs?: number;
    };

type BrokerReply =
  | { ok: true; result: unknown }
  | { ok: false; code: ErrorCode; message: string };

const isErrorCode = (code: unknown): code is ErrorCode =>
  code === "VALIDATION" ||
  code === "NOT_FOUND" ||
  code === "CONFLICT" ||
  code === "DEPENDENCY" ||
  code === "INTERNAL";

async function handle(
  transport: RunnerTransport,
  line: string,
): Promise<BrokerReply> {
  try {
    const request = JSON.parse(line) as BrokerRequest;
    if (typeof request.workspaceId !== "string")
      throw new DaedalusError(
        "VALIDATION",
        "A broker request needs a workspace",
      );
    if (request.kind === "unavailable")
      return {
        ok: true,
        result: await transport.unavailable(request.workspaceId),
      };
    if (request.kind !== "request" || !METHODS.has(request.method))
      throw new DaedalusError("VALIDATION", "Unknown broker request");
    return {
      ok: true,
      result: await transport.request(
        request.workspaceId,
        request.method,
        request.params as never,
        typeof request.timeoutMs === "number" ? request.timeoutMs : undefined,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof DaedalusError && isErrorCode(error.code)
          ? error.code
          : "INTERNAL",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Serves `transport` to other processes. Returns a function that stops it. */
export async function serveBroker(
  home: string,
  transport: RunnerTransport,
): Promise<() => Promise<void>> {
  const path = brokerSocketPath(home);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await chmod(join(path, ".."), 0o700);
  // One left by an app that did not shut down cleanly.
  await rm(path, { force: true });
  const buffers = new WeakMap<object, string>();
  const listener = Bun.listen({
    unix: path,
    socket: {
      data(socket, chunk) {
        const buffer = (buffers.get(socket) ?? "") + chunk.toString();
        if (buffer.length > MAX_REQUEST_BYTES) {
          socket.end();
          return;
        }
        const end = buffer.indexOf("\n");
        if (end === -1) {
          buffers.set(socket, buffer);
          return;
        }
        buffers.set(socket, "");
        void handle(transport, buffer.slice(0, end)).then((reply) => {
          socket.write(`${JSON.stringify(reply)}\n`);
          socket.end();
        });
      },
    },
  });
  await chmod(path, 0o600);
  return async () => {
    listener.stop(true);
    await rm(path, { force: true });
  };
}

/** Asks the broker one thing; undefined when nothing is serving it. */
async function ask(
  home: string,
  request: BrokerRequest,
  timeoutMs: number,
): Promise<BrokerReply | undefined> {
  const reply = Promise.withResolvers<BrokerReply | undefined>();
  let buffer = "";
  const timer = setTimeout(
    () =>
      reply.resolve({
        ok: false,
        code: "DEPENDENCY",
        message: "The Daedalus app did not answer for the cloud runner",
      }),
    timeoutMs + 5_000,
  );
  try {
    await Bun.connect({
      unix: brokerSocketPath(home),
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify(request)}\n`);
        },
        data(_socket, chunk) {
          buffer += chunk.toString();
          const end = buffer.indexOf("\n");
          if (end === -1) return;
          try {
            reply.resolve(JSON.parse(buffer.slice(0, end)) as BrokerReply);
          } catch {
            reply.resolve(undefined);
          }
        },
        close() {
          reply.resolve(undefined);
        },
        error() {
          reply.resolve(undefined);
        },
      },
    });
  } catch {
    reply.resolve(undefined);
  }
  return reply.promise.finally(() => clearTimeout(timer));
}

/** Whether a process on this Mac holds the link and serves the broker. */
export async function brokerAvailable(home: string): Promise<boolean> {
  // `Bun.file().exists()` is false for a socket, so this asks `stat`.
  if (!(await stat(brokerSocketPath(home)).catch(() => undefined)))
    return false;
  return (
    (await ask(home, { kind: "unavailable", workspaceId: "" }, 2_000)) !==
    undefined
  );
}

/** The runner, through the process that holds the link. */
export class BrokerTransport implements RunnerTransport {
  constructor(private readonly home: string) {}

  async unavailable(workspaceId: string): Promise<string | undefined> {
    const reply = await ask(
      this.home,
      { kind: "unavailable", workspaceId },
      5_000,
    );
    if (!reply) return "The Daedalus app that holds the cloud link went away";
    if (!reply.ok) return reply.message;
    return reply.result as string | undefined;
  }

  async request<M extends RunnerMethod>(
    workspaceId: string,
    method: M,
    params: RunnerMethods[M]["params"],
    timeoutMs = 30_000,
  ): Promise<RunnerMethods[M]["result"]> {
    const reply = await ask(
      this.home,
      { kind: "request", workspaceId, method, params, timeoutMs },
      timeoutMs,
    );
    if (!reply)
      throw new DaedalusError(
        "DEPENDENCY",
        "The Daedalus app that holds the cloud link went away",
      );
    if (!reply.ok) throw new DaedalusError(reply.code, reply.message);
    return reply.result as RunnerMethods[M]["result"];
  }
}

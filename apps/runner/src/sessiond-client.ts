import { RunnerError } from "./errors";
import type { SessionBackend, Terminal } from "./backend";
import { SocketWriter } from "@daedalus/remote-protocol";
import {
  encodeInputFrame,
  MAX_HEADER_BYTES,
  MAX_REPLY_BYTES,
  REQUEST_TIMEOUT_MS,
  RUN_TIMEOUT_SLACK_MS,
  type SessiondMethod,
  type SessiondMethods,
} from "./sessiond-protocol";

const MAX_ERROR_MESSAGE = 4096;

/** Terminal input waiting for sessiond to read it; past this the terminal closes. */
const MAX_PENDING_INPUT_BYTES = 8 * 1024 * 1024;

/**
 * Turns an `{error}` line into a `RunnerError` the runner may pass on. The
 * code must look like one of ours; the message is cut. Both came from a
 * process an agent could have replaced.
 */
const toError = (value: unknown): RunnerError => {
  const error = (value ?? {}) as { code?: unknown; message?: unknown };
  const code =
    typeof error.code === "string" && /^[A-Z_]{1,40}$/.test(error.code)
      ? error.code
      : "FAILED";
  const message =
    typeof error.message === "string"
      ? error.message.slice(0, MAX_ERROR_MESSAGE)
      : "sessiond failed";
  return new RunnerError(code, message);
};

const TIMEOUT = () =>
  new RunnerError("SESSIOND_TIMEOUT", "The session container did not answer");
const UNAVAILABLE = (reason: string) =>
  new RunnerError("SESSIOND_UNAVAILABLE", reason);

type Connect = typeof Bun.connect;

/** The runner's side of the sessiond protocol. Every reply is untrusted. */
export class SessiondClient implements SessionBackend {
  constructor(
    private readonly path: string,
    private readonly connect: Connect = Bun.connect,
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  async call<M extends SessiondMethod>(
    method: M,
    params: SessiondMethods[M]["params"],
  ): Promise<SessiondMethods[M]["result"]> {
    const timeoutMs =
      method === "host.run"
        ? ((params as { timeoutMs?: number }).timeoutMs ?? 10 * 60_000) +
          RUN_TIMEOUT_SLACK_MS
        : this.requestTimeoutMs;
    const reply = Promise.withResolvers<unknown>();
    let buffer = Buffer.alloc(0);
    let done = false;
    let writer: SocketWriter | undefined;
    const finish = (settle: () => void, socket?: { end(): void }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle();
      socket?.end();
    };
    const timer = setTimeout(
      () => finish(() => reply.reject(TIMEOUT())),
      timeoutMs,
    );
    try {
      await this.connect({
        unix: this.path,
        socket: {
          open: (socket) => {
            writer = new SocketWriter(socket);
            writer.write(`${JSON.stringify({ method, params })}\n`);
          },
          drain: () => writer?.flush(),
          data: (socket, chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length > MAX_REPLY_BYTES) {
              finish(
                () =>
                  reply.reject(
                    new RunnerError(
                      "SESSIOND_REPLY_TOO_LARGE",
                      "Reply too large",
                    ),
                  ),
                socket,
              );
              return;
            }
            const end = buffer.indexOf("\n");
            if (end < 0) return;
            finish(() => {
              try {
                reply.resolve(
                  JSON.parse(buffer.subarray(0, end).toString("utf8")),
                );
              } catch {
                reply.reject(UNAVAILABLE("Unreadable reply"));
              }
            }, socket);
          },
          close: () =>
            finish(() => reply.reject(UNAVAILABLE("Connection closed"))),
          error: (_socket, error) =>
            finish(() => reply.reject(UNAVAILABLE(error.message))),
        },
      });
    } catch (error) {
      finish(() => reply.reject(UNAVAILABLE((error as Error).message)));
    }
    const message = (await reply.promise) as {
      result?: unknown;
      error?: unknown;
    } | null;
    if (message === null || typeof message !== "object")
      throw UNAVAILABLE("Unreadable reply");
    if ("error" in message) throw toError(message.error);
    if (!("result" in message)) throw UNAVAILABLE("Reply has no result");
    return message.result as SessiondMethods[M]["result"];
  }

  async openTerminal(
    session: string,
    size: { cols: number; rows: number },
    onOutput: (output: Uint8Array) => void,
  ): Promise<Terminal> {
    const opened = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let header = Buffer.alloc(0);
    let live = false;
    const timer = setTimeout(() => {
      opened.reject(TIMEOUT());
      socket?.end();
    }, this.requestTimeoutMs);
    let socket: Awaited<ReturnType<Connect>> | undefined;
    let writer: SocketWriter | undefined;
    try {
      socket = await this.connect({
        unix: this.path,
        socket: {
          open: (s) => {
            writer = new SocketWriter(s, MAX_PENDING_INPUT_BYTES);
            writer.write(
              `${JSON.stringify({ terminal: { session, cols: size.cols, rows: size.rows } })}\n`,
            );
          },
          drain: () => writer?.flush(),
          data: (s, chunk) => {
            if (live) {
              onOutput(new Uint8Array(chunk));
              return;
            }
            header = Buffer.concat([header, chunk]);
            const end = header.indexOf("\n");
            if (end < 0 || end > MAX_HEADER_BYTES) {
              if (header.length > MAX_HEADER_BYTES) {
                opened.reject(UNAVAILABLE("Terminal header too long"));
                s.end();
              }
              return;
            }
            try {
              const reply = JSON.parse(
                header.subarray(0, end).toString("utf8"),
              ) as { ok?: unknown; error?: unknown };
              if (reply.ok !== true) throw toError(reply.error);
              live = true;
              opened.resolve();
              const rest = header.subarray(end + 1);
              if (rest.length > 0) onOutput(new Uint8Array(rest));
            } catch (error) {
              opened.reject(
                error instanceof RunnerError
                  ? error
                  : UNAVAILABLE("Bad header"),
              );
              s.end();
            }
          },
          close: () => {
            opened.reject(UNAVAILABLE("Connection closed"));
            closed.resolve();
          },
          error: (_s, error) => {
            opened.reject(UNAVAILABLE(error.message));
            closed.resolve();
          },
        },
      });
      await opened.promise;
    } catch (error) {
      socket?.end();
      throw error instanceof RunnerError
        ? error
        : UNAVAILABLE((error as Error).message);
    } finally {
      clearTimeout(timer);
    }
    const input = writer!;
    return {
      start: () => closed.promise,
      write: (data) => input.write(encodeInputFrame({ type: "input", data })),
      resize: (cols, rows) =>
        input.write(encodeInputFrame({ type: "resize", cols, rows })),
      close: () => input.end(),
    };
  }
}

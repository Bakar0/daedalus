import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { runCommand } from "@daedalus/platform";
import { SocketWriter } from "@daedalus/remote-protocol";
import { RunnerError } from "./errors";
import type { RunnerHandlers } from "./handlers";
import {
  InputFrameReader,
  MAX_HEADER_BYTES,
  MAX_REQUEST_BYTES,
  SESSIOND_METHODS,
  type SessiondMethod,
  type TerminalHeader,
} from "./sessiond-protocol";
import type { Terminal } from "./backend";

/**
 * Makes `path` a folder only this process can use, for `XDG_RUNTIME_DIR`,
 * and returns it, or undefined when that is not possible.
 *
 * Claude Code refuses to put its cross-session messaging socket under a
 * folder that anyone can write without the sticky bit, which the session's
 * `/tmp` is (a disk `emptyDir`, mode 2777, owned by root). The shared runtime
 * folder is a memory `emptyDir`, which is sticky, so a private folder inside
 * it passes. Only sockets go there; the folder is small.
 */
export function privateRuntimeFolder(path: string): string | undefined {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.())
      return undefined;
    chmodSync(path, 0o700);
    return path;
  } catch {
    return undefined;
  }
}

export interface SessionDaemonDeps {
  handlers: RunnerHandlers;
  /** Panes whose command ended, by session, with the exit status. */
  deadPanes: () => Promise<Record<string, number | null>>;
  hasSession: (session: string) => Promise<boolean>;
  openTerminal: (
    session: string,
    size: { cols: number; rows: number },
    onOutput: (output: Uint8Array) => void,
  ) => Terminal;
}

/**
 * Terminal output waiting for the runner to read it. Past this the runner
 * is not reading, and the terminal is closed rather than held in memory.
 */
const MAX_PENDING_OUTPUT_BYTES = 8 * 1024 * 1024;

interface Connection {
  buffer: Buffer;
  writer: SocketWriter;
  /** Set once the first line is read. */
  kind?: "request" | "terminal";
  terminal?: Terminal;
  frames?: InputFrameReader;
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

const errorLine = (error: unknown): string =>
  line({
    error: {
      code: error instanceof RunnerError ? error.code : "FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  });

/**
 * The daemon in the session container. It owns tmux and does every piece of
 * work that touches `/workspace` or runs a command, as the session uid, so
 * the runner never has to.
 */
export class SessionDaemon {
  #server: ReturnType<typeof Bun.listen<Connection>> | undefined;

  constructor(private readonly deps: SessionDaemonDeps) {}

  /** `group`, when this process is in it, becomes the socket's group. */
  listen(path: string, group?: number): void {
    if (existsSync(path)) rmSync(path);
    this.#server = Bun.listen<Connection>({
      unix: path,
      socket: {
        open: (socket) => {
          socket.data = {
            buffer: Buffer.alloc(0),
            writer: new SocketWriter(socket),
          };
        },
        data: (socket, chunk) => void this.#onData(socket, chunk),
        drain: (socket) => socket.data.writer.flush(),
        close: (socket) => socket.data.terminal?.close(),
        error: (socket) => socket.data?.terminal?.close(),
      },
    });
    // The runner is another uid in the same group, so group access is the
    // one it gets.
    chmodSync(path, 0o660);
    if (group !== undefined && process.getgroups?.().includes(group))
      chownSync(path, -1, group);
  }

  stop(): void {
    this.#server?.stop(true);
  }

  async #onData(socket: Bun.Socket<Connection>, chunk: Buffer): Promise<void> {
    const connection = socket.data;
    try {
      if (connection.kind === "terminal") {
        for (const frame of connection.frames!.push(chunk)) {
          if (frame.type === "input") connection.terminal?.write(frame.data);
          else connection.terminal?.resize(frame.cols, frame.rows);
        }
        return;
      }
      if (connection.kind === "request") return;
      connection.buffer = Buffer.concat([connection.buffer, chunk]);
      const end = connection.buffer.indexOf("\n");
      const limit = MAX_REQUEST_BYTES;
      if (end < 0) {
        if (connection.buffer.length > limit)
          throw new Error("Request too long");
        return;
      }
      const first = connection.buffer.subarray(0, end).toString("utf8");
      const rest = connection.buffer.subarray(end + 1);
      connection.buffer = Buffer.alloc(0);
      const message = JSON.parse(first) as
        { method?: unknown; params?: unknown } | TerminalHeader;
      if ("terminal" in message) {
        if (end > MAX_HEADER_BYTES) throw new Error("Header too long");
        connection.kind = "terminal";
        connection.frames = new InputFrameReader();
        await this.#openTerminal(socket, message.terminal);
        if (rest.length > 0 && connection.terminal)
          for (const frame of connection.frames.push(rest)) {
            if (frame.type === "input") connection.terminal.write(frame.data);
            else connection.terminal.resize(frame.cols, frame.rows);
          }
        return;
      }
      connection.kind = "request";
      connection.writer.write(
        await this.#request(message.method, message.params),
      );
      connection.writer.end();
    } catch (error) {
      connection.writer.write(errorLine(error));
      connection.writer.end();
    }
  }

  async #request(method: unknown, params: unknown): Promise<string> {
    if (
      typeof method !== "string" ||
      !(SESSIOND_METHODS as readonly string[]).includes(method)
    )
      return errorLine(new RunnerError("UNKNOWN_METHOD", String(method)));
    try {
      if (method === "deadPanes")
        return line({ result: await this.deps.deadPanes() });
      const handler = this.deps.handlers[
        method as Exclude<SessiondMethod, "deadPanes">
      ] as (params: unknown) => Promise<unknown>;
      return line({ result: await handler(params) });
    } catch (error) {
      return errorLine(error);
    }
  }

  async #openTerminal(
    socket: Bun.Socket<Connection>,
    header: TerminalHeader["terminal"],
  ): Promise<void> {
    if (
      typeof header?.session !== "string" ||
      typeof header.cols !== "number" ||
      typeof header.rows !== "number"
    )
      throw new RunnerError("VALIDATION", "Bad terminal header");
    if (!(await this.deps.hasSession(header.session)))
      throw new RunnerError("LOST", "No such session");
    // A writer of its own, bounded, so a runner that stops reading closes
    // the terminal instead of filling this container's memory.
    const writer = new SocketWriter(socket, MAX_PENDING_OUTPUT_BYTES);
    socket.data.writer = writer;
    const terminal = this.deps.openTerminal(
      header.session,
      { cols: header.cols, rows: header.rows },
      (output) => writer.write(output),
    );
    socket.data.terminal = terminal;
    writer.write(line({ ok: true }));
    void terminal.start().then(() => writer.end());
  }
}

/** Dead panes across the session container's tmux server. */
export async function deadPanes(
  tmuxExecutable: string,
  socketName: string,
): Promise<Record<string, number | null>> {
  const result = await runCommand(
    tmuxExecutable,
    [
      "-L",
      socketName,
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{pane_dead}\t#{pane_dead_status}",
    ],
    { timeoutMs: 10_000 },
  );
  const dead: Record<string, number | null> = {};
  if (result.exitCode !== 0) {
    if (/no server running|error connecting to/i.test(result.stderr))
      return dead;
    throw new Error(result.stderr.trim() || "tmux list-panes failed");
  }
  for (const entry of result.stdout.split("\n")) {
    const [session, isDead, status] = entry.split("\t");
    if (!session || isDead !== "1") continue;
    const code = Number.parseInt(status ?? "", 10);
    dead[session] = Number.isNaN(code) ? null : code;
  }
  return dead;
}

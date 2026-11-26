import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Socket, UnixSocketListener } from "bun";

/**
 * The process that runs one agent over the Agent Client Protocol.
 *
 * A session with `runner = "acp"` has no provider TUI. Its tmux session runs
 * `daedal acp-host` instead, and that host runs the provider's ACP adapter as
 * a child and speaks newline-delimited JSON-RPC to it over stdio. Living in
 * the tmux session is what lets an ACP agent outlive the app, be found by
 * `reconcile` and be stopped the way every other session is.
 *
 * The app never talks to the adapter. The host appends every protocol
 * message, in both directions, to a log file, and takes commands on a unix
 * socket. The app reads the log from an offset, so a restarted app replays
 * the conversation from the file and misses nothing that happened while it
 * was closed.
 */

export type JsonObject = { [key: string]: unknown };

/** One JSON-RPC message: a request, a notification or a response. */
export interface AcpMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** What the host itself reports, between the protocol messages. */
export type AcpHostEvent =
  /** The adapter answered `session/new` or `session/load`. */
  | { type: "ready"; acpSessionId: string; modes?: unknown }
  | { type: "turn_start"; text: string }
  | { type: "turn_end"; stopReason?: string; error?: string }
  /** A prompt that arrived during a turn and waits for it to end. */
  | { type: "queued"; text: string }
  | { type: "stderr"; text: string }
  | { type: "error"; message: string }
  | { type: "exit"; code: number | null };

export type AcpLogEntry = { seq: number; at: string } & (
  | { from: "agent" | "client"; message: AcpMessage }
  | { from: "host"; event: AcpHostEvent }
);

/** What the host is told to run. Written to a file: tmux caps a command's length. */
export interface AcpLaunch {
  /** The Daedalus home whose `acp` folder holds the log and the socket. */
  home: string;
  /** The Daedalus session this host runs. */
  sessionId: string;
  cwd: string;
  /** Whose adapter to run. */
  provider: "claude" | "codex";
  /**
   * The adapter's command line, for a test's stand-in. Left out, the host
   * runs the provider's own adapter: see `acpAdapterCommand`.
   */
  adapter?: { executable: string; args: string[] };
  /** An ACP session to load and continue, in place of a new one. */
  load?: string;
  /** `_meta` of `session/new`: the adapter's own options. */
  meta?: JsonObject;
  /** The model the session was launched with, kept for a relaunch. */
  model?: string;
  /** A mode to set once the session exists. */
  mode?: string;
  /** The first turn, sent as soon as the session is ready. */
  prompt?: string;
}

export type AcpCommand =
  | { type: "prompt"; text: string }
  | { type: "cancel" }
  | { type: "permission"; requestId: number | string; optionId: string }
  | { type: "mode"; modeId: string }
  | { type: "stop" };

export type AcpReply = { ok: true } | { ok: false; error: string };

export interface AcpPaths {
  directory: string;
  log: string;
  socket: string;
  launch: string;
}

/**
 * Where a session's host keeps its files, named by the session id without
 * dashes. The socket takes only the first 16 characters of that: a unix
 * socket path holds 103 bytes, and a long home would not leave room for 32.
 */
export function acpPaths(home: string, sessionId: string): AcpPaths {
  const directory = join(home, "acp");
  const key = sessionId.replaceAll("-", "");
  return {
    directory,
    log: join(directory, `${key}.jsonl`),
    socket: join(directory, `${key.slice(0, 16)}.sock`),
    launch: join(directory, `${key}.launch.json`),
  };
}

const PROTOCOL_VERSION = 1;
/** How long a stopped adapter gets to exit before it is killed. */
const STOP_GRACE_MS = 2_000;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A command as it came off the socket, or undefined when it is not one. */
export function parseAcpCommand(value: unknown): AcpCommand | undefined {
  if (!isObject(value)) return undefined;
  switch (value.type) {
    case "cancel":
    case "stop":
      return { type: value.type };
    case "prompt":
      return typeof value.text === "string"
        ? { type: "prompt", text: value.text }
        : undefined;
    case "mode":
      return typeof value.modeId === "string"
        ? { type: "mode", modeId: value.modeId }
        : undefined;
    case "permission":
      return (typeof value.requestId === "number" ||
        typeof value.requestId === "string") &&
        typeof value.optionId === "string"
        ? {
            type: "permission",
            requestId: value.requestId,
            optionId: value.optionId,
          }
        : undefined;
    default:
      return undefined;
  }
}

interface AdapterProcess {
  write(line: string): void;
  end(): void;
  kill(): void;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number | null>;
}

const ADAPTER_PACKAGES = {
  claude: "claude-agent-acp",
  codex: "codex-acp",
} as const;

/**
 * The command that runs a provider's ACP adapter, on the bun this process
 * runs on. The app bundle carries each adapter as one file beside the CLI
 * (`app/acp/<provider>.js`, next to `app/cli/daedal.js`); from a checkout it
 * is the installed package.
 */
export function acpAdapterCommand(
  provider: "claude" | "codex",
  cliEntrypoint: string | undefined = Bun.argv[1],
): { executable: string; args: string[] } {
  const candidates = [
    ...(cliEntrypoint
      ? [join(dirname(cliEntrypoint), "..", "acp", `${provider}.js`)]
      : []),
    join(
      import.meta.dir,
      "..",
      "..",
      "node_modules",
      "@agentclientprotocol",
      ADAPTER_PACKAGES[provider],
      "dist",
      "index.js",
    ),
  ];
  const entry = candidates.find((candidate) => existsSync(candidate));
  if (!entry)
    throw new Error(
      `The ${provider} ACP adapter is not installed with this app`,
    );
  return { executable: process.execPath, args: [entry] };
}

function spawnAdapter(launch: AcpLaunch): AdapterProcess {
  const command = launch.adapter ?? acpAdapterCommand(launch.provider);
  const child = Bun.spawn([command.executable, ...command.args], {
    cwd: launch.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    write: (line) => {
      child.stdin.write(line);
      child.stdin.flush();
    },
    end: () => void child.stdin.end(),
    kill: () => child.kill(),
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited.then((code) => code),
  };
}

/** Calls `onLine` for each line of a stream, without its newline. */
async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line) onLine(line);
    }
  }
  if (buffer.trim()) onLine(buffer.trim());
}

export class AcpHost {
  private seq = 0;
  private nextId = 1;
  private adapter: AdapterProcess | undefined;
  private server: UnixSocketListener<{ buffer: string }> | undefined;
  private acpSessionId: string | undefined;
  private readonly waiting = new Map<
    number | string,
    (message: AcpMessage) => void
  >();
  /** Permission requests the agent waits on, by their JSON-RPC id. */
  private readonly permissions = new Set<number | string>();
  private readonly prompts: string[] = [];
  private turnRunning = false;
  private stopping = false;

  private readonly paths: AcpPaths;

  constructor(private readonly launch: AcpLaunch) {
    this.paths = acpPaths(launch.home, launch.sessionId);
  }

  /** Runs the adapter until it exits, and resolves with its exit code. */
  async run(): Promise<number | null> {
    mkdirSync(dirname(this.paths.log), { recursive: true });
    let adapter: AdapterProcess;
    try {
      adapter = spawnAdapter(this.launch);
    } catch (error) {
      this.report({ type: "error", message: errorText(error) });
      this.report({ type: "exit", code: null });
      return null;
    }
    this.adapter = adapter;
    const output = readLines(adapter.stdout, (line) => this.fromAgent(line));
    const errors = readLines(adapter.stderr, (line) =>
      this.report({ type: "stderr", text: line.slice(0, 2_000) }),
    );
    this.listen();
    void this.start().catch((error: unknown) => {
      this.report({ type: "error", message: errorText(error) });
      this.stop();
    });
    const code = await adapter.exited;
    await Promise.allSettled([output, errors]);
    // Whoever still waits on the adapter gets an answer.
    for (const resolve of this.waiting.values())
      resolve({ error: { code: -32000, message: "The agent exited" } });
    this.waiting.clear();
    this.server?.stop(true);
    rmSync(this.paths.socket, { force: true });
    this.report({ type: "exit", code });
    return code;
  }

  private async start(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "daedalus", version: "1" },
    });
    const { load, cwd, meta } = this.launch;
    const opened = await this.request(load ? "session/load" : "session/new", {
      ...(load ? { sessionId: load } : {}),
      cwd,
      mcpServers: [],
      ...(meta ? { _meta: meta } : {}),
    });
    const result = isObject(opened) ? opened : {};
    const acpSessionId =
      load ?? (typeof result.sessionId === "string" ? result.sessionId : "");
    if (!acpSessionId) throw new Error("The agent opened no session");
    this.acpSessionId = acpSessionId;
    this.report({
      type: "ready",
      acpSessionId,
      ...(result.modes === undefined ? {} : { modes: result.modes }),
    });
    if (this.launch.mode)
      // A mode the adapter does not have leaves it in its own default.
      await this.request("session/set_mode", {
        sessionId: acpSessionId,
        modeId: this.launch.mode,
      }).catch((error: unknown) =>
        this.report({ type: "error", message: errorText(error) }),
      );
    if (this.launch.prompt) this.prompts.unshift(this.launch.prompt);
    void this.runTurns();
  }

  /** Sends the waiting prompts one at a time: ACP runs one turn per session. */
  private async runTurns(): Promise<void> {
    if (this.turnRunning || !this.acpSessionId) return;
    this.turnRunning = true;
    try {
      for (;;) {
        const text = this.prompts.shift();
        if (text === undefined) break;
        this.report({ type: "turn_start", text });
        try {
          const result = await this.request("session/prompt", {
            sessionId: this.acpSessionId,
            prompt: [{ type: "text", text }],
          });
          const stopReason =
            isObject(result) && typeof result.stopReason === "string"
              ? result.stopReason
              : undefined;
          this.report({
            type: "turn_end",
            ...(stopReason ? { stopReason } : {}),
          });
        } catch (error) {
          this.report({ type: "turn_end", error: errorText(error) });
        }
      }
    } finally {
      this.turnRunning = false;
    }
  }

  private handle(command: AcpCommand): AcpReply {
    if (command.type === "stop") {
      this.stop();
      return { ok: true };
    }
    const sessionId = this.acpSessionId;
    if (command.type === "prompt") {
      if (!command.text) return { ok: false, error: "The prompt is empty" };
      this.prompts.push(command.text);
      // Before the session is ready the prompt waits for it too.
      if (this.turnRunning || !sessionId)
        this.report({ type: "queued", text: command.text });
      void this.runTurns();
      return { ok: true };
    }
    if (!sessionId) return { ok: false, error: "The agent is still starting" };
    if (command.type === "cancel") {
      // Stop means stop: what waited behind this turn does not run either.
      this.prompts.length = 0;
      // The protocol has the client answer every open permission request
      // with `cancelled` when it cancels the turn.
      for (const id of this.permissions)
        this.send({ id, result: { outcome: { outcome: "cancelled" } } });
      this.permissions.clear();
      this.send({ method: "session/cancel", params: { sessionId } });
      return { ok: true };
    }
    if (command.type === "permission") {
      if (!this.permissions.delete(command.requestId))
        return { ok: false, error: "That permission request is not open" };
      this.send({
        id: command.requestId,
        result: {
          outcome: { outcome: "selected", optionId: command.optionId },
        },
      });
      return { ok: true };
    }
    void this.request("session/set_mode", {
      sessionId,
      modeId: command.modeId,
    }).catch((error: unknown) =>
      this.report({ type: "error", message: errorText(error) }),
    );
    return { ok: true };
  }

  private stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    const adapter = this.adapter;
    if (!adapter) return;
    // The adapter exits when its stdin closes.
    adapter.end();
    const timer = setTimeout(() => adapter.kill(), STOP_GRACE_MS);
    void adapter.exited.then(() => clearTimeout(timer));
  }

  private fromAgent(line: string): void {
    let message: AcpMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isObject(parsed)) return;
      message = parsed;
    } catch {
      // An adapter that prints something else to stdout has not spoken.
      this.report({ type: "stderr", text: line.slice(0, 2_000) });
      return;
    }
    this.write({ from: "agent", message });
    if (message.id !== undefined && message.method === undefined) {
      const resolve = this.waiting.get(message.id);
      this.waiting.delete(message.id);
      resolve?.(message);
      return;
    }
    if (message.id === undefined) return;
    if (message.method === "session/request_permission") {
      this.permissions.add(message.id);
      return;
    }
    // The agent asks for something this client does not offer.
    this.send({
      id: message.id,
      error: { code: -32601, message: "Method not supported" },
    });
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.waiting.set(id, (message) =>
        message.error
          ? reject(new Error(message.error.message))
          : resolve(message.result),
      );
      this.send({ id, method, params });
    });
  }

  private send(message: AcpMessage): void {
    const whole = { jsonrpc: "2.0", ...message };
    this.write({ from: "client", message: whole });
    try {
      this.adapter?.write(`${JSON.stringify(whole)}\n`);
    } catch {
      // The adapter is gone; `run` reports its exit.
    }
  }

  private report(event: AcpHostEvent): void {
    this.write({ from: "host", event });
  }

  private write(
    entry:
      | { from: "agent" | "client"; message: AcpMessage }
      | { from: "host"; event: AcpHostEvent },
  ): void {
    const line = { seq: ++this.seq, at: new Date().toISOString(), ...entry };
    try {
      appendFileSync(this.paths.log, `${JSON.stringify(line)}\n`);
    } catch {
      // A log that cannot be written does not end the agent's turn.
    }
  }

  /** One command per line in, one reply per line out. */
  private listen(): void {
    rmSync(this.paths.socket, { force: true });
    const answer = (socket: Socket<{ buffer: string }>, line: string) => {
      let reply: AcpReply;
      try {
        const command = parseAcpCommand(JSON.parse(line));
        reply = command
          ? this.handle(command)
          : { ok: false, error: "Not a command" };
      } catch (error) {
        reply = { ok: false, error: errorText(error) };
      }
      socket.write(`${JSON.stringify(reply)}\n`);
    };
    this.server = Bun.listen<{ buffer: string }>({
      unix: this.paths.socket,
      socket: {
        open: (socket) => {
          socket.data = { buffer: "" };
        },
        data: (socket, chunk) => {
          socket.data.buffer += chunk.toString();
          let at: number;
          while ((at = socket.data.buffer.indexOf("\n")) >= 0) {
            const line = socket.data.buffer.slice(0, at).trim();
            socket.data.buffer = socket.data.buffer.slice(at + 1);
            if (line) answer(socket, line);
          }
        },
      },
    });
  }
}

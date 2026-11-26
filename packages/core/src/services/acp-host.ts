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

/** A JSON-RPC message as the adapter sent it, or undefined when it is not one. */
export function parseAcpMessage(value: unknown): AcpMessage | undefined {
  if (!isObject(value)) return undefined;
  const { id, method, params, result, error } = value;
  if (id !== undefined && typeof id !== "number" && typeof id !== "string")
    return undefined;
  if (method !== undefined && typeof method !== "string") return undefined;
  return {
    ...(id === undefined ? {} : { id }),
    ...(method === undefined ? {} : { method }),
    ...(isObject(params) ? { params } : {}),
    ...(result === undefined ? {} : { result }),
    ...(isObject(error)
      ? {
          error: {
            code: typeof error.code === "number" ? error.code : 0,
            message:
              typeof error.message === "string"
                ? error.message
                : "The agent reported an error",
          },
        }
      : {}),
  };
}

/** A launch file's contents, or undefined when they are not a launch. */
export function parseAcpLaunch(value: unknown): AcpLaunch | undefined {
  if (!isObject(value)) return undefined;
  const { home, sessionId, cwd, provider, load, meta, model, mode, prompt } =
    value;
  if (
    typeof home !== "string" ||
    typeof sessionId !== "string" ||
    typeof cwd !== "string" ||
    (provider !== "claude" && provider !== "codex")
  )
    return undefined;
  return {
    home,
    sessionId,
    cwd,
    provider,
    ...(typeof load === "string" ? { load } : {}),
    ...(isObject(meta) ? { meta } : {}),
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof mode === "string" ? { mode } : {}),
    ...(typeof prompt === "string" ? { prompt } : {}),
  };
}

/** A line of a host's log, or undefined when it is not a whole entry. */
export function parseAcpLogEntry(value: unknown): AcpLogEntry | undefined {
  if (!isObject(value) || typeof value.seq !== "number") return undefined;
  const at = typeof value.at === "string" ? value.at : "";
  if (value.from === "host")
    return isObject(value.event) && typeof value.event.type === "string"
      ? ({
          seq: value.seq,
          at,
          from: "host",
          event: value.event,
        } as AcpLogEntry)
      : undefined;
  if (value.from !== "agent" && value.from !== "client") return undefined;
  const message = parseAcpMessage(value.message);
  return message
    ? { seq: value.seq, at, from: value.from, message }
    : undefined;
}

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
  /** The adapter exited: nothing more is sent to it. */
  private closed = false;

  private readonly paths: AcpPaths;

  constructor(private readonly launch: AcpLaunch) {
    this.paths = acpPaths(launch.home, launch.sessionId);
  }

  /** Runs the adapter until it exits, and resolves with its exit code. */
  async run(): Promise<number | null> {
    mkdirSync(dirname(this.paths.log), { recursive: true, mode: 0o700 });
    let adapter: AdapterProcess;
    try {
      // First, so a socket that cannot be made leaves no adapter behind.
      this.listen();
      adapter = spawnAdapter(this.launch);
    } catch (error) {
      this.server?.stop(true);
      rmSync(this.paths.socket, { force: true });
      this.report({ type: "error", message: errorText(error) });
      this.report({ type: "exit", code: null });
      return null;
    }
    this.adapter = adapter;
    const output = readLines(adapter.stdout, (line) => this.fromAgent(line));
    const errors = readLines(adapter.stderr, (line) =>
      this.report({ type: "stderr", text: line.slice(0, 2_000) }),
    );
    void this.start().catch((error: unknown) => {
      // An adapter that exited said why itself, on its stderr.
      if (!this.closed)
        this.report({ type: "error", message: errorText(error) });
      this.shutdown();
    });
    const code = await adapter.exited;
    await Promise.allSettled([output, errors]);
    this.closed = true;
    this.server?.stop(true);
    rmSync(this.paths.socket, { force: true });
    // Nothing that waited behind the turn runs now, and whoever still
    // waits on the adapter gets an answer.
    this.prompts.length = 0;
    for (const resolve of this.waiting.values())
      resolve({ error: { code: -32000, message: "The agent exited" } });
    this.waiting.clear();
    // The turn that was cut short logs its end before the exit does.
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    const { cwd, meta } = this.launch;
    const open = (load: string | undefined) =>
      this.request(load ? "session/load" : "session/new", {
        ...(load ? { sessionId: load } : {}),
        cwd,
        mcpServers: [],
        ...(meta ? { _meta: meta } : {}),
      });
    let load = this.launch.load;
    const opened = await open(load).catch((error: unknown) => {
      if (!load) throw error;
      // A conversation the provider never wrote down, as when the session
      // had no turn, cannot be loaded: it starts again.
      this.report({ type: "error", message: errorText(error) });
      load = undefined;
      return open(undefined);
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
        const text = this.closed ? undefined : this.prompts.shift();
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
      this.shutdown();
      return { ok: true };
    }
    if (this.closed) return { ok: false, error: "The agent exited" };
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
      // Only the turn ends. What waits behind it still runs: some of it is
      // Daedalus's own, such as a workflow brief, and was promised delivered.
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

  /** Ends the adapter, and with it `run`. Also what a signal asks for. */
  shutdown(): void {
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
      const parsed = parseAcpMessage(JSON.parse(line));
      if (!parsed) return;
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
      if (this.closed) return reject(new Error("The agent exited"));
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
      // The owner's only: it holds every prompt and answer.
      appendFileSync(this.paths.log, `${JSON.stringify(line)}\n`, {
        mode: 0o600,
      });
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

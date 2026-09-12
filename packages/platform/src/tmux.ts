import {
  findExecutable,
  runCommand,
  type CommandOptions,
  type CommandResult,
} from "./process";

export const TMUX_EXECUTABLE_FALLBACKS = [
  "/opt/homebrew/bin/tmux",
  "/usr/local/bin/tmux",
  "/usr/bin/tmux",
];

export const resolveTmuxExecutable = () =>
  findExecutable("tmux", TMUX_EXECUTABLE_FALLBACKS) ?? "tmux";

export interface TmuxLaunch {
  session: string;
  cwd: string;
  executable: string;
  args: string[];
  env?: Record<string, string>;
}

export interface TmuxClient {
  probe(): Promise<string | undefined>;
  createSession(launch: TmuxLaunch): Promise<void>;
  hasSession(session: string): Promise<boolean>;
  listSessions(): Promise<string[]>;
  attach(session: string): Promise<number>;
  send(session: string, text: string): Promise<void>;
  stop(session: string, force?: boolean): Promise<void>;
}

export interface TmuxTerminalTarget {
  socketName: string;
  session: string;
}

export class CommandTmuxClient implements TmuxClient {
  constructor(
    readonly socketName = "daedalus",
    readonly executable = resolveTmuxExecutable(),
    private readonly command: (
      executable: string,
      args: string[],
      options?: CommandOptions,
    ) => Promise<CommandResult> = runCommand,
  ) {}

  private args(...args: string[]): string[] {
    return ["-L", this.socketName, ...args];
  }

  async probe(): Promise<string | undefined> {
    try {
      const result = await this.command(this.executable, ["-V"]);
      return result.exitCode === 0
        ? result.stdout.trim() || result.stderr.trim()
        : undefined;
    } catch {
      return undefined;
    }
  }

  async createSession(launch: TmuxLaunch): Promise<void> {
    const environment = Object.entries(launch.env ?? {}).flatMap(
      ([key, value]) => ["-e", `${key}=${value}`],
    );
    const result = await this.command(
      this.executable,
      this.args(
        "new-session",
        "-d",
        "-s",
        launch.session,
        "-c",
        launch.cwd,
        ...environment,
        "--",
        launch.executable,
        ...launch.args,
      ),
    );
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || "tmux session creation failed");
  }

  async hasSession(session: string): Promise<boolean> {
    const result = await this.command(
      this.executable,
      this.args("has-session", "-t", session),
    );
    return result.exitCode === 0;
  }

  async listSessions(): Promise<string[]> {
    const result = await this.command(
      this.executable,
      this.args("list-sessions", "-F", "#{session_name}"),
    );
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  async attach(session: string): Promise<number> {
    const result = await this.command(
      this.executable,
      this.args("attach-session", "-t", session),
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    return result.exitCode;
  }

  async send(session: string, text: string): Promise<void> {
    const literal = await this.command(
      this.executable,
      this.args("send-keys", "-t", session, "-l", "--", text),
    );
    if (literal.exitCode !== 0)
      throw new Error(literal.stderr.trim() || "tmux input failed");
    const enter = await this.command(
      this.executable,
      this.args("send-keys", "-t", session, "Enter"),
    );
    if (enter.exitCode !== 0)
      throw new Error(enter.stderr.trim() || "tmux Enter input failed");
  }

  async stop(session: string, force = false): Promise<void> {
    if (!force) {
      const interrupt = await this.command(
        this.executable,
        this.args("send-keys", "-t", session, "C-c"),
      );
      if (interrupt.exitCode !== 0)
        throw new Error(interrupt.stderr.trim() || "tmux interrupt failed");
      await Bun.sleep(100);
    }
    if (await this.hasSession(session)) {
      const killed = await this.command(
        this.executable,
        this.args("kill-session", "-t", session),
      );
      if (killed.exitCode !== 0)
        throw new Error(killed.stderr.trim() || "tmux stop failed");
    }
  }
}

export const SPIKE_SOCKET = "daedalus-spike";
export const SPIKE_SESSION = "daedalus_spike";

export const TERMINAL_CAPTURE_LINES = 10_000;
export const TERMINAL_CAPTURE_BYTES = 1024 * 1024;

export function boundTerminalCapture(
  screen: string,
  limit = TERMINAL_CAPTURE_BYTES,
): Uint8Array {
  const encoded = new TextEncoder().encode(screen.replace(/\r?\n/g, "\r\n"));
  let body =
    encoded.byteLength > limit
      ? encoded.slice(encoded.byteLength - limit)
      : encoded;
  while (body.length > 0 && (body[0]! & 0xc0) === 0x80) body = body.slice(1);
  const reset = new TextEncoder().encode("\u001b[H\u001b[2J");
  const output = new Uint8Array(reset.byteLength + body.byteLength);
  output.set(reset);
  output.set(body, reset.byteLength);
  return output;
}

const terminalArgs = (socketName: string, ...args: string[]) => [
  "-L",
  socketName,
  ...args,
];

const tmuxArgs = (...args: string[]) => ["-L", SPIKE_SOCKET, ...args];

export async function ensureSpikeSession(cwd: string): Promise<boolean> {
  const executable = resolveTmuxExecutable();
  const exists = await runCommand(
    executable,
    tmuxArgs("has-session", "-t", SPIKE_SESSION),
  );
  if (exists.exitCode === 0) return false;
  const created = await runCommand(
    executable,
    tmuxArgs(
      "new-session",
      "-d",
      "-s",
      SPIKE_SESSION,
      "-c",
      cwd,
      "-x",
      "100",
      "-y",
      "30",
    ),
  );
  if (created.exitCode !== 0)
    throw new Error(created.stderr || "tmux session creation failed");
  return true;
}

export async function captureSpikePane(): Promise<Uint8Array> {
  return captureTmuxPane({
    socketName: SPIKE_SOCKET,
    session: SPIKE_SESSION,
  });
}

export async function captureTmuxPane(
  target: TmuxTerminalTarget,
  historyLines = TERMINAL_CAPTURE_LINES,
  executable = resolveTmuxExecutable(),
): Promise<Uint8Array> {
  const safeHistory = Math.max(
    0,
    Math.min(TERMINAL_CAPTURE_LINES, historyLines),
  );
  const captured = await runCommand(
    executable,
    terminalArgs(
      target.socketName,
      "capture-pane",
      "-p",
      "-e",
      "-J",
      "-S",
      `-${safeHistory}`,
      "-t",
      target.session,
    ),
  );
  if (captured.exitCode !== 0)
    throw new Error(captured.stderr || "tmux capture failed");
  return boundTerminalCapture(captured.stdout);
}

export async function sendSpikeInput(data: string): Promise<void> {
  return sendTmuxInput(
    { socketName: SPIKE_SOCKET, session: SPIKE_SESSION },
    data,
  );
}

export async function sendTmuxInput(
  target: TmuxTerminalTarget,
  data: string,
  executable = resolveTmuxExecutable(),
): Promise<void> {
  const chunks = data.split("\r");
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? "";
    if (chunk) {
      const literal = await runCommand(
        executable,
        terminalArgs(
          target.socketName,
          "send-keys",
          "-t",
          target.session,
          "-l",
          "--",
          chunk,
        ),
      );
      if (literal.exitCode !== 0)
        throw new Error(literal.stderr || "tmux input failed");
    }
    if (index < chunks.length - 1) {
      const enter = await runCommand(
        executable,
        terminalArgs(
          target.socketName,
          "send-keys",
          "-t",
          target.session,
          "Enter",
        ),
      );
      if (enter.exitCode !== 0)
        throw new Error(enter.stderr || "tmux Enter input failed");
    }
  }
}

export function decodeControlOutput(payload: string): Uint8Array {
  const decoded = payload.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
  return new TextEncoder().encode(decoded);
}

export class TmuxControlBridge {
  readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  #onOutput: (output: Uint8Array) => void;
  #buffer = "";
  #resizeTimer: ReturnType<typeof setTimeout> | undefined;
  #pendingSize: { cols: number; rows: number } | undefined;
  #lastSize: { cols: number; rows: number } | undefined;

  constructor(
    onOutput: (output: Uint8Array) => void,
    target: TmuxTerminalTarget = {
      socketName: SPIKE_SOCKET,
      session: SPIKE_SESSION,
    },
    executable = resolveTmuxExecutable(),
  ) {
    this.#onOutput = onOutput;
    this.process = Bun.spawn(
      [
        executable,
        ...terminalArgs(
          target.socketName,
          "-C",
          "attach-session",
          "-t",
          target.session,
        ),
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
  }

  async start(): Promise<void> {
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      this.#buffer += decoder.decode(value, { stream: true });
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.startsWith("%output ")) {
          const separator = line.indexOf(" ", 8);
          if (separator >= 0)
            this.#onOutput(decodeControlOutput(line.slice(separator + 1)));
        }
        newline = this.#buffer.indexOf("\n");
      }
    }
  }

  resize(cols: number, rows: number): void {
    const safeCols = Math.max(20, Math.min(500, Math.floor(cols)));
    const safeRows = Math.max(5, Math.min(300, Math.floor(rows)));
    if (this.#lastSize?.cols === safeCols && this.#lastSize.rows === safeRows)
      return;
    this.#pendingSize = { cols: safeCols, rows: safeRows };
    if (!this.#lastSize) {
      this.applyPendingSize();
      return;
    }
    if (this.#resizeTimer) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = setTimeout(() => {
      this.#resizeTimer = undefined;
      this.applyPendingSize();
    }, 100);
  }

  close(): void {
    if (this.#resizeTimer) clearTimeout(this.#resizeTimer);
    this.process.stdin.end();
  }

  private applyPendingSize(): void {
    const size = this.#pendingSize;
    this.#pendingSize = undefined;
    if (!size) return;
    this.#lastSize = size;
    this.process.stdin.write(`refresh-client -C ${size.cols},${size.rows}\n`);
    this.process.stdin.flush();
  }
}

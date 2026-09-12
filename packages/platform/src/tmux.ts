import { runCommand, type CommandOptions, type CommandResult } from "./process";

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

export class CommandTmuxClient implements TmuxClient {
  constructor(
    readonly socketName = "daedalus",
    private readonly executable = "tmux",
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

const tmuxArgs = (...args: string[]) => ["-L", SPIKE_SOCKET, ...args];

export async function ensureSpikeSession(cwd: string): Promise<boolean> {
  const exists = await runCommand(
    "tmux",
    tmuxArgs("has-session", "-t", SPIKE_SESSION),
  );
  if (exists.exitCode === 0) return false;
  const created = await runCommand(
    "tmux",
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
  const captured = await runCommand(
    "tmux",
    tmuxArgs("capture-pane", "-p", "-e", "-J", "-S", "-", "-t", SPIKE_SESSION),
  );
  if (captured.exitCode !== 0)
    throw new Error(captured.stderr || "tmux capture failed");
  const screen = captured.stdout.replace(/\r?\n/g, "\r\n");
  return new TextEncoder().encode(`\u001b[H\u001b[2J${screen}`);
}

export async function sendSpikeInput(data: string): Promise<void> {
  const chunks = data.split("\r");
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? "";
    if (chunk) {
      const literal = await runCommand(
        "tmux",
        tmuxArgs("send-keys", "-t", SPIKE_SESSION, "-l", "--", chunk),
      );
      if (literal.exitCode !== 0)
        throw new Error(literal.stderr || "tmux input failed");
    }
    if (index < chunks.length - 1) {
      const enter = await runCommand(
        "tmux",
        tmuxArgs("send-keys", "-t", SPIKE_SESSION, "Enter"),
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

  constructor(onOutput: (output: Uint8Array) => void) {
    this.#onOutput = onOutput;
    this.process = Bun.spawn(
      ["tmux", ...tmuxArgs("-C", "attach-session", "-t", SPIKE_SESSION)],
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
    this.process.stdin.write(`refresh-client -C ${safeCols},${safeRows}\n`);
    this.process.stdin.flush();
  }

  close(): void {
    this.process.stdin.end();
  }
}

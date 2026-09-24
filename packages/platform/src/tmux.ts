import {
  findExecutable,
  runCommand,
  standardExecutableFallbacks,
  type CommandOptions,
  type CommandResult,
} from "./process";

export const TMUX_EXECUTABLE_FALLBACKS = standardExecutableFallbacks("tmux");

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
  capture(session: string): Promise<string>;
  sendKeys(session: string, keys: string[]): Promise<void>;
  send(session: string, text: string): Promise<void>;
  stop(session: string, force?: boolean): Promise<void>;
  /**
   * Ends the whole server on this socket, and with it every session in it —
   * including ones Daedalus never started. Only `daedal shutdown` and the menu
   * item that runs it ever call this; nothing reaches for it implicitly.
   *
   * Resolves `true` when a server was running and is now gone, `false` when
   * there was nothing to stop, which is the same goal state reached sooner.
   */
  killServer(): Promise<boolean>;
}

export interface TmuxTerminalTarget {
  socketName: string;
  session: string;
}

export const tmuxPtyArguments = (target: TmuxTerminalTarget): string[] =>
  terminalArgs(
    target.socketName,
    "set-option",
    "-t",
    target.session,
    "status",
    "off",
    ";",
    "set-option",
    "-t",
    target.session,
    "mouse",
    "on",
    ";",
    "attach-session",
    "-t",
    target.session,
  );

/**
 * Variables that describe whoever launched Daedalus rather than the machine.
 * Opening the app from an agent's shell hands it that agent's whole
 * environment, and tmux copies its server's environment into every session it
 * starts: `NO_COLOR` and `TERM=dumb` from a tool shell turned every agent
 * terminal plain white, and another session's `DAEDALUS_SESSION_ID` made a new
 * agent report as that one. A session gets its own `DAEDALUS_*` values at
 * launch, so dropping the inherited ones loses nothing.
 */
export const INHERITED_SESSION_VARIABLES: readonly string[] = [
  "NO_COLOR",
  "FORCE_COLOR",
  "TERM",
  "COLORTERM",
  "TMUX",
  "TMUX_PANE",
  "CLAUDECODE",
  "AI_AGENT",
  "DAEDALUS_SESSION_ID",
  "DAEDALUS_TASK_ID",
  "DAEDALUS_TASK_NUMBER",
  "DAEDALUS_WORKSPACE_ID",
];

export const INHERITED_SESSION_VARIABLE_PREFIXES: readonly string[] = [
  "CLAUDE_CODE_",
];

export const isInheritedSessionVariable = (key: string): boolean =>
  INHERITED_SESSION_VARIABLES.includes(key) ||
  INHERITED_SESSION_VARIABLE_PREFIXES.some((prefix) => key.startsWith(prefix));

/** A copy of `environment` without anything `isInheritedSessionVariable` names. */
export const withoutInheritedSessionVariables = (
  environment: NodeJS.ProcessEnv,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !isInheritedSessionVariable(entry[0]),
    ),
  );

export const tmuxPtyEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
) => ({
  ...withoutInheritedSessionVariables(environment),
  // Finder and Spotlight launch GUI apps without locale variables. tmux uses
  // the client locale when calculating Unicode cell widths, so an unset or
  // non-UTF-8 locale corrupts wide glyphs and leaves the cursor out of place.
  LANG: "C.UTF-8",
  LC_CTYPE: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
});

export class CommandTmuxClient implements TmuxClient {
  constructor(
    readonly socketName = "daedalus",
    readonly executable = resolveTmuxExecutable(),
    private readonly command: (
      executable: string,
      args: string[],
      options?: CommandOptions,
    ) => Promise<CommandResult> = runCommand,
    private readonly serverWorkingDirectory?: string,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.environment = withoutInheritedSessionVariables(environment);
  }

  /**
   * What every tmux command runs with. Any command can be the one that starts
   * the server, and the server hands its environment to every session after.
   */
  private readonly environment: Record<string, string>;

  private args(...args: string[]): string[] {
    return ["-L", this.socketName, ...args];
  }

  private run(
    args: string[],
    options: Omit<CommandOptions, "env" | "replaceEnvironment"> = {},
  ): Promise<CommandResult> {
    return this.command(this.executable, this.args(...args), {
      ...options,
      env: this.environment,
      replaceEnvironment: true,
    });
  }

  /**
   * A server started before this build, or by a client that did not clean its
   * environment, still holds the variables in its global environment and
   * copies them into every new session. Unsetting them there repairs such a
   * server in place, without killing the sessions already running on it.
   */
  private async scrubServerEnvironment(): Promise<void> {
    const shown = await this.run(["show-environment", "-g"]);
    // No server yet: the new session starts one from the clean environment.
    if (shown.exitCode !== 0) return;
    const inherited = shown.stdout
      .split(/\r?\n/)
      .map((line) => line.split("=", 1)[0]!)
      .filter((key) => key && isInheritedSessionVariable(key));
    if (inherited.length === 0) return;
    // Best effort: a server that refuses still gets the new session, which
    // sets its own DAEDALUS_* values over any stale ones.
    await this.run(
      inherited.flatMap((key, index) => [
        ...(index > 0 ? [";"] : []),
        "set-environment",
        "-g",
        "-u",
        key,
      ]),
    );
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
    await this.scrubServerEnvironment();
    const environment = Object.entries({
      ...launch.env,
      PWD: launch.cwd,
    }).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const args = [
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
    ];
    const result = await this.run(
      args,
      this.serverWorkingDirectory ? { cwd: this.serverWorkingDirectory } : {},
    );
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || "tmux session creation failed");
  }

  async hasSession(session: string): Promise<boolean> {
    const result = await this.run(["has-session", "-t", session]);
    return result.exitCode === 0;
  }

  async listSessions(): Promise<string[]> {
    const result = await this.run(["list-sessions", "-F", "#{session_name}"]);
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  }

  async attach(session: string): Promise<number> {
    // The one command that keeps the caller's environment: it draws in the
    // caller's own terminal, so it needs that terminal's TERM, and it cannot
    // start a server for anything to leak into.
    const result = await this.command(
      this.executable,
      this.args("attach-session", "-t", session),
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    return result.exitCode;
  }

  async capture(session: string): Promise<string> {
    const result = await this.run(["capture-pane", "-p", "-J", "-t", session]);
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || "tmux capture failed");
    return result.stdout;
  }

  async sendKeys(session: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const result = await this.run(["send-keys", "-t", session, ...keys]);
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || "tmux key input failed");
  }

  async send(session: string, text: string): Promise<void> {
    const literal = await this.run([
      "send-keys",
      "-t",
      session,
      "-l",
      "--",
      text,
    ]);
    if (literal.exitCode !== 0)
      throw new Error(literal.stderr.trim() || "tmux input failed");
    // Codex treats keystrokes that arrive within a few milliseconds of each
    // other as a paste, and an Enter inside that burst becomes a newline in
    // the composer rather than a submit. The pause ends the burst first.
    await Bun.sleep(SEND_ENTER_DELAY_MS);
    const enter = await this.run(["send-keys", "-t", session, "Enter"]);
    if (enter.exitCode !== 0)
      throw new Error(enter.stderr.trim() || "tmux Enter input failed");
  }

  async stop(session: string, force = false): Promise<void> {
    if (!force) {
      const interrupt = await this.run(["send-keys", "-t", session, "C-c"]);
      if (interrupt.exitCode !== 0)
        throw new Error(interrupt.stderr.trim() || "tmux interrupt failed");
      await Bun.sleep(100);
    }
    if (await this.hasSession(session)) {
      const killed = await this.run(["kill-session", "-t", session]);
      if (killed.exitCode !== 0)
        throw new Error(killed.stderr.trim() || "tmux stop failed");
    }
  }

  async killServer(): Promise<boolean> {
    const result = await this.run(["kill-server"]);
    if (result.exitCode === 0) return true;
    // Already down is the goal, not a failure: tmux exits on its own once the
    // last session in it ends, so a sweep that stopped everything may well
    // find no server left to kill.
    const message = (
      result.stderr.trim() || result.stdout.trim()
    ).toLowerCase();
    if (message.includes("no server running")) return false;
    throw new Error(result.stderr.trim() || "tmux server could not be stopped");
  }
}

export const SEND_ENTER_DELAY_MS = 300;
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
  "-u",
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

/**
 * Attaches to a durable tmux session through a real pseudo-terminal.
 *
 * tmux then owns terminal emulation, cursor placement, keyboard decoding, and
 * redraws. This avoids reconstructing a screen from capture-pane and replaying
 * a second control-mode stream on top of it.
 */
export class TmuxPtyBridge {
  readonly process: Bun.Subprocess;
  #closed = false;

  constructor(
    onOutput: (output: Uint8Array) => void,
    target: TmuxTerminalTarget,
    initialSize: { cols: number; rows: number } = { cols: 80, rows: 24 },
    executable = resolveTmuxExecutable(),
  ) {
    const cols = Math.max(20, Math.min(500, Math.floor(initialSize.cols)));
    const rows = Math.max(5, Math.min(300, Math.floor(initialSize.rows)));
    this.process = Bun.spawn([executable, ...tmuxPtyArguments(target)], {
      env: tmuxPtyEnvironment(),
      terminal: {
        cols,
        rows,
        data: (_terminal, data) => onOutput(data),
      },
    });
  }

  async start(): Promise<void> {
    await this.process.exited;
  }

  write(data: string): void {
    if (!this.#closed) this.process.terminal?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.#closed) return;
    const safeCols = Math.max(20, Math.min(500, Math.floor(cols)));
    const safeRows = Math.max(5, Math.min(300, Math.floor(rows)));
    this.process.terminal?.resize(safeCols, safeRows);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.process.terminal?.close();
    this.process.kill();
  }
}

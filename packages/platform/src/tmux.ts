import { isAbsolute } from "node:path";
import {
  findExecutable,
  runCommand,
  standardExecutableFallbacks,
  type CommandOptions,
  type CommandResult,
} from "./process";

export const TMUX_EXECUTABLE_FALLBACKS = standardExecutableFallbacks("tmux");

/**
 * The tmux Daedalus.app carries in its bundle, as an absolute path. The app
 * and its bundled CLI set it, so a Mac with no tmux installed still runs
 * agents, and every Mac runs the version the app was tested with. Unset, or
 * pointing at nothing executable, the search falls back to PATH and the
 * standard install locations.
 */
export const BUNDLED_TMUX_VARIABLE = "DAEDALUS_TMUX";

export const findTmuxExecutable = (
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const bundled = environment[BUNDLED_TMUX_VARIABLE];
  return findExecutable(bundled && isAbsolute(bundled) ? bundled : "tmux", [
    "tmux",
    ...TMUX_EXECUTABLE_FALLBACKS,
  ]);
};

export const resolveTmuxExecutable = () => findTmuxExecutable() ?? "tmux";

export interface TmuxLaunch {
  session: string;
  cwd: string;
  executable: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * Keep the pane on screen after the command exits, so a one-shot command
   * such as a sign-in leaves its last words readable instead of vanishing
   * with its session. Set in the same tmux invocation as the session, before
   * the command can finish.
   */
  keepOnExit?: boolean;
}

export interface TmuxClient {
  probe(): Promise<string | undefined>;
  createSession(launch: TmuxLaunch): Promise<void>;
  hasSession(session: string): Promise<boolean>;
  /**
   * The live session names; empty when no server is running. Throws when
   * tmux did not answer, which is not the same as no sessions.
   */
  listSessions(): Promise<string[]>;
  attach(session: string): Promise<number>;
  /** `styled` keeps the escape codes, so dim text can be told apart. */
  capture(session: string, options?: { styled?: boolean }): Promise<string>;
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
  /**
   * Attaches to `session` through a real pseudo-terminal and streams what
   * tmux draws to `onOutput`. The size, 80 by 24 when absent, is clamped (see
   * `clampTerminalSize`). The caller starts it with `start()` and ends it
   * with `close()`.
   */
  openPty(
    session: string,
    size: TerminalSize | undefined,
    onOutput: (output: Uint8Array) => void,
  ): TmuxPty;
  /**
   * Fixes the session's window at `size` regardless of which client attached
   * last (`window-size manual`), clamped like `openPty`. Undone by
   * `unpinWindowSize`.
   */
  pinWindowSize(session: string, size: TerminalSize): Promise<void>;
  /** Hands the window's size back to tmux, which sizes it from its clients. */
  unpinWindowSize(session: string): Promise<void>;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** A tmux client attached through a pseudo-terminal: see `TmuxClient.openPty`. */
export interface TmuxPty {
  start(): Promise<void>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/**
 * The one place a terminal size is bounded: whole numbers, 20 to 500 columns
 * and 5 to 300 rows. Callers pass whatever a window or a phone reports.
 */
export const clampTerminalSize = ({
  cols,
  rows,
}: TerminalSize): TerminalSize => ({
  cols: Math.max(20, Math.min(500, Math.floor(cols))),
  rows: Math.max(5, Math.min(300, Math.floor(rows))),
});

export interface TmuxTerminalTarget {
  socketName: string;
  session: string;
}

/**
 * The slot Daedalus's own terminal feature occupies. A fixed index rather than
 * an append, so attaching a hundred times sets it once; high enough that the
 * built-in entries and a user's `~/.tmux.conf` never reach it.
 */
const HYPERLINKS_FEATURE_INDEX = 99;

/** Next to the hyperlinks slot, for the same reason. */
const SYNC_FEATURE_INDEX = 98;

/** Daedalus's slot in a hook or override array, for the same reason. */
const HOOK_INDEX = 99;

/** The desktop terminal's selection colour, for tmux's copy mode. */
const COPY_MODE_BACKGROUND = "#38546b";

/** The desktop terminal's background (`background` in its theme). */
const TERMINAL_BACKGROUND = "#111112";

/**
 * Hides the cursor while a pane is in copy mode. tmux shows copy mode's own
 * cursor there, a block that moves with every line the wheel scrolls back,
 * and Codex looked as if its prompt had jumped. tmux has no option to hide
 * it, so it becomes a bar in the background colour: a block that colour
 * would hide the character under it. Leaving copy mode puts back whatever
 * the program asked for.
 */
const HIDE_COPY_MODE_CURSOR = [
  "if-shell -F '#{pane_in_mode}'",
  `'set-option -p cursor-colour "${TERMINAL_BACKGROUND}" ; set-option -p cursor-style bar'`,
  "'set-option -p -u cursor-colour ; set-option -p -u cursor-style'",
].join(" ");

/**
 * tmux's own copy-mode wheel bindings, which scroll five lines a report. The
 * Daedalus terminal sends one report per line the trackpad moved, so these
 * become one line a report: see `CommandTmuxClient.scrollCopyModeByLine`.
 */
const COPY_MODE_WHEEL_DEFAULTS = ["copy-mode", "copy-mode-vi"].flatMap(
  (table) =>
    (
      [
        ["WheelUpPane", "scroll-up"],
        ["WheelDownPane", "scroll-down"],
      ] as const
    ).map(([key, command]) => ({ table, key, command })),
);

/**
 * Whether `list-keys -T <table>` shows tmux's default binding for `key`.
 * tmux 3.7 prints nothing when asked for a single key, so the whole table is
 * read and the key's own line picked out.
 */
export const isDefaultCopyModeWheelBinding = (
  listed: string,
  key: string,
  command: string,
): boolean =>
  listed
    .split("\n")
    .some(
      (line) =>
        line.split(/\s+/)[3] === key &&
        line.trim().endsWith(`select-pane \\; send-keys -X -N 5 ${command}`),
    );

/**
 * What a key does in copy mode once typing leaves it: tmux leaves copy mode
 * and sends the key on to the program, as `send-keys` with no key sends the
 * one it is bound to.
 */
const LEAVE_COPY_MODE = ["send-keys", "-X", "cancel", "\\;", "send-keys"];

/** Copy-mode keys that still move around in it rather than leave it. */
const COPY_MODE_MOVES = new Set([
  "Escape",
  "Home",
  "End",
  "NPage",
  "PPage",
  "Up",
  "Down",
  "Left",
  "Right",
  "M-Up",
  "M-Down",
  "C-Up",
  "C-Down",
]);

/**
 * The keys in `list-keys -T copy-mode` output that typing should take out of
 * copy mode: everything but moving around, the mouse, and keys already
 * leaving. The names come back as a command line takes them, so `M-{` loses
 * its quotes and `\;` keeps its backslash.
 */
export const copyModeTypingKeys = (listed: string): string[] =>
  listed.split("\n").flatMap((line) => {
    const words = line.trim().split(/\s+/);
    if (words[0] !== "bind-key" || words[2] !== "copy-mode") return [];
    const key = (words[3] ?? "").replace(/^"(.*)"$/, "$1");
    const command = words.slice(4).join(" ");
    if (
      !key ||
      COPY_MODE_MOVES.has(key) ||
      /Mouse|Wheel|Click/.test(key) ||
      command === LEAVE_COPY_MODE.join(" ")
    )
      return [];
    return [key];
  });

export const tmuxPtyArguments = (target: TmuxTerminalTarget): string[] =>
  terminalArgs(
    target.socketName,
    // xterm.js opens OSC 8 links, but tmux strips them unless the attaching
    // terminal declares `hyperlinks`, and none of its defaults do. Set before
    // the attach in the same command, the attaching client already has it.
    "set-option",
    "-s",
    `terminal-features[${HYPERLINKS_FEATURE_INDEX}]`,
    "xterm*:hyperlinks",
    ";",
    // Claude and Codex track whether their pane has focus, and without this
    // tmux swallows the focus reports xterm.js sends. Claude then prints a
    // footer hint asking for `focus-events on` in a `~/.tmux.conf` this
    // server never reads.
    "set-option",
    "-s",
    "focus-events",
    "on",
    ";",
    // tmux repaints the whole pane for every step a fullscreen program
    // scrolls, about 14 KB written over 14 ms. Without `sync` xterm.js drew
    // whatever part had arrived by the next frame, so nearly every frame of a
    // scroll was half old screen and half new. With it, tmux brackets each
    // repaint in synchronized output and xterm.js draws only whole ones.
    "set-option",
    "-s",
    `terminal-features[${SYNC_FEATURE_INDEX}]`,
    "xterm*:sync",
    ";",
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
    // A drag over a program that reads no mouse, Codex or a shell, is tmux's
    // copy mode, which highlights it black on yellow. The terminal's own
    // selection colour (`selectionBackground` in the desktop theme) makes
    // the drag look like the selection it leaves behind.
    "set-option",
    "-w",
    "-t",
    target.session,
    "mode-style",
    `bg=${COPY_MODE_BACKGROUND}`,
    ";",
    "set-hook",
    "-g",
    `pane-mode-changed[${HOOK_INDEX}]`,
    HIDE_COPY_MODE_CURSOR,
    ";",
    // tmux puts a cursor back with `ESC [ 2 q`, a steady block, where the
    // terminal's own is a blinking one; `ESC [ 0 q` asks for that.
    "set-option",
    "-s",
    `terminal-overrides[${HOOK_INDEX}]`,
    "xterm*:Se=\\E[0 q",
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
  "DAEDALUS_SESSION_DIRECTORY",
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

/**
 * How long any tmux command may take before it is killed and reported as
 * failed. The server answers in milliseconds; a client still waiting after
 * this is talking to a wedged server, and the desktop host's one thread must
 * not wait with it.
 */
export const TMUX_COMMAND_TIMEOUT_MS = 10_000;

/**
 * The most a tmux client sends as one command: its arguments, each with a
 * NUL, in a 16 KB message less its header and argument count. Over this the
 * client prints "command too long" and starts nothing. Measured on tmux 3.7c.
 */
export const TMUX_COMMAND_MAX_BYTES = 16_364;

/** The size tmux counts for a command's arguments. */
export const tmuxCommandBytes = (args: readonly string[]): number =>
  args.reduce((total, arg) => total + Buffer.byteLength(arg) + 1, 0);

export class CommandTmuxClient implements TmuxClient {
  /** The version the executable reported, once it has: see `probe`. */
  private probed: string | undefined;

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

  /** Set once the copy-mode bindings have been looked at. */
  private copyModeKeys: Promise<void> | undefined;

  /**
   * Makes copy mode scroll one line per wheel report, where tmux's default
   * scrolls five, because the Daedalus terminal sends a report per line. Only
   * a binding that is still tmux's default is replaced, so one from the user's
   * `~/.tmux.conf` stays as they wrote it. Bindings are server-wide: a plain
   * `tmux attach` to this socket from another terminal scrolls by line too.
   */
  async scrollCopyModeByLine(): Promise<void> {
    for (const { table, key, command } of COPY_MODE_WHEEL_DEFAULTS) {
      const listed = await this.run(["list-keys", "-T", table]);
      if (
        listed.exitCode === 0 &&
        isDefaultCopyModeWheelBinding(listed.stdout, key, command)
      )
        await this.run([
          "bind-key",
          "-T",
          table,
          key,
          "send-keys",
          "-X",
          command,
        ]);
    }
  }

  /**
   * Makes a key typed in copy mode leave it and reach the program. A program
   * that reads no mouse, Codex or a shell, puts its pane in copy mode when
   * the wheel scrolls it back, and tmux's emacs keys then took what the user
   * typed: `f` opened a "(jump forward)" prompt and the program got nothing.
   * Moving keys and the mouse still work in copy mode. Only the emacs table
   * changes: someone who chose vi keys chose to type into copy mode.
   */
  async typingLeavesCopyMode(): Promise<void> {
    const listed = await this.run(["list-keys", "-T", "copy-mode"]);
    if (listed.exitCode !== 0) return;
    for (const key of ["Any", ...copyModeTypingKeys(listed.stdout)])
      await this.run(["bind-key", "-T", "copy-mode", key, ...LEAVE_COPY_MODE]);
  }

  private args(...args: string[]): string[] {
    return ["-L", this.socketName, ...args];
  }

  private run(
    args: string[],
    options: Omit<CommandOptions, "env" | "replaceEnvironment"> & {
      /** Overlaid on the clean environment for this one command. */
      env?: Record<string, string>;
    } = {},
  ): Promise<CommandResult> {
    return this.command(this.executable, this.args(...args), {
      timeoutMs: TMUX_COMMAND_TIMEOUT_MS,
      ...options,
      env: { ...this.environment, ...options.env },
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

  /**
   * The tmux version, or `undefined` when there is no usable tmux. A success
   * is remembered: the executable does not change under a running process,
   * and the desktop host asked this on every tick, which under load was one
   * more blocking spawn per tick for an answer it already had. A failure is
   * asked again, since tmux may be installed later.
   */
  async probe(): Promise<string | undefined> {
    if (this.probed !== undefined) return this.probed;
    try {
      const result = await this.command(this.executable, ["-V"], {
        timeoutMs: TMUX_COMMAND_TIMEOUT_MS,
      });
      const version =
        result.exitCode === 0
          ? result.stdout.trim() || result.stderr.trim()
          : undefined;
      if (version) this.probed = version;
      return version;
    } catch {
      return undefined;
    }
  }

  async createSession(launch: TmuxLaunch): Promise<void> {
    await this.scrubServerEnvironment();
    const environment = Object.entries({
      // Programs decide for themselves whether the terminal supports OSC 8
      // links, and under tmux they guess no. Daedalus's terminal does (see
      // `tmuxPtyArguments`), and Claude Code then sends a URL wrapped across
      // rows as one link instead of rows of text no link detector can join.
      FORCE_HYPERLINK: "1",
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
      ...(launch.keepOnExit
        ? [";", "set-option", "-t", launch.session, "remain-on-exit", "on"]
        : []),
      // Also set on attach (see `tmuxPtyArguments`), but Claude reads it once
      // when it starts, which is usually before the app's terminal attaches.
      ";",
      "set-option",
      "-s",
      "focus-events",
      "on",
    ];
    // tmux's own message for this, "command too long", names neither the
    // limit nor what filled it.
    const bytes = tmuxCommandBytes(args);
    if (bytes > TMUX_COMMAND_MAX_BYTES)
      throw new Error(
        `The launch command is ${bytes} bytes and tmux accepts at most ${TMUX_COMMAND_MAX_BYTES}. ` +
          `Each attached repository adds an --add-dir argument; detach repositories this workspace does not need.`,
      );
    // tmux gives a new session's command the PATH of the client that asked
    // for it, not the `-e PATH=` above: measured on tmux 3.7c, a client with
    // PATH=/a and `-e PATH=/b` starts a command that sees /a. So the client
    // itself carries the session's PATH, or the command gets this process's.
    const result = await this.run(args, {
      ...(this.serverWorkingDirectory
        ? { cwd: this.serverWorkingDirectory }
        : {}),
      ...(launch.env?.PATH ? { env: { PATH: launch.env.PATH } } : {}),
    });
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || "tmux session creation failed");
  }

  async hasSession(session: string): Promise<boolean> {
    const result = await this.run(["has-session", "-t", session]);
    return result.exitCode === 0;
  }

  async listSessions(): Promise<string[]> {
    const result = await this.run(["list-sessions", "-F", "#{session_name}"]);
    if (result.exitCode !== 0) {
      // No server, or a socket left by one that exited: there are no sessions.
      if (/no server running|error connecting to/i.test(result.stderr))
        return [];
      // Anything else, a timeout above all, says nothing about the sessions.
      // A Mac waking from sleep was seen to get here, and reading it as "no
      // sessions" marked every session lost while all of them kept running.
      throw new Error(
        result.timedOut
          ? "tmux did not answer list-sessions in time"
          : result.stderr.trim() || "tmux list-sessions failed",
      );
    }
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

  async capture(
    session: string,
    options: { styled?: boolean } = {},
  ): Promise<string> {
    const result = await this.run([
      "capture-pane",
      "-p",
      ...(options.styled ? ["-e"] : []),
      "-J",
      "-t",
      session,
    ]);
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

  openPty(
    session: string,
    size: TerminalSize | undefined,
    onOutput: (output: Uint8Array) => void,
  ): TmuxPty {
    this.copyModeKeys ??= this.scrollCopyModeByLine()
      .then(() => this.typingLeavesCopyMode())
      .catch(() => {});
    return new TmuxPtyBridge(
      onOutput,
      { socketName: this.socketName, session },
      size,
      this.executable,
    );
  }

  async pinWindowSize(session: string, size: TerminalSize): Promise<void> {
    const { cols, rows } = clampTerminalSize(size);
    await this.run([
      "set-option",
      "-w",
      "-t",
      session,
      "window-size",
      "manual",
      ";",
      "resize-window",
      "-t",
      session,
      "-x",
      String(cols),
      "-y",
      String(rows),
    ]);
  }

  async unpinWindowSize(session: string): Promise<void> {
    await this.run(["set-option", "-w", "-u", "-t", session, "window-size"]);
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

const terminalArgs = (socketName: string, ...args: string[]) => [
  "-u",
  "-L",
  socketName,
  ...args,
];

/**
 * Attaches to a durable tmux session through a real pseudo-terminal.
 *
 * tmux then owns terminal emulation, cursor placement, keyboard decoding, and
 * redraws. This avoids reconstructing a screen from capture-pane and replaying
 * a second control-mode stream on top of it.
 */
export class TmuxPtyBridge implements TmuxPty {
  readonly process: Bun.Subprocess;
  #closed = false;

  constructor(
    onOutput: (output: Uint8Array) => void,
    target: TmuxTerminalTarget,
    initialSize: TerminalSize = { cols: 80, rows: 24 },
    executable = resolveTmuxExecutable(),
  ) {
    const { cols, rows } = clampTerminalSize(initialSize);
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
    const size = clampTerminalSize({ cols, rows });
    this.process.terminal?.resize(size.cols, size.rows);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.process.terminal?.close();
    this.process.kill();
  }
}

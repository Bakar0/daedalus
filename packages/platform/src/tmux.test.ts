import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  BUNDLED_TMUX_VARIABLE,
  clampTerminalSize,
  CommandTmuxClient,
  findTmuxExecutable,
  isInheritedSessionVariable,
  tmuxPtyArguments,
  tmuxPtyEnvironment,
  TMUX_COMMAND_MAX_BYTES,
  TMUX_COMMAND_TIMEOUT_MS,
  tmuxCommandBytes,
} from "./tmux";

describe("findTmuxExecutable", () => {
  test("prefers the tmux the app bundles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daedalus-tmux-"));
    try {
      const bundled = join(directory, "tmux");
      await writeFile(bundled, "#!/bin/sh\n");
      await chmod(bundled, 0o755);
      expect(findTmuxExecutable({ [BUNDLED_TMUX_VARIABLE]: bundled })).toBe(
        bundled,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("falls back to the usual search when the bundled path is unusable", () => {
    const usual = findTmuxExecutable({});
    expect(
      findTmuxExecutable({ [BUNDLED_TMUX_VARIABLE]: "/nonexistent/tmux" }),
    ).toBe(usual);
    // A relative value would resolve against whatever directory the caller
    // happens to be in, so it is never taken as the bundle's path.
    expect(findTmuxExecutable({ [BUNDLED_TMUX_VARIABLE]: "tmux" })).toBe(usual);
  });
});

test("tmux PTYs always use a UTF-8 locale for Unicode cell widths", () => {
  expect(
    tmuxPtyEnvironment({
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_CTYPE: "C",
      LC_ALL: "C",
    }),
  ).toMatchObject({
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_CTYPE: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  });
});

// What an agent's tool shell carried into the app on 2026-09-23.
const AGENT_SHELL_ENVIRONMENT = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/someone",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  TERM: "dumb",
  COLORTERM: "",
  TMUX: "/private/tmp/tmux-501/default,123,0",
  TMUX_PANE: "%3",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  AI_AGENT: "codex",
  DAEDALUS_HOME: "/Users/someone/.daedalus",
  DAEDALUS_SESSION_ID: "another-session",
  DAEDALUS_TASK_ID: "another-task",
  DAEDALUS_TASK_NUMBER: "25",
  DAEDALUS_WORKSPACE_ID: "another-workspace",
};

test("tmux PTYs drop an agent shell's terminal state and identity", () => {
  const environment = tmuxPtyEnvironment(AGENT_SHELL_ENVIRONMENT);
  expect(environment).toMatchObject({
    PATH: "/usr/bin:/bin",
    HOME: "/Users/someone",
    DAEDALUS_HOME: "/Users/someone/.daedalus",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  });
  for (const key of [
    "NO_COLOR",
    "FORCE_COLOR",
    "TMUX",
    "TMUX_PANE",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "AI_AGENT",
    "DAEDALUS_SESSION_ID",
    "DAEDALUS_TASK_ID",
    "DAEDALUS_TASK_NUMBER",
    "DAEDALUS_WORKSPACE_ID",
  ])
    expect(environment).not.toHaveProperty(key);
});

test("tmux PTYs use native mouse scrolling, pass OSC 8 links and focus", () => {
  expect(
    tmuxPtyArguments({ socketName: "isolated", session: "daedalus_123" }),
  ).toEqual([
    "-u",
    "-L",
    "isolated",
    "set-option",
    "-s",
    "terminal-features[99]",
    "xterm*:hyperlinks",
    ";",
    "set-option",
    "-s",
    "focus-events",
    "on",
    ";",
    "set-option",
    "-t",
    "daedalus_123",
    "status",
    "off",
    ";",
    "set-option",
    "-t",
    "daedalus_123",
    "mouse",
    "on",
    ";",
    "attach-session",
    "-t",
    "daedalus_123",
  ]);
});

describe("CommandTmuxClient", () => {
  test("remembers a successful version probe and asks again after a failure", async () => {
    let installed = false;
    const command = vi.fn(async () => ({
      exitCode: installed ? 0 : 1,
      stdout: installed ? "tmux 3.5a\n" : "",
      stderr: installed ? "" : "not found",
    }));
    const tmux = new CommandTmuxClient("isolated", "tmux", command);
    expect(await tmux.probe()).toBeUndefined();
    expect(await tmux.probe()).toBeUndefined();
    expect(command).toHaveBeenCalledTimes(2);
    installed = true;
    expect(await tmux.probe()).toBe("tmux 3.5a");
    expect(await tmux.probe()).toBe("tmux 3.5a");
    expect(command).toHaveBeenCalledTimes(3);
  });

  test("gives every tmux command a timeout", async () => {
    const command = vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const tmux = new CommandTmuxClient("isolated", "tmux", command);
    await tmux.listSessions();
    expect(command).toHaveBeenCalledWith(
      "tmux",
      ["-L", "isolated", "list-sessions", "-F", "#{session_name}"],
      expect.objectContaining({ timeoutMs: TMUX_COMMAND_TIMEOUT_MS }),
    );
  });

  test("tells no server apart from a tmux that did not answer", async () => {
    const answer = (result: {
      exitCode: number;
      stderr: string;
      timedOut?: boolean;
    }) =>
      new CommandTmuxClient("isolated", "tmux", async () => ({
        stdout: "",
        ...result,
      }));
    expect(
      await answer({
        exitCode: 1,
        stderr:
          "error connecting to /private/tmp/tmux-501/isolated (No such file or directory)",
      }).listSessions(),
    ).toEqual([]);
    expect(
      await answer({
        exitCode: 1,
        stderr: "no server running on /private/tmp/tmux-501/isolated",
      }).listSessions(),
    ).toEqual([]);
    // Seen after the Mac woke: a timeout must not read as "no sessions".
    await expect(
      answer({ exitCode: 124, stderr: "", timedOut: true }).listSessions(),
    ).rejects.toThrow("did not answer");
  });

  test("refuses a launch tmux would reject as too long, and says why", async () => {
    const command = vi.fn(async (_executable: string, _args: string[]) => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const tmux = new CommandTmuxClient("isolated", "tmux", command);
    const launch = (bytes: number) =>
      tmux.createSession({
        session: "daedalus_big",
        cwd: "/tmp",
        executable: "agent",
        args: ["x".repeat(bytes)],
      });
    await expect(launch(TMUX_COMMAND_MAX_BYTES)).rejects.toThrow(
      /detach repositories/,
    );
    expect(
      command.mock.calls.some(([, args]) => args.includes("new-session")),
    ).toBe(false);
    await launch(10_000);
    expect(
      command.mock.calls.some(([, args]) => args.includes("new-session")),
    ).toBe(true);
  });

  test("counts a command's size the way tmux does", () => {
    // Each argument and its NUL, in bytes rather than characters.
    expect(tmuxCommandBytes(["new-session", "·"])).toBe(12 + 3);
  });

  test("starts a session from a client carrying the session's PATH", async () => {
    // tmux hands the new command its client's PATH and ignores `-e PATH=`, so
    // the PATH has to travel on the client or the agent never sees it.
    const command = vi.fn(
      async (
        _executable: string,
        _args: string[],
        _options?: { env?: Record<string, string | undefined> },
      ) => ({ exitCode: 0, stdout: "", stderr: "" }),
    );
    const tmux = new CommandTmuxClient("isolated", "tmux", command, undefined, {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/someone",
    });
    await tmux.createSession({
      session: "daedalus_path",
      cwd: "/tmp",
      executable: "agent",
      args: [],
      env: { PATH: "/home/bin:/opt/homebrew/bin:/usr/bin:/bin" },
    });
    const created = command.mock.calls.find(([, args]) =>
      args.includes("new-session"),
    );
    expect(created?.[2]?.env).toMatchObject({
      PATH: "/home/bin:/opt/homebrew/bin:/usr/bin:/bin",
      HOME: "/Users/someone",
    });

    // A session that names no PATH keeps the client's own.
    command.mockClear();
    await tmux.createSession({
      session: "daedalus_plain",
      cwd: "/tmp",
      executable: "shell",
      args: [],
    });
    expect(
      command.mock.calls.find(([, args]) => args.includes("new-session"))?.[2]
        ?.env,
    ).toMatchObject({ PATH: "/usr/bin:/bin" });
  });

  test("passes executable, arguments, environment, cwd, and input as distinct argv", async () => {
    const command = vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const tmux = new CommandTmuxClient("isolated", "tmux", command);
    await tmux.createSession({
      session: "daedalus_123",
      cwd: "/tmp/work space",
      executable: "agent",
      args: ["literal; touch /tmp/nope", "$(also-nope)"],
      env: { TASK: "one two" },
    });
    expect(command).toHaveBeenCalledWith(
      "tmux",
      [
        "-L",
        "isolated",
        "new-session",
        "-d",
        "-s",
        "daedalus_123",
        "-c",
        "/tmp/work space",
        "-e",
        "FORCE_HYPERLINK=1",
        "-e",
        "TASK=one two",
        "-e",
        "PWD=/tmp/work space",
        "--",
        "agent",
        "literal; touch /tmp/nope",
        "$(also-nope)",
        ";",
        "set-option",
        "-s",
        "focus-events",
        "on",
      ],
      expect.anything(),
    );
    await tmux.send("daedalus_123", "hello; exit");
    expect(command).toHaveBeenNthCalledWith(
      3,
      "tmux",
      [
        "-L",
        "isolated",
        "send-keys",
        "-t",
        "daedalus_123",
        "-l",
        "--",
        "hello; exit",
      ],
      expect.anything(),
    );
    await tmux.attach("daedalus_123");
    expect(command).toHaveBeenNthCalledWith(
      5,
      "tmux",
      ["-L", "isolated", "attach-session", "-t", "daedalus_123"],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
  });

  test("ends only its own server, and reads an absent one as success", async () => {
    const stopped = vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const tmux = new CommandTmuxClient("isolated", "tmux", stopped);
    await expect(tmux.killServer()).resolves.toBe(true);
    // `-L` is the whole safety story: this must never reach the user's own
    // tmux server, only the socket Daedalus keys to its home.
    expect(stopped).toHaveBeenCalledWith(
      "tmux",
      ["-L", "isolated", "kill-server"],
      expect.anything(),
    );

    // Nothing to stop is the goal state reached sooner, not a failure: tmux
    // exits on its own once the last session in it ends.
    const absent = new CommandTmuxClient("isolated", "tmux", async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "no server running on /tmp/tmux-501/isolated",
    }));
    await expect(absent.killServer()).resolves.toBe(false);

    const broken = new CommandTmuxClient("isolated", "tmux", async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "permission denied",
    }));
    await expect(broken.killServer()).rejects.toThrow("permission denied");
  });

  test("runs tmux with an environment that holds nothing inherited from an agent", async () => {
    const command = vi.fn(
      async (_executable: string, _args: string[], _options?: unknown) => ({
        exitCode: 1,
        stdout: "",
        stderr: "no server running",
      }),
    );
    const tmux = new CommandTmuxClient(
      "isolated",
      "tmux",
      command,
      "/home",
      AGENT_SHELL_ENVIRONMENT,
    );
    command.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "no server running",
    });
    command.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    await tmux.createSession({
      session: "daedalus_123",
      cwd: "/work",
      executable: "agent",
      args: [],
      env: { DAEDALUS_SESSION_ID: "this-session" },
    });
    await tmux.hasSession("daedalus_123");
    expect(command).toHaveBeenCalledTimes(3);
    for (const [, , options] of command.mock.calls) {
      const { env, replaceEnvironment } = options as {
        env: Record<string, string>;
        replaceEnvironment: boolean;
      };
      // Overlaid on the caller's own environment, removing keys would do
      // nothing: the child would inherit them anyway.
      expect(replaceEnvironment).toBe(true);
      expect(env).toMatchObject({
        PATH: "/usr/bin:/bin",
        DAEDALUS_HOME: "/Users/someone/.daedalus",
      });
      expect(Object.keys(env).filter(isInheritedSessionVariable)).toEqual([]);
    }
    // The session still gets its own identity, passed explicitly.
    expect(command.mock.calls[1]?.[1]).toContain(
      "DAEDALUS_SESSION_ID=this-session",
    );
  });

  test("clears inherited variables from a server that already holds them", async () => {
    const command = vi.fn(
      async (_executable: string, _args: string[], _options?: unknown) => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    );
    command.mockResolvedValueOnce({
      exitCode: 0,
      stdout: [
        "HOME=/Users/someone",
        "NO_COLOR=1",
        "TERM=dumb",
        "-TMUX",
        "CLAUDE_CODE_ENTRYPOINT=cli",
        "DAEDALUS_SESSION_ID=another-session",
        "",
      ].join("\n"),
      stderr: "",
    });
    const tmux = new CommandTmuxClient("isolated", "tmux", command);
    await tmux.createSession({
      session: "daedalus_123",
      cwd: "/work",
      executable: "agent",
      args: [],
    });
    expect(command.mock.calls.map((call) => call[1])).toEqual([
      ["-L", "isolated", "show-environment", "-g"],
      [
        "-L",
        "isolated",
        "set-environment",
        "-g",
        "-u",
        "NO_COLOR",
        ";",
        "set-environment",
        "-g",
        "-u",
        "TERM",
        ";",
        "set-environment",
        "-g",
        "-u",
        "CLAUDE_CODE_ENTRYPOINT",
        ";",
        "set-environment",
        "-g",
        "-u",
        "DAEDALUS_SESSION_ID",
      ],
      expect.arrayContaining(["new-session", "daedalus_123"]),
    ]);
  });
});

describe("clampTerminalSize", () => {
  test("keeps whole sizes inside 20..500 columns and 5..300 rows", () => {
    expect(clampTerminalSize({ cols: 93.7, rows: 31.2 })).toEqual({
      cols: 93,
      rows: 31,
    });
    expect(clampTerminalSize({ cols: 1, rows: 1 })).toEqual({
      cols: 20,
      rows: 5,
    });
    expect(clampTerminalSize({ cols: 9000, rows: 9000 })).toEqual({
      cols: 500,
      rows: 300,
    });
  });
});

describe("CommandTmuxClient window pinning", () => {
  const recorded = () => {
    const command = vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    return {
      command,
      tmux: new CommandTmuxClient("isolated", "tmux", command),
    };
  };

  test("pins the window to a clamped size", async () => {
    const { command, tmux } = recorded();
    await tmux.pinWindowSize("s", { cols: 9000, rows: 2 });
    expect(command).toHaveBeenCalledWith(
      "tmux",
      [
        "-L",
        "isolated",
        "set-option",
        "-w",
        "-t",
        "s",
        "window-size",
        "manual",
        ";",
        "resize-window",
        "-t",
        "s",
        "-x",
        "500",
        "-y",
        "5",
      ],
      expect.anything(),
    );
  });

  test("unpins by unsetting the window option", async () => {
    const { command, tmux } = recorded();
    await tmux.unpinWindowSize("s");
    expect(command).toHaveBeenCalledWith(
      "tmux",
      ["-L", "isolated", "set-option", "-w", "-u", "-t", "s", "window-size"],
      expect.anything(),
    );
  });
});

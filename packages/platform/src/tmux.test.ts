import { describe, expect, test, vi } from "vitest";
import {
  boundTerminalCapture,
  CommandTmuxClient,
  isInheritedSessionVariable,
  tmuxPtyArguments,
  tmuxPtyEnvironment,
} from "./tmux";

test("terminal captures preserve recent complete UTF-8 within a byte bound", () => {
  const capture = boundTerminalCapture(
    `old output ${"x".repeat(20)}שלום 😀`,
    16,
  );
  const decoded = new TextDecoder().decode(capture);
  expect(capture.byteLength).toBeLessThanOrEqual(23);
  expect(decoded).toMatch(/^\u001b\[H\u001b\[2J/);
  expect(decoded).toContain("שלום 😀");
  expect(decoded).not.toContain("�");
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

test("tmux PTYs use native mouse scrolling", () => {
  expect(
    tmuxPtyArguments({ socketName: "isolated", session: "daedalus_123" }),
  ).toEqual([
    "-u",
    "-L",
    "isolated",
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
        "TASK=one two",
        "-e",
        "PWD=/tmp/work space",
        "--",
        "agent",
        "literal; touch /tmp/nope",
        "$(also-nope)",
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

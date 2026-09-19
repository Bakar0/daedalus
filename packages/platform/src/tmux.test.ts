import { describe, expect, test, vi } from "vitest";
import {
  boundTerminalCapture,
  CommandTmuxClient,
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
    expect(command).toHaveBeenCalledWith("tmux", [
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
    ]);
    await tmux.send("daedalus_123", "hello; exit");
    expect(command).toHaveBeenNthCalledWith(2, "tmux", [
      "-L",
      "isolated",
      "send-keys",
      "-t",
      "daedalus_123",
      "-l",
      "--",
      "hello; exit",
    ]);
    await tmux.attach("daedalus_123");
    expect(command).toHaveBeenNthCalledWith(
      4,
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
    expect(stopped).toHaveBeenCalledWith("tmux", [
      "-L",
      "isolated",
      "kill-server",
    ]);

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
});

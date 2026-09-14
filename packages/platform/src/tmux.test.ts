import { describe, expect, test, vi } from "vitest";
import {
  boundTerminalCapture,
  CommandTmuxClient,
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
});

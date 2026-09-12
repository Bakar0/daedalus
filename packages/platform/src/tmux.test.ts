import { describe, expect, test, vi } from "vitest";
import { CommandTmuxClient, decodeControlOutput } from "./tmux";

describe("decodeControlOutput", () => {
  test("decodes tmux octal control bytes and keeps Unicode", () => {
    const decoded = new TextDecoder().decode(
      decodeControlOutput("\u001b[31mשלום \\015\\012"),
    );
    expect(decoded).toBe("\u001b[31mשלום \r\n");
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
  });
});

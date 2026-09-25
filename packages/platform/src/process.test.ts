import { describe, expect, test, vi } from "vitest";
import {
  findExecutable,
  processIsAlive,
  runCommand,
  standardExecutableFallbacks,
  TIMED_OUT_EXIT_CODE,
} from "./process";

describe("findExecutable", () => {
  test("uses an absolute fallback when a GUI process has no shell PATH", () => {
    const which = vi.fn(() => null);
    const isExecutable = vi.fn(
      (candidate: string) => candidate === "/opt/homebrew/bin/tmux",
    );
    expect(
      findExecutable(
        "tmux",
        ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"],
        which,
        isExecutable,
      ),
    ).toBe("/opt/homebrew/bin/tmux");
    expect(which).toHaveBeenCalledWith("tmux");
    expect(isExecutable).toHaveBeenCalledWith("/opt/homebrew/bin/tmux");
    expect(which).not.toHaveBeenCalledWith("/opt/homebrew/bin/tmux");
  });
});

describe("standardExecutableFallbacks", () => {
  test("offers Homebrew locations ahead of the paths a bundle already inherits", () => {
    expect(standardExecutableFallbacks("tmux")).toEqual([
      "/opt/homebrew/bin/tmux",
      "/usr/local/bin/tmux",
      "/usr/bin/tmux",
      "/bin/tmux",
    ]);
  });

  test("resolves a Homebrew executable for a caller with no shell PATH", () => {
    const which = vi.fn(() => null);
    const isExecutable = vi.fn(
      (candidate: string) => candidate === "/opt/homebrew/bin/gh",
    );
    expect(
      findExecutable(
        "gh",
        standardExecutableFallbacks("gh"),
        which,
        isExecutable,
      ),
    ).toBe("/opt/homebrew/bin/gh");
  });
});

describe("runCommand", () => {
  test("writes string input and closes the child stdin", async () => {
    const result = await runCommand(
      process.execPath,
      [
        "-e",
        "const input = await Bun.stdin.text(); process.stdout.write(input.toUpperCase())",
      ],
      { stdin: "model catalog" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("MODEL CATALOG");
  });

  test("kills a child that outlives its timeout and says so", async () => {
    const started = Date.now();
    const result = await runCommand("sleep", ["30"], { timeoutMs: 150 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(TIMED_OUT_EXIT_CODE);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a child that finishes in time is not marked as timed out", async () => {
    const result = await runCommand("true", [], { timeoutMs: 5_000 });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBeUndefined();
  });
});

describe("processIsAlive", () => {
  test("sees this process and not a pid nothing holds", () => {
    expect(processIsAlive(process.pid)).toBe(true);
    // The maximum pid on macOS is 99998; nothing can hold this one.
    expect(processIsAlive(2_147_000_000)).toBe(false);
  });
});

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  findExecutable,
  processIsAlive,
  readLoginShellPath,
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

describe("readLoginShellPath", () => {
  const withShell = async (
    script: string,
    check: (shell: string) => Promise<void>,
  ) => {
    const directory = await mkdtemp(join(tmpdir(), "daedalus-shell-"));
    const shell = join(directory, "shell");
    try {
      await writeFile(shell, `#!/bin/sh\n${script}\n`);
      await chmod(shell, 0o755);
      await check(shell);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  test("reads the PATH out of whatever an interactive configuration prints", async () => {
    // A stand-in shell: prints a greeting, then runs the `-c` command as a
    // real login shell would, with a PATH its configuration built.
    await withShell(
      'echo "Welcome back"; PATH=/opt/homebrew/bin:/usr/bin:/bin; export PATH; eval "$4"; echo "bye"',
      async (shell) => {
        expect(await readLoginShellPath(shell)).toBe(
          "/opt/homebrew/bin:/usr/bin:/bin",
        );
      },
    );
  });

  test("answers nothing for a shell that fails, or no shell at all", async () => {
    await withShell("exit 3", async (shell) => {
      expect(await readLoginShellPath(shell)).toBeUndefined();
    });
    await withShell('echo "no marker here"', async (shell) => {
      expect(await readLoginShellPath(shell)).toBeUndefined();
    });
    expect(await readLoginShellPath(undefined)).toBeUndefined();
    expect(await readLoginShellPath("zsh")).toBeUndefined();
  });
});

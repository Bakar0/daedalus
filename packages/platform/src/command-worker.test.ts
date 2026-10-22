import { afterEach, describe, expect, test } from "bun:test";
import { startCommandWorker } from "./command-worker";
import { runCommand, runCommandsOn } from "./process";

describe("startCommandWorker", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    runCommandsOn(undefined);
    stop?.();
    stop = undefined;
  });
  const installed = () => {
    let calls = 0;
    const worker = startCommandWorker();
    stop = worker.stop;
    runCommandsOn({
      available: worker.available,
      run: (...args) => {
        calls += 1;
        return worker.run(...args);
      },
    });
    return { worker, calls: () => calls };
  };

  test("runs what runCommand runs, with the same answer", async () => {
    const { calls } = installed();
    expect(
      await runCommand("/bin/sh", ["-c", "printf out; printf err >&2; exit 3"]),
    ).toEqual({ exitCode: 3, stdout: "out", stderr: "err" });
    expect(
      (await runCommand("/bin/cat", [], { stdin: "fed through stdin" })).stdout,
    ).toBe("fed through stdin");
    expect(
      (await runCommand("/bin/pwd", [], { cwd: "/tmp" })).stdout.trim(),
    ).toMatch(/\/tmp$/);
    expect(calls()).toBe(3);
  });

  test("carries the caller's environment, as it is now", async () => {
    installed();
    process.env.DAEDALUS_COMMAND_WORKER_TEST = "set after the worker started";
    try {
      expect(
        (
          await runCommand("/bin/sh", [
            "-c",
            'printf %s "$DAEDALUS_COMMAND_WORKER_TEST"',
          ])
        ).stdout,
      ).toBe("set after the worker started");
      expect(
        (
          await runCommand("/bin/sh", ["-c", 'printf %s "$ONLY"'], {
            env: { ONLY: "this", PATH: "/usr/bin:/bin" },
            replaceEnvironment: true,
          })
        ).stdout,
      ).toBe("this");
    } finally {
      delete process.env.DAEDALUS_COMMAND_WORKER_TEST;
    }
  });

  test("times out, and rejects a missing executable, as runCommand does", async () => {
    installed();
    expect(
      await runCommand("/bin/sleep", ["5"], { timeoutMs: 100 }),
    ).toMatchObject({ exitCode: 124, timedOut: true });
    const missing = await runCommand("/no/such/executable", []).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(missing).toBeInstanceOf(Error);
  });

  test("leaves a child that writes to the terminal on the calling thread", async () => {
    const { calls } = installed();
    await runCommand("/usr/bin/true", [], { stdout: "inherit" });
    expect(calls()).toBe(0);
  });

  test("a stopped worker hands launching back to the caller", async () => {
    const { worker } = installed();
    worker.stop();
    expect(worker.available()).toBe(false);
    expect((await runCommand("/bin/echo", ["still works"])).stdout).toBe(
      "still works\n",
    );
  });
});

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runCommand } from "@daedalus/platform";

/**
 * The tmux server an application context creates for a home, named the same
 * way `createApplicationContext` names it.
 */
const socketNameFor = (home: string) =>
  `daedalus-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 12)}`;

/**
 * Runs `run` against a throwaway Daedalus home, then takes the home *and its
 * agents* away again.
 *
 * Removing the directory is not enough. A test that spawns an agent starts a
 * real provider process inside a real tmux server keyed to this home, and
 * those outlive the directory quite happily: every suite run used to leave one
 * running process per spawning test, for ever. They accumulate across runs
 * until the machine cannot start a process within the spawn timeout, at which
 * point the suite fails in ways that look like product bugs and are not —
 * roughly 350 stray processes were collected this way before anyone noticed.
 */
export async function withTemporaryDaedalusHome<T>(
  run: (home: string) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "daedalus-test-"));
  try {
    return await run(home);
  } finally {
    // Before the directory, because the socket name is derived from it. Best
    // effort: a test that never started a server has nothing to kill, and a
    // cleanup failure must not mask the test's own result.
    await runCommand("tmux", ["-L", socketNameFor(home), "kill-server"]).catch(
      () => undefined,
    );
    await rm(home, { recursive: true, force: true });
  }
}

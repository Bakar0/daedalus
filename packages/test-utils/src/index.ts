import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

/**
 * Points a test home's Claude and Codex at executables that do not exist, so
 * nothing the test calls launches the real ones from the developer's PATH.
 * A snapshot or `doctor` otherwise runs `claude auth status` and `codex
 * app-server`, which ask the network and took 1 to 5 seconds a run, past the
 * 5-second test timeout under a loaded suite.
 *
 * A missing provider makes Daedalus ask the login shell for a PATH instead,
 * so a test that runs the CLI as a subprocess also passes `SHELL: ""`
 * (`NO_LOGIN_SHELL`) in its environment.
 */
export async function withoutProviderClis(home: string): Promise<void> {
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      agents: {
        claude: { executable: join(home, "no-claude"), args: [] },
        codex: { executable: join(home, "no-codex"), args: [] },
      },
    }),
  );
}

/** The environment that keeps a subprocess from starting a login shell. */
export const NO_LOGIN_SHELL = { SHELL: "" } as const;

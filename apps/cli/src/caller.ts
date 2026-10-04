import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  DaedalusError,
  type AgentSession,
  type ApplicationContext,
} from "@daedalus/core";

/**
 * Which Daedalus session a command was run from.
 *
 * The environment cannot answer this on its own. Claude can move a session
 * into the background for its agent view, and from then on the session's
 * commands run with another Claude process's environment: another session's
 * `DAEDALUS_SESSION_ID`, even another channel's `DAEDALUS_HOME`. The working
 * directory stays the session's own, so it decides first:
 *
 * 1. The live sessions whose working directory contains the current one. An
 *    agent often runs commands from inside its folder, such as a repository
 *    worktree under it, so the closest folder wins.
 * 2. When two sessions share that folder, `DAEDALUS_SESSION_ID` breaks the
 *    tie if it names one of them. Otherwise it is ambiguous, and the caller
 *    has to name the session.
 * 3. When no session's folder contains the current directory, as for a
 *    command run from `/tmp`, `DAEDALUS_SESSION_ID` is used as before.
 *
 * Every command that defaults to "this session" goes through here, so a skill
 * never has to pass `--session` for its own session.
 */
export async function callerSession(
  context: ApplicationContext,
  options: {
    directory?: string;
    environmentId?: string | undefined;
  } = {},
): Promise<AgentSession | undefined> {
  const environmentId =
    "environmentId" in options
      ? options.environmentId
      : process.env.DAEDALUS_SESSION_ID;
  const here = await real(options.directory ?? process.cwd());
  let best: AgentSession[] = [];
  let bestDepth = -1;
  for (const session of context.repositories.listAgents()) {
    if (session.archivedAt) continue;
    if (session.status !== "running" && session.status !== "starting") continue;
    const folder = await real(session.workingDirectory);
    if (!contains(folder, here)) continue;
    const depth = folder.split(sep).length;
    if (depth > bestDepth) {
      best = [session];
      bestDepth = depth;
    } else if (depth === bestDepth) best.push(session);
  }
  if (best.length === 1) return best[0];
  if (best.length > 1) {
    const named = best.find((session) => session.id === environmentId);
    if (named) return named;
    throw new DaedalusError(
      "CONFLICT",
      `${best.length} running sessions work in ${here} (${best
        .map((session) => `${session.name} ${session.id.slice(0, 8)}`)
        .join(", ")}); pass --session <id>`,
    );
  }
  if (!environmentId) return undefined;
  return context.repositories.findAgent(environmentId) ?? undefined;
}

const real = (path: string) => realpath(path).catch(() => resolve(path));

function contains(folder: string, path: string): boolean {
  const between = relative(folder, path);
  return (
    between === "" ||
    (!between.startsWith(`..${sep}`) &&
      between !== ".." &&
      !between.startsWith(sep))
  );
}

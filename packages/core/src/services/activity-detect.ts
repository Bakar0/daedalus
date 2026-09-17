import type { DaedalusConfig } from "../config";
import type { AgentSession } from "../domain";
import type { SqliteRepositories } from "../repositories";
import type { ActivityService } from "./activity";
import { recoverCodexSessionId } from "./agents";
import { observeCodexRollout, type ActivityObservation } from "./hook-events";
import { codexRolloutPath } from "./telemetry";

/**
 * The polled floor under the hook tiers.
 *
 * Hooks push; this pulls, and it only exists because a Codex build older than
 * 0.145 ignores hooks entirely and a newer one will not run them until the
 * user has trusted them. Everything it reads is the same rollout JSONL that
 * `readCodexSession` already tails for token counts, so no second reader is
 * opened and no second file is watched.
 *
 * Its readings are `source: "transcript"`, which is what stops them fighting
 * the hooks: `ActivityService` refuses a lower-confidence write over a fresh
 * higher-confidence one, so on a machine where both tiers work the rollout
 * never overwrites a hook fact.
 */
const CACHE_MS = 5_000;

interface CacheEntry {
  checkedAt: number;
  lastModified: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Reads the tail of a Codex rollout and turns it into an observation, or
 * nothing at all when the file has not changed since the last look. Gating on
 * mtime is what makes this safe to call on the desktop's 1.2 second tick.
 */
export async function detectCodexRolloutActivity(
  config: DaedalusConfig,
  agent: AgentSession,
  repositories?: SqliteRepositories,
): Promise<ActivityObservation | undefined> {
  const now = Date.now();
  const cached = cache.get(agent.id);
  if (cached && now - cached.checkedAt < CACHE_MS) return undefined;
  // Codex's own session id is recovered at spawn, but a session that was still
  // sitting on a startup prompt had not written a rollout yet and keeps a null
  // locator forever. Recovering it here makes the fallback self-healing rather
  // than dependent on the timing of one lookup — and repairs token telemetry
  // for the same sessions, which reads the same locator.
  let subject = agent;
  if (!subject.providerSessionId && repositories) {
    const recovered = await recoverCodexSessionId({
      sessionsDirectory: config.codexSessionsDirectory,
      workingDirectory: agent.workingDirectory,
      startedAt: agent.startedAt,
      claimedIds: repositories
        .listAgents()
        .flatMap((item) =>
          item.providerSessionId ? [item.providerSessionId] : [],
        ),
      // Anything written since this session started, in a directory only this
      // session owns, is this session's.
      windowMs: Math.max(60_000, now - Date.parse(agent.startedAt) + 60_000),
    });
    if (recovered) {
      subject = { ...agent, providerSessionId: recovered };
      repositories.updateAgent(subject);
    }
  }
  const path = await codexRolloutPath(config.codexSessionsDirectory, subject);
  if (!path) return undefined;
  try {
    const file = Bun.file(path);
    const lastModified = file.lastModified;
    cache.set(agent.id, { checkedAt: now, lastModified });
    if (cached && cached.lastModified === lastModified) return undefined;
    const text = await file.slice(Math.max(0, file.size - 256 * 1024)).text();
    return observeCodexRollout(text);
  } catch {
    return undefined;
  }
}

/**
 * One pass over every live session that has a polled detector. Providers with
 * working hooks report without being asked, so there is deliberately nothing
 * here for Claude and nothing for `custom` — a custom session has no
 * structured signal at all and reports `unknown` rather than a fabrication.
 */
export async function sweepProviderActivity(input: {
  config: DaedalusConfig;
  repositories: SqliteRepositories;
  activity: ActivityService;
}): Promise<number> {
  const live = input.repositories
    .listAgents()
    .filter(
      (agent) =>
        agent.kind === "agent" &&
        agent.provider === "codex" &&
        (agent.status === "running" || agent.status === "starting"),
    );
  let applied = 0;
  await Promise.all(
    live.map(async (agent) => {
      const observation = await detectCodexRolloutActivity(
        input.config,
        agent,
        input.repositories,
      );
      if (!observation) return;
      const outcome = await input.activity
        .observe({ sessionId: agent.id, observation })
        .catch(() => undefined);
      if (outcome?.applied) applied += 1;
    }),
  );
  return applied;
}

/** Test seam; the cache is process-local and otherwise never cleared. */
export const resetRolloutCache = (): void => cache.clear();

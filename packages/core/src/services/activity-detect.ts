import type { DaedalusConfig } from "../config";
import type { AgentSession } from "../domain";
import type { TmuxClient } from "@daedalus/platform";
import type { SqliteRepositories } from "../repositories";
import type { ActivityService } from "./activity";
import { recoverCodexSessionId } from "./agents";
import {
  observeClaudePane,
  observeClaudeTranscript,
  observeCodexRollout,
  type ActivityObservation,
} from "./hook-events";
import { claudeTranscriptPath, codexRolloutPath } from "./telemetry";

/**
 * The polled floor under the hook tiers.
 *
 * Hooks push; this pulls, and each provider needs it for a different reason.
 * For Codex it is a floor: a build older than 0.145 ignores hooks entirely and
 * a newer one will not run them until the user has trusted them. For Claude,
 * whose hooks are installed at launch and always run, it covers the one gap
 * hooks cannot — neither `Stop` nor anything else fires for a turn the user
 * ended with escape, so an interrupted session sits on `working` until the
 * ten-minute decay. Both read the same JSONL the telemetry reader already
 * tails for token counts, so no second reader is opened and no second file is
 * watched.
 *
 * Their readings are `source: "transcript"`, which is what stops them fighting
 * the hooks: `ActivityService` refuses a lower-confidence write over a fresh
 * higher-confidence one, so on a machine where both tiers work the transcript
 * never overwrites a hook fact. The interrupt is the deliberate exception,
 * because it is the fact and no hook is coming.
 */
const CACHE_MS = 5_000;

interface CacheEntry {
  checkedAt: number;
  lastModified: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * The mtime gate shared by both detectors, and what makes them safe to call on
 * the desktop's 1.2 second tick: an unchanged file is never read, and a file
 * checked moments ago is not even stat'd.
 */
async function readChangedTail(
  key: string,
  path: string,
  bytes: number,
): Promise<string | undefined> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.checkedAt < CACHE_MS) return undefined;
  try {
    const file = Bun.file(path);
    const lastModified = file.lastModified;
    cache.set(key, { checkedAt: now, lastModified });
    if (cached && cached.lastModified === lastModified) return undefined;
    return await file.slice(Math.max(0, file.size - bytes)).text();
  } catch {
    return undefined;
  }
}

/**
 * The Claude tail, and the reason it is not the rollout's 256 KiB.
 *
 * Claude writes bookkeeping between conversation entries — file-history
 * snapshots most of all, which carry file contents — and those land *after*
 * an interrupt marker. Across the transcripts on hand the widest gap from an
 * interrupt to the next conversation entry was 282 KiB, so a smaller window
 * would sometimes hold nothing but bookkeeping and miss the one event this
 * reads for. The cost of the margin is bounded: the read is gated on mtime
 * and happens at most once every five seconds per session.
 */
const CLAUDE_TAIL_BYTES = 1024 * 1024;

/**
 * Reads the tail of a Claude transcript for an interrupted turn. Claude's
 * session id is Daedalus's own — it is handed over with `--session-id` at
 * launch — so unlike Codex there is nothing to recover and nothing to search.
 */
export async function detectClaudeTranscriptActivity(
  config: DaedalusConfig,
  agent: AgentSession,
): Promise<ActivityObservation | undefined> {
  const text = await readChangedTail(
    agent.id,
    claudeTranscriptPath(config.claudeProjectsDirectory, agent),
    CLAUDE_TAIL_BYTES,
  );
  return text === undefined ? undefined : observeClaudeTranscript(text);
}

/**
 * The pane has no mtime to gate on, so it gets a plain throttle. It is also
 * only ever consulted for a session already reading `working`, which is the
 * only state it is allowed to change — so on a quiet board it costs nothing.
 */
const paneChecked = new Map<string, number>();

/**
 * Captures a Claude session's pane and reads its status line.
 *
 * This is the tier that catches an escape so early that Claude wrote nothing
 * anywhere — no hook, and a transcript holding only the prompt. A capture
 * failure is not evidence of anything, so it reports nothing at all.
 */
export async function detectClaudePaneActivity(
  tmux: TmuxClient,
  agent: AgentSession,
): Promise<ActivityObservation | undefined> {
  const now = Date.now();
  const checked = paneChecked.get(agent.id);
  if (checked !== undefined && now - checked < CACHE_MS) return undefined;
  paneChecked.set(agent.id, now);
  try {
    return observeClaudePane(await tmux.capture(agent.tmuxSession));
  } catch {
    return undefined;
  }
}

/**
 * Reads the tail of a Codex rollout and turns it into an observation, or
 * nothing at all when the file has not changed since the last look.
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
  const text = await readChangedTail(agent.id, path, 256 * 1024);
  return text === undefined ? undefined : observeCodexRollout(text);
}

/**
 * One pass over every live session that has a polled detector. There is
 * deliberately nothing here for `custom` — a custom session has no structured
 * signal at all and reports `unknown` rather than a fabrication.
 */
export async function sweepProviderActivity(input: {
  config: DaedalusConfig;
  repositories: SqliteRepositories;
  activity: ActivityService;
  /** Omitted by callers with no terminal to read; the pane tier is then off. */
  tmux?: TmuxClient;
}): Promise<number> {
  const live = input.repositories
    .listAgents()
    .filter(
      (agent) =>
        agent.kind === "agent" &&
        (agent.provider === "codex" || agent.provider === "claude") &&
        (agent.status === "running" || agent.status === "starting"),
    );
  let applied = 0;
  await Promise.all(
    live.map(async (agent) => {
      let observation =
        agent.provider === "claude"
          ? await detectClaudeTranscriptActivity(input.config, agent)
          : await detectCodexRolloutActivity(
              input.config,
              agent,
              input.repositories,
            );
      // The pane is asked only when the cheaper tiers had nothing and the
      // session is still reading `working` — the one state it may retract,
      // and the one an instant escape leaves behind.
      if (
        !observation &&
        input.tmux &&
        agent.provider === "claude" &&
        input.activity.get(agent.id)?.activity === "working"
      )
        observation = await detectClaudePaneActivity(input.tmux, agent);
      if (!observation) return;
      const outcome = await input.activity
        .observe({ sessionId: agent.id, observation })
        .catch(() => undefined);
      if (outcome?.applied) applied += 1;
    }),
  );
  return applied;
}

/** Test seam; the caches are process-local and otherwise never cleared. */
export const resetRolloutCache = (): void => {
  cache.clear();
  paneChecked.clear();
};

import { writeFileAtomic } from "@daedalus/platform";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  admitsActivityWrite,
  heartbeatDue,
  nextToolUseId,
  type ActivityOutcome,
} from "./activity";
import {
  deleteActivityRecord,
  readActivityRecord,
  writeActivityRecord,
  type StoredActivityRecord,
} from "./activity-store";
import type { ApplicationContext } from "./context";
import { recordSessionCost } from "./cost-ledger";
import {
  codexHookInSession,
  observeClaudeHook,
  observeCodexHook,
  pendingBackgroundAgents,
  type ActivityObservation,
} from "./hook-events";

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A hook payload larger than this is ignored rather than parsed. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * How much of a Claude transcript is read for background agents. A launch
 * further back than this is missed and the turn reads as an ordinary one,
 * which is the behaviour from before this was read at all.
 */
const CLAUDE_BACKGROUND_TAIL_BYTES = 4 * 1024 * 1024;

export interface HookIngestInput {
  /** `DAEDALUS_HOME`, where the durable activity record lives. */
  home: string | undefined;
  /** The Daedalus session the hook reports for. */
  sessionId: string | undefined;
  /** The provider's hook name, such as `Stop` or `PreToolUse`. */
  event: string;
  /** Reads the hook's stdin; called only once the session checks out. */
  readPayload: () => Promise<string>;
  /** `DAEDALUS_SESSION_DIRECTORY`, which tells a Codex hook it is ours. */
  sessionDirectory?: string | undefined;
  /** Opens the control plane. Called at most once, and only when needed. */
  openContext: () => Promise<ApplicationContext>;
}

/**
 * The sink every provider activity hook feeds, as `daedal agent event <Event>`.
 *
 * Three rules shape all of it. It must never block or slow a turn, so it reads
 * a bounded payload and never throws. It must work when the Daedalus app is
 * not running and the database is unavailable, so the durable record under
 * `<home>/activity` is written before the database is touched at all. And it
 * must never surface a failure inside the agent's session, so every error is
 * swallowed: a broken control plane is Daedalus's problem, not something to
 * interrupt the user's work with.
 *
 * The record follows the same rank and guard rule as the index, so a write
 * the index would reject never reaches the record `restore()` replays.
 */
export async function ingestHook(input: HookIngestInput): Promise<void> {
  let opened: Promise<ApplicationContext> | undefined;
  let failedOpens = 0;
  // The first failed open is forgotten, so a database that was busy for the
  // routines check is tried once more for the reading and the flush. A second
  // failure sticks: each attempt can wait out the busy timeout, and a turn
  // must not wait for three.
  const context = () =>
    (opened ??= Promise.resolve()
      .then(input.openContext)
      .catch((error: unknown) => {
        failedOpens += 1;
        if (failedOpens === 1) opened = undefined;
        throw error;
      }));
  try {
    const hook = await readHookInput(input);
    if (!hook) return;
    const { home, sessionId } = hook;
    const payload = parsePayload(hook.text);
    if (!payload) return;
    const provider =
      // Only Codex payloads carry a turn or thread id. Anything else is read
      // as Claude, and an event Claude does not know falls back to Codex.
      typeof payload.turn_id === "string" ||
      typeof payload.thread_id === "string"
        ? "codex"
        : "claude";
    if (
      provider === "codex" &&
      !(await codexHookIsOwn(payload.cwd, input.sessionDirectory))
    )
      return;
    // A session with routines sits at its prompt after every run, so its
    // turns end `idle` rather than `done`. Only `Stop` depends on it, and
    // only `Stop` pays for the database read.
    const routines =
      input.event === "Stop" &&
      (await context()
        .then((opened) => Boolean(opened.abilities.held(sessionId, "routines")))
        .catch(() => false));
    const observation =
      provider === "codex"
        ? observeCodexHook(input.event, payload, { routines })
        : (observeClaudeHook(input.event, payload, {
            backgroundAgents: await claudeBackgroundAgents(
              input.event,
              payload,
            ),
            routines,
          }) ?? observeCodexHook(input.event, payload, { routines }));
    if (!observation) return;
    const providerSessionId =
      typeof payload.session_id === "string" ? payload.session_id : undefined;
    await applyObservation({
      home,
      sessionId,
      observation,
      context,
      ...(providerSessionId ? { providerSessionId } : {}),
    });
    if (input.event === "SessionStart" || input.event === "Stop")
      // Team messages that could not reach the session before: it was not
      // running yet, or a send failed. Retried on the next post, chat or turn.
      await context()
        .then((opened) => opened.teams.flushSession(sessionId))
        .catch(() => undefined);
  } catch {
    // An activity hook must never interfere with the provider session.
  } finally {
    await opened?.then((opened) => opened.close()).catch(() => undefined);
  }
}

/**
 * The checks both sinks make before they read anything: a valid session id
 * and a home, then a bounded, non-empty payload. stdin is read only once the
 * session checks out.
 */
async function readHookInput(input: {
  home: string | undefined;
  sessionId: string | undefined;
  readPayload: () => Promise<string>;
}): Promise<{ home: string; sessionId: string; text: string } | undefined> {
  const { home, sessionId } = input;
  if (!sessionId || !SESSION_ID.test(sessionId) || !home) return undefined;
  const text = await input.readPayload();
  if (!text.trim() || text.length > MAX_PAYLOAD_BYTES) return undefined;
  return { home, sessionId, text };
}

function parsePayload(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** `codexHookInSession` for this hook, with both paths resolved. */
async function codexHookIsOwn(
  cwd: unknown,
  sessionDirectory: string | undefined,
): Promise<boolean> {
  const resolved = (path: unknown) =>
    typeof path === "string" && path
      ? realpath(path).catch(() => resolve(path))
      : undefined;
  return codexHookInSession(
    await resolved(cwd),
    await resolved(sessionDirectory),
  );
}

/**
 * Background agents the Claude conversation is still waiting on, read only for
 * `Stop`, the one event whose meaning depends on it. Every other hook fires
 * mid-turn, many times a minute, and must not pay for a transcript read.
 */
async function claudeBackgroundAgents(
  event: string,
  payload: Record<string, unknown>,
): Promise<number> {
  if (event !== "Stop") return 0;
  const path = payload.transcript_path;
  if (typeof path !== "string" || !path) return 0;
  try {
    const file = Bun.file(path);
    const text = await file
      .slice(Math.max(0, file.size - CLAUDE_BACKGROUND_TAIL_BYTES))
      .text();
    return pendingBackgroundAgents(text);
  } catch {
    return 0;
  }
}

/**
 * Writes the durable record first, then applies the observation to the index.
 *
 * The order is the whole point. The record is what makes a hook succeed while
 * the control plane is unavailable, and `ActivityService.restore()` replays it
 * on the next startup, so an app that is down during a turn loses the badge
 * for the duration, never the turn.
 *
 * That replay is also why the record takes the index's rule. The record is
 * written only when the rule admits the observation over the record already
 * there, and when the index then rejects it anyway (the two disagreed, after
 * a hook ran with the database down) the write is undone. The undo happens
 * only while the record is still the one this hook wrote, so it does not put
 * an old reading over a newer one a concurrent hook wrote earlier. A write
 * that lands between the re-read and the undo can still be lost; the next
 * hook writes the record again.
 */
async function applyObservation(input: {
  home: string;
  sessionId: string;
  observation: ActivityObservation;
  providerSessionId?: string;
  context: () => Promise<ApplicationContext>;
}): Promise<void> {
  const { home, sessionId, observation } = input;
  const binding = input.providerSessionId
    ? { providerSessionId: input.providerSessionId }
    : {};
  const prior = await readActivityRecord(home, sessionId).catch(
    () => undefined,
  );
  let written: StoredActivityRecord | undefined;
  if (observation.heartbeat) {
    // Subagents fire many hooks a minute. The record file answers "is there
    // anything to refresh?" without opening the database, and a heartbeat
    // must never write the record itself: it carries no reading of its own.
    if (!prior || !heartbeatDue(prior, observation.ifActivity, Date.now()))
      return;
  } else if (
    !observation.clear &&
    admitsActivityWrite(prior, observation, Date.now())
  ) {
    const now = new Date().toISOString();
    const detail = observation.detail ?? null;
    const toolUseId = nextToolUseId(prior, { ...observation, detail });
    const record: StoredActivityRecord = {
      sessionId,
      activity: observation.activity,
      detail,
      since: now,
      observedAt: now,
      source: observation.source,
      ...binding,
      ...(toolUseId ? { toolUseId } : {}),
    };
    written = await writeActivityRecord(home, record).then(
      () => record,
      () => undefined,
    );
  }
  let outcome: ActivityOutcome | undefined;
  try {
    const context = await input.context();
    outcome = await context.activity.observe({
      sessionId,
      observation,
      ...binding,
    });
  } catch {
    // The record on disk is already correct; the index catches up on restart.
    return;
  }
  if (!written || !outcome || outcome.applied) return;
  const current = await readActivityRecord(home, sessionId).catch(
    () => undefined,
  );
  if (!current || !sameRecord(current, written)) return;
  await (
    prior
      ? writeActivityRecord(home, prior)
      : deleteActivityRecord(home, sessionId)
  ).catch(() => undefined);
}

const sameRecord = (left: StoredActivityRecord, right: StoredActivityRecord) =>
  left.observedAt === right.observedAt &&
  left.activity === right.activity &&
  left.source === right.source &&
  left.detail === right.detail;

/**
 * The sink for Claude's status line, as `daedal agent telemetry`. It writes
 * the latest model, context and rate-limit reading for the telemetry service
 * to read, and books the session's cost by day so the spend outlives the
 * session. Like `ingestHook` it never throws.
 */
export async function ingestStatusLine(input: {
  home: string | undefined;
  sessionId: string | undefined;
  /** Reads the status line's stdin; called only once the session checks out. */
  readPayload: () => Promise<string>;
}): Promise<void> {
  try {
    const hook = await readHookInput(input);
    if (!hook) return;
    const { home, sessionId } = hook;
    const payload = JSON.parse(hook.text) as {
      model?: unknown;
      context_window?: unknown;
      rate_limits?: unknown;
      cost?: { total_cost_usd?: unknown };
    };
    const costUsd = payload.cost?.total_cost_usd;
    await writeFileAtomic(
      join(home, "telemetry", `${sessionId}.json`),
      JSON.stringify({
        observedAt: new Date().toISOString(),
        model: payload.model,
        context_window: payload.context_window,
        rate_limits: payload.rate_limits,
        ...(typeof costUsd === "number"
          ? { cost: { total_cost_usd: costUsd } }
          : {}),
      }),
      { mode: 0o600, ensureDir: true },
    );
    if (typeof costUsd === "number")
      await recordSessionCost(home, sessionId, costUsd);
  } catch {
    // A status-line hook must never interfere with the provider session.
  }
}

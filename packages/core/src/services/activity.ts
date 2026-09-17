import {
  isAttentionActivity,
  type AgentActivity,
  type AgentActivitySource,
  type AgentActivityState,
  type AgentSession,
  type AttentionReason,
  type SessionAttention,
  type StoredAgentActivity,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import {
  deleteActivityRecord,
  listActivityRecords,
  readActivityRecord,
  writeActivityRecord,
  type StoredActivityRecord,
} from "./activity-store";
import type { ActivityObservation } from "./hook-events";
import type {
  NotificationDecision,
  NotificationService,
} from "./notifications";

/**
 * The badge answers "is this session blocked, and why?", never "how many
 * events happened?". Five is dev-3.0's cap and it is the right shape: enough
 * context to understand a tangled block, few enough to read at a glance.
 */
export const MAX_ATTENTION_REASONS = 5;

/** A reason longer than this is truncated; badges are read, not studied. */
export const MAX_REASON_LENGTH = 200;

/**
 * A turn that bounces working -> needs_permission -> working three times is one
 * alert. Inside this window a repeat of the same activity updates the badge
 * and stays quiet.
 */
export const NOTIFICATION_DEBOUNCE_MS = 45_000;

/**
 * How long a `working` reading stays credible without a fresh observation.
 * A crashed session whose last hook was PreToolUse would otherwise pin at
 * "working" forever, and a status display that lies is worse than none.
 *
 * The asymmetry is deliberate: `idle`, `needs_input` and `needs_permission`
 * never decay. Waiting on a human for an hour is a real state, not a stale
 * one, and it is exactly the state the badge exists to surface.
 */
export const ACTIVITY_STALE_AFTER_MS = 10 * 60_000;

const DECAYS: readonly AgentActivity[] = ["working"];

export interface RecordActivityInput {
  sessionId: string;
  activity: AgentActivity;
  detail?: string | null;
  source: AgentActivitySource;
  /** Overrides the generated alert text; used by `daedal attention`. */
  reason?: string;
  /** Apply only when the stored activity is one of these. */
  ifActivity?: readonly AgentActivity[];
  /** Skip when the stored activity is one of these. */
  ifNotActivity?: readonly AgentActivity[];
  /** The provider's own session id, when the detector knows it. */
  providerSessionId?: string;
}

export interface ActivityOutcome {
  state: AgentActivityState;
  /** False when a guard rejected the write; the state returned is the old one. */
  applied: boolean;
  attention?: SessionAttention;
  notification?: NotificationDecision;
  /** True when this call changed the activity rather than merely refreshing it. */
  transitioned: boolean;
}

export interface AttentionOutcome {
  attention?: SessionAttention;
  notification?: NotificationDecision;
}

const truncate = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;

const publicState = (stored: StoredAgentActivity): AgentActivityState => ({
  sessionId: stored.sessionId,
  activity: stored.activity,
  detail: stored.detail,
  since: stored.since,
  observedAt: stored.observedAt,
  source: stored.source,
});

/**
 * Applies one raise to a reason list. Identical text collapses onto the
 * existing entry and is promoted to newest rather than piling up, and the cap
 * evicts the *oldest* so the freshest context always survives.
 *
 * An inferred reason additionally evicts the previous inferred one. One block
 * is seen by several hooks — Claude reports a wait through `PermissionRequest`
 * and again through the `Notification` that raises the dialog — and each is a
 * description of the same thing, not a second thing to do. Without this the
 * badge counts events rather than reasons, which is the one shape it is never
 * supposed to take. What the agent wrote itself still accumulates: those are
 * genuinely separate statements.
 */
export function accumulateReasons(
  reasons: readonly AttentionReason[],
  incoming: AttentionReason,
  limit = MAX_ATTENTION_REASONS,
): AttentionReason[] {
  const kept = reasons.filter(
    (reason) =>
      reason.text !== incoming.text &&
      !(incoming.generated && reason.generated),
  );
  return [...kept, incoming].slice(-limit);
}

const ACTIVITY_HEADLINE: Record<AgentActivity, string | null> = {
  unknown: null,
  working: null,
  idle: null,
  needs_permission: "needs permission",
  needs_input: "is asking a question",
  done: "finished",
  error: "hit an error",
};

/**
 * Owns what an agent is doing and whether it is blocked on the user. Detection
 * lives elsewhere — provider hooks, transcripts, pane readings, or the agent
 * itself through `daedal attention` — and every detector funnels into
 * `record`, so the badge rules and the alert rules are written once.
 */
export class ActivityService {
  private readonly home: string;
  private readonly now: () => Date;

  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly notifications: NotificationService,
    options: {
      /** Where the durable per-session records live. */
      home: string;
      /** Injected so staleness decay is testable without waiting ten minutes. */
      now?: () => Date;
    },
  ) {
    this.home = options.home;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Whether an observation from `source` may overwrite what `stored` says.
   *
   * Provider fidelity is wildly asymmetric, so the source is not decoration:
   * a pane guess must never be able to overwrite a hook fact, or the display
   * quietly degrades to the confidence of its worst detector. A stale reading
   * is fair game for anyone, because by then nobody is claiming it is true.
   */
  private outranked(
    stored: StoredAgentActivity | undefined,
    source: AgentActivitySource,
    at: number,
  ): boolean {
    if (!stored) return false;
    const rank = (value: AgentActivitySource) =>
      value === "pane" ? 1 : value === "transcript" ? 2 : 3;
    if (rank(source) >= rank(stored.source)) return false;
    return at - Date.parse(stored.observedAt) < ACTIVITY_STALE_AFTER_MS;
  }

  /**
   * The guarded compare-and-set from dev-3.0, and the reason there is no turn
   * id anywhere in this file. Hooks fire concurrently and arrive out of order,
   * and what actually needs protecting is not "is this the same turn" but "is
   * the state I am about to overwrite more meaningful than the one I carry".
   * Comparing against the current state answers that directly.
   */
  private guarded(
    stored: StoredAgentActivity | undefined,
    input: RecordActivityInput,
  ): boolean {
    const current = stored?.activity ?? "unknown";
    if (input.ifActivity && !input.ifActivity.includes(current)) return false;
    if (input.ifNotActivity?.includes(current)) return false;
    return true;
  }

  list(): AgentActivityState[] {
    return this.repositories.listAgentActivity().map(publicState);
  }

  get(sessionId: string): AgentActivityState | undefined {
    const stored = this.repositories.findAgentActivity(sessionId);
    return stored ? publicState(stored) : undefined;
  }

  listAttention(workspaceId?: string): SessionAttention[] {
    return this.repositories.listSessionAttention(workspaceId);
  }

  attentionFor(sessionId: string): SessionAttention | undefined {
    return this.repositories.findSessionAttention(sessionId);
  }

  private session(sessionId: string): AgentSession {
    const session = this.repositories.findAgent(sessionId);
    if (!session)
      throw new DaedalusError("NOT_FOUND", `Session ${sessionId} not found`);
    return session;
  }

  /** "deadalus · Claude · #11" — enough to act on without opening anything. */
  private alertTitle(session: AgentSession): string {
    const workspace = this.repositories.findWorkspace(session.workspaceId);
    const task = session.taskId
      ? this.repositories.findTask(session.taskId)
      : undefined;
    return [
      workspace?.name ?? "Daedalus",
      session.name || session.provider,
      task ? `#${task.number}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  private alertSubtitle(session: AgentSession): string | undefined {
    const task = session.taskId
      ? this.repositories.findTask(session.taskId)
      : undefined;
    return task?.title;
  }

  /**
   * Records an observation. The activity's `since` only moves when the
   * activity itself changes, so "waiting 4m" measures the block rather than
   * the polling interval.
   */
  async record(input: RecordActivityInput): Promise<ActivityOutcome> {
    const session = this.session(input.sessionId);
    const previous = this.repositories.findAgentActivity(input.sessionId);
    const at = this.now();
    if (
      !this.guarded(previous, input) ||
      this.outranked(previous, input.source, at.getTime())
    )
      return {
        state: previous
          ? publicState(previous)
          : {
              sessionId: input.sessionId,
              activity: "unknown",
              detail: null,
              since: at.toISOString(),
              observedAt: at.toISOString(),
              source: input.source,
            },
        applied: false,
        transitioned: false,
      };
    const now = at.toISOString();
    const transitioned = previous?.activity !== input.activity;
    const detail = input.detail
      ? truncate(input.detail, MAX_REASON_LENGTH)
      : null;
    const stored: StoredAgentActivity = {
      sessionId: input.sessionId,
      activity: input.activity,
      detail,
      since: transitioned ? now : (previous?.since ?? now),
      observedAt: now,
      source: input.source,
      notifiedActivity: previous?.notifiedActivity ?? null,
      notifiedAt: previous?.notifiedAt ?? null,
    };

    let attention = this.repositories.findSessionAttention(input.sessionId);
    if (isAttentionActivity(input.activity)) {
      // An explicit reason always lands on the badge, transition or not: that
      // is what makes repeated raises accumulate context instead of alerts.
      if (input.reason !== undefined)
        attention = this.raiseReason(session, input.reason, input.source, now);
      else if (transitioned || !attention)
        attention = this.raiseReason(
          session,
          this.reasonText(session, input.activity, detail),
          input.source,
          now,
          true,
        );
    } else if (attention && this.canAutoClear(attention, input.source)) {
      // A badge that outlives its cause trains people to ignore badges, so the
      // clear happens on the transition out — not on the user finally looking.
      this.clearAttentionRecords(input.sessionId);
      attention = undefined;
    }

    const notification = transitioned
      ? // An agent that wrote its own reason gets to say it in its own words;
        // wrapping it in a generated headline only adds noise.
        await this.alert(session, stored, input.reason ?? detail, input.reason)
      : undefined;
    this.repositories.saveAgentActivity(stored);
    const state = publicState(stored);
    // The durable record is written last and never allowed to fail the call:
    // the index is already correct, and a lost mirror costs a restart replay,
    // not a wrong badge.
    await writeActivityRecord(this.home, {
      ...state,
      ...(input.providerSessionId
        ? { providerSessionId: input.providerSessionId }
        : {}),
    }).catch(() => undefined);
    return {
      state,
      applied: true,
      ...(attention ? { attention } : {}),
      ...(notification ? { notification } : {}),
      transitioned,
    };
  }

  /**
   * The single entry point for every provider detector. Hook sinks and the
   * rollout tail both produce an `ActivityObservation` and hand it here, so
   * the guard rules live with the observation that declares them and the badge
   * rules stay in one place.
   */
  async observe(input: {
    sessionId: string;
    observation: ActivityObservation;
    providerSessionId?: string;
  }): Promise<ActivityOutcome | undefined> {
    const { observation } = input;
    if (observation.clear) {
      this.forget(input.sessionId);
      return undefined;
    }
    return this.record({
      sessionId: input.sessionId,
      activity: observation.activity,
      detail: observation.detail ?? null,
      source: observation.source,
      ...(observation.ifActivity ? { ifActivity: observation.ifActivity } : {}),
      ...(observation.ifNotActivity
        ? { ifNotActivity: observation.ifNotActivity }
        : {}),
      ...(input.providerSessionId
        ? { providerSessionId: input.providerSessionId }
        : {}),
    });
  }

  /**
   * Silence is not evidence of work. A `working` reading with a stale
   * `observedAt` decays to `unknown` rather than being believed forever —
   * the kill -9 case, where the last thing anyone saw was a PreToolUse.
   */
  async decay(): Promise<AgentActivityState[]> {
    const cutoff = this.now().getTime() - ACTIVITY_STALE_AFTER_MS;
    const decayed: AgentActivityState[] = [];
    for (const stored of this.repositories.listAgentActivity()) {
      if (!DECAYS.includes(stored.activity)) continue;
      if (Date.parse(stored.observedAt) > cutoff) continue;
      const now = this.now().toISOString();
      const next: StoredAgentActivity = {
        ...stored,
        activity: "unknown",
        detail: null,
        since: now,
        observedAt: now,
      };
      this.repositories.saveAgentActivity(next);
      const state = publicState(next);
      await writeActivityRecord(this.home, state).catch(() => undefined);
      decayed.push(state);
    }
    return decayed;
  }

  /**
   * Startup rebuilds activity from the durable records rather than from
   * defaults, so restarting the app with a session mid-turn does not report it
   * as `unknown` until the next hook happens to fire.
   *
   * Lifecycle still dominates: a record belonging to a session that is no
   * longer live is deleted, never restored. "Working" is the single most
   * damaging thing to show for a session that is already gone.
   */
  async restore(): Promise<number> {
    const sessions = new Map(
      this.repositories.listAgents().map((agent) => [agent.id, agent]),
    );
    let restored = 0;
    for (const record of await listActivityRecords(this.home)) {
      const session = sessions.get(record.sessionId);
      if (
        !session ||
        (session.status !== "running" && session.status !== "starting")
      ) {
        await deleteActivityRecord(this.home, record.sessionId).catch(
          () => undefined,
        );
        continue;
      }
      const stored = this.repositories.findAgentActivity(record.sessionId);
      // A record older than the index is a leftover from a write the index
      // already has; replaying it would move `since` backwards.
      if (
        stored &&
        Date.parse(stored.observedAt) >= Date.parse(record.observedAt)
      )
        continue;
      this.repositories.saveAgentActivity({
        sessionId: record.sessionId,
        activity: record.activity,
        detail: record.detail,
        since: record.since,
        observedAt: record.observedAt,
        source: record.source,
        // The debounce bookkeeping is carried over rather than reset, so a
        // replay cannot re-arm an alert that already fired.
        notifiedActivity: stored?.notifiedActivity ?? null,
        notifiedAt: stored?.notifiedAt ?? null,
      });
      // A blocked session has to come back blocked. Writing the index without
      // the badge would restore the state and lose the only part of it the
      // user was ever going to act on.
      if (
        isAttentionActivity(record.activity) &&
        !this.repositories.findSessionAttention(record.sessionId)
      )
        this.raiseReason(
          session,
          this.reasonText(session, record.activity, record.detail),
          record.source,
          record.observedAt,
          true,
        );
      restored += 1;
    }
    return restored;
  }

  /**
   * The durable record for a session, including the provider session id bound
   * to it. Detectors read this to tell the real conversation apart from the
   * short-lived internal agents that fire the same events beside it.
   */
  async binding(sessionId: string): Promise<StoredActivityRecord | undefined> {
    return readActivityRecord(this.home, sessionId);
  }

  /**
   * Low-confidence pane readings may raise a badge but never retract one: a
   * guess is not evidence that the user was answered, and silently dropping a
   * real block is the worse failure.
   */
  private canAutoClear(
    attention: SessionAttention,
    source: AgentActivitySource,
  ): boolean {
    if (source === "pane") return false;
    if (source === "agent" || source === "hook") return true;
    // A transcript reading is trustworthy about the agent's own output but
    // says nothing about whether the question the agent asked was answered.
    return attention.reasons.every((reason) => reason.source !== "agent");
  }

  private reasonText(
    session: AgentSession,
    activity: AgentActivity,
    detail: string | null,
  ): string {
    const provider =
      session.provider.slice(0, 1).toUpperCase() + session.provider.slice(1);
    const headline = ACTIVITY_HEADLINE[activity] ?? "needs you";
    if (!detail) return `${provider} ${headline}`;
    // Some details are already a whole sentence the provider wrote about
    // itself. Wrapping one produces "Claude needs permission: Claude needs your
    // permission to use …", which is the badge talking over itself.
    return detail.toLowerCase().startsWith(provider.toLowerCase())
      ? detail
      : `${provider} ${headline}: ${detail}`;
  }

  private raiseReason(
    session: AgentSession,
    text: string,
    source: AgentActivitySource,
    now: string,
    generated = false,
  ): SessionAttention {
    const existing = this.repositories.findSessionAttention(session.id);
    const reason: AttentionReason = {
      id: crypto.randomUUID(),
      text: truncate(text, MAX_REASON_LENGTH),
      raisedAt: now,
      source,
      ...(generated ? { generated: true } : {}),
    };
    const attention: SessionAttention = {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      reasons: accumulateReasons(existing?.reasons ?? [], reason),
      // The badge's own age is what "waiting 4m" reports, so a second reason
      // landing on an open badge must not reset the clock.
      raisedAt: existing?.raisedAt ?? now,
      updatedAt: now,
    };
    this.repositories.saveSessionAttention(attention);
    return attention;
  }

  /**
   * The agent reporting on itself. Inference can tell you a session is
   * blocked; only the agent can tell you why, and this is the only path that
   * works for `custom` sessions and providers with no hook support at all.
   */
  async raise(input: {
    sessionId: string;
    reason: string;
    source?: AgentActivitySource;
  }): Promise<AttentionOutcome> {
    const reason = input.reason.trim();
    if (!reason)
      throw new DaedalusError("VALIDATION", "An attention reason is required");
    const outcome = await this.record({
      sessionId: input.sessionId,
      activity: "needs_input",
      detail: reason,
      source: input.source ?? "agent",
      reason,
    });
    return {
      ...(outcome.attention ? { attention: outcome.attention } : {}),
      ...(outcome.notification ? { notification: outcome.notification } : {}),
    };
  }

  private clearAttentionRecords(sessionId: string): void {
    this.repositories.deleteSessionAttention(sessionId);
    // Badge alerts queue while the app is down. Without this purge a cleared
    // badge resurrects the moment that queue flushes.
    this.notifications.purge(sessionId);
  }

  /**
   * All-or-nothing, and privileged: it is never queued and never silenced.
   * Suppressing an alert is a preference; suppressing the retraction of an
   * alert is a bug.
   */
  clear(sessionId: string): { cleared: number } {
    const existing = this.repositories.findSessionAttention(sessionId);
    this.clearAttentionRecords(sessionId);
    const stored = this.repositories.findAgentActivity(sessionId);
    // The block is over, but nothing here knows what the session moved on to.
    // `unknown` says that honestly; a detector will overwrite it shortly.
    if (stored && isAttentionActivity(stored.activity)) {
      const now = this.now().toISOString();
      const next: StoredAgentActivity = {
        ...stored,
        activity: "unknown",
        detail: null,
        since: now,
        observedAt: now,
      };
      this.repositories.saveAgentActivity(next);
      void writeActivityRecord(this.home, publicState(next)).catch(
        () => undefined,
      );
    }
    return { cleared: existing?.reasons.length ?? 0 };
  }

  /** Drops every trace of a session, for archive and removal. */
  forget(sessionId: string): void {
    this.repositories.deleteAgentActivity(sessionId);
    this.repositories.deleteSessionAttention(sessionId);
    this.notifications.purge(sessionId);
    // Fire-and-forget: the index is already clean, and a leftover file is
    // discarded by the next `restore` anyway.
    void deleteActivityRecord(this.home, sessionId).catch(() => undefined);
  }

  private async alert(
    session: AgentSession,
    stored: StoredAgentActivity,
    detail: string | null,
    reason?: string,
  ): Promise<NotificationDecision | undefined> {
    const headline = ACTIVITY_HEADLINE[stored.activity];
    if (!headline) return undefined;
    const debounced =
      stored.notifiedActivity === stored.activity &&
      stored.notifiedAt !== null &&
      Date.now() - Date.parse(stored.notifiedAt) < NOTIFICATION_DEBOUNCE_MS;
    if (debounced) return undefined;
    stored.notifiedActivity = stored.activity;
    stored.notifiedAt = stored.observedAt;
    const subtitle = this.alertSubtitle(session);
    return this.notifications.notify({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      level:
        stored.activity === "error"
          ? "error"
          : stored.activity === "done"
            ? "success"
            : "info",
      title: this.alertTitle(session),
      ...(subtitle ? { subtitle } : {}),
      body: reason ?? this.reasonText(session, stored.activity, detail),
      blocking: isAttentionActivity(stored.activity),
    });
  }
}

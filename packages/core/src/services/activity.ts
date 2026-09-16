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

export interface RecordActivityInput {
  sessionId: string;
  activity: AgentActivity;
  detail?: string | null;
  source: AgentActivitySource;
  /** Overrides the generated alert text; used by `daedal attention`. */
  reason?: string;
}

export interface ActivityOutcome {
  state: AgentActivityState;
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
 */
export function accumulateReasons(
  reasons: readonly AttentionReason[],
  incoming: AttentionReason,
  limit = MAX_ATTENTION_REASONS,
): AttentionReason[] {
  const withoutDuplicate = reasons.filter(
    (reason) => reason.text !== incoming.text,
  );
  return [...withoutDuplicate, incoming].slice(-limit);
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
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly notifications: NotificationService,
  ) {}

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
    const now = new Date().toISOString();
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
    return {
      state: publicState(stored),
      ...(attention ? { attention } : {}),
      ...(notification ? { notification } : {}),
      transitioned,
    };
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
    return detail
      ? `${provider} ${headline}: ${detail}`
      : `${provider} ${headline}`;
  }

  private raiseReason(
    session: AgentSession,
    text: string,
    source: AgentActivitySource,
    now: string,
  ): SessionAttention {
    const existing = this.repositories.findSessionAttention(session.id);
    const reason: AttentionReason = {
      id: crypto.randomUUID(),
      text: truncate(text, MAX_REASON_LENGTH),
      raisedAt: now,
      source,
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
      const now = new Date().toISOString();
      this.repositories.saveAgentActivity({
        ...stored,
        activity: "unknown",
        detail: null,
        since: now,
        observedAt: now,
      });
    }
    return { cleared: existing?.reasons.length ?? 0 };
  }

  /** Drops every trace of a session, for archive and removal. */
  forget(sessionId: string): void {
    this.repositories.deleteAgentActivity(sessionId);
    this.repositories.deleteSessionAttention(sessionId);
    this.notifications.purge(sessionId);
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

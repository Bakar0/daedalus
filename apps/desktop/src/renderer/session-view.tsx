/**
 * The session indicator vocabulary, shared by the Sessions list and the board.
 *
 * It lives in its own module so both surfaces draw a session from one copy of
 * the precedence rules and one set of glyphs. Two copies would drift, and a
 * board that disagreed with the session list about whether an agent needs the
 * user would be worse than no board.
 */
import type {
  AgentActivity,
  AgentActivityDto,
  AgentSessionDto,
  AttentionReasonDto,
  SessionAttentionDto,
} from "@daedalus/protocol";

export const sessionName = (session: AgentSessionDto) =>
  session.name ||
  (session.kind === "terminal"
    ? "Terminal"
    : session.provider.slice(0, 1).toUpperCase() + session.provider.slice(1));

export const providerLabel = (provider: string) =>
  provider.slice(0, 1).toUpperCase() + provider.slice(1);

export const compactTokenLabel = (tokens: number) =>
  tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);

export const sessionConfiguredModel = (session?: AgentSessionDto) => {
  if (!session) return undefined;
  for (let index = session.args.length - 1; index >= 0; index -= 1) {
    const argument = session.args[index]!;
    if (argument.startsWith("--model=")) return argument.slice(8);
    if (argument === "--model") return session.args[index + 1];
  }
  return undefined;
};

export const sessionTool = (
  session: AgentSessionDto,
): "codex" | "claude" | "terminal" =>
  session.kind === "terminal" || session.provider === "custom"
    ? "terminal"
    : session.provider;

// Codex and Claude paths are bundled from @lobehub/icons-static-svg (MIT).
export function ToolIcon({ tool }: { tool: "codex" | "claude" | "terminal" }) {
  if (tool === "codex")
    return (
      <svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
        <path
          clipRule="evenodd"
          d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
          fillRule="evenodd"
        />
      </svg>
    );
  if (tool === "claude")
    return (
      <svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
        <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
      </svg>
    );
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <rect height="18" rx="2.5" width="20" x="2" y="3" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </svg>
  );
}

export function CreateButton({
  disabled,
  label,
  onClick,
}: {
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="create-button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <svg
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2"
        viewBox="0 0 16 16"
      >
        <path d="M8 3v10M3 8h10" />
      </svg>
      <span>New</span>
    </button>
  );
}

export function SessionLaunchIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 18 18"
    >
      <rect height="13" rx="2" width="16" x="1" y="2.5" />
      <path d="m5 7 2 2-2 2M9.5 11h3" />
    </svg>
  );
}

export const sessionIsLive = (session: AgentSessionDto) =>
  session.status === "running" || session.status === "starting";

/**
 * The visual tier a session sits in. `attention` is deliberately the only tier
 * that is loud: a grid where the one session blocked on you is instantly
 * obvious is the entire point, and everything else is ambient by comparison.
 */
export type SessionTone =
  "attention" | "working" | "idle" | "done" | "error" | "lost" | "ended";

export interface SessionStatusView {
  tone: SessionTone;
  /** Short label naming the activity, never the colour. */
  label: string;
  /** Secondary line: "Editing agents.ts", "Bash(git push)", the question. */
  detail: string | null;
  /** Start of the current state, for "waiting 4m". */
  since: string | null;
  /** True while the user is the thing standing in the way. */
  attention: boolean;
  /** Open reasons on the badge, newest last, capped at five upstream. */
  reasons: AttentionReasonDto[];
  /**
   * A pane-derived guess. Rendered muted and hedged, because presenting a
   * heuristic as a fact is how a status display loses its credibility.
   */
  unconfirmed: boolean;
}

export const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  unknown: "no signal",
  working: "working",
  needs_permission: "needs permission",
  needs_input: "needs input",
  idle: "idle",
  done: "done",
  error: "error",
};

/** For surfaces with no activity to show: integrated terminals, workspaces. */
export const lifecycleTone = (
  status: AgentSessionDto["status"],
): SessionTone =>
  status === "running"
    ? "idle"
    : status === "starting"
      ? "working"
      : status === "lost"
        ? "lost"
        : "ended";

const LIFECYCLE_LABEL: Record<AgentSessionDto["status"], string> = {
  starting: "starting",
  running: "running",
  exited: "exited",
  lost: "lost",
};

/**
 * Folds the three inputs the renderer is given — lifecycle status, observed
 * activity, and the attention badge — into one thing to draw. This is the only
 * place the precedence lives, and it is an adapter: no inference, no
 * heuristics, no timers deciding state.
 */
export function sessionStatusView(
  session: AgentSessionDto,
  activity?: AgentActivityDto,
  attention?: SessionAttentionDto,
): SessionStatusView {
  const reasons = attention?.reasons ?? [];
  const newest = reasons.at(-1);
  if (attention && reasons.length > 0) {
    const blocked =
      activity &&
      (activity.activity === "needs_permission" ||
        activity.activity === "needs_input")
        ? activity.activity
        : "needs_input";
    return {
      tone: "attention",
      label: ACTIVITY_LABEL[blocked],
      detail: newest?.text ?? activity?.detail ?? null,
      since: attention.raisedAt,
      attention: true,
      reasons,
      // A badge the agent raised about itself is a report, not a reading.
      unconfirmed: reasons.every((reason) => reason.source === "pane"),
    };
  }
  if (!sessionIsLive(session))
    return {
      tone: session.status === "lost" ? "lost" : "ended",
      label: LIFECYCLE_LABEL[session.status],
      // Why it could not be revived, when something tried and failed. A reboot
      // makes every session `lost` at once, and the ones that are staying that
      // way have to be tellable apart from the ones that simply came back.
      detail: session.status === "lost" ? session.lostReason : null,
      since: session.endedAt,
      // A vanished session is today's attention signal and stays one.
      attention: session.status === "lost",
      reasons: [],
      unconfirmed: false,
    };
  if (!activity || activity.activity === "unknown")
    return {
      tone: session.status === "starting" ? "working" : "idle",
      label: LIFECYCLE_LABEL[session.status],
      detail: null,
      since: session.startedAt,
      attention: false,
      reasons: [],
      unconfirmed: false,
    };
  return {
    tone:
      activity.activity === "error"
        ? "error"
        : activity.activity === "done"
          ? "done"
          : activity.activity === "idle"
            ? "idle"
            : "working",
    label: ACTIVITY_LABEL[activity.activity],
    detail: activity.detail,
    since: activity.since,
    attention: false,
    reasons: [],
    unconfirmed: activity.source === "pane",
  };
}

/**
 * "waiting 4m" is what makes a stalled session visible; the bare word
 * "waiting" is not. Sub-minute waits read as "just now" rather than "0m".
 */
export function waitingLabel(since: string | null, now: number): string {
  if (!since) return "";
  const elapsed = now - Date.parse(since);
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

/** Screen readers get the activity and the wait, never the colour. */
export function statusAriaLabel(
  session: AgentSessionDto,
  view: SessionStatusView,
  now: number,
): string {
  const parts = [`${sessionName(session)}: ${view.label}`];
  if (view.attention && view.since)
    parts.push(`waiting ${waitingLabel(view.since, now)}`);
  if (view.reasons.length > 1) parts.push(`${view.reasons.length} reasons`);
  if (view.detail) parts.push(view.detail);
  if (view.unconfirmed) parts.push("unconfirmed reading");
  return parts.join(", ");
}

/**
 * Colour is never the only carrier: attention draws a solid outer ring and a
 * count, working pulses, and everything else is a plain dot. That survives
 * colour-blindness and a glance at a dense list.
 */
export function AgentStatusDot({
  count,
  label,
  view,
}: {
  count?: number;
  label?: string;
  view: SessionStatusView;
}) {
  return (
    <span
      aria-hidden={label ? undefined : "true"}
      aria-label={label}
      className={`agent-dot tone-${view.tone}${view.unconfirmed ? " unconfirmed" : ""}`}
      role={label ? "img" : undefined}
    >
      {view.attention && count !== undefined && count > 1 && (
        <span className="agent-dot-count">{count}</span>
      )}
    </span>
  );
}

import type { AgentActivityState, AgentSession } from "../domain";

/**
 * When Daedalus may type a line into a session the user may also be typing
 * in. There are no modes and nothing is locked: a line goes in only when the
 * session is idle at its prompt, its input box is empty, and nobody pressed a
 * key in its terminal for `QUIET_AFTER_TYPING_MS`. Everything else waits, and
 * says why.
 */

/** After a keystroke in a session's terminal, Daedalus types nothing for this long. */
export const QUIET_AFTER_TYPING_MS = 2 * 60_000;

/** The text of Claude's `idle_prompt` notification. */
export const CLAUDE_IDLE_NOTICE = "Claude is waiting for your input";

/** Codex's placeholder, shown only while its input box is empty. */
const CODEX_EMPTY_COMPOSER = "Ask Codex to do anything";

/**
 * The text in Claude's input box, if the pane shows one: the last prompt line
 * under Claude's composer rule. `undefined` when no prompt line is found,
 * which says nothing either way.
 */
export function composerText(screen: string): string | undefined {
  const lines = screen.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^\s*[❯>]\s?(.*)$/.exec(lines[index]!);
    if (match && /^\s*─{8,}/.test(lines[index - 1] ?? ""))
      return match[1]!.replace(/ /g, " ").trim();
  }
  return undefined;
}

/**
 * The text in a session's input box: `""` when it is empty, the text when it
 * has some, `undefined` when no input box shows. Codex has no rule above its
 * box, so its empty box is recognised by the placeholder it shows; anything
 * else on a Codex prompt line counts as text.
 */
export function inputBoxText(
  screen: string,
  provider: AgentSession["provider"],
): string | undefined {
  if (provider !== "codex") return composerText(screen);
  if (screen.includes(CODEX_EMPTY_COMPOSER)) return "";
  const lines = screen.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^\s*[›▌]\s?(.*)$/.exec(lines[index]!);
    if (match) return match[1]!.replace(/ /g, " ").trim();
  }
  return undefined;
}

/**
 * The pane's own answer to "is it at its prompt": an input box is showing
 * and no turn is running (both providers show "esc to interrupt" while they
 * work).
 */
export function paneAtPrompt(
  screen: string,
  provider: AgentSession["provider"] = "claude",
): boolean {
  return (
    inputBoxText(screen, provider) !== undefined &&
    !/esc to interrupt/i.test(screen)
  );
}

/**
 * Whether the session is at its prompt, where a typed line starts a turn
 * rather than landing in the middle of one. A Claude session that ended its
 * turn with background agents still running reports `working`, and that is
 * exactly the state routines are delivered in: the typed line starts a turn
 * alongside them. A badge the agent raised on itself is not a prompt to
 * answer, so it does not hold delivery; a real question or permission
 * dialog does, because a typed line would answer it.
 */
export function activityAtPrompt(
  activity: AgentActivityState | undefined,
): boolean {
  if (!activity) return false;
  switch (activity.activity) {
    case "idle":
    case "done":
      return true;
    case "working":
      return /^Waiting for \d+ background agents?$/.test(activity.detail ?? "");
    case "needs_input":
      // A badge the agent raised on itself, or Claude's idle notice: neither
      // is a question that a typed line would answer.
      return (
        activity.source === "agent" || activity.detail === CLAUDE_IDLE_NOTICE
      );
    default:
      return false;
  }
}

/**
 * Why a line is not being typed in. Said out loud, because a queue that
 * silently stops looks like a broken feature.
 */
export type DeliveryHoldReason =
  | "paused"
  | "stopped"
  | "handoff"
  | "typing"
  | "busy"
  | "waiting-on-user"
  | "input-text"
  | "in-flight-limit"
  | "skill-missing";

export interface DeliveryHold {
  reason: DeliveryHoldReason;
  text: string;
  /** For `typing`: when the quiet time ends. */
  until?: string;
}

/**
 * The host's memory of who typed where, and the one rule every line Daedalus
 * types into a session goes through. Keystrokes reach only the desktop host,
 * which is also where the clock runs, so none of this is stored.
 */
export class DeliveryGate {
  private readonly keystrokes = new Map<string, number>();
  private readonly skipQuiet = new Set<string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** The user pressed a key in this session's terminal. */
  noteKeystroke(sessionId: string): void {
    this.keystrokes.set(sessionId, this.now().getTime());
    this.skipQuiet.delete(sessionId);
  }

  lastKeystrokeAt(sessionId: string): string | null {
    const at = this.keystrokes.get(sessionId);
    return at === undefined ? null : new Date(at).toISOString();
  }

  /** When typing stops holding this session, or null when it does not. */
  quietUntil(sessionId: string): Date | null {
    const at = this.keystrokes.get(sessionId);
    if (at === undefined || this.skipQuiet.has(sessionId)) return null;
    const until = at + QUIET_AFTER_TYPING_MS;
    return until > this.now().getTime() ? new Date(until) : null;
  }

  /** Run now: the next line skips the quiet time, and nothing else. */
  skipQuietOnce(sessionId: string): void {
    this.skipQuiet.add(sessionId);
  }

  /** A line went in, so the next one waits for quiet again. */
  delivered(sessionId: string): void {
    this.skipQuiet.delete(sessionId);
  }

  /**
   * Null when a line may be typed into the session now; otherwise why not.
   * `screen` is the pane as text, read just before this call, so the input
   * box is checked as close to the typing as it can be.
   */
  check(input: {
    session: AgentSession;
    activity: AgentActivityState | undefined;
    screen: string;
  }): DeliveryHold | null {
    const { session, activity, screen } = input;
    if (session.status !== "running" || session.archivedAt)
      return { reason: "stopped", text: "the session is not running" };
    if (session.handoffRequestedAt)
      return { reason: "handoff", text: "the session is handing off" };
    const until = this.quietUntil(session.id);
    if (until)
      return {
        reason: "typing",
        text: "you typed in this session",
        until: until.toISOString(),
      };
    const unknown = !activity || activity.activity === "unknown";
    const atPrompt =
      activityAtPrompt(activity) ||
      (unknown && paneAtPrompt(screen, session.provider));
    if (!atPrompt)
      return activity?.activity === "needs_permission" ||
        activity?.activity === "needs_input"
        ? {
            reason: "waiting-on-user",
            text: "the session is waiting for an answer",
          }
        : { reason: "busy", text: "the session is busy" };
    const box = inputBoxText(screen, session.provider);
    if (box === undefined)
      return { reason: "busy", text: "no input box is showing" };
    if (box) return { reason: "input-text", text: "the input box has text" };
    return null;
  }
}

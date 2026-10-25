import type { DaedalusConfig } from "../config";
import type { AgentActivityState, AgentSession } from "../domain";
import { DaedalusError } from "../errors";
import type { DeliveryGate, DeliveryHold } from "./delivery";
import { buildSkillInvocation } from "./providers";
import { leaveInInbox, postToInbox, usesInbox } from "./session-inbox";
import { requireSkill } from "./installed-skills";
import type { SessionHosts } from "./session-hosts";

/** Between two lines delivered into one session, at least this long. */
const DELIVERY_GAP_MS = 15_000;
/**
 * A line delivered with no activity reading since is presumed lost after
 * this, so a session whose hooks do not report still gets its lines.
 */
const UNACKNOWLEDGED_DELIVERY_MS = 2 * 60_000;
/**
 * How long Codex takes to turn a picked `$skill` mention into a chip before
 * a second Enter can submit it.
 */
const CODEX_MENTION_SETTLE_MS = 400;

/**
 * When a line may reach the session.
 *
 * - `now`: the user asked for it, so nothing holds it. An inbox takes it in
 *   its mailbox, which arrives mid-turn; otherwise it is typed at once.
 * - `at-prompt`: only while the session waits at its prompt, under the
 *   delivery gate. An inbox takes it only while its waiter is reading,
 *   unless it must arrive.
 * - `next-prompt`: an inbox takes it in its mailbox at once, and it arrives
 *   when the session is next at its prompt. Typed, it waits like `at-prompt`.
 */
export type DeliveryWhen = "now" | "at-prompt" | "next-prompt";

export interface DeliveryOptions {
  when: DeliveryWhen;
  /** The session's latest activity reading, which the gate judges. */
  activity?: AgentActivityState;
  /**
   * Typed as this Daedalus skill with its arguments instead of the line. An
   * inbox still takes the line, which should name the skill.
   */
  skill?: { id: string; args?: string };
  /**
   * For `at-prompt`: once the gate lets it through, an inbox keeps the line
   * in its mailbox even if its waiter is not reading, so it is never lost.
   */
  mustArrive?: boolean;
}

/**
 * - `delivered`: the line went in.
 * - `held`: it did not, and why, for the routines bar.
 * - `settling`: the last line has not landed yet; nothing new to say.
 */
export type DeliveryResult =
  | { kind: "delivered" }
  | { kind: "held"; held: DeliveryHold }
  | { kind: "settling" };

/** A line sent `now` is never left to settle. */
export type ImmediateDeliveryResult = Exclude<
  DeliveryResult,
  { kind: "settling" }
>;

/**
 * The line, or how to make it once it may go in, so the checks it needs run
 * only then. A typed skill still resolves it, for those checks.
 */
export type DeliveryLine = string | (() => Promise<string>);

const DELIVERED = { kind: "delivered" } as const;

const held = (hold: DeliveryHold) => ({ kind: "held", held: hold }) as const;

/**
 * Every line Daedalus hands to a running session without the user sending
 * it: routine runs, grant and revoke notes, rebirth requests. It owns the
 * choice between a Claude session's inbox and typing into the pane, the
 * pause between two lines, the screen read and the delivery gate. Callers
 * say what to send and when, and get back whether it went in.
 */
export class SessionChannel {
  /** When a line last went in through the gate, per session. */
  private readonly lastDelivered = new Map<string, number>();

  constructor(
    private readonly config: DaedalusConfig,
    /** Where each session runs: its host reads and types in its pane. */
    private readonly hosts: SessionHosts,
    /** Keystrokes per session, and the rule for typing into one. */
    private readonly gate: DeliveryGate,
    private readonly now: () => Date = () => new Date(),
    /** Hands a line to a session's inbox pipe; injected so tests need no pipe. */
    private readonly post: (
      session: AgentSession,
      line: string,
    ) => Promise<boolean> = (session, line) =>
      postToInbox(config, session.id, line),
  ) {}

  deliver(
    session: AgentSession,
    line: DeliveryLine,
    options: DeliveryOptions & { when: "now" },
  ): Promise<ImmediateDeliveryResult>;
  deliver(
    session: AgentSession,
    line: DeliveryLine,
    options: DeliveryOptions,
  ): Promise<DeliveryResult>;
  async deliver(
    session: AgentSession,
    line: DeliveryLine,
    options: DeliveryOptions,
  ): Promise<DeliveryResult> {
    const inbox = usesInbox(session);
    if (inbox && options.when !== "at-prompt") {
      await leaveInInbox(this.config, session.id, await resolve(line));
      return DELIVERED;
    }
    if (options.when === "now") return this.type(session, line, options.skill);
    const { activity } = options;
    if (!this.settled(session.id, activity)) return { kind: "settling" };
    const screen = await this.screen(session);
    const hold = this.gate.check({ session, activity, screen, untyped: inbox });
    if (hold) return held(hold);
    if (inbox && options.mustArrive) {
      await leaveInInbox(this.config, session.id, await resolve(line));
    } else if (inbox) {
      // Claude wakes with this as a system reminder: nothing is typed, so
      // it never shows as the user's message.
      if (!(await this.post(session, await resolve(line))))
        return held({
          reason: "busy",
          text: "the session is not waiting at its prompt",
        });
    } else {
      const typed = await this.type(session, line, options.skill);
      if (typed.kind !== "delivered") return typed;
    }
    this.lastDelivered.set(session.id, this.now().getTime());
    this.gate.delivered(session.id);
    return DELIVERED;
  }

  /** The pane as the gate reads it; one that cannot be read is empty. */
  private async screen(session: AgentSession): Promise<string> {
    try {
      return await this.hosts
        .get(session.hostId)
        .capture(session.tmuxSession, { styled: true });
    } catch {
      return "";
    }
  }

  /**
   * When the quiet time after a keystroke stops holding lines for this
   * session, or null when it does not. Typing never holds an inbox.
   */
  quietUntil(session: AgentSession): Date | null {
    return usesInbox(session) ? null : this.gate.quietUntil(session.id);
  }

  lastKeystrokeAt(sessionId: string): string | null {
    return this.gate.lastKeystrokeAt(sessionId);
  }

  /** Run now: the next line skips the quiet time, and nothing else. */
  skipQuietOnce(sessionId: string): void {
    this.gate.skipQuietOnce(sessionId);
  }

  /**
   * Whether the last line delivered has had time to land: a gap between
   * lines, and an activity reading since the last one, or long enough
   * without one that it was lost.
   */
  private settled(
    sessionId: string,
    activity: AgentActivityState | undefined,
  ): boolean {
    const last = this.lastDelivered.get(sessionId);
    if (last === undefined) return true;
    const now = this.now().getTime();
    if (now - last < DELIVERY_GAP_MS) return false;
    const seen = activity && Date.parse(activity.observedAt) > last;
    return Boolean(seen) || now - last >= UNACKNOWLEDGED_DELIVERY_MS;
  }

  /**
   * Types the line, or the skill as `/name args` for Claude and `$name args`
   * for Codex. Held when the skill is not installed for the provider.
   */
  private async type(
    session: AgentSession,
    line: DeliveryLine,
    skill: DeliveryOptions["skill"],
  ): Promise<ImmediateDeliveryResult> {
    if (session.status !== "running")
      return held({ reason: "stopped", text: "the session is not running" });
    if (!skill) {
      await this.hosts
        .get(session.hostId)
        .send(session.tmuxSession, await resolve(line));
      return DELIVERED;
    }
    let skillName: string;
    try {
      skillName = await requireSkill(this.config, session, skill.id);
    } catch (error) {
      if (error instanceof DaedalusError && error.code === "CONFLICT")
        return held({ reason: "skill-missing", text: error.message });
      throw error;
    }
    // Typed as the skill, the line only runs its own checks. The skill is
    // checked first, so a missing one is a hold rather than a throw.
    await resolve(line);
    const provider = session.provider as "claude" | "codex";
    await this.hosts
      .get(session.hostId)
      .send(
        session.tmuxSession,
        buildSkillInvocation(provider, skillName, skill.args ?? ""),
      );
    // In Codex, `$name` opens the skill mention popup, and the first Enter
    // only picks the skill from it. The second one submits. On an empty
    // composer an Enter does nothing, so this is safe if the popup changes.
    if (provider === "codex") {
      await Bun.sleep(CODEX_MENTION_SETTLE_MS);
      await this.hosts
        .get(session.hostId)
        .sendKeys(session.tmuxSession, ["Enter"]);
    }
    return DELIVERED;
  }
}

const resolve = (line: DeliveryLine): Promise<string> =>
  typeof line === "string" ? Promise.resolve(line) : line();

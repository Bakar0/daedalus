import { join } from "node:path";
import { pathExists, type TmuxClient } from "@daedalus/platform";
import type { DaedalusConfig } from "../config";
import type { AgentActivityState, AgentSession } from "../domain";
import { DaedalusError } from "../errors";
import { DeliveryGate, type DeliveryHold } from "./delivery";
import { buildSkillInvocation } from "./providers";
import { leaveInInbox, postToInbox, usesInbox } from "./session-inbox";
import {
  channelArtifactName,
  skillLinkPaths,
  type SkillProvider,
} from "./skills";

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
 *   delivery gate. An inbox takes it only while its waiter is reading.
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
}

/**
 * - `delivered`: the line went in.
 * - `held`: it did not, and why, for the routines bar.
 * - `settling`: the last line has not landed yet; nothing new to say.
 */
export type DeliveryResult =
  { delivered: true } | { held: DeliveryHold } | { settling: true };

const DELIVERED = { delivered: true } as const;

/**
 * Every line Daedalus hands to a running session without the user sending
 * it: routine runs, grant and revoke notes, rebirth requests. It owns the
 * choice between a Claude session's inbox and typing into the pane, the
 * pause between two lines, the screen read and the delivery gate. Callers
 * say what to send and when, and get back whether it went in.
 */
export class SessionChannel {
  /** Keystrokes per session, and the rule for typing into one. */
  readonly gate: DeliveryGate;
  /** When a line last went in through the gate, per session. */
  private readonly lastDelivered = new Map<string, number>();

  constructor(
    private readonly config: DaedalusConfig,
    private readonly tmux: TmuxClient,
    private readonly now: () => Date = () => new Date(),
    /** Hands a line to a session's inbox pipe; injected so tests need no pipe. */
    private readonly post: (
      session: AgentSession,
      line: string,
    ) => Promise<boolean> = (session, line) =>
      postToInbox(config, session.id, line),
  ) {
    this.gate = new DeliveryGate(now);
  }

  async deliver(
    session: AgentSession,
    line: string,
    options: DeliveryOptions,
  ): Promise<DeliveryResult> {
    const inbox = usesInbox(session);
    if (inbox && options.when !== "at-prompt") {
      await leaveInInbox(this.config, session.id, line);
      return DELIVERED;
    }
    if (options.when === "now") return this.type(session, line, options.skill);
    const { activity } = options;
    if (!this.settled(session.id, activity)) return { settling: true };
    const screen = await this.tmux
      .capture(session.tmuxSession, { styled: true })
      .catch(() => "");
    const hold = this.gate.check({ session, activity, screen, untyped: inbox });
    if (hold) return { held: hold };
    if (inbox) {
      // Claude wakes with this as a system reminder: nothing is typed, so
      // it never shows as the user's message.
      if (!(await this.post(session, line)))
        return {
          held: {
            reason: "busy",
            text: "the session is not waiting at its prompt",
          },
        };
    } else {
      const typed = await this.type(session, line, options.skill);
      if (!("delivered" in typed)) return typed;
    }
    this.lastDelivered.set(session.id, this.now().getTime());
    this.gate.delivered(session.id);
    return DELIVERED;
  }

  /**
   * When the quiet time after a keystroke stops holding lines for this
   * session, or null when it does not. Typing never holds an inbox.
   */
  quietUntil(session: AgentSession): Date | null {
    return usesInbox(session) ? null : this.gate.quietUntil(session.id);
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
    line: string,
    skill: DeliveryOptions["skill"],
  ): Promise<DeliveryResult> {
    if (session.status !== "running")
      return {
        held: { reason: "stopped", text: "the session is not running" },
      };
    if (!skill) {
      await this.tmux.send(session.tmuxSession, line);
      return DELIVERED;
    }
    let skillName: string;
    try {
      skillName = await requireSkill(this.config, session, skill.id);
    } catch (error) {
      if (error instanceof DaedalusError && error.code === "CONFLICT")
        return { held: { reason: "skill-missing", text: error.message } };
      throw error;
    }
    const provider = session.provider as "claude" | "codex";
    await this.tmux.send(
      session.tmuxSession,
      buildSkillInvocation(provider, skillName, skill.args ?? ""),
    );
    // In Codex, `$name` opens the skill mention popup, and the first Enter
    // only picks the skill from it. The second one submits. On an empty
    // composer an Enter does nothing, so this is safe if the popup changes.
    if (provider === "codex") {
      await Bun.sleep(CODEX_MENTION_SETTLE_MS);
      await this.tmux.sendKeys(session.tmuxSession, ["Enter"]);
    }
    return DELIVERED;
  }
}

/** The skill's installed name for the provider, if it is installed. */
export async function installedSkill(
  config: DaedalusConfig,
  provider: SkillProvider,
  skillId: string,
): Promise<string | undefined> {
  const skillName = channelArtifactName(config, skillId);
  const installed = skillLinkPaths(config, skillName).find((link) =>
    link.providers.includes(provider),
  );
  return installed && (await pathExists(join(installed.path, "SKILL.md")))
    ? skillName
    : undefined;
}

/** The skill's installed name, or `CONFLICT` when it is not installed. */
export async function requireSkill(
  config: DaedalusConfig,
  session: AgentSession,
  skillId: string,
): Promise<string> {
  if (session.provider !== "claude" && session.provider !== "codex")
    throw new DaedalusError(
      "CONFLICT",
      "Only Claude and Codex sessions can run Daedalus skills",
    );
  const skillName = await installedSkill(config, session.provider, skillId);
  if (!skillName)
    throw new DaedalusError(
      "CONFLICT",
      `The ${skillId} skill is not installed for ${session.provider}. Turn it on in Settings, Skills, or with 'daedal skill enable ${skillId}'.`,
    );
  return skillName;
}

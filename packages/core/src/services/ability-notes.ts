import type { AgentActivityState, SessionAbility } from "../domain";
import type { SqliteRepositories } from "../repositories";
import type { AbilityService } from "./abilities";
import type { SessionChannel } from "./session-channel";

export interface AbilityNoteTickInput {
  activity: (sessionId: string) => AgentActivityState | undefined;
}

export interface AbilityNoteTickResult {
  /** Sessions a grant or revoke note was handed to. */
  notes: string[];
  events: string[];
}

/**
 * Hands grant and revoke notes to their sessions on the desktop host's tick.
 * An inbox takes a note at once and it arrives when the session is next at
 * its prompt; typed, it waits for the delivery rule.
 */
export class AbilityNoteDelivery {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly abilities: AbilityService,
    private readonly channel: SessionChannel,
  ) {}

  async tick(input: AbilityNoteTickInput): Promise<AbilityNoteTickResult> {
    const result: AbilityNoteTickResult = { notes: [], events: [] };
    for (const row of this.repositories.abilities.list()) {
      if (!row.pendingNote) continue;
      try {
        if (await this.deliver(row, row.pendingNote, input))
          result.notes.push(row.sessionId);
      } catch (error) {
        result.events.push(
          `${row.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return result;
  }

  private async deliver(
    row: SessionAbility,
    note: string,
    input: AbilityNoteTickInput,
  ): Promise<boolean> {
    const session = this.repositories.findAgent(row.sessionId);
    if (!session || session.archivedAt || session.status !== "running")
      return false;
    const outcome = await this.channel.deliver(session, note, {
      when: "next-prompt",
      activity: input.activity(session.id),
    });
    if (outcome.kind !== "delivered") return false;
    this.abilities.noteDelivered(row, note);
    return true;
  }
}

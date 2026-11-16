import type { AgentSession } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { TeamService } from "./teams";

/** A lead marking a team member done, or open again. */
export class ThreadService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly teams: Pick<TeamService, "memberOf">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Marks a member done (or open again). It moves to Resolved and stops
   * counting against its lead's member cap; it keeps running until stopped.
   */
  resolve(sessionId: string, resolved: boolean): AgentSession {
    const session = this.repositories.findAgent(sessionId);
    if (!session)
      throw new DaedalusError("NOT_FOUND", `Session ${sessionId} not found`);
    if (!this.teams.memberOf(session.id))
      throw new DaedalusError(
        "VALIDATION",
        `'${session.name}' is in no lead's team`,
      );
    const resolvedAt = resolved ? this.now().toISOString() : null;
    this.repositories.setAgentResolved(session.id, resolvedAt);
    return { ...session, resolvedAt };
  }
}

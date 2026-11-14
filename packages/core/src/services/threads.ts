import type { AgentSession, ThreadSuggestion } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { TeamService } from "./teams";
import type { TrackingService } from "./tracking";
import type { WorkspaceService } from "./workspaces";

/** The longest title a suggested thread takes; it becomes a session name. */
export const THREAD_TITLE_MAX = 120;

/**
 * Threads: the sessions the main agent tracks, or a lead's team members, as
 * the Threads pane shows them; the threads either suggests for the user to
 * start; and marking one resolved.
 */
export class ThreadService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaces: Pick<WorkspaceService, "getActive">,
    private readonly teams: Pick<TeamService, "spawnMember" | "memberOf">,
    private readonly tracking: Pick<TrackingService, "start" | "isTracked">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Saves a thread the lead suggests. Nothing starts until the user presses
   * Start in the Threads pane.
   */
  async suggest(input: {
    lead: string;
    title: string;
    workspace?: string;
    message?: string;
  }): Promise<ThreadSuggestion> {
    const lead = this.lead(input.lead);
    const title = input.title.trim().replace(/\s+/g, " ");
    if (!title)
      throw new DaedalusError(
        "VALIDATION",
        'A suggested thread needs a title: daedal thread suggest "<title>"',
      );
    if (title.length > THREAD_TITLE_MAX)
      throw new DaedalusError(
        "VALIDATION",
        `A thread title has at most ${THREAD_TITLE_MAX} characters; put the details in --message`,
      );
    const workspace = input.workspace
      ? await this.workspaces.getActive(input.workspace)
      : undefined;
    if (
      workspace?.kind === "home" ||
      (!workspace &&
        lead.workspaceId === this.repositories.findHomeWorkspace()?.id)
    )
      throw new DaedalusError(
        "VALIDATION",
        "A thread runs in one of your workspaces, not at Home; pass --workspace <workspace>",
      );
    const message = input.message?.trim();
    return this.repositories.threads.create({
      leadSessionId: lead.id,
      title,
      workspaceId: workspace?.id ?? null,
      message: message || null,
      createdAt: this.now().toISOString(),
    });
  }

  /** The lead's suggestions still waiting on the user, oldest first. */
  suggestions(lead: string): ThreadSuggestion[] {
    return this.repositories.threads.open(this.lead(lead).id);
  }

  /**
   * Starts a suggestion. The main agent's becomes an ordinary session it
   * tracks; any other lead's becomes a new member of its team.
   */
  async start(id: number): Promise<AgentSession> {
    const suggestion = this.open(id);
    const lead = this.lead(suggestion.leadSessionId);
    const session =
      lead.workspaceId === this.repositories.findHomeWorkspace()?.id
        ? await this.tracking.start({
            tracker: lead.id,
            workspace: suggestion.workspaceId ?? "",
            name: suggestion.title,
            message: suggestion.message ?? suggestion.title,
          })
        : (
            await this.teams.spawnMember({
              team: suggestion.leadSessionId,
              addedBy: "user",
              name: suggestion.title,
              instructions: suggestion.message ?? suggestion.title,
              ...(suggestion.workspaceId
                ? { workspace: suggestion.workspaceId }
                : {}),
            })
          ).session;
    this.repositories.threads.close(
      suggestion.id,
      this.now().toISOString(),
      session.id,
    );
    return session;
  }

  dismiss(id: number): ThreadSuggestion {
    const suggestion = this.open(id);
    this.repositories.threads.close(
      suggestion.id,
      this.now().toISOString(),
      null,
    );
    return { ...suggestion, closedAt: this.now().toISOString() };
  }

  /**
   * Marks a thread done (or open again). It moves to Resolved, stops
   * counting against its lead's member cap and stops reporting to the
   * session tracking it; it keeps running until stopped.
   */
  resolve(sessionId: string, resolved: boolean): AgentSession {
    const session = this.repositories.findAgent(sessionId);
    if (!session)
      throw new DaedalusError("NOT_FOUND", `Session ${sessionId} not found`);
    if (
      !this.teams.memberOf(session.id) &&
      !this.tracking.isTracked(session.id)
    )
      throw new DaedalusError(
        "VALIDATION",
        `'${session.name}' is not a thread: nothing tracks it and it is in no lead's team`,
      );
    const resolvedAt = resolved ? this.now().toISOString() : null;
    this.repositories.setAgentResolved(session.id, resolvedAt);
    return { ...session, resolvedAt };
  }

  private lead(reference: string): AgentSession {
    const lead = this.repositories.findAgent(reference);
    if (!lead)
      throw new DaedalusError("NOT_FOUND", `Session ${reference} not found`);
    return lead;
  }

  private open(id: number): ThreadSuggestion {
    const suggestion = this.repositories.threads.find(id);
    if (!suggestion)
      throw new DaedalusError("NOT_FOUND", `No suggested thread ${id}`);
    if (suggestion.closedAt)
      throw new DaedalusError(
        "CONFLICT",
        suggestion.startedSessionId
          ? `Suggested thread ${id} was already started`
          : `Suggested thread ${id} was dismissed`,
      );
    return suggestion;
  }
}

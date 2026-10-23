import type { AgentSession, Workspace } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { AgentService } from "./agents";
import type { SessionMoves } from "./session-move";
import type { WorkspaceService } from "./workspaces";

/** What archiving a cloud copy away needs from the cloud service. */
export interface ArchiveCloud {
  /** Deletes the pod, its volumes, its token and the gateway's record. */
  delete(workspaceReference: string): Promise<void>;
}

/**
 * - `archived`: done.
 * - `needsApproval`: moving it home would bring files that steer agents;
 *   asked as a move asks, then again with `approved`.
 * - `needsConfirmation`: its cloud workspace cannot be reached, or the move
 *   failed; with `withoutCloudChanges` it is archived with what this Mac has.
 */
export type SessionArchiveResult =
  | { status: "archived"; session: AgentSession }
  | { status: "needsApproval"; paths: string[] }
  | { status: "needsConfirmation"; reason: string };

/** As a session's, naming the session that asks. */
export type WorkspaceArchiveResult =
  | { status: "archived"; workspace: Workspace }
  | { status: "needsApproval"; sessionId: string; paths: string[] }
  | { status: "needsConfirmation"; sessionId: string; reason: string };

export interface SessionArchiveOptions {
  repositories: SqliteRepositories;
  agents: AgentService;
  workspaces: WorkspaceService;
  moves: SessionMoves;
  cloud: ArchiveCloud;
}

/**
 * Archiving where the cloud is involved. A cloud session comes home first,
 * conversation and code, and is archived as a session of this Mac; restoring
 * it is then local. Archiving a workspace does that for every cloud session,
 * then deletes the cloud copy; deleting a workspace deletes it too.
 */
export class SessionArchive {
  constructor(private readonly options: SessionArchiveOptions) {}

  async archiveSession(input: {
    sessionId: string;
    force?: boolean;
    approved?: string[];
    withoutCloudChanges?: boolean;
  }): Promise<SessionArchiveResult> {
    const { agents, moves } = this.options;
    const agent = await agents.get(input.sessionId);
    if (!agent.hostId || agent.archivedAt)
      return {
        status: "archived",
        session: await agents.archive(agent.id, input.force),
      };
    if (input.withoutCloudChanges)
      return { status: "archived", session: await this.#leaveCloud(agent) };
    let moved: AgentSession;
    try {
      const result = await moves.move({
        sessionId: agent.id,
        to: "local",
        ...(input.approved ? { approved: input.approved } : {}),
      });
      if (result.status === "needsApproval") return result;
      moved = result.session;
      // Its notice is about working on; an archived session does not.
      moves.dismiss(agent.id);
    } catch (error) {
      return {
        status: "needsConfirmation",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      status: "archived",
      session: await agents.archive(moved.id, input.force),
    };
  }

  /**
   * Archives a cloud session with what this Mac has, the cloud's work left
   * in the cloud copy. One that came from this Mac goes back to the folder
   * and conversation it left with; one born in the cloud has nothing here,
   * so it stays a cloud session, archived.
   */
  async #leaveCloud(agent: AgentSession): Promise<AgentSession> {
    const { agents, moves, repositories } = this.options;
    const folder = await moves.movedFrom(agent.id);
    // Its pod may be gone: nothing there is stopped, it reads as ended.
    const ended: AgentSession = {
      ...agent,
      ...(agent.status === "running" || agent.status === "starting"
        ? { status: "lost", endedAt: new Date().toISOString() }
        : {}),
    };
    if (!folder) {
      const archived = {
        ...ended,
        archivedAt: new Date().toISOString(),
      };
      repositories.updateAgent(archived);
      return archived;
    }
    repositories.updateAgent({
      ...ended,
      hostId: null,
      workingDirectory: folder,
    });
    await moves.forget(agent.id);
    return agents.archive(agent.id, true);
  }

  async archiveWorkspace(input: {
    reference: string;
    approved?: Record<string, string[]>;
    withoutCloudChanges?: boolean;
  }): Promise<WorkspaceArchiveResult> {
    const { repositories, workspaces, cloud } = this.options;
    const workspace = await workspaces.get(input.reference);
    if (workspace.archivedAt) return { status: "archived", workspace };
    const inCloud = repositories
      .listAgents({ workspaceId: workspace.id })
      .filter((session) => session.hostId && !session.archivedAt);
    for (const session of inCloud) {
      const approved = input.approved?.[session.id];
      const result = await this.archiveSession({
        sessionId: session.id,
        force: true,
        ...(approved ? { approved } : {}),
        ...(input.withoutCloudChanges ? { withoutCloudChanges: true } : {}),
      });
      if (result.status !== "archived")
        return { ...result, sessionId: session.id };
    }
    // Before the workspace is archived, so a gateway that cannot be reached
    // leaves it as it was, to try again.
    if (repositories.cloudWorkspaceId(workspace.id))
      await cloud.delete(workspace.id);
    return {
      status: "archived",
      workspace: await workspaces.archive(workspace.id),
    };
  }

  /** Deletes an archived workspace for good, its cloud copy first. */
  async deleteWorkspace(reference: string): Promise<Workspace> {
    const workspace = await this.options.workspaces.get(reference);
    if (!workspace.archivedAt)
      throw new DaedalusError(
        "CONFLICT",
        `Workspace '${workspace.slug}' is not archived; archive it before deleting it`,
      );
    await this.#deleteCloudCopy(workspace);
    return this.options.workspaces.deletePermanently(workspace.id);
  }

  /** Removes a workspace from Daedalus, its cloud copy first. */
  async removeWorkspace(
    reference: string,
    options: { deleteFiles?: boolean; force?: boolean },
  ): Promise<{ workspace: Workspace; filesDeleted: boolean }> {
    const { repositories, workspaces } = this.options;
    const workspace = await workspaces.get(reference);
    // Only when the removal will go ahead: the refusals below are the ones
    // `remove` makes, and a cloud copy deleted for nothing is lost.
    const refused =
      !options.force ||
      repositories
        .listAgents({ workspaceId: workspace.id })
        .some(
          (session) =>
            session.status === "running" || session.status === "starting",
        ) ||
      repositories.listSessionWorktrees({ workspaceId: workspace.id }).length >
        0;
    if (!refused) await this.#deleteCloudCopy(workspace);
    return workspaces.remove(workspace.id, options);
  }

  async #deleteCloudCopy(workspace: Workspace): Promise<void> {
    if (this.options.repositories.cloudWorkspaceId(workspace.id))
      await this.options.cloud.delete(workspace.id);
  }
}

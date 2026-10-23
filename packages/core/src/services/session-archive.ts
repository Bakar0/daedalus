import type { AgentSession, Workspace } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { AgentService } from "./agents";
import type { WorkspaceMoveResult, WorkspaceMoves } from "./workspace-move";
import type { WorkspaceService } from "./workspaces";

/** What archiving a cloud copy away needs from the cloud service. */
export interface ArchiveCloud {
  /** Deletes the pod, its volumes, its token and the gateway's record. */
  delete(workspaceReference: string): Promise<void>;
}

/**
 * - `archived`: done.
 * - `needsApproval`: the workspace comes home from the cloud first, and
 *   that brings files that steer agents; asked as a move asks, then again
 *   with `approved`.
 * - `needsSmaller`: it cannot come home, being over a cap.
 */
export type WorkspaceArchiveResult =
  | { status: "archived"; workspace: Workspace }
  | Extract<WorkspaceMoveResult, { status: "needsApproval" | "needsSmaller" }>;

export interface SessionArchiveOptions {
  repositories: SqliteRepositories;
  agents: AgentService;
  workspaces: WorkspaceService;
  workspaceMoves: WorkspaceMoves;
  cloud: ArchiveCloud;
}

/**
 * Archiving and deleting where the cloud is involved. A workspace in the
 * cloud comes home before it is archived; its cloud copy is deleted with
 * it, as it is when a workspace is deleted or removed. A session archives
 * where it runs.
 */
export class SessionArchive {
  constructor(private readonly options: SessionArchiveOptions) {}

  archiveSession(input: {
    sessionId: string;
    force?: boolean;
  }): Promise<AgentSession> {
    return this.options.agents.archive(input.sessionId, input.force);
  }

  async archiveWorkspace(input: {
    reference: string;
    approved?: string[];
  }): Promise<WorkspaceArchiveResult> {
    const { repositories, workspaces, workspaceMoves, cloud } = this.options;
    const workspace = await workspaces.get(input.reference);
    if (workspace.archivedAt) return { status: "archived", workspace };
    if (workspace.place === "cloud") {
      let moved: WorkspaceMoveResult;
      try {
        // Nothing runs in an archived workspace: no turn is waited for.
        moved = await workspaceMoves.move({
          workspace: workspace.id,
          to: "mac",
          stopWorking: true,
          ...(input.approved ? { approved: input.approved } : {}),
        });
      } catch (error) {
        throw new DaedalusError(
          "CONFLICT",
          `${workspace.name} could not come home from the cloud, so it is not archived: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (moved.status === "needsApproval" || moved.status === "needsSmaller")
        return moved;
      if (moved.status !== "moved")
        throw new DaedalusError(
          "CONFLICT",
          `${workspace.name} could not come home from the cloud, so it is not archived`,
        );
      workspaceMoves.dismiss(workspace.id);
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

import type { Workspace } from "../domain";
import type { SqliteRepositories } from "../repositories";
import type { WorkspaceService } from "./workspaces";

/**
 * Home: the hidden Home workspace row, which shows Activity, Routines and a
 * file tree of the Daedalus home. It has no agent of its own.
 */
export class HomeService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly workspaces: Pick<WorkspaceService, "ensureHome">,
    private readonly sessions: {
      archive(id: string): Promise<unknown>;
    },
  ) {}

  /** The Home row, made on first use. */
  async open(): Promise<Workspace> {
    return this.workspaces.ensureHome();
  }

  /**
   * Archives a session left running at Home by an older build, which had a
   * main agent there. A session that cannot be archived is left as it is.
   * Returns the sessions it archived.
   */
  async retireMainAgent(): Promise<string[]> {
    const home = this.repositories.findHomeWorkspace();
    if (!home) return [];
    const retired: string[] = [];
    for (const session of this.repositories.listAgents()) {
      if (
        session.workspaceId !== home.id ||
        session.kind !== "agent" ||
        session.teamId ||
        session.archivedAt
      )
        continue;
      try {
        await this.sessions.archive(session.id);
        retired.push(session.id);
      } catch {
        // Left running; the user can archive it by hand.
      }
    }
    return retired;
  }
}

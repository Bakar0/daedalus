import type { AgentSession, Workspace } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { AgentService } from "./agents";
import { cloudHostId } from "./cloud-launch";
import { isPodAccess } from "./move-side";
import type { SessionHosts } from "./session-hosts";
import { MOVED_BACK_NOTICE, type SessionMoves } from "./session-move";
import type { WorkspaceService } from "./workspaces";

/** What archiving a cloud copy away needs from the cloud service. */
export interface ArchiveCloud {
  /** Deletes the pod, its volumes, its token and the gateway's record. */
  delete(workspaceReference: string): Promise<void>;
  /** Wakes or makes the copy and waits for its runner; its host id. */
  prepareForSession(workspaceReference: string): Promise<string>;
  /** Puts it to sleep, its volumes kept. */
  sleep(workspaceReference: string): Promise<unknown>;
  /** The gateway's record of it. */
  get(workspaceReference: string): Promise<unknown>;
}

/** A repository a session born in the cloud could bring home. */
type HomeRepository = { name: string; bytes: number };

/** As `SessionMoveResult`'s, when there are more than come home at once. */
type NeedsRepositories = {
  status: "needsRepositories";
  repositories: HomeRepository[];
  maxCount: number;
  maxBytes: number;
};

/**
 * - `archived`: done.
 * - `needsApproval`: moving it home would bring files that steer agents;
 *   asked as a move asks, then again with `approved`.
 * - `needsConfirmation`: its cloud workspace cannot be reached, or the move
 *   failed; with `withoutCloudChanges` it is archived with what this Mac has.
 */
export type SessionArchiveResult =
  | {
      status: "archived";
      session: AgentSession;
      /** What came home, and what stayed in the cloud copy. */
      notice?: string;
    }
  | { status: "needsApproval"; paths: string[] }
  | { status: "needsConfirmation"; reason: string }
  | NeedsRepositories;

/** As a session's, naming the session that asks. */
export type WorkspaceArchiveResult =
  | { status: "archived"; workspace: Workspace }
  | { status: "needsApproval"; sessionId: string; paths: string[] }
  | { status: "needsConfirmation"; sessionId: string; reason: string }
  | (NeedsRepositories & { sessionId: string })
  /**
   * The cloud copy holds work nothing brought home, one plain line each:
   * delete it, or keep it asleep, with `cloudCopy`.
   */
  | { status: "needsCloudDecision"; lost: string[] };

export interface SessionArchiveOptions {
  repositories: SqliteRepositories;
  agents: AgentService;
  workspaces: WorkspaceService;
  moves: SessionMoves;
  cloud: ArchiveCloud;
  hosts: SessionHosts;
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
    repositories?: string[];
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
    let notice: string | undefined;
    try {
      const result = await moves.move({
        sessionId: agent.id,
        to: "local",
        ...(input.approved ? { approved: input.approved } : {}),
        ...(input.repositories ? { repositories: input.repositories } : {}),
      });
      if (result.status !== "moved") return result;
      moved = result.session;
      // What came home and what stayed; how to work on does not apply.
      notice =
        result.notice?.replace(MOVED_BACK_NOTICE, "").trim() || undefined;
      // Kept on the session while something stayed in the cloud copy.
      if (!notice?.includes("stayed in the cloud copy"))
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
      ...(notice ? { notice } : {}),
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
    repositories.updateAgent(ended);
    repositories.setAgentPlace(agent.id, {
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
    repositories?: Record<string, string[]>;
    /** For a cloud copy that holds work: see `needsCloudDecision`. */
    cloudCopy?: "delete" | "keep";
  }): Promise<WorkspaceArchiveResult> {
    const { repositories, workspaces, cloud } = this.options;
    const workspace = await workspaces.get(input.reference);
    if (workspace.archivedAt) return { status: "archived", workspace };
    const inCloud = repositories
      .listAgents({ workspaceId: workspace.id })
      .filter((session) => session.hostId && !session.archivedAt);
    for (const session of inCloud) {
      const approved = input.approved?.[session.id];
      const chosen = input.repositories?.[session.id];
      const result = await this.archiveSession({
        sessionId: session.id,
        force: true,
        ...(approved ? { approved } : {}),
        ...(chosen ? { repositories: chosen } : {}),
        ...(input.withoutCloudChanges ? { withoutCloudChanges: true } : {}),
      });
      if (result.status !== "archived")
        return { ...result, sessionId: session.id };
    }
    // Before the workspace is archived, so a gateway that cannot be reached
    // leaves it as it was, to try again.
    if (repositories.cloudWorkspaceId(workspace.id)) {
      if (!input.cloudCopy) {
        const lost = await this.#lostWithCopy(workspace);
        if (lost.length) return { status: "needsCloudDecision", lost };
      }
      if (input.cloudCopy === "keep") await cloud.sleep(workspace.id);
      else await cloud.delete(workspace.id);
    }
    return {
      status: "archived",
      workspace: await workspaces.archive(workspace.id),
    };
  }

  /**
   * What deleting a workspace's cloud copy would lose, one plain line each:
   * conversations of sessions archived without coming home, and in the pod
   * root, repositories nothing brought home and files outside git. Names
   * come from the pod, so they are cleaned and cut short.
   */
  async #lostWithCopy(workspace: Workspace): Promise<string[]> {
    const { repositories, cloud, hosts } = this.options;
    const cloudId = repositories.cloudWorkspaceId(workspace.id)!;
    const hostId = cloudHostId(cloudId);
    const lost = repositories
      .listAgents({ workspaceId: workspace.id })
      .filter((session) => session.hostId === hostId && session.archivedAt)
      .map(
        (session) =>
          `the conversation of "${podText(session.name)}", archived without coming home`,
      );
    // Gone already: nothing in it to lose.
    const gone = await cloud.get(workspace.id).then(
      () => false,
      (error: unknown) =>
        error instanceof DaedalusError &&
        error.details?.gatewayCode === "NOT_FOUND",
    );
    if (gone) return [];
    let listing: string;
    try {
      const host = hosts.get(await cloud.prepareForSession(workspace.id));
      if (!isPodAccess(host)) throw new Error("no pod");
      const result = await host.run({
        cwd: ".",
        executable: "bash",
        args: ["-c", POD_LEFT_SCRIPT],
      });
      if (result.exitCode !== 0) throw new Error(result.stderr);
      listing = result.stdout;
    } catch {
      return [
        ...lost,
        "whatever else is in the cloud copy: it could not be reached to check",
      ];
    }
    const repositoriesLeft: string[] = [];
    const files: string[] = [];
    for (const line of listing.split("\n")) {
      const [kind, name] = line.split("\t");
      if (!name) continue;
      if (kind === "repository") repositoriesLeft.push(podText(name));
      else if (kind === "other") files.push(podText(name));
    }
    for (const name of repositoriesLeft.slice(0, 10))
      lost.push(`the repository ${name}, which did not come home`);
    if (repositoriesLeft.length > 10)
      lost.push(`${repositoriesLeft.length - 10} more repositories`);
    if (files.length)
      lost.push(
        `${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""} outside git in the cloud workspace`,
      );
    return lost;
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

/**
 * Lists the pod root's own entries, Claude's home and Daedalus's folders
 * left out: a repository no session brought home (no move ref in it), or
 * anything outside git. Tab separated, one per line.
 */
const POD_LEFT_SCRIPT = `for entry in *; do
  [ -e "$entry" ] || continue
  [ "$entry" = worktrees ] && continue
  if [ -d "$entry/.git" ]; then
    if [ -z "$(git -C "$entry" for-each-ref --count=1 refs/daedalus/moves/)" ]; then
      printf 'repository\\t%s\\n' "$entry"
    fi
  else
    printf 'other\\t%s\\n' "$entry"
  fi
done`;

/** A name from the pod, safe to show as plain text in a question. */
function podText(name: string): string {
  // C0 and C1 controls, and the marks that reorder or hide text.
  const clean = name.replace(
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
    "?",
  );
  return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
}

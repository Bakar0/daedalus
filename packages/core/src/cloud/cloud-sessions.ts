import type { CloudWorkspace } from "@daedalus/remote-protocol";
import type { AgentSession } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { AgentService } from "../services/agents";
import { cloudHostId, cloudHostWorkspace } from "../services/cloud-launch";
import { CLOUD_SLEEP_REASON, type CloudService } from "./cloud-service";

export interface CloudSessionsOptions {
  repositories: SqliteRepositories;
  agents: AgentService;
  cloud: CloudService;
}

/**
 * Waking a cloud workspace for its sessions. A sleep ends every session in
 * the pod; waking the workspace, from its menu or by opening one of them,
 * brings them back with their conversations.
 */
export class CloudSessions {
  constructor(private readonly options: CloudSessionsOptions) {}

  /**
   * Opening a cloud session: wakes its workspace if it sleeps and resumes
   * the session. A workspace already awake (woken from its menu, or by
   * another of its sessions) only resumes it.
   */
  async wake(sessionId: string): Promise<AgentSession> {
    const { agents, cloud, repositories } = this.options;
    const session = await agents.get(sessionId);
    const cloudId = session.hostId
      ? cloudHostWorkspace(session.hostId)
      : undefined;
    if (!cloudId)
      throw new DaedalusError(
        "VALIDATION",
        "This session runs on this Mac, not in a cloud workspace",
      );
    if (!repositories.workspaceForCloud(cloudId))
      throw new DaedalusError(
        "DEPENDENCY",
        "This session's cloud workspace is not in the cloud account this Mac is signed in to",
      );
    // Also when it reads as awake: woken a moment ago, its runner may not be
    // linked yet. The gateway leaves a healthy pod as it is.
    await cloud.wakeForSessions(cloudId);
    // A session the pod's idle sleep ended may still read as running.
    if ((await agents.get(sessionId)).status !== "lost")
      await agents.reconcile();
    const current = await agents.get(sessionId);
    // Awake and running already, say from a second click while the first
    // one was resuming it.
    if (current.status === "running" || current.status === "starting")
      return current;
    return agents.reviveLost(sessionId);
  }

  /**
   * Wakes a workspace from its menu and resumes the sessions its sleep
   * ended. One that cannot resume stays lost and says why on its card; the
   * wake itself still succeeds.
   */
  async wakeWorkspace(workspaceReference: string): Promise<CloudWorkspace> {
    const { agents, cloud, repositories } = this.options;
    const cloudId = await cloud.linkedCloudId(workspaceReference);
    const workspaceId = repositories.workspaceForCloud(cloudId);
    const hostId = cloudHostId(cloudId);
    // Ended by the sleep: those the Mac put to sleep say so, and those the
    // pod's idle sleep ended still read as running.
    const ended = new Set(
      (workspaceId ? repositories.listAgents({ workspaceId }) : [])
        .filter(
          (session) =>
            session.hostId === hostId &&
            !session.archivedAt &&
            (session.status === "running" ||
              session.status === "starting" ||
              (session.status === "lost" &&
                session.lostReason === CLOUD_SLEEP_REASON)),
        )
        .map((session) => session.id),
    );
    const woken = await cloud.wakeForSessions(cloudId);
    if (ended.size === 0) return woken;
    await agents.reconcile();
    await Promise.all(
      [...ended].map(async (sessionId) => {
        if ((await agents.get(sessionId)).status === "lost")
          await agents.reviveLost(sessionId).catch(() => undefined);
      }),
    );
    return woken;
  }
}

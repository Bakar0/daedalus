/**
 * How a session on a cloud host is launched. Stage 0 runs Claude or a login
 * shell in the root of the workspace's pod. Nothing here reads this Mac's
 * provider folders or writes a file for the session: every path a local
 * launch puts in the arguments is a path on this Mac, which the pod does not
 * have.
 */

/** The cloud host of a workspace: its pod, as the relay names it. */
export const cloudHostId = (workspaceId: string): string => `ws:${workspaceId}`;

/** The workspace a cloud host id names, or undefined for anything else. */
export const cloudHostWorkspace = (hostId: string): string | undefined =>
  hostId.startsWith("ws:") ? hostId.slice(3) : undefined;

/** Why a session whose cloud workspace went to sleep is lost. */
export const CLOUD_SLEEP_REASON = "The cloud workspace went to sleep";

/** Why a session is lost whose cloud copy the gateway deleted, unused. */
export const CLOUD_COLLECTED_REASON =
  "Its cloud copy was deleted after 30 days asleep; the workspace is back on this Mac from its backup";

/**
 * Shown on a workspace that fell back to this Mac's backup because the
 * gateway deleted its cloud copy.
 */
export const CLOUD_COLLECTED_NOTICE =
  "Back on this Mac as it was when it moved to the cloud: its cloud copy was deleted after 30 days asleep, with the work done there.";

/** Whether a session is lost only because its cloud workspace sleeps. */
export const asleepInCloud = (session: {
  hostId: string | null;
  status: string;
  lostReason: string | null;
  archivedAt: string | null;
}): boolean =>
  Boolean(session.hostId) &&
  session.status === "lost" &&
  session.lostReason === CLOUD_SLEEP_REASON &&
  !session.archivedAt;

/** The working directory of a cloud session: the workspace root. */
export const CLOUD_WORKING_DIRECTORY = ".";

/** On the pod's PATH, from the runner image. */
export const CLOUD_DAEDAL = "daedal";
export const CLOUD_CLAUDE = "claude";
export const CLOUD_SHELL = "bash";

/**
 * The only secret a cloud session is given, when the workspace or the user
 * has one of this name. Without it the user signs in to Claude in the
 * session's terminal, and the login stays on the workspace volume.
 */
export const CLOUD_LAUNCH_SECRETS = ["ANTHROPIC_API_KEY"] as const;

/**
 * The environment of a cloud session. The runner sets PATH, HOME and the
 * rest of the process basics itself; these are what `daedal` in the pod
 * sends back to the Mac.
 */
export function cloudEnvironment(input: {
  sessionId: string;
  workspaceId: string;
  workingDirectory: string;
  task?: { id: string; number: number };
}): Record<string, string> {
  return {
    DAEDALUS_SESSION_ID: input.sessionId,
    DAEDALUS_SESSION_DIRECTORY: input.workingDirectory,
    DAEDALUS_WORKSPACE_ID: input.workspaceId,
    ...(input.task
      ? {
          DAEDALUS_TASK_ID: input.task.id,
          DAEDALUS_TASK_NUMBER: String(input.task.number),
        }
      : {}),
  };
}

/**
 * Set by the Mac, and only by it, on a `daedal` it runs for a cloud session:
 * the host the call came from. The command then acts as the session named by
 * `DAEDALUS_SESSION_ID` only when that session runs on this host, and never
 * as a local session whose folder holds the mapped working directory.
 */
export const CLOUD_CALLER_VARIABLE = "DAEDALUS_CLOUD_CALLER";

/**
 * Set by the Mac next to `CLOUD_CALLER_VARIABLE`: the mark for text from
 * that cloud workspace, `[from cloud workspace final]`, which a hook event's
 * detail carries where the app shows it (N-5).
 */
export const CLOUD_MARK_VARIABLE = "DAEDALUS_CLOUD_MARK";

import type { DaedalusConfig } from "../config";
import { DaedalusError } from "../errors";
import { daedalusClaudeSettings } from "./hook-install";
import {
  CLAUDE_DEFAULT_RENDERER,
  isValidModelName,
  permissionModeArgs,
} from "./providers";

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

export function cloudClaudeArgs(
  config: DaedalusConfig,
  input: {
    sessionId: string;
    sessionName: string;
    model?: string;
    prompt?: string;
    acceptPeerMessages?: boolean;
    /** The conversation to resume instead of starting one. */
    resume?: string;
  },
): string[] {
  // The status line runs `daedal agent telemetry`, which reads files named
  // in its input. Those names are paths in the pod, so it is left out, and
  // no inbox hook either: the inbox is a pipe on this Mac.
  const { statusLine: _statusLine, ...settings } = daedalusClaudeSettings(
    CLOUD_DAEDAL,
    input.sessionId,
    { acceptPeerMessages: input.acceptPeerMessages },
  );
  const model = input.model?.trim();
  if (model && !isValidModelName(model))
    throw new DaedalusError("VALIDATION", "Model name is invalid");
  return [
    "--settings",
    JSON.stringify({ ...settings, tui: CLAUDE_DEFAULT_RENDERER }),
    ...permissionModeArgs("claude", config.agents.claude?.permissionMode),
    ...(model ? ["--model", model] : []),
    ...(input.resume
      ? ["--resume", input.resume]
      : [
          "--session-id",
          input.sessionId,
          "--name",
          input.sessionName,
          ...(input.prompt ? [input.prompt] : []),
        ]),
  ];
}

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

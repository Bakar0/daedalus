import { posix } from "node:path";
import type { Task, Workspace } from "../domain";
import { DaedalusError } from "../errors";
import { IN_CLOUD_MESSAGE } from "./cloud-launch";
import { isPodAccess, type PodAccess } from "./move-side";
import {
  sessionDirectoryName,
  sessionInstructionsTemplate,
  sessionTaskDirectoryName,
} from "./workspace-content";

/** The pod's workspace folder, as sessions there see it. */
export const POD_WORKSPACE = "/workspace";

export { IN_CLOUD_MESSAGE } from "./cloud-launch";

/** Refuses anything that would write this Mac's folder of a cloud workspace. */
export function requireOnMac(workspace: Pick<Workspace, "place">): void {
  if (workspace.place === "cloud")
    throw new DaedalusError("CONFLICT", IN_CLOUD_MESSAGE);
}

/** A session's instruction file as the pod holds it: the pod's paths. */
export const podSessionInstructions = (): string =>
  sessionInstructionsTemplate(POD_WORKSPACE);

/**
 * A session's folder in a cloud workspace's pod, named as `prepareSession`
 * names one on this Mac, with the same instruction file, written for the
 * pod's paths. Returns the folder relative to the workspace root.
 */
export async function preparePodSession(
  host: unknown,
  input: {
    task?: Pick<Task, "number" | "title">;
    sessionId: string;
    provider?: string;
    instructions: boolean;
  },
): Promise<string> {
  if (!isPodAccess(host))
    throw new DaedalusError(
      "DEPENDENCY",
      "The cloud workspace cannot take files from this Mac",
    );
  const pod: PodAccess = host;
  const group = input.task
    ? sessionTaskDirectoryName(input.task)
    : "unassigned";
  const short = posix.join("worktrees", group, sessionDirectoryName(input));
  const taken =
    (
      await pod.run({
        cwd: ".",
        executable: "test",
        args: ["-e", short],
      })
    ).exitCode === 0;
  const folder = taken
    ? posix.join("worktrees", group, input.sessionId)
    : short;
  const made = await pod.run({
    cwd: ".",
    executable: "mkdir",
    args: ["-p", "--", folder],
  });
  if (made.exitCode !== 0)
    throw new DaedalusError(
      "DEPENDENCY",
      `The cloud workspace could not make ${folder}: ${made.stderr.trim()}`,
    );
  if (input.instructions)
    await pod.writeFiles([
      {
        path: posix.join(folder, "AGENTS.md"),
        contents: new TextEncoder().encode(podSessionInstructions()),
      },
    ]);
  return folder;
}

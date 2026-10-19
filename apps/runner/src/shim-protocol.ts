import { join } from "node:path";
import { RUNNER_PATHS } from "@daedalus/remote-protocol";

/** What the shim sends over the Unix socket, one JSON line. */
export interface ShimRequest {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  queueable: boolean;
}

export const socketPath = (
  environment: NodeJS.ProcessEnv = process.env,
): string =>
  environment.DAEDALUS_RUNNER_SOCKET ?? join(RUNNER_PATHS.state, "shim.sock");

/** `daedal agent event ...` is a hook event and may wait for the Mac. */
export const isQueueable = (argv: string[]): boolean =>
  argv[0] === "agent" && argv[1] === "event";

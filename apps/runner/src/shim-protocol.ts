import { RUNNER_PATHS } from "@daedalus/remote-protocol";

/** What the shim sends over the Unix socket, one JSON line. */
export interface ShimRequest {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
}

export const socketPath = (
  environment: NodeJS.ProcessEnv = process.env,
): string => environment.DAEDALUS_RUNNER_SOCKET ?? RUNNER_PATHS.shimSocket;

/**
 * `daedal agent event ...` is a hook event and may wait for the Mac. The
 * runner decides this from the arguments; the shim does not say (N-4).
 */
export const isQueueable = (argv: string[]): boolean =>
  argv[0] === "agent" && argv[1] === "event";

/**
 * The only variables the shim forwards. Anything else with a `DAEDALUS_`
 * prefix, the runner token above all, stays out of the call, which the runner
 * writes to disk and sends to the Mac.
 */
export const FORWARDED_VARIABLES = [
  "DAEDALUS_SESSION_ID",
  "DAEDALUS_TASK_ID",
  "DAEDALUS_TASK_NUMBER",
  "DAEDALUS_WORKSPACE_ID",
] as const;

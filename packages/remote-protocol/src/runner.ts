import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@daedalus/protocol";

/**
 * The protocol between a user's Mac and the runner in one of their cloud
 * workspace pods. CONTRACT for cloud sessions stage 0: change it only through
 * the team lead.
 *
 * Transport: the gateway's relay, with the same binary frames as the phone
 * (`encodeRelayFrame`). Device ids are `mac:<macId>` and
 * `ws:<workspaceId>`. Security: the runner starts the Noise KK handshake with
 * `startHandshake` (the role a phone has), and the Mac answers with
 * `acceptHandshake`. Each side learns the other's static key from the gateway
 * once and pins it.
 *
 * Inside the secure channel the byte layout is the phone's: a kind byte of 0
 * then JSON, or 1 then a 4-byte channel number and raw terminal output
 * (`encodeTerminalOutput`).
 */

/** Paths are relative to the workspace root, which is `/workspace` in a pod. */
export type WorkspacePath = string;

export interface RunnerLaunch {
  /** The tmux session name, as the Mac's `AgentSession.tmuxSession`. */
  session: string;
  cwd: WorkspacePath;
  executable: string;
  args: string[];
  env?: Record<string, string>;
  /** Kept in the runner's memory only; never written to disk or logs. */
  secrets?: Record<string, string>;
  keepOnExit?: boolean;
}

export interface RunnerCommand {
  cwd: WorkspacePath;
  executable: string;
  args: string[];
  env?: Record<string, string>;
  secrets?: Record<string, string>;
  /** Default 10 minutes; the runner kills the command after it. */
  timeoutMs?: number;
}

export interface CommandResult {
  exitCode: number;
  /** UTF-8, cut to the last 1 MiB each. */
  stdout: string;
  stderr: string;
}

/** Mac to runner: what `SessionHost` needs, plus files and one-shot commands. */
export interface RunnerMethods {
  "host.probe": { params: null; result: { version: string } };
  "host.start": { params: RunnerLaunch; result: null };
  "host.isLive": { params: { session: string }; result: boolean };
  "host.listLive": { params: null; result: string[] };
  "host.capture": {
    params: { session: string; styled?: boolean };
    result: string;
  };
  "host.sendKeys": {
    params: { session: string; keys: string[] };
    result: null;
  };
  "host.send": { params: { session: string; text: string }; result: null };
  "host.stop": { params: { session: string; force?: boolean }; result: null };
  /** One-shot commands such as `git clone`; not in tmux. */
  "host.run": { params: RunnerCommand; result: CommandResult };
  "fs.write": {
    params: { files: { path: WorkspacePath; base64: string }[] };
    result: null;
  };
  "fs.read": {
    params: { path: WorkspacePath };
    /** null when the file does not exist. Files over 8 MiB are refused. */
    result: { base64: string } | null;
  };
}

/**
 * `daedal` run inside a pod. The pod's `daedal` is a shim that sends this to
 * the Mac, which runs the command against its own database with `cwd` mapped
 * onto its copy of the workspace, and replies with a `CommandResult`.
 */
export interface DaedalCall {
  /** Unique per call; the Mac ignores a call id it has already answered. */
  callId: string;
  argv: string[];
  cwd: WorkspacePath;
  /** Only the `DAEDALUS_*` variables of the calling process. */
  env: Record<string, string>;
  stdin?: string;
  /**
   * Set by the runner, from `argv`, for hook events (`daedal agent event
   * ...`). The runner queues these while the Mac is offline, on disk under
   * `/workspace/.daedalus-runner/queue.jsonl`, and replays them in order when
   * the Mac reconnects. Any other call fails at once while the Mac is offline,
   * with exit code 75 and "Daedalus on the Mac is offline".
   */
  queueable: boolean;
  /** When the call was made, ISO 8601, so a replayed event keeps its time. */
  at: string;
}

/** Runner to Mac. */
export interface MacMethods {
  "daedal.call": { params: DaedalCall; result: CommandResult };
}

export type RunnerMethod = keyof RunnerMethods;
export type MacMethod = keyof MacMethods;

export type RunnerSecureMessage =
  | { t: "req"; id: number; method: RunnerMethod | MacMethod; params: unknown }
  | { t: "res"; id: number; result: unknown }
  | { t: "err"; id: number; code: string; message: string }
  /** A tmux session ended. */
  | { t: "session.exited"; session: string; exitCode: number | null }
  /** Opens a terminal on a session; output arrives as kind-1 frames. */
  | {
      t: "term.open";
      ch: number;
      session: string;
      cols: number;
      rows: number;
    }
  | { t: "term.client"; ch: number; message: TerminalClientMessage }
  | { t: "term.server"; ch: number; message: TerminalServerMessage }
  | { t: "term.close"; ch: number };

export const encodeRunnerMessage = (
  message: RunnerSecureMessage,
): Uint8Array => {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const out = new Uint8Array(1 + body.length);
  out[0] = 0;
  out.set(body, 1);
  return out;
};

/**
 * Pod layout the runner, gateway and chart share. Two containers from one
 * image (artifacts/cloud-sessions/h1-pod-spec.md): `runner` (uid 1000) holds
 * the relay link, token, identity and queue; `session` (uid 1001) runs
 * `sessiond`, which owns tmux and does all workspace work. Neither runs the
 * other's code, and the runner treats every `sessiond` reply as untrusted.
 */
export const RUNNER_PATHS = {
  /** Session container only. */
  workspace: "/workspace",
  /** Session container only. */
  cache: "/cache",
  /** Runner container only, on PVC `ws-<id>-state`: identity key, event queue. */
  state: "/var/lib/daedalus-runner",
  /** Runner container only: the runner token, from Secret `ws-<id>-runner`. */
  token: "/run/daedalus-token/token",
  /**
   * An `emptyDir` both containers mount, for Unix sockets: S3 Files and other
   * network file systems cannot hold them.
   */
  runtime: "/run/daedalus-runner",
  /**
   * Where the runner listens for the `daedal` shim: in a folder the runner
   * makes and owns (mode 0755), so the session container cannot take the
   * path first.
   */
  shimSocket: "/run/daedalus-runner/runner/daedal.sock",
  /** Where `sessiond` listens for the runner. */
  sessionSocket: "/run/daedalus-runner/session.sock",
} as const;

/**
 * Environment the gateway's controller gives the runner container. Nothing
 * secret: the token is a file at `RUNNER_PATHS.token`.
 */
export const RUNNER_ENV = {
  gatewayUrl: "DAEDALUS_GATEWAY_URL",
  workspaceId: "DAEDALUS_WORKSPACE_ID",
  macId: "DAEDALUS_MAC_ID",
  macKey: "DAEDALUS_MAC_KEY",
  /** Minutes with no live session and no open terminal before the runner asks to sleep. */
  idleMinutes: "DAEDALUS_WORKSPACE_IDLE_MINUTES",
} as const;

/**
 * The gateway's HTTP and WebSocket API. CONTRACT for cloud sessions stage 0:
 * change it only through the team lead.
 *
 * The gateway is one service: a relay (rooms keyed by user, not by Mac) and a
 * controller that creates and deletes workspace pods. Every request is scoped
 * to the signed-in user. Another user's workspace answers 404, never 403, so
 * its existence does not leak.
 *
 * Auth: `Authorization: Bearer <token>` on every request, including the
 * WebSocket upgrade. A user token comes from sign-in; a runner token is made
 * by the controller per workspace and given to the pod as a Kubernetes
 * Secret. The gateway stores only SHA-256 hashes of tokens.
 *
 * Routes:
 *
 *   POST   /v1/dev/login            DevLoginRequest -> DevLoginResponse
 *                                   only when the chart sets gateway.devLogin
 *   GET    /v1/me                   -> GatewayUser
 *   POST   /v1/workspaces           CreateWorkspaceRequest -> CloudWorkspace (201)
 *   GET    /v1/workspaces           -> { workspaces: CloudWorkspace[] }
 *   GET    /v1/workspaces/:id       -> CloudWorkspace
 *   POST   /v1/workspaces/:id/wake  -> CloudWorkspace
 *   POST   /v1/workspaces/:id/sleep -> CloudWorkspace
 *                                   Also allowed with a runner token, for
 *                                   its own workspace only: the runner's
 *                                   idle sleep. Another id is 404; every
 *                                   other route with a runner token is 401.
 *   DELETE /v1/workspaces/:id       -> 204; deletes the pod, its volume and token
 *
 * Collection: a workspace asleep DAEDALUS_WORKSPACE_ASLEEP_DAYS (30) is
 * deleted as DELETE does; a `u-<userId>` namespace labelled for a user with no
 * workspace left goes too.
 *   GET    /v1/connect              WebSocket. A user token joins as
 *                                   `mac:<macId>` (query `macId`); a runner
 *                                   token joins as `ws:<workspaceId>` and
 *                                   sends its static key as query
 *                                   `runnerKey`. The first key is stored; a
 *                                   different key later is refused (CONFLICT).
 *   GET    /health                  -> 200 "ok", no auth
 *
 * Errors: JSON `{ error: { code, message } }` with codes VALIDATION (400),
 * UNAUTHORIZED (401), NOT_FOUND (404), CONFLICT (409), QUOTA (429), INTERNAL
 * (500).
 *
 * Relay notices reuse `RelayNotice` from frames.ts; `peer` tells the Mac when
 * a runner comes online or goes away, and the runner when the Mac does.
 */

export interface DevLoginRequest {
  email: string;
}

export interface DevLoginResponse {
  user: GatewayUser;
  token: string;
}

export interface GatewayUser {
  /** Lowercase letters and digits, at most 20; the namespace is `u-<id>`. */
  id: string;
  email: string;
}

export interface CreateWorkspaceRequest {
  /** The Mac's workspace UUID. Unique per user, not across users. */
  workspaceId: string;
  name: string;
  macId: string;
  /** The Mac's static public key, base64, given to the runner to pin. */
  macKey: string;
  /** Defaults come from the chart's workspace.resources. */
  resources?: { cpu?: string; memory?: string };
}

export type CloudWorkspaceStatus =
  "starting" | "running" | "sleeping" | "failed";

export interface CloudWorkspace {
  workspaceId: string;
  name: string;
  status: CloudWorkspaceStatus;
  /** Why it failed, for the user; null otherwise. */
  reason: string | null;
  /** Whether the runner is connected to the relay right now. */
  runnerOnline: boolean;
  /**
   * The runner's static public key, base64, once the runner has connected
   * for the first time; the Mac pins it. Null before then.
   */
  runnerKey: string | null;
  createdAt: string;
  /** When it went to sleep, while asleep; a long sleep deletes it. */
  sleptAt?: string | null;
}

export type GatewayErrorCode =
  | "VALIDATION"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "QUOTA"
  | "INTERNAL";

export interface GatewayError {
  error: { code: GatewayErrorCode; message: string };
}

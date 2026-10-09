import type { Room } from "./room";

export interface Env {
  DB: D1Database;
  ROOMS: DurableObjectNamespace<Room>;
  /** Shared secret for the admin routes. Unset means no admin access. */
  ADMIN_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Overridable so the local check can stand in for Google. */
  GOOGLE_AUTH_URL?: string;
  GOOGLE_TOKEN_URL?: string;
  /** Comma-separated origins a sign-in may return to. */
  APP_ORIGINS?: string;
}

/** Device and room ids: 16 random bytes in base64url, from the devices. */
export const ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Sent by every client, and echoed, so browsers accept the upgrade. */
export const PROTOCOL = "daedalus.v1";

export const nowIso = (): string => new Date().toISOString();

export function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return base64url(new Uint8Array(digest));
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++)
    difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export const json = (data: unknown, status = 200): Response =>
  Response.json(data, { status });

export const fail = (status: number, code: string, message: string): Response =>
  json({ ok: false, error: { code, message } }, status);

export function bearer(request: Request): string | undefined {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
}

/**
 * Browsers cannot set headers on a WebSocket, so the token travels as a
 * subprotocol, `auth.<token>`, next to `daedalus.v1`.
 */
export function protocolToken(request: Request): {
  hasProtocol: boolean;
  token?: string;
} {
  const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((value) => value.trim());
  const auth = offered.find((value) => value.startsWith("auth."));
  return {
    hasProtocol: offered.includes(PROTOCOL),
    ...(auth ? { token: auth.slice(5) } : {}),
  };
}

/**
 * Close codes the clients act on. A refused connection is accepted and then
 * closed with one of these, because a browser cannot read an HTTP status
 * from a failed upgrade.
 */
export const CLOSE = {
  replaced: 4000,
  claimed: 4001,
  unauthorized: 4401,
  noEntitlement: 4402,
  forbidden: 4403,
  overQuota: 4429,
} as const;

export function refuse(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, reason);
  return new Response(null, {
    status: 101,
    webSocket: pair[0],
    headers: { "Sec-WebSocket-Protocol": PROTOCOL },
  });
}

export const currentMonth = (date = new Date()): string =>
  date.toISOString().slice(0, 7);

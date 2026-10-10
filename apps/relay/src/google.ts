import { activeEntitlement, createSession, redeemInvite } from "./accounts";
import {
  base64url,
  type Env,
  fail,
  ID,
  isDev,
  nowIso,
  randomToken,
  sha256,
} from "./util";

/**
 * Google sign-in, authorization code flow with PKCE. The phone page sends
 * the user to `/auth/google/start`; Google returns them to
 * `/auth/google/callback`, which sends them back to the page with a session
 * token in the URL fragment (fragments never reach a server log).
 *
 * The ID token comes straight from Google's token endpoint over TLS, in
 * exchange for a code and the client secret, so its claims are trusted
 * without checking its signature (OpenID Connect Core 3.1.3.7).
 *
 * A new account needs an invite code. Without one, nothing is stored.
 *
 * The start sets a cookie holding a random nonce and keeps its hash with
 * the state; the callback needs the same cookie. A callback URL made by
 * someone else, from a sign-in they started, does not work in another
 * browser (login CSRF).
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const STATE_MINUTES = 10;
const COOKIE = "__Host-daedalus-signin";

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

const redirect = (location: string, setCookie: string): Response =>
  new Response(null, {
    status: 302,
    headers: { Location: location, "Set-Cookie": setCookie },
  });

const clearCookie = `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

function allowedReturn(env: Env, returnTo: string): boolean {
  let origin: string;
  try {
    origin = new URL(returnTo).origin;
  } catch {
    return false;
  }
  return (env.APP_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(origin);
}

const callbackUrl = (request: Request) =>
  new URL("/auth/google/callback", request.url).toString();

function back(returnTo: string, fragment: Record<string, string>): Response {
  const url = new URL(returnTo);
  url.hash = new URLSearchParams(fragment).toString();
  return redirect(url.toString(), clearCookie);
}

export async function googleStart(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
    return fail(503, "NOT_CONFIGURED", "Google sign-in is not set up.");
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("return") ?? "";
  if (!allowedReturn(env, returnTo))
    return fail(400, "BAD_RETURN", "That return address is not allowed.");
  const invite = url.searchParams.get("invite")?.trim() || null;
  const device = url.searchParams.get("device") ?? "";

  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(48);
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  await env.DB.prepare(
    "INSERT INTO oauth_states (state, verifier, return_to, invite, expires_at, browser_hash, device_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      state,
      verifier,
      returnTo,
      invite,
      new Date(Date.now() + STATE_MINUTES * 60_000).toISOString(),
      await sha256(nonce),
      ID.test(device) ? device : null,
    )
    .run();
  // Old abandoned sign-ins are swept as new ones start.
  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?")
    .bind(nowIso())
    .run();

  const google = new URL((isDev(env) && env.GOOGLE_AUTH_URL) || AUTH_URL);
  google.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(request),
    response_type: "code",
    scope: "openid email",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return redirect(
    google.toString(),
    `${COOKIE}=${nonce}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${STATE_MINUTES * 60}`,
  );
}

interface IdClaims {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  exp?: number;
}

function claims(idToken: string): IdClaims {
  const payload = idToken.split(".")[1] ?? "";
  const padded = payload.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
    ),
  ) as IdClaims;
}

export async function googleCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const nonce = cookie(request, COOKIE) ?? "";
  const pending = await env.DB.prepare(
    "DELETE FROM oauth_states WHERE state = ? AND expires_at > ? AND browser_hash = ? RETURNING verifier, return_to AS returnTo, invite, device_id AS deviceId",
  )
    .bind(state, nowIso(), await sha256(nonce))
    .first<{
      verifier: string;
      returnTo: string;
      invite: string | null;
      deviceId: string | null;
    }>();
  if (!pending)
    return fail(
      400,
      "BAD_STATE",
      "This sign-in expired or was started in another browser. Start again.",
    );
  const code = url.searchParams.get("code");
  if (!code) return back(pending.returnTo, { error: "cancelled" });

  const exchange = await fetch(
    (isDev(env) && env.GOOGLE_TOKEN_URL) || TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID ?? "",
        client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
        redirect_uri: callbackUrl(request),
        grant_type: "authorization_code",
        code_verifier: pending.verifier,
      }),
    },
  );
  if (!exchange.ok) return back(pending.returnTo, { error: "google_failed" });
  const { id_token: idToken } = (await exchange.json()) as {
    id_token?: string;
  };
  const identity = idToken ? claims(idToken) : {};
  if (
    !identity.sub ||
    !identity.email ||
    identity.email_verified !== true ||
    identity.aud !== env.GOOGLE_CLIENT_ID ||
    !ISSUERS.has(identity.iss ?? "") ||
    (identity.exp ?? 0) * 1000 < Date.now()
  )
    return back(pending.returnTo, { error: "google_failed" });

  let user = await env.DB.prepare("SELECT id FROM users WHERE google_sub = ?")
    .bind(identity.sub)
    .first<{ id: string }>();
  if (!user) {
    if (!pending.invite)
      return back(pending.returnTo, { error: "invite_required" });
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(id, identity.sub, identity.email, nowIso())
      .run();
    if (!(await redeemInvite(env.DB, id, pending.invite))) {
      await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
      return back(pending.returnTo, { error: "invite_invalid" });
    }
    user = { id };
  } else {
    await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?")
      .bind(identity.email, user.id)
      .run();
    if (pending.invite && !(await activeEntitlement(env.DB, user.id)))
      await redeemInvite(env.DB, user.id, pending.invite);
  }
  return back(pending.returnTo, {
    token: await createSession(env.DB, user.id, pending.deviceId),
  });
}

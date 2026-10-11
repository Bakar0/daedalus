import { approveUnlock, unlockPending } from "./admin";
import {
  activeEntitlement,
  claimKeyValid,
  claimMac,
  countActiveDevices,
  createSession,
  device as deviceById,
  redeemInvite,
} from "./accounts";
import {
  base64url,
  type Env,
  fail,
  ID,
  isDev,
  nowIso,
  randomToken,
  room,
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
 * Anyone can make an account; without a plan it cannot connect anything.
 * An invite code given at sign-in is redeemed on the way.
 *
 * A Mac signs in the same way, in the browser: Daedalus opens
 * `/auth/google/start?mac=<id>&claim=<key>` with the claim key of a code it
 * just registered, and the callback puts the Mac on the account that signed
 * in and shows a page that says to go back to the Mac.
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
  // Sudo mode: this sign-in approves an admin unlock (see admin.ts).
  const unlockHash = url.searchParams.get("unlock") ?? "";
  if (unlockHash && !(await unlockPending(env, unlockHash)))
    return macPage(
      "Unlock expired",
      "Go back to Daedalus on your Mac and click Unlock again.",
      400,
    );
  const macId = url.searchParams.get("mac") ?? "";
  let macClaimHash: string | null = null;
  if (macId) {
    const mac = ID.test(macId) ? await deviceById(env.DB, macId) : undefined;
    const claim = url.searchParams.get("claim") ?? "";
    if (
      !mac ||
      mac.kind !== "mac" ||
      mac.revokedAt ||
      mac.userId ||
      !(await claimKeyValid(mac, claim))
    )
      return macPage(
        "Sign-in expired",
        "Go back to Daedalus on your Mac and click Sign in again.",
        400,
      );
    macClaimHash = mac.claimHash;
  }
  const fromMac = Boolean(macId || unlockHash);
  const returnTo = fromMac ? "" : (url.searchParams.get("return") ?? "");
  if (!fromMac && !allowedReturn(env, returnTo))
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
    "INSERT INTO oauth_states (state, verifier, return_to, invite, expires_at, browser_hash, device_id, mac_id, mac_claim_hash, mac_name, unlock_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      state,
      verifier,
      returnTo,
      invite,
      new Date(Date.now() + STATE_MINUTES * 60_000).toISOString(),
      await sha256(nonce),
      ID.test(device) ? device : null,
      macId || null,
      macClaimHash,
      macId ? (url.searchParams.get("name") ?? "").slice(0, 80) : null,
      unlockHash || null,
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
    // An unlock always shows the chooser and the consent screen, so it
    // cannot finish without someone clicking through it.
    prompt: unlockHash ? "select_account consent" : "select_account",
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
    `DELETE FROM oauth_states WHERE state = ? AND expires_at > ? AND browser_hash = ?
     RETURNING verifier, return_to AS returnTo, invite, device_id AS deviceId,
       mac_id AS macId, mac_claim_hash AS macClaimHash, mac_name AS macName,
       unlock_hash AS unlockHash`,
  )
    .bind(state, nowIso(), await sha256(nonce))
    .first<Pending>();
  if (!pending)
    return fail(
      400,
      "BAD_STATE",
      "This sign-in expired or was started in another browser. Start again.",
    );
  const code = url.searchParams.get("code");
  if (!code) return finish(pending, { error: "cancelled" });

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
  if (!exchange.ok) return finish(pending, { error: "google_failed" });
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
    return finish(pending, { error: "google_failed" });

  let user = await env.DB.prepare("SELECT id FROM users WHERE google_sub = ?")
    .bind(identity.sub)
    .first<{ id: string }>();
  // An unlock changes no account: it only approves, or not.
  if (pending.unlockHash) {
    const result = await approveUnlock(env, pending.unlockHash, user?.id);
    return macPage(result.title, result.body, result.ok ? 200 : 403);
  }
  if (!user) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(id, identity.sub, identity.email, nowIso())
      .run();
    user = { id };
  } else {
    await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?")
      .bind(identity.email, user.id)
      .run();
  }
  if (pending.invite && !(await activeEntitlement(env.DB, user.id)))
    await redeemInvite(env.DB, user.id, pending.invite);

  if (pending.macId) return macSignedIn(env, pending, user.id, identity.email);
  return back(pending.returnTo, {
    token: await createSession(env.DB, user.id, pending.deviceId),
  });
}

interface Pending {
  verifier: string;
  returnTo: string;
  invite: string | null;
  deviceId: string | null;
  macId: string | null;
  macClaimHash: string | null;
  macName: string | null;
  unlockHash: string | null;
}

/** Ends a sign-in that failed: back to the phone page, or a page for a Mac. */
function finish(pending: Pending, fragment: { error: string }): Response {
  if (!pending.macId && !pending.unlockHash)
    return back(pending.returnTo, fragment);
  return macPage(
    fragment.error === "cancelled" ? "Sign-in cancelled" : "Sign-in failed",
    `Go back to Daedalus on your Mac and click ${pending.unlockHash ? "Unlock" : "Sign in"} again.`,
    400,
  );
}

/** Puts the Mac that started this sign-in on the account, and says so. */
async function macSignedIn(
  env: Env,
  pending: Pending,
  userId: string,
  email: string,
): Promise<Response> {
  const mac = await deviceById(env.DB, pending.macId ?? "");
  if (
    !mac ||
    mac.revokedAt ||
    mac.userId ||
    !pending.macClaimHash ||
    mac.claimHash !== pending.macClaimHash
  )
    return macPage(
      "Sign-in expired",
      "Go back to Daedalus on your Mac and click Sign in again.",
      400,
    );
  const plan = await activeEntitlement(env.DB, userId);
  if (plan && (await countActiveDevices(env.DB, userId, "mac")) >= plan.maxMacs)
    return macPage(
      "Too many Macs",
      `${email} already has ${plan.maxMacs} Macs, the most its plan allows. Remove one from the account, then sign in again.`,
      403,
    );
  const token = await claimMac(env.DB, mac, userId, pending.macName ?? "");
  if (!token)
    return macPage(
      "Sign-in expired",
      "Go back to Daedalus on your Mac and click Sign in again.",
      409,
    );
  await room(env, mac.id).fetch("https://room/claimed", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  return macPage(
    "Your Mac is signed in",
    `Daedalus on your Mac is now signed in as ${email}. ${
      plan
        ? "Go back to it to pair your phone."
        : "Phone access needs Daedalus Pro: go back to it to enter an invite code."
    } You can close this tab.`,
  );
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** The page a Mac's sign-in ends on, in the browser. */
function macPage(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Daedalus</title><style>
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#141821;--muted:#5b6475}
@media (prefers-color-scheme:dark){:root{--bg:#0d1220;--fg:#eef1f6;--muted:#9aa4b8}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
main{max-width:420px;padding:32px 24px;text-align:center}img{width:72px;height:72px}h1{font-size:24px;margin:16px 0 8px}p{color:var(--muted);margin:0}
</style></head><body><main><img alt="" src="/icon-192.png"><h1>${escape(title)}</h1><p>${escape(body)}</p></main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": clearCookie,
      },
    },
  );
}

import {
  activeEntitlement,
  bindSession,
  claimKeyValid,
  claimMac,
  countActiveDevices,
  type Device,
  type Entitlement,
  deleteSession,
  device,
  emailOf,
  redeemInvite,
  sessionFor,
  type User,
  userDevices,
  userForSession,
} from "./accounts";
import {
  type AdminAction,
  adminAction,
  adminFor,
  createUnlock,
  KEY_ACTOR,
  lockAdmin,
  unlockedUntil,
} from "./admin";
import { googleCallback, googleStart } from "./google";
import { budget, budgetUsd, overageUsd } from "./budget";
import { allowedEndpoint, sendPush } from "./push";
import {
  bearer,
  CLOSE,
  constantTimeEqual,
  currentMonth,
  type Env,
  fail,
  ID,
  isDev,
  json,
  misconfigured,
  nowIso,
  protocolToken,
  randomToken,
  refuse,
  room,
  sha256,
} from "./util";

export { Budget } from "./budget";
export { Room } from "./room";

/**
 * The Daedalus relay: phone accounts (Google sign-in plus an entitlement),
 * Mac claiming, device revocation, admin routes, and the WebSocket entry
 * that admits a device into its Mac's room. See `room.ts` for forwarding.
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      if (misconfigured(env))
        return fail(503, "MISCONFIGURED", "DEV_MODE is set on a live relay.");
      if (route === "GET /health") return new Response("ok");
      if (route === "GET /v1/connect") return await connect(request, env);
      // Every other API request counts toward the budget; connects count
      // themselves, since they also need its answer.
      ctx.waitUntil(
        budget(env)
          .add({ workerRequests: 1 })
          .catch(() => {}),
      );
      if (url.pathname.startsWith("/auth/")) {
        if (!(await authAllowed(env, request)))
          return fail(
            429,
            "RATE_LIMITED",
            "Too many sign-in attempts. Wait a minute.",
          );
        if (route === "GET /auth/google/start")
          return await googleStart(request, env);
        if (route === "GET /auth/google/callback")
          return await googleCallback(request, env);
      }
      if (route === "POST /v1/push/notify")
        return await pushNotify(request, env);
      if (url.pathname.startsWith("/v1/macs/"))
        return await macRoutes(request, env, route);
      if (url.pathname.startsWith("/admin/"))
        return await admin(request, env, route);
      if (url.pathname.startsWith("/v1/"))
        return await account(request, env, route);
      return fail(404, "NOT_FOUND", "Not found");
    } catch (error) {
      console.error(error);
      return fail(500, "INTERNAL", "Something went wrong.");
    }
  },
  /** Hourly: drop stale rows, and the watchdog (see `watchdog`). */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(housekeeping(env));
  },
} satisfies ExportedHandler<Env>;

/** The limit on sign-ins, invite codes and claims, per IP. */
function authAllowed(env: Env, request: Request): Promise<boolean> {
  if (isDev(env) && env.AUTH_LIMIT_OFF === "1") return Promise.resolve(true);
  return allowed(env.AUTH_LIMITER, request);
}

/** Per IP, for requests made before anyone is known. */
async function allowed(limiter: RateLimit, request: Request): Promise<boolean> {
  const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return (await limiter.limit({ key })).success;
}

async function housekeeping(env: Env): Promise<void> {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  await env.DB.batch([
    // A Mac nobody claimed within a day is a QR code nobody scanned.
    env.DB.prepare(
      "DELETE FROM devices WHERE kind = 'mac' AND user_id IS NULL AND created_at < ?",
    ).bind(dayAgo),
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(
      nowIso(),
    ),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowIso()),
    env.DB.prepare("DELETE FROM admin_unlocks WHERE expires_at < ?").bind(
      nowIso(),
    ),
    // Keys that cannot be used any more; their accounts show their plans.
    env.DB.prepare(
      "DELETE FROM invites WHERE used >= max_uses OR expires_at < ?",
    ).bind(nowIso()),
  ]);
  await watchdog(env);
}

/**
 * The cap's last layer, in case the count itself is wrong: Cloudflare's own
 * analytics for the month, priced. Past the budget it closes the relay;
 * past twice the budget it takes the relay off workers.dev altogether, which
 * stops all traffic until someone turns it back on. Needs CF_ACCOUNT_ID and
 * CF_WATCHDOG_TOKEN (Workers Scripts edit, Account Analytics read); without
 * them it does nothing.
 */
async function watchdog(env: Env): Promise<void> {
  if (!env.CF_ACCOUNT_ID || !env.CF_WATCHDOG_TOKEN) return;
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_WATCHDOG_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
        durableObjectsInvocationsAdaptiveGroups(limit:1000,filter:{datetime_geq:$s,datetime_lt:$e}){sum{requests}}
        workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:$s,datetime_lt:$e}){sum{requests}}}}}`,
      variables: { a: env.CF_ACCOUNT_ID, s: monthStart, e: now.toISOString() },
    }),
  });
  if (!response.ok) return;
  const data = (await response.json()) as {
    data?: {
      viewer?: {
        accounts?: Array<{
          durableObjectsInvocationsAdaptiveGroups?: Array<{
            sum: { requests: number };
          }>;
          workersInvocationsAdaptive?: Array<{ sum: { requests: number } }>;
        }>;
      };
    };
  };
  const account = data.data?.viewer?.accounts?.[0];
  if (!account) return;
  const sum = (rows?: Array<{ sum: { requests: number } }>) =>
    (rows ?? []).reduce((total, row) => total + row.sum.requests, 0);
  // Analytics count every WebSocket message as a request, not one in 20, so
  // this overestimates: the watchdog errs on the side of closing.
  const spent = overageUsd({
    doRequests: sum(account.durableObjectsInvocationsAdaptiveGroups),
    frames: 0,
    workerRequests: sum(account.workersInvocationsAdaptive),
  });
  const limit = budgetUsd(env);
  if (spent < limit) return;
  await closeEverything(env, "watchdog");
  if (spent >= 2 * limit)
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/daedalus-relay/subdomain`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.CF_WATCHDOG_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      },
    );
}

/** Closes the budget and every connected room at once. */
async function closeEverything(env: Env, by: string): Promise<void> {
  await budget(env).close(by);
  const { results } = await env.DB.prepare(
    "SELECT id FROM devices WHERE kind = 'mac' AND user_id IS NOT NULL AND revoked_at IS NULL",
  ).all<{ id: string }>();
  for (const mac of results)
    await room(env, mac.id).fetch("https://room/kick", {
      method: "POST",
      body: JSON.stringify({ code: CLOSE.budgetExhausted }),
    });
}

/**
 * Admits a device to a Mac's room, or accepts and closes it with a code the
 * client acts on (see `CLOSE`).
 *
 * - A Mac with a device token joins its room as its account. A Mac with no
 *   token joins as unclaimed, which lets it wait for a phone to claim it and
 *   nothing else, unless it was claimed before: then the token is required.
 * - A phone needs a session, an active entitlement, and a Mac of the same
 *   account. Its first connection registers it, within the plan's limit.
 */
async function connect(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket")
    return fail(426, "UPGRADE", "Expected a WebSocket upgrade");
  const url = new URL(request.url);
  const macId = url.searchParams.get("room") ?? "";
  const role = url.searchParams.get("role");
  const deviceId = url.searchParams.get("device") ?? "";
  const { hasProtocol, token } = protocolToken(request);
  if (
    !hasProtocol ||
    !ID.test(macId) ||
    !ID.test(deviceId) ||
    (role !== "mac" && role !== "phone") ||
    (role === "mac" && deviceId !== macId)
  )
    return fail(400, "BAD_CONNECT", "Bad connect request");
  // This request and the room's: both count, and the answer is whether the
  // relay is still inside its monthly budget.
  if (!(await budget(env).add({ workerRequests: 1, doRequests: 1 })).open)
    return refuse(
      CLOSE.budgetExhausted,
      "Remote access is paused until the 1st",
    );

  let userId: string | null = null;
  let email = "";
  let plan: Entitlement | undefined;
  const mac = await device(env.DB, macId);
  if (role === "mac") {
    if (mac && mac.kind !== "mac") return refuse(CLOSE.forbidden, "Not a Mac");
    if (mac?.revokedAt) return refuse(CLOSE.unauthorized, "Device revoked");
    if (mac?.userId) {
      if (!token || (await sha256(token)) !== mac.tokenHash)
        return refuse(CLOSE.unauthorized, "Device token required");
      plan = await activeEntitlement(env.DB, mac.userId);
      if (!plan) return refuse(CLOSE.noEntitlement, "No active access");
      userId = mac.userId;
      email =
        (
          await env.DB.prepare("SELECT email FROM users WHERE id = ?")
            .bind(userId)
            .first<{ email: string }>()
        )?.email ?? "";
    } else if (!(await allowed(env.UNCLAIMED_LIMITER, request))) {
      // Unclaimed Macs connect with no sign-in, so they are limited per IP.
      return refuse(CLOSE.rateLimited, "Too many new Macs from here");
    } else {
      // An unclaimed Mac proves it is the same Mac with a secret of its own,
      // registered on its first connection, before its id was ever shown.
      // Someone who read the id off a QR code cannot take its place.
      if (!token) return refuse(CLOSE.unauthorized, "Device secret required");
      const hash = await sha256(token);
      if (!mac)
        await env.DB.prepare(
          "INSERT INTO devices (id, user_id, kind, token_hash, created_at) VALUES (?, NULL, 'mac', ?, ?)",
        )
          .bind(macId, hash, nowIso())
          .run();
      else if (!mac.tokenHash)
        await env.DB.prepare(
          "UPDATE devices SET token_hash = ? WHERE id = ? AND token_hash IS NULL",
        )
          .bind(hash, macId)
          .run();
      else if (hash !== mac.tokenHash)
        return refuse(CLOSE.unauthorized, "Device secret does not match");
    }
  } else {
    const session = await sessionFor(env.DB, token);
    if (!session) return refuse(CLOSE.unauthorized, "Sign in again");
    const { user } = session;
    // A sign-in is one phone's: a copied token cannot add other phones.
    if (session.deviceId && session.deviceId !== deviceId)
      return refuse(CLOSE.forbidden, "This sign-in belongs to another phone");
    const entitlement = await activeEntitlement(env.DB, user.id);
    if (!entitlement) return refuse(CLOSE.noEntitlement, "No active access");
    if (!mac || mac.userId !== user.id || mac.revokedAt)
      return refuse(CLOSE.forbidden, "That Mac is not on this account");
    const phone = await device(env.DB, deviceId);
    if (phone && phone.kind !== "phone")
      return refuse(CLOSE.forbidden, "Not a phone");
    // A phone removed from its account comes back only with a Google
    // sign-in made on it after the removal: the sign-ins it had ended with
    // it, so a lost phone stays out, and its owner can add it back.
    const returning = Boolean(phone?.userId === user.id && phone.revokedAt);
    if (
      returning &&
      (session.deviceId !== deviceId ||
        session.createdAt <= (phone?.revokedAt ?? ""))
    )
      return refuse(
        CLOSE.forbidden,
        "This phone was removed. Sign in again on it to add it back",
      );
    // A phone is on one account at a time. Signed in to another account on
    // this same phone (the sign-in names it), it moves there: the account
    // it leaves loses it and its sign-ins on it.
    const moving = Boolean(phone && phone.userId !== user.id);
    if (moving && session.deviceId !== deviceId)
      return refuse(CLOSE.forbidden, "This phone is on another account");
    if (!phone || moving || returning) {
      if (
        (await countActiveDevices(env.DB, user.id, "phone")) >=
        entitlement.maxPhones
      )
        return refuse(CLOSE.forbidden, "Phone limit reached");
      const name = url.searchParams.get("name")?.slice(0, 80) ?? "";
      if (returning)
        await env.DB.prepare(
          "UPDATE devices SET name = ?, claimed_at = ?, revoked_at = NULL WHERE id = ?",
        )
          .bind(name, nowIso(), deviceId)
          .run();
      else if (moving)
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE devices SET user_id = ?, name = ?, claimed_at = ?, revoked_at = NULL WHERE id = ?",
          ).bind(user.id, name, nowIso(), deviceId),
          env.DB.prepare(
            "DELETE FROM sessions WHERE device_id = ? AND user_id != ?",
          ).bind(deviceId, user.id),
        ]);
      else
        await env.DB.prepare(
          "INSERT INTO devices (id, user_id, kind, name, created_at, claimed_at) VALUES (?, ?, 'phone', ?, ?, ?)",
        )
          .bind(deviceId, user.id, name, nowIso(), nowIso())
          .run();
    }
    if (!session.deviceId)
      await bindSession(env.DB, session.tokenHash, deviceId);
    userId = user.id;
  }
  await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
    .bind(nowIso(), deviceId)
    .run();

  const headers = new Headers(request.headers);
  headers.set("X-Daedalus-Role", role);
  headers.set("X-Daedalus-Device", deviceId);
  headers.set("X-Daedalus-User", userId ?? "");
  headers.set("X-Daedalus-Email", email);
  // A claimed Mac shows its account's plan, and when it ends.
  headers.set("X-Daedalus-Plan", plan?.plan ?? "");
  headers.set("X-Daedalus-Plan-Expires", plan?.expiresAt ?? "");
  return room(env, macId).fetch(new Request(request, { headers }));
}

/** Pushes at most this often per account; later asks within it are dropped. */
const PUSH_INTERVAL_MS = 15_000;

/**
 * A Mac asking for its account's phones to be told a session needs them. It
 * proves itself with its device token. The push carries nothing.
 */
async function pushNotify(request: Request, env: Env): Promise<Response> {
  const mac = await macFrom(request, env);
  if (!mac?.userId) return fail(401, "UNAUTHORIZED", "Device token required.");
  if (!(await activeEntitlement(env.DB, mac.userId)))
    return fail(402, "NO_ENTITLEMENT", "This account has no active access.");
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK)
    return fail(503, "NOT_CONFIGURED", "Notifications are not set up.");
  if (!(await budget(env).status()).open)
    return fail(503, "PAUSED", "Remote access is paused until the 1st.");
  // One push per window per account, claimed in one statement so two Macs
  // asking at once send one push.
  const cutoff = new Date(Date.now() - PUSH_INTERVAL_MS).toISOString();
  const claimed = await env.DB.prepare(
    `INSERT INTO push_state (user_id, last_sent_at) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET last_sent_at = excluded.last_sent_at
     WHERE push_state.last_sent_at < ?`,
  )
    .bind(mac.userId, nowIso(), cutoff)
    .run();
  if (!claimed.meta.changes)
    return json({ ok: true, data: { sent: 0, throttled: true } });
  const { results } = await env.DB.prepare(
    `SELECT push_subscriptions.device_id AS deviceId, endpoint FROM push_subscriptions
     JOIN devices ON devices.id = push_subscriptions.device_id
     WHERE push_subscriptions.user_id = ? AND devices.revoked_at IS NULL`,
  )
    .bind(mac.userId)
    .all<{ deviceId: string; endpoint: string }>();
  const keys = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateJwk: env.VAPID_PRIVATE_JWK,
    subject: env.VAPID_SUBJECT ?? new URL(request.url).origin,
  };
  let sent = 0;
  for (const subscription of results) {
    const outcome = await sendPush(subscription.endpoint, keys).catch(() => ({
      ok: false,
      gone: false,
      status: 0,
    }));
    if (outcome.ok) sent += 1;
    if (outcome.gone)
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE device_id = ?")
        .bind(subscription.deviceId)
        .run();
  }
  return json({ ok: true, data: { sent, throttled: false } });
}

/**
 * A Mac proving itself over HTTP: its id, and its device token (claimed) or
 * its own secret (unclaimed) as the bearer token.
 */
async function macFrom(
  request: Request,
  env: Env,
): Promise<Device | undefined> {
  const macId = request.headers.get("X-Daedalus-Device") ?? "";
  const token = bearer(request);
  const mac = ID.test(macId) ? await device(env.DB, macId) : undefined;
  if (
    !mac ||
    mac.kind !== "mac" ||
    mac.revokedAt ||
    !token ||
    !mac.tokenHash ||
    (await sha256(token)) !== mac.tokenHash
  )
    return undefined;
  return mac;
}

/** A pairing code lasts two minutes; the relay keeps its claim key 5. */
const CLAIM_MAX_MS = 5 * 60_000;

/** What a Mac asks of the relay about itself. */
async function macRoutes(
  request: Request,
  env: Env,
  route: string,
): Promise<Response> {
  const mac = await macFrom(request, env);
  if (!mac) return fail(401, "UNAUTHORIZED", "Device secret required.");

  // The Mac is showing a pairing code: a claim must present its key.
  if (route === "POST /v1/macs/offer") {
    const { claimHash, expiresAt } = await body<{
      claimHash: string;
      expiresAt: number;
    }>(request);
    if (!claimHash || typeof expiresAt !== "number")
      return fail(400, "BAD_REQUEST", "Missing claim hash.");
    const until = Math.min(expiresAt, Date.now() + CLAIM_MAX_MS);
    await env.DB.prepare(
      "UPDATE devices SET claim_hash = ?, claim_expires_at = ? WHERE id = ?",
    )
      .bind(claimHash, new Date(until).toISOString(), mac.id)
      .run();
    return json({ ok: true, data: null });
  }

  // A signed-in Mac asks who it belongs to and the account's plan. It asks
  // over HTTP because without a plan the relay refuses its connection.
  if (route === "POST /v1/macs/account") {
    if (!mac.userId) return json({ ok: true, data: null });
    return json({
      ok: true,
      data: {
        email: await emailOf(env.DB, mac.userId),
        plan: (await activeEntitlement(env.DB, mac.userId)) ?? null,
        admin: Boolean(await adminFor(env, mac.userId)),
      },
    });
  }

  // Settings › Account's admin section, for an account on ADMIN_ACCOUNTS.
  // The narrower door (see admin.ts): Pro only, capped, rate-limited.
  const macAdmin: Record<string, AdminAction> = {
    "POST /v1/macs/admin/invites": "invites.list",
    "POST /v1/macs/admin/invites/create": "invites.create",
    "POST /v1/macs/admin/invites/delete": "invites.delete",
    "POST /v1/macs/admin/invites/rename": "invites.rename",
    "POST /v1/macs/admin/users": "users.list",
    "POST /v1/macs/admin/plan": "plan.set",
    "POST /v1/macs/admin/log": "log.list",
  };
  const action = macAdmin[route];
  const unlockRoute =
    route === "POST /v1/macs/admin/unlock" ||
    route === "POST /v1/macs/admin/session" ||
    route === "POST /v1/macs/admin/lock";
  if (action || unlockRoute) {
    const actor = mac.userId ? await adminFor(env, mac.userId) : undefined;
    if (!actor || !mac.userId)
      return fail(403, "FORBIDDEN", "This account is not an admin.");
    const secret = request.headers.get("X-Daedalus-Admin");

    // Sudo mode (admin.ts): the Mac starts an unlock with the hash of a
    // secret it keeps in memory, and the browser approves it.
    if (route === "POST /v1/macs/admin/unlock") {
      const { secretHash } = await body<{ secretHash: string }>(request);
      if (!secretHash || secretHash.length < 32)
        return fail(400, "BAD_REQUEST", "Missing the unlock.");
      await createUnlock(env, mac.id, mac.userId, secretHash);
      const url = new URL("/auth/google/start", request.url);
      url.searchParams.set("unlock", secretHash);
      return json({ ok: true, data: { url: url.toString() } });
    }
    if (route === "POST /v1/macs/admin/session")
      return json({
        ok: true,
        data: {
          unlockedUntil:
            (await unlockedUntil(env, mac.id, mac.userId, secret)) ?? null,
        },
      });
    if (route === "POST /v1/macs/admin/lock") {
      await lockAdmin(env, mac.id);
      return json({ ok: true, data: null });
    }
    if (!action) return fail(404, "NOT_FOUND", "Not found");
    if (!(await unlockedUntil(env, mac.id, mac.userId, secret, true)))
      return fail(
        403,
        "ADMIN_LOCKED",
        "Admin is locked. Unlock it with Google in Settings › Account.",
      );
    return adminAction(
      env,
      action,
      await body<Record<string, unknown>>(request),
      { actor, restricted: true },
    );
  }

  // An invite code typed on the Mac, for the Mac's account.
  if (route === "POST /v1/macs/invite") {
    if (!mac.userId) return fail(409, "NOT_SIGNED_IN", "Sign in first.");
    if (!(await authAllowed(env, request)))
      return fail(429, "RATE_LIMITED", "Too many attempts. Wait a minute.");
    const { code } = await body<{ code: string }>(request);
    if (!code || !(await redeemInvite(env.DB, mac.userId, code)))
      return fail(400, "INVITE_INVALID", "That invite code is not valid.");
    return json({
      ok: true,
      data: await activeEntitlement(env.DB, mac.userId),
    });
  }

  // The Mac leaves its account: its user declined the first phone, which
  // means someone else claimed it, or chose Leave this account.
  if (route === "POST /v1/macs/leave") {
    await env.DB.prepare(
      "UPDATE devices SET revoked_at = ?, token_hash = NULL, claim_hash = NULL WHERE id = ?",
    )
      .bind(nowIso(), mac.id)
      .run();
    await room(env, mac.id).fetch("https://room/kick", {
      method: "POST",
      body: JSON.stringify({}),
    });
    return json({ ok: true, data: null });
  }

  return fail(404, "NOT_FOUND", "Not found");
}

async function signedIn(request: Request, env: Env): Promise<User | Response> {
  const user = await userForSession(env.DB, bearer(request));
  return user ?? fail(401, "UNAUTHORIZED", "Sign in again.");
}

async function body<T>(request: Request): Promise<Partial<T>> {
  try {
    return (await request.json()) as Partial<T>;
  } catch {
    return {};
  }
}

/** What a signed-in phone can do with its account. */
async function account(
  request: Request,
  env: Env,
  route: string,
): Promise<Response> {
  const user = await signedIn(request, env);
  if (user instanceof Response) return user;

  if (route === "GET /v1/me") {
    const usage = await env.DB.prepare(
      "SELECT bytes FROM usage WHERE user_id = ? AND month = ?",
    )
      .bind(user.id, currentMonth())
      .first<{ bytes: number }>();
    return json({
      ok: true,
      data: {
        user,
        entitlement: (await activeEntitlement(env.DB, user.id)) ?? null,
        devices: await userDevices(env.DB, user.id),
        usageBytes: usage?.bytes ?? 0,
      },
    });
  }

  if (route === "GET /v1/push/key") {
    if (!env.VAPID_PUBLIC_KEY)
      return fail(503, "NOT_CONFIGURED", "Notifications are not set up.");
    return json({ ok: true, data: { publicKey: env.VAPID_PUBLIC_KEY } });
  }

  if (
    route === "PUT /v1/push/subscription" ||
    route === "DELETE /v1/push/subscription"
  ) {
    const { deviceId, endpoint } = await body<{
      deviceId: string;
      endpoint: string;
    }>(request);
    const phone = deviceId ? await device(env.DB, deviceId) : undefined;
    if (
      !phone ||
      phone.kind !== "phone" ||
      phone.userId !== user.id ||
      phone.revokedAt
    )
      return fail(404, "NOT_FOUND", "This phone is not on this account.");
    if (route.startsWith("DELETE")) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE device_id = ?")
        .bind(phone.id)
        .run();
      return json({ ok: true, data: null });
    }
    if (
      !endpoint ||
      !allowedEndpoint(
        endpoint,
        isDev(env) ? env.PUSH_TEST_ENDPOINT : undefined,
      )
    )
      return fail(
        400,
        "BAD_ENDPOINT",
        "That is not a push service this relay sends to.",
      );
    await env.DB.prepare(
      `INSERT INTO push_subscriptions (device_id, user_id, endpoint, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET endpoint = excluded.endpoint`,
    )
      .bind(phone.id, user.id, endpoint, nowIso())
      .run();
    return json({ ok: true, data: null });
  }

  if (route === "POST /v1/signout") {
    await deleteSession(env.DB, bearer(request) ?? "");
    return json({ ok: true, data: null });
  }

  if (route === "POST /v1/signout-all") {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?")
      .bind(user.id)
      .run();
    return json({ ok: true, data: null });
  }

  if (
    (route === "POST /v1/invites/redeem" ||
      route === "POST /v1/pairings/claim") &&
    !(await authAllowed(env, request))
  )
    return fail(429, "RATE_LIMITED", "Too many attempts. Wait a minute.");

  if (route === "POST /v1/invites/redeem") {
    const { code } = await body<{ code: string }>(request);
    if (!code || !(await redeemInvite(env.DB, user.id, code)))
      return fail(400, "INVITE_INVALID", "That invite code is not valid.");
    return json({ ok: true, data: await activeEntitlement(env.DB, user.id) });
  }

  if (route === "POST /v1/pairings/claim") {
    const { macId, name, claimKey } = await body<{
      macId: string;
      name: string;
      claimKey: string;
    }>(request);
    if (!macId || !ID.test(macId))
      return fail(400, "BAD_REQUEST", "Missing Mac id.");
    const entitlement = await activeEntitlement(env.DB, user.id);
    if (!entitlement)
      return fail(402, "NO_ENTITLEMENT", "This account has no active access.");
    const mac = await device(env.DB, macId);
    if (!mac || mac.kind !== "mac" || mac.revokedAt)
      return fail(
        404,
        "NOT_FOUND",
        "That Mac is not online. Open Daedalus on it.",
      );
    if (mac.userId === user.id) return json({ ok: true, data: { macId } });
    const keyValid = await claimKeyValid(mac, claimKey);
    // Someone holding this Mac's code is looking at its screen, so it is
    // fine to say which account the Mac is on.
    if (mac.userId)
      return keyValid
        ? fail(
            409,
            "WRONG_ACCOUNT",
            `This Mac is signed in as ${await emailOf(env.DB, mac.userId)}. Sign in with that account on this phone.`,
          )
        : fail(409, "CLAIMED", "That Mac belongs to another account.");
    if (!keyValid)
      return fail(
        403,
        "BAD_CLAIM",
        "This pairing code is not valid any more. Show a new one on your Mac.",
      );
    if (
      (await countActiveDevices(env.DB, user.id, "mac")) >= entitlement.maxMacs
    )
      return fail(403, "MAC_LIMIT", "This account has reached its Mac limit.");
    const token = await claimMac(env.DB, mac, user.id, name ?? "");
    if (!token)
      return fail(409, "CLAIMED", "That Mac was claimed a moment ago.");
    await room(env, macId).fetch("https://room/claimed", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    return json({ ok: true, data: { macId } });
  }

  const remove = /^DELETE \/v1\/devices\/([A-Za-z0-9_-]+)$/.exec(route);
  if (remove) {
    const target = await device(env.DB, remove[1]!);
    if (!target || target.userId !== user.id)
      return fail(404, "NOT_FOUND", "No such device.");
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE devices SET revoked_at = ?, token_hash = NULL WHERE id = ?",
      ).bind(nowIso(), target.id),
      // A removed phone's sign-in ends with it.
      env.DB.prepare("DELETE FROM sessions WHERE device_id = ?").bind(
        target.id,
      ),
    ]);
    const rooms =
      target.kind === "mac"
        ? [target.id]
        : (await userDevices(env.DB, user.id))
            .filter((item) => item.kind === "mac")
            .map((item) => item.id);
    for (const macId of rooms)
      await room(env, macId).fetch("https://room/kick", {
        method: "POST",
        body: JSON.stringify({ deviceId: target.id }),
      });
    return json({ ok: true, data: null });
  }

  return fail(404, "NOT_FOUND", "Not found");
}

/** Invites, grants and usage, for the owner, with `ADMIN_KEY`. */
async function admin(
  request: Request,
  env: Env,
  route: string,
): Promise<Response> {
  const key = bearer(request);
  if (!env.ADMIN_KEY || !key || !constantTimeEqual(key, env.ADMIN_KEY))
    return fail(401, "UNAUTHORIZED", "Admin key required.");

  const actions: Record<string, AdminAction> = {
    "GET /admin/invites": "invites.list",
    "POST /admin/invites": "invites.create",
    "POST /admin/invites/rename": "invites.rename",
    "GET /admin/users": "users.list",
    "POST /admin/entitlements": "plan.set",
    "GET /admin/log": "log.list",
  };
  const action = actions[route];
  if (action)
    return adminAction(
      env,
      action,
      route.startsWith("GET ")
        ? {}
        : await body<Record<string, unknown>>(request),
      { actor: KEY_ACTOR, devices: true },
    );

  if (route === "GET /admin/budget")
    return json({ ok: true, data: await budget(env).status() });

  if (route === "POST /admin/budget") {
    const { open } = await body<{ open: boolean }>(request);
    if (open) return json({ ok: true, data: await budget(env).reopen() });
    await closeEverything(env, "admin");
    return json({ ok: true, data: await budget(env).status() });
  }

  return fail(404, "NOT_FOUND", "Not found");
}

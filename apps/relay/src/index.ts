import {
  activeEntitlement,
  countActiveDevices,
  createInvite,
  deleteSession,
  device,
  PLANS,
  redeemInvite,
  setEntitlement,
  type User,
  userDevices,
  userForSession,
} from "./accounts";
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
  json,
  nowIso,
  protocolToken,
  randomToken,
  refuse,
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
        if (!(await allowed(env.AUTH_LIMITER, request)))
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

const room = (env: Env, macId: string) =>
  env.ROOMS.get(env.ROOMS.idFromName(macId));

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
  const mac = await device(env.DB, macId);
  if (role === "mac") {
    if (mac && mac.kind !== "mac") return refuse(CLOSE.forbidden, "Not a Mac");
    if (mac?.revokedAt) return refuse(CLOSE.unauthorized, "Device revoked");
    if (mac?.userId) {
      if (!token || (await sha256(token)) !== mac.tokenHash)
        return refuse(CLOSE.unauthorized, "Device token required");
      if (!(await activeEntitlement(env.DB, mac.userId)))
        return refuse(CLOSE.noEntitlement, "No active access");
      userId = mac.userId;
    } else if (!(await allowed(env.UNCLAIMED_LIMITER, request))) {
      // Unclaimed Macs connect with no sign-in, so they are limited per IP.
      return refuse(CLOSE.rateLimited, "Too many new Macs from here");
    } else if (!mac) {
      await env.DB.prepare(
        "INSERT INTO devices (id, user_id, kind, created_at) VALUES (?, NULL, 'mac', ?)",
      )
        .bind(macId, nowIso())
        .run();
    }
  } else {
    const user = await userForSession(env.DB, token);
    if (!user) return refuse(CLOSE.unauthorized, "Sign in again");
    const entitlement = await activeEntitlement(env.DB, user.id);
    if (!entitlement) return refuse(CLOSE.noEntitlement, "No active access");
    if (!mac || mac.userId !== user.id || mac.revokedAt)
      return refuse(CLOSE.forbidden, "That Mac is not on this account");
    const phone = await device(env.DB, deviceId);
    if (
      phone &&
      (phone.userId !== user.id || phone.revokedAt || phone.kind !== "phone")
    )
      return refuse(CLOSE.forbidden, "This phone was removed");
    if (!phone) {
      if (
        (await countActiveDevices(env.DB, user.id, "phone")) >=
        entitlement.maxPhones
      )
        return refuse(CLOSE.forbidden, "Phone limit reached");
      await env.DB.prepare(
        "INSERT INTO devices (id, user_id, kind, name, created_at, claimed_at) VALUES (?, ?, 'phone', ?, ?, ?)",
      )
        .bind(
          deviceId,
          user.id,
          url.searchParams.get("name")?.slice(0, 80) ?? "",
          nowIso(),
          nowIso(),
        )
        .run();
    }
    userId = user.id;
  }
  await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
    .bind(nowIso(), deviceId)
    .run();

  const headers = new Headers(request.headers);
  headers.set("X-Daedalus-Role", role);
  headers.set("X-Daedalus-Device", deviceId);
  headers.set("X-Daedalus-User", userId ?? "");
  return room(env, macId).fetch(new Request(request, { headers }));
}

/** Pushes at most this often per account; later asks within it are dropped. */
const PUSH_INTERVAL_MS = 15_000;

/**
 * A Mac asking for its account's phones to be told a session needs them. It
 * proves itself with its device token. The push carries nothing.
 */
async function pushNotify(request: Request, env: Env): Promise<Response> {
  const macId = request.headers.get("X-Daedalus-Device") ?? "";
  const token = bearer(request);
  const mac = ID.test(macId) ? await device(env.DB, macId) : undefined;
  if (
    !mac ||
    mac.kind !== "mac" ||
    !mac.userId ||
    mac.revokedAt ||
    !token ||
    (await sha256(token)) !== mac.tokenHash
  )
    return fail(401, "UNAUTHORIZED", "Device token required.");
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
    if (!endpoint || !allowedEndpoint(endpoint, env.PUSH_TEST_ENDPOINT))
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

  if (
    (route === "POST /v1/invites/redeem" ||
      route === "POST /v1/pairings/claim") &&
    !(await allowed(env.AUTH_LIMITER, request))
  )
    return fail(429, "RATE_LIMITED", "Too many attempts. Wait a minute.");

  if (route === "POST /v1/invites/redeem") {
    const { code } = await body<{ code: string }>(request);
    if (!code || !(await redeemInvite(env.DB, user.id, code)))
      return fail(400, "INVITE_INVALID", "That invite code is not valid.");
    return json({ ok: true, data: await activeEntitlement(env.DB, user.id) });
  }

  if (route === "POST /v1/pairings/claim") {
    const { macId, name } = await body<{ macId: string; name: string }>(
      request,
    );
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
    if (mac.userId)
      return fail(409, "CLAIMED", "That Mac belongs to another account.");
    if (
      (await countActiveDevices(env.DB, user.id, "mac")) >= entitlement.maxMacs
    )
      return fail(403, "MAC_LIMIT", "This account has reached its Mac limit.");
    const token = randomToken();
    const claimed = await env.DB.prepare(
      `UPDATE devices SET user_id = ?, name = ?, token_hash = ?, claimed_at = ?
       WHERE id = ? AND user_id IS NULL AND revoked_at IS NULL`,
    )
      .bind(
        user.id,
        (name ?? "").slice(0, 80),
        await sha256(token),
        nowIso(),
        macId,
      )
      .run();
    if (!claimed.meta.changes)
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
    await env.DB.prepare(
      "UPDATE devices SET revoked_at = ?, token_hash = NULL WHERE id = ?",
    )
      .bind(nowIso(), target.id)
      .run();
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

  if (route === "POST /admin/invites") {
    const options = await body<{
      plan: string;
      maxUses: number;
      days: number;
      note: string;
    }>(request);
    if (options.plan && !PLANS[options.plan])
      return fail(400, "BAD_PLAN", `Plans: ${Object.keys(PLANS).join(", ")}`);
    return json({
      ok: true,
      data: { code: await createInvite(env.DB, options) },
    });
  }

  if (route === "GET /admin/invites") {
    const { results } = await env.DB.prepare(
      "SELECT code, plan, max_uses AS maxUses, used, expires_at AS expiresAt, note, created_at AS createdAt FROM invites ORDER BY created_at DESC",
    ).all();
    return json({ ok: true, data: results });
  }

  if (route === "GET /admin/users") {
    const { results } = await env.DB.prepare(
      `SELECT users.id, users.email, users.created_at AS createdAt,
              entitlements.plan, entitlements.status, entitlements.source,
              (SELECT COUNT(*) FROM devices WHERE devices.user_id = users.id AND kind = 'mac' AND revoked_at IS NULL) AS macs,
              (SELECT COUNT(*) FROM devices WHERE devices.user_id = users.id AND kind = 'phone' AND revoked_at IS NULL) AS phones,
              COALESCE((SELECT bytes FROM usage WHERE usage.user_id = users.id AND month = ?), 0) AS usageBytes
       FROM users LEFT JOIN entitlements ON entitlements.user_id = users.id
       ORDER BY users.created_at`,
    )
      .bind(currentMonth())
      .all();
    return json({ ok: true, data: results });
  }

  if (route === "GET /admin/budget")
    return json({ ok: true, data: await budget(env).status() });

  if (route === "POST /admin/budget") {
    const { open } = await body<{ open: boolean }>(request);
    if (open) return json({ ok: true, data: await budget(env).reopen() });
    await closeEverything(env, "admin");
    return json({ ok: true, data: await budget(env).status() });
  }

  if (route === "POST /admin/entitlements") {
    const { email, status, plan, monthlyFrames } = await body<{
      email: string;
      status: "active" | "revoked";
      plan: string;
      monthlyFrames: number;
    }>(request);
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind(email ?? "")
      .first<{ id: string }>();
    if (!user) return fail(404, "NOT_FOUND", "No user with that email.");
    if (plan && !PLANS[plan])
      return fail(400, "BAD_PLAN", `Plans: ${Object.keys(PLANS).join(", ")}`);
    const current = await env.DB.prepare(
      "SELECT plan FROM entitlements WHERE user_id = ?",
    )
      .bind(user.id)
      .first<{ plan: string }>();
    await setEntitlement(
      env.DB,
      user.id,
      plan ?? current?.plan ?? "beta",
      "admin",
      status === "revoked" ? "revoked" : "active",
      typeof monthlyFrames === "number" && monthlyFrames > 0
        ? { monthlyFrames }
        : {},
    );
    if (status === "revoked") {
      const macs = (await userDevices(env.DB, user.id)).filter(
        (item) => item.kind === "mac",
      );
      for (const mac of macs)
        await room(env, mac.id).fetch("https://room/kick", {
          method: "POST",
          body: JSON.stringify({ code: CLOSE.noEntitlement }),
        });
    }
    return json({
      ok: true,
      data: (await activeEntitlement(env.DB, user.id)) ?? null,
    });
  }

  return fail(404, "NOT_FOUND", "Not found");
}

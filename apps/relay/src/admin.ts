import {
  activeEntitlement,
  createInvite,
  daysFromNow,
  PLANS,
  setEntitlement,
  userDevices,
} from "./accounts";
import {
  CLOSE,
  currentMonth,
  type Env,
  fail,
  json,
  nowIso,
  room,
  sha256,
} from "./util";

/**
 * What the owner can do to keys (invite codes) and accounts. Two doors lead
 * here: the `/admin/*` routes with `ADMIN_KEY` (the relay-admin script), and
 * a signed-in Mac whose account is on `ADMIN_ACCOUNTS` (Settings › Account).
 *
 * The Mac's door is the narrower one, because its credential is a device
 * token on a computer where agents run: it can only make and grant Pro,
 * within `MAC_LIMITS`, and only so many changes an hour. Every change
 * through either door goes in `admin_log`.
 */
export type AdminAction =
  | "invites.list"
  | "invites.create"
  | "invites.delete"
  | "invites.rename"
  | "users.list"
  | "plan.set"
  | "log.list";

/** Who is acting: an admin's account, or the admin key. */
export interface AdminActor {
  userId: string | null;
  email: string;
}

export const KEY_ACTOR: AdminActor = { userId: null, email: "admin key" };

/** What a Mac's admin may do at most. */
export const MAC_LIMITS = {
  maxUses: 100,
  days: 365,
  changesPerHour: 60,
};

/**
 * The Google account ids on the relay's admin list. `ADMIN_ACCOUNTS` is
 * comma-separated `label=id` entries (the label, an email, only names the
 * entry), or bare ids. Matching the id, not the email, means an email
 * that later belongs to another Google account is not an admin.
 */
function adminIds(env: Env): Set<string> {
  return new Set(
    (env.ADMIN_ACCOUNTS ?? "")
      .split(",")
      .map((entry) => entry.split("=").pop()?.trim() ?? "")
      .filter(Boolean),
  );
}

/** The account as an actor if it is on the admin list, else undefined. */
export async function adminFor(
  env: Env,
  userId: string,
): Promise<AdminActor | undefined> {
  const user = await env.DB.prepare(
    "SELECT email, google_sub AS googleSub FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{ email: string; googleSub: string }>();
  return user && adminIds(env).has(user.googleSub)
    ? { userId, email: user.email }
    : undefined;
}

const badPlan = () =>
  fail(400, "BAD_PLAN", `Plans: ${Object.keys(PLANS).join(", ")}`);

/** A positive whole number, at most `max`, or undefined. */
const count = (value: unknown, max = Number.POSITIVE_INFINITY) =>
  typeof value === "number" && value > 0
    ? Math.min(Math.floor(value), max)
    : undefined;

async function record(
  env: Env,
  actor: AdminActor,
  action: AdminAction,
  target: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO admin_log (at, actor_user_id, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      nowIso(),
      actor.userId,
      actor.email,
      action,
      target,
      JSON.stringify(detail),
    )
    .run();
}

export async function adminAction(
  env: Env,
  action: AdminAction,
  input: Record<string, unknown>,
  options: {
    actor: AdminActor;
    /** The Mac's door: Pro only, capped, rate-limited. */
    restricted?: boolean;
    /**
     * The script also wants each account's device counts and Google
     * account id (for ADMIN_ACCOUNTS); the Mac does not.
     */
    devices?: boolean;
  },
): Promise<Response> {
  const { actor, restricted = false } = options;
  const dayLimit = restricted ? MAC_LIMITS.days : Number.POSITIVE_INFINITY;

  if (action === "invites.list") {
    const { results } = await env.DB.prepare(
      `SELECT code, plan, max_uses AS maxUses, used, expires_at AS expiresAt,
              grant_days AS grantDays, note, created_at AS createdAt
       FROM invites
       WHERE used < max_uses AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC`,
    )
      .bind(nowIso())
      .all();
    return json({ ok: true, data: results });
  }

  if (action === "users.list") {
    const devices = options.devices
      ? `users.google_sub AS googleAccountId,
         (SELECT COUNT(*) FROM devices WHERE devices.user_id = users.id AND kind = 'mac' AND revoked_at IS NULL) AS macs,
         (SELECT COUNT(*) FROM devices WHERE devices.user_id = users.id AND kind = 'phone' AND revoked_at IS NULL) AS phones,`
      : "";
    const { results } = await env.DB.prepare(
      `SELECT users.id, users.email, users.created_at AS createdAt,
              entitlements.plan, entitlements.status, entitlements.source,
              entitlements.expires_at AS expiresAt,
              ${devices}
              COALESCE((SELECT bytes FROM usage WHERE usage.user_id = users.id AND month = ?), 0) AS usageBytes
       FROM users LEFT JOIN entitlements ON entitlements.user_id = users.id
       ORDER BY users.created_at`,
    )
      .bind(currentMonth())
      .all();
    return json({ ok: true, data: results });
  }

  if (action === "log.list") {
    const { results } = await env.DB.prepare(
      "SELECT at, actor, action, target, detail FROM admin_log ORDER BY id DESC LIMIT 100",
    ).all<{
      at: string;
      actor: string;
      action: string;
      target: string;
      detail: string;
    }>();
    return json({
      ok: true,
      data: results.map((row) => ({
        ...row,
        detail: JSON.parse(row.detail) as unknown,
      })),
    });
  }

  // Everything below changes something: it is logged, and through the
  // Mac's door it counts against the hourly limit.
  if (restricted && actor.userId) {
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS changes FROM admin_log WHERE actor_user_id = ? AND at > ?",
    )
      .bind(actor.userId, new Date(Date.now() - 3_600_000).toISOString())
      .first<{ changes: number }>();
    if ((recent?.changes ?? 0) >= MAC_LIMITS.changesPerHour)
      return fail(
        429,
        "RATE_LIMITED",
        `At most ${MAC_LIMITS.changesPerHour} admin changes an hour. Try again later.`,
      );
  }

  if (action === "invites.create") {
    // The Mac's door makes Pro keys only; the admin key may name a plan.
    const plan = restricted
      ? "pro"
      : typeof input.plan === "string"
        ? input.plan
        : undefined;
    if (plan && !PLANS[plan]) return badPlan();
    const maxUses = count(
      input.maxUses,
      restricted ? MAC_LIMITS.maxUses : 1_000,
    );
    const days = count(input.days, dayLimit);
    const grantDays = count(input.grantDays, dayLimit);
    const note = typeof input.note === "string" ? input.note.slice(0, 200) : "";
    const code = await createInvite(env.DB, {
      ...(plan ? { plan } : {}),
      ...(maxUses ? { maxUses } : {}),
      // Through the Mac's door a key always ends.
      ...(days ? { days } : restricted ? { days: 30 } : {}),
      ...(grantDays ? { grantDays } : {}),
      note,
    });
    await record(env, actor, action, code, {
      plan: plan ?? "pro",
      maxUses: maxUses ?? 1,
      grantDays: grantDays ?? null,
      name: note,
    });
    return json({ ok: true, data: { code } });
  }

  if (action === "invites.delete") {
    const code = typeof input.code === "string" ? input.code : "";
    const deleted = await env.DB.prepare(
      "DELETE FROM invites WHERE code = ? RETURNING note",
    )
      .bind(code)
      .first<{ note: string }>();
    if (!deleted) return fail(404, "NOT_FOUND", "No such key.");
    await record(env, actor, action, code, { name: deleted.note });
    return json({ ok: true, data: null });
  }

  // A key's name is its note: who or what it is for.
  if (action === "invites.rename") {
    const code = typeof input.code === "string" ? input.code : "";
    const name =
      typeof input.note === "string" ? input.note.slice(0, 200).trim() : "";
    const renamed = await env.DB.prepare(
      "UPDATE invites SET note = ? WHERE code = ?",
    )
      .bind(name, code)
      .run();
    if (!renamed.meta.changes) return fail(404, "NOT_FOUND", "No such key.");
    await record(env, actor, action, code, { name });
    return json({ ok: true, data: null });
  }

  // plan.set
  const email = typeof input.email === "string" ? input.email : "";
  /**
   * `expired` ends the plan now; the account keeps its sign-ins and can
   * redeem an invite. `revoked` also ends its sign-ins, and invites no
   * longer work for it.
   */
  const status =
    input.status === "revoked" || input.status === "expired"
      ? input.status
      : "active";
  // The Mac's door grants Pro only; the admin key may name a plan.
  const plan = restricted
    ? "pro"
    : typeof input.plan === "string"
      ? input.plan
      : undefined;
  const monthlyFrames = restricted ? undefined : input.monthlyFrames;
  /** How long the plan lasts from now; 0 for no end. */
  const days =
    typeof input.days === "number"
      ? input.days > 0
        ? Math.min(Math.floor(input.days), dayLimit)
        : 0
      : undefined;
  const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!user) return fail(404, "NOT_FOUND", "No user with that email.");
  if (plan && !PLANS[plan]) return badPlan();
  const current = await env.DB.prepare(
    "SELECT plan, expires_at AS expiresAt FROM entitlements WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ plan: string; expiresAt: string | null }>();
  await setEntitlement(
    env.DB,
    user.id,
    plan ?? current?.plan ?? "pro",
    "admin",
    {
      status,
      limits:
        typeof monthlyFrames === "number" && monthlyFrames > 0
          ? { monthlyFrames }
          : {},
      // Without `days`, a plan that has not ended keeps its end; one that
      // has is granted again with none.
      expiresAt:
        typeof days === "number"
          ? daysFromNow(days)
          : current?.expiresAt && current.expiresAt > nowIso()
            ? current.expiresAt
            : null,
    },
  );
  if (status === "revoked" || status === "expired") {
    if (status === "revoked")
      await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?")
        .bind(user.id)
        .run();
    const macs = (await userDevices(env.DB, user.id)).filter(
      (item) => item.kind === "mac",
    );
    for (const mac of macs)
      await room(env, mac.id).fetch("https://room/kick", {
        method: "POST",
        body: JSON.stringify({ code: CLOSE.noEntitlement }),
      });
  }
  await record(env, actor, action, email, {
    status,
    plan: plan ?? current?.plan ?? "pro",
    ...(typeof days === "number" ? { days } : {}),
  });
  return json({
    ok: true,
    data: (await activeEntitlement(env.DB, user.id)) ?? null,
  });
}

/**
 * Sudo mode. A Mac's admin calls need, besides its device token, the secret
 * of an unlock that the admin approved by signing in with Google in the
 * browser. The Mac keeps the secret in memory only, so the device token in
 * the Keychain, which agents on the Mac could read, is not enough alone.
 */
export const UNLOCK = {
  /** How long a pending unlock waits for its Google sign-in. */
  pendingMs: 10 * 60_000,
  /** How long an approved unlock lasts after the last admin call. */
  idleMs: 15 * 60_000,
  /** How long it lasts at most after approval. */
  maxMs: 60 * 60_000,
};

/** A pending unlock for this Mac's admin account. */
export async function createUnlock(
  env: Env,
  macId: string,
  userId: string,
  secretHash: string,
): Promise<void> {
  await env.DB.batch([
    // One unlock per Mac: a new one replaces the last.
    env.DB.prepare("DELETE FROM admin_unlocks WHERE mac_id = ?").bind(macId),
    env.DB.prepare(
      "INSERT INTO admin_unlocks (secret_hash, mac_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      secretHash,
      macId,
      userId,
      nowIso(),
      new Date(Date.now() + UNLOCK.pendingMs).toISOString(),
    ),
  ]);
}

/** Whether `secretHash` names an unlock still waiting for its sign-in. */
export async function unlockPending(
  env: Env,
  secretHash: string,
): Promise<boolean> {
  return Boolean(
    await env.DB.prepare(
      "SELECT 1 FROM admin_unlocks WHERE secret_hash = ? AND approved_at IS NULL AND expires_at > ?",
    )
      .bind(secretHash, nowIso())
      .first(),
  );
}

/**
 * Approves a pending unlock if the Google account that just signed in is
 * the Mac's account and an admin. Returns what the browser page says.
 */
export async function approveUnlock(
  env: Env,
  secretHash: string,
  userId: string | undefined,
): Promise<{ ok: boolean; title: string; body: string }> {
  const unlock = await env.DB.prepare(
    "SELECT user_id AS userId FROM admin_unlocks WHERE secret_hash = ? AND approved_at IS NULL AND expires_at > ?",
  )
    .bind(secretHash, nowIso())
    .first<{ userId: string }>();
  if (!unlock)
    return {
      ok: false,
      title: "Unlock expired",
      body: "Go back to Daedalus on your Mac and click Unlock again.",
    };
  if (!userId || userId !== unlock.userId || !(await adminFor(env, userId)))
    return {
      ok: false,
      title: "Not the admin account",
      body: "Sign in with the Google account your Mac is signed in with. Admin stays locked.",
    };
  await env.DB.prepare(
    "UPDATE admin_unlocks SET approved_at = ?, expires_at = ? WHERE secret_hash = ?",
  )
    .bind(
      nowIso(),
      new Date(Date.now() + UNLOCK.idleMs).toISOString(),
      secretHash,
    )
    .run();
  return {
    ok: true,
    title: "Admin unlocked",
    body: "Go back to Daedalus on your Mac. Admin stays unlocked for 15 minutes after your last change, an hour at most. You can close this tab.",
  };
}

/**
 * Until when this Mac's unlock works, given its secret, or undefined when
 * it is locked. With `use`, moves the end on: 15 more minutes, never past
 * an hour after approval.
 */
export async function unlockedUntil(
  env: Env,
  macId: string,
  userId: string,
  secret: string | null,
  use = false,
): Promise<string | undefined> {
  if (!secret) return undefined;
  const unlock = await env.DB.prepare(
    `SELECT secret_hash AS secretHash, approved_at AS approvedAt, expires_at AS expiresAt
     FROM admin_unlocks
     WHERE secret_hash = ? AND mac_id = ? AND user_id = ?
       AND approved_at IS NOT NULL AND expires_at > ?`,
  )
    .bind(await sha256(secret), macId, userId, nowIso())
    .first<{ secretHash: string; approvedAt: string; expiresAt: string }>();
  if (!unlock) return undefined;
  const cap = Date.parse(unlock.approvedAt) + UNLOCK.maxMs;
  if (Date.now() >= cap) return undefined;
  if (!use) return unlock.expiresAt;
  const until = new Date(
    Math.min(Date.now() + UNLOCK.idleMs, cap),
  ).toISOString();
  await env.DB.prepare(
    "UPDATE admin_unlocks SET expires_at = ? WHERE secret_hash = ?",
  )
    .bind(until, unlock.secretHash)
    .run();
  return until;
}

export async function lockAdmin(env: Env, macId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM admin_unlocks WHERE mac_id = ?")
    .bind(macId)
    .run();
}

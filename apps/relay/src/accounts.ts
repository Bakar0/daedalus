import { currentMonth, nowIso, randomToken, sha256 } from "./util";

export interface Plan {
  maxMacs: number;
  maxPhones: number;
  monthlyMb: number;
  /**
   * Frames the relay forwards for the account in a month. A frame is what
   * Cloudflare bills (1/20 of a request); 3 million is about $0.03, three
   * times a heavy user (artifacts/remote-work/cost-analysis.md).
   */
  monthlyFrames: number;
}

/** What each plan allows. An invite or a grant names one of these. */
export const PLANS: Record<string, Plan> = {
  beta: { maxMacs: 2, maxPhones: 3, monthlyMb: 2048, monthlyFrames: 3_000_000 },
  admin: {
    maxMacs: 10,
    maxPhones: 10,
    monthlyMb: 20_480,
    monthlyFrames: 30_000_000,
  },
};

export interface User {
  id: string;
  email: string;
}

export interface Entitlement {
  plan: string;
  source: string;
  status: string;
  expiresAt: string | null;
  maxMacs: number;
  maxPhones: number;
  monthlyMb: number;
  monthlyFrames: number;
}

export interface Device {
  id: string;
  userId: string | null;
  kind: "mac" | "phone";
  name: string;
  tokenHash: string | null;
  createdAt: string;
  claimedAt: string | null;
  revokedAt: string | null;
  lastSeenAt: string | null;
}

const SESSION_DAYS = 90;

export async function createSession(
  db: D1Database,
  userId: string,
): Promise<string> {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(await sha256(token), userId, nowIso(), expires.toISOString())
    .run();
  return token;
}

export async function userForSession(
  db: D1Database,
  token: string | undefined,
): Promise<User | undefined> {
  if (!token) return undefined;
  const row = await db
    .prepare(
      `SELECT users.id, users.email FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
    )
    .bind(await sha256(token), nowIso())
    .first<User>();
  return row ?? undefined;
}

export async function deleteSession(
  db: D1Database,
  token: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(await sha256(token))
    .run();
}

/** The user's entitlement if it is active right now, else undefined. */
export async function activeEntitlement(
  db: D1Database,
  userId: string,
): Promise<Entitlement | undefined> {
  const row = await db
    .prepare(
      `SELECT plan, source, status, expires_at AS expiresAt, max_macs AS maxMacs,
              max_phones AS maxPhones, monthly_mb AS monthlyMb,
              monthly_frames AS monthlyFrames
       FROM entitlements
       WHERE user_id = ? AND status = 'active'
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .bind(userId, nowIso())
    .first<Entitlement>();
  return row ?? undefined;
}

export async function setEntitlement(
  db: D1Database,
  userId: string,
  planName: string,
  source: "invite" | "admin",
  status: "active" | "revoked" = "active",
  /** Overrides for one account, from the admin routes. */
  limits: Partial<Plan> = {},
): Promise<void> {
  const base = PLANS[planName];
  if (!base) throw new Error(`Unknown plan ${planName}`);
  const plan = { ...base, ...limits };
  await db
    .prepare(
      `INSERT INTO entitlements
         (user_id, plan, source, status, expires_at, max_macs, max_phones, monthly_mb, monthly_frames, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         plan = excluded.plan, source = excluded.source, status = excluded.status,
         expires_at = NULL, max_macs = excluded.max_macs,
         max_phones = excluded.max_phones, monthly_mb = excluded.monthly_mb,
         monthly_frames = excluded.monthly_frames,
         updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      planName,
      source,
      status,
      plan.maxMacs,
      plan.maxPhones,
      plan.monthlyMb,
      plan.monthlyFrames,
      nowIso(),
    )
    .run();
}

/**
 * Uses one place on an invite and grants its plan. The single UPDATE is
 * what keeps two sign-ups from taking the last place together.
 */
export async function redeemInvite(
  db: D1Database,
  userId: string,
  code: string,
): Promise<boolean> {
  const invite = await db
    .prepare(
      `UPDATE invites SET used = used + 1
       WHERE code = ? AND used < max_uses
         AND (expires_at IS NULL OR expires_at > ?)
       RETURNING plan`,
    )
    .bind(code.trim().toUpperCase(), nowIso())
    .first<{ plan: string }>();
  if (!invite) return false;
  await setEntitlement(db, userId, invite.plan, "invite");
  return true;
}

export async function createInvite(
  db: D1Database,
  options: { plan?: string; maxUses?: number; days?: number; note?: string },
): Promise<string> {
  const plan = options.plan ?? "beta";
  if (!PLANS[plan]) throw new Error(`Unknown plan ${plan}`);
  // Readable on a phone keyboard: no 0/O or 1/I.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const code = [...bytes].map((byte) => alphabet[byte % 32]).join("");
  const formatted = `${code.slice(0, 5)}-${code.slice(5)}`;
  const expires = options.days
    ? new Date(Date.now() + options.days * 86_400_000).toISOString()
    : null;
  await db
    .prepare(
      "INSERT INTO invites (code, plan, max_uses, used, expires_at, note, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
    )
    .bind(
      formatted,
      plan,
      options.maxUses ?? 1,
      expires,
      options.note ?? "",
      nowIso(),
    )
    .run();
  return formatted;
}

export async function device(
  db: D1Database,
  id: string,
): Promise<Device | undefined> {
  const row = await db
    .prepare(
      `SELECT id, user_id AS userId, kind, name, token_hash AS tokenHash,
              created_at AS createdAt, claimed_at AS claimedAt,
              revoked_at AS revokedAt, last_seen_at AS lastSeenAt
       FROM devices WHERE id = ?`,
    )
    .bind(id)
    .first<Device>();
  return row ?? undefined;
}

export async function userDevices(
  db: D1Database,
  userId: string,
): Promise<Device[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id AS userId, kind, name, NULL AS tokenHash,
              created_at AS createdAt, claimed_at AS claimedAt,
              revoked_at AS revokedAt, last_seen_at AS lastSeenAt
       FROM devices WHERE user_id = ? AND revoked_at IS NULL
       ORDER BY created_at`,
    )
    .bind(userId)
    .all<Device>();
  return results;
}

export async function countActiveDevices(
  db: D1Database,
  userId: string,
  kind: "mac" | "phone",
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND kind = ? AND revoked_at IS NULL",
    )
    .bind(userId, kind)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Adds to this month's usage and returns the month's totals. */
export async function addUsage(
  db: D1Database,
  userId: string,
  bytes: number,
  frames: number,
): Promise<{ bytes: number; frames: number }> {
  const row = await db
    .prepare(
      `INSERT INTO usage (user_id, month, bytes, frames) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, month) DO UPDATE SET
         bytes = bytes + excluded.bytes, frames = frames + excluded.frames
       RETURNING bytes, frames`,
    )
    .bind(userId, currentMonth(), bytes, frames)
    .first<{ bytes: number; frames: number }>();
  return row ?? { bytes, frames };
}

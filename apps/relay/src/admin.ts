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
} from "./util";

/**
 * What the owner can do to keys (invite codes) and accounts. Two doors lead
 * here: the `/admin/*` routes with `ADMIN_KEY` (the relay-admin script), and
 * a signed-in Mac whose account is on `ADMIN_EMAILS` (Settings › Account).
 */
export type AdminAction =
  | "invites.list"
  | "invites.create"
  | "invites.delete"
  | "users.list"
  | "plan.set";

/** Whether this email is on the relay's admin list. */
export function isAdmin(env: Env, email: string): boolean {
  if (!email) return false;
  return (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .includes(email.toLowerCase());
}

const badPlan = () =>
  fail(400, "BAD_PLAN", `Plans: ${Object.keys(PLANS).join(", ")}`);

export async function adminAction(
  env: Env,
  action: AdminAction,
  input: Record<string, unknown>,
  /** The script also wants each account's device counts; the Mac does not. */
  options: { devices?: boolean } = {},
): Promise<Response> {
  if (action === "invites.list") {
    const { results } = await env.DB.prepare(
      "SELECT code, plan, max_uses AS maxUses, used, expires_at AS expiresAt, grant_days AS grantDays, note, created_at AS createdAt FROM invites ORDER BY created_at DESC",
    ).all();
    return json({ ok: true, data: results });
  }

  if (action === "invites.create") {
    const plan = typeof input.plan === "string" ? input.plan : undefined;
    if (plan && !PLANS[plan]) return badPlan();
    const number = (value: unknown) =>
      typeof value === "number" && value > 0 ? Math.floor(value) : undefined;
    const maxUses = number(input.maxUses);
    const days = number(input.days);
    const grantDays = number(input.grantDays);
    return json({
      ok: true,
      data: {
        code: await createInvite(env.DB, {
          ...(plan ? { plan } : {}),
          ...(maxUses ? { maxUses: Math.min(maxUses, 1_000) } : {}),
          ...(days ? { days } : {}),
          ...(grantDays ? { grantDays } : {}),
          note: typeof input.note === "string" ? input.note.slice(0, 200) : "",
        }),
      },
    });
  }

  if (action === "invites.delete") {
    const code = typeof input.code === "string" ? input.code : "";
    const deleted = await env.DB.prepare("DELETE FROM invites WHERE code = ?")
      .bind(code)
      .run();
    if (!deleted.meta.changes) return fail(404, "NOT_FOUND", "No such key.");
    return json({ ok: true, data: null });
  }

  if (action === "users.list") {
    const devices = options.devices
      ? `(SELECT COUNT(*) FROM devices WHERE devices.user_id = users.id AND kind = 'mac' AND revoked_at IS NULL) AS macs,
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
  const plan = typeof input.plan === "string" ? input.plan : undefined;
  const monthlyFrames = input.monthlyFrames;
  /** How long the plan lasts from now; 0 for no end. */
  const days = input.days;
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
  return json({
    ok: true,
    data: (await activeEntitlement(env.DB, user.id)) ?? null,
  });
}

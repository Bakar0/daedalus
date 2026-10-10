// Admin for the Daedalus relay: invites, users and access.
//
//   RELAY_ADMIN_KEY=… bun run relay-admin --relay https://… <command>
//
// Commands:
//   invite [--plan beta] [--uses 1] [--days 14] [--note text]
//   invites
//   users
//   grant <email> [--plan beta]
//   revoke <email>
//   budget                 month-to-date units and estimated overage
//   budget close|reopen    pause or resume the whole relay
//
// Keep the key in a Daedalus secret and run through `daedal exec --secret
// RELAY_ADMIN_KEY -- bun run relay-admin …`, so it never lands in a shell
// history.
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    relay: { type: "string", default: process.env.RELAY_URL },
    plan: { type: "string" },
    uses: { type: "string" },
    days: { type: "string" },
    note: { type: "string" },
  },
});

const relay = values.relay;
const key = process.env.RELAY_ADMIN_KEY;
if (!relay || !key) {
  console.error("Needs --relay <url> (or RELAY_URL) and RELAY_ADMIN_KEY.");
  process.exit(2);
}
const base = new URL(relay);
if (base.protocol === "wss:") base.protocol = "https:";
if (base.protocol === "ws:") base.protocol = "http:";

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = (await response.json()) as
    { ok: true; data: unknown } | { ok: false; error: { message: string } };
  if (!result.ok) {
    console.error(result.error.message);
    process.exit(1);
  }
  return result.data;
}

const [command, argument] = positionals;
const number = (value?: string) => (value ? Number(value) : undefined);

switch (command) {
  case "invite": {
    const data = (await call("POST", "/admin/invites", {
      plan: values.plan,
      maxUses: number(values.uses),
      days: number(values.days),
      note: values.note,
    })) as { code: string };
    console.log(data.code);
    break;
  }
  case "invites":
    console.table(await call("GET", "/admin/invites"));
    break;
  case "users":
    console.table(await call("GET", "/admin/users"));
    break;
  case "budget":
    if (argument === "close" || argument === "reopen")
      console.log(
        await call("POST", "/admin/budget", { open: argument === "reopen" }),
      );
    else console.log(await call("GET", "/admin/budget"));
    break;
  case "grant":
  case "revoke":
    if (!argument) {
      console.error(`Usage: ${command} <email>`);
      process.exit(2);
    }
    console.log(
      await call("POST", "/admin/entitlements", {
        email: argument,
        status: command === "grant" ? "active" : "revoked",
        plan: values.plan,
      }),
    );
    break;
  default:
    console.error(
      "Commands: invite, invites, users, grant <email>, revoke <email>, budget [close|reopen]",
    );
    process.exit(2);
}

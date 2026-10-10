# Daedalus relay

Lets a phone operate Daedalus on a Mac from anywhere. The Mac and the phone each open a WebSocket to the relay, and the relay passes frames between them. The frames are encrypted end to end by the devices (`packages/remote-protocol`), so the relay reads only the routing id at the front of each frame.

It is a Cloudflare Worker with:

- one Durable Object (`Room`, `src/room.ts`) per Mac, holding that Mac's socket and its phones' sockets;
- a D1 database (`migrations/`) with users, sign-in sessions, devices, entitlements, invites and monthly usage.

The Mac side is `apps/desktop/src/bun/remote.ts`.

## Access

A phone signs in with Google (`/auth/google/start`). A new account needs an invite code, which grants a plan (`PLANS` in `src/accounts.ts`). Signing in alone is not enough. A Mac or phone connects only while its account has an active entitlement. Rooms recheck access hourly, and every 5 minutes while frames flow, and they also flush usage. An account past its plan's monthly data gets a `quota` notice, and the Mac stops terminal streams. At twice the limit the relay closes the connections.

A Mac starts unclaimed. A signed-in phone claims it by scanning its QR code (`POST /v1/pairings/claim`). The relay then gives the Mac a device token to reconnect with as that account's Mac. Removing a device (`DELETE /v1/devices/:id`) disconnects it. A removed Mac starts over with a new id.

Refused connections are accepted and then closed with a code (`CLOSE` in `src/util.ts`), because a browser cannot read the HTTP status of a failed WebSocket upgrade.

## Cost caps

Cloudflare has no spending limit for Workers, Durable Objects or D1, so the relay caps itself. The numbers behind this are in `artifacts/remote-work/cost-analysis.md`.

- **Per account.** Each plan has `monthlyFrames` (beta: 3 million, about $0.03). Rooms count frames and flush the count after 50,000 frames or 5 minutes. At the limit, the account's connections close with `overQuota`.
- **Whole relay.** One `Budget` Durable Object (`src/budget.ts`) keeps the month's billable units: frames, Durable Object requests and Worker requests. It prices them against the plan's included amounts. Once the estimated overage reaches `MONTHLY_BUDGET_USD`, connects and pushes are refused with `budgetExhausted`, rooms close their sockets, and the phone says remote access is paused until the 1st. Static files and `/health` keep answering.
- **Before sign-in.** Rate Limiting bindings, per IP: `AUTH_LIMITER` (30 a minute) covers `/auth/*`, invite codes and claims, and `UNCLAIMED_LIMITER` (10 a minute) covers unclaimed Mac connects. WAF rules would need a zone, which a workers.dev relay doesn't have.
- **Hourly** (cron `17 * * * *`): removes unclaimed Macs older than a day, plus expired sign-in states and sessions. Then the **watchdog** reads Cloudflare's own analytics for the month and prices them. Past the budget it closes the relay; past twice the budget it turns off the workers.dev route. It needs `CF_WATCHDOG_TOKEN`, and does nothing without it.

`relay-admin budget` shows the month so far. `relay-admin budget close` and `budget reopen` pause and resume the relay by hand.

## Configuration

| Name                                | Kind   | Purpose                                                                        |
| ----------------------------------- | ------ | ------------------------------------------------------------------------------ |
| `ADMIN_KEY`                         | secret | Bearer key for `/admin/*`                                                      |
| `GOOGLE_CLIENT_ID`                  | secret | Google OAuth web client                                                        |
| `GOOGLE_CLIENT_SECRET`              | secret | Google OAuth web client                                                        |
| `APP_ORIGINS`                       | var    | Comma-separated origins a sign-in may return to                                |
| `MONTHLY_BUDGET_USD`                | var    | Estimated overage a month at which the relay pauses (10)                       |
| `CF_ACCOUNT_ID`                     | var    | The account the watchdog reads analytics for                                   |
| `CF_WATCHDOG_TOKEN`                 | secret | Token with Account Analytics: Read and Workers Scripts: Edit, for the watchdog |
| `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` | var    | Web Push (`src/push.ts`)                                                       |
| `VAPID_PRIVATE_JWK`                 | secret | Web Push signing key                                                           |

In Google Cloud Console the OAuth client's authorized redirect URI is `https://<relay host>/auth/google/callback`.

## Admin

```sh
daedal exec --secret RELAY_ADMIN_KEY -- bun run relay-admin --relay https://<relay host> invite --note "for Dana"
daedal exec --secret RELAY_ADMIN_KEY -- bun run relay-admin --relay https://<relay host> users
daedal exec --secret RELAY_ADMIN_KEY -- bun run relay-admin --relay https://<relay host> revoke dana@example.com
```

`invite` takes `--plan`, `--uses` and `--days`. `grant` re-activates an account.

## Develop and deploy

```sh
bun run test:remote        # local relay (wrangler dev + local D1) driven end to end
cd apps/relay
daedal exec --secret CLOUDFLARE_API_TOKEN -- ./node_modules/.bin/wrangler d1 migrations apply DB --remote
daedal exec --secret CLOUDFLARE_API_TOKEN -- ./node_modules/.bin/wrangler deploy
printf %s "$VALUE" | daedal exec --secret CLOUDFLARE_API_TOKEN -- ./node_modules/.bin/wrangler secret put NAME
```

The relay is its own TypeScript project (Cloudflare's globals clash with Bun's). `bun run typecheck` checks it too.

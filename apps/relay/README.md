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

## Configuration

| Name                   | Kind   | Purpose                                         |
| ---------------------- | ------ | ----------------------------------------------- |
| `ADMIN_KEY`            | secret | Bearer key for `/admin/*`                       |
| `GOOGLE_CLIENT_ID`     | secret | Google OAuth web client                         |
| `GOOGLE_CLIENT_SECRET` | secret | Google OAuth web client                         |
| `APP_ORIGINS`          | var    | Comma-separated origins a sign-in may return to |

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

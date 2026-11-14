---
plan: Cart API v2
owner: checkout-lead
---

# Cart API v2

Replace the session-bound cart with a server cart that follows the user across web and mobile. The old cart lives in a signed cookie, caps at 20 items, and is lost when the user switches device. Support tickets about lost carts went from 40 to 130 a month since mobile launched.

Out of scope: wish lists, price rules, and guest-to-account merging beyond what checkout needs this quarter.

## Context

Carts are read on every page view (about 2,400 reads per second at peak) and written about 90 times per second. Mobile 4.0 ships on Dec 4 and calls the same endpoints, so the API has to be stable by Nov 20 for the docs team.

| Today                 | After                                        |
| --------------------- | -------------------------------------------- |
| Cookie, 4 KB limit    | Postgres row per cart, Redis in front        |
| Lost on device switch | Keyed by user id, shared by web and mobile   |
| No history            | `cart_events` for support and analytics      |

## Approach

Endpoints write to Postgres and invalidate Redis; reads go to Redis first. Checkout emits `cart.checked_out` so Orders can stop polling.

```
GET    /cart                → 200 { items, totals, version }
POST   /cart/items          → 201   (If-Match: version)
DELETE /cart/items/:sku     → 204
POST   /cart/checkout       → 202   emits cart.checked_out
```

## Tasks

- [x] Migrate saved carts @ui ^migrate
- [/] Cart endpoints @api ^endpoints
  Build the four endpoints above behind the `cart_v2` flag. Writes use optimistic locking on `version`; a stale write gets 409 with the current cart so the client can retry.

  - Validate SKUs against the catalog service, not the cookie.
  - Return totals computed server side; the client never sums.
  - Rate limit writes to 10 per second per user.

  ```ts
  // - [ ] not a task: this is inside a fence
  if (request.version !== cart.version) return conflict(cart);
  ```

  - [x] GET /cart and POST /cart/items ^get-post
  - [/] 409 on a stale version, with the current cart ^stale
  - [ ] Write rate limit ^rate-limit
- [/] Cart storage @db ^storage
  One `carts` row per user plus `cart_items`. The hot query is "cart for user" on every page view; the analytics job scans carts changed in the last day.
  > ? Which index: (user_id) or (user_id, updated_at)? The second serves the analytics scan but adds about 30% write cost.
- [x] Cart cache @cache ^cache
- [!] Payments provider @payments ^payments
  Move card capture to the new provider's hosted fields. The provider's sandbox has been down since Tuesday; testing runs against recorded responses.
  > ? Ship behind the old provider while the sandbox is down?
- [ ] Checkout screens ^screens
  Cart page and checkout summary on web and mobile, reading the server cart.
- [-] Guest cart merge ^guest-merge
  Dropped for this quarter; see Out of scope.

## Done when

- Web and mobile read the same cart for a signed-in user.
- p95 for `GET /cart` stays under 40 ms at 2,400 reads per second.
- The `cart_v2` flag is on for 100% of traffic for a week with no rollback.

## Risks

| Risk                      | Odds   | Plan                                 |
| ------------------------- | ------ | ------------------------------------ |
| Payments cut-over slips   | medium | Keep the old provider behind a flag  |
| Docs wait on a stable API | low    | Freeze the API on Nov 20             |

## Log

- Nov 12 14:02 @payments: sandbox down, testing against recorded responses
- Nov 12 11:40 @db asked under Cart storage
- Nov 11 23:15 @checkout-lead started the plan

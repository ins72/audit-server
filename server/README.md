# Login gate, Stripe paywall and plan sharing

Server pieces of this fork (new here? start with [`docs/README.md`](../docs/README.md)). For architecture, design decisions, extension points and known limitations read
[`docs/HANDOVER.md`](../docs/HANDOVER.md) first. `http_server.js` wires them together; configuration is in `/.env.example`.

## How it works

1. The Stremio core logs the user in against api.strem.io, as usual.
2. The page posts the Stremio `authKey` to `POST /auth/session`. The server verifies it with Stremio
   (`getUser`), stores who the user is, sets a signed 12h cookie, and **throws the authKey away**.
3. The page shows only the login screen to logged-out users (no guest mode), a paywall to logged-in users
   without an entitlement, and the app otherwise. A 2-minute heartbeat (`GET /auth/me`) keeps the cookie fresh
   and picks up changes such as a lapsed subscription or a removed invite.

Entitlement = an active/trialing subscription of your own, **or** an operator comp grant for your email, **or** being
invited (by verified Stremio email) to an owner's active plan. `past_due` keeps access for `PAST_DUE_GRACE_DAYS`.

## Endpoints

| Route | Who | Purpose |
|---|---|---|
| `POST /auth/session` | page | verify authKey, start session |
| `GET /auth/me` | session | user + entitlement, heartbeat |
| `POST /auth/logout` | anyone | clear cookie |
| `GET /billing/plans` | session | plans the UI may offer (id, name, description, seats; never price ids) |
| `POST /billing/checkout` `{planId}`, `/billing/portal` | session | Stripe Checkout (409 `subscription_exists` while Stripe holds a subscription) / Customer Portal |
| `GET/POST /billing/invites`, `POST /billing/invites/remove` | owner or manager | manage shared seats |
| `POST /billing/webhook` | Stripe | subscription state (signature checked) |
| `GET /operator/` | none (static) | operator panel UI; its API calls need `ADMIN_TOKEN` |
| `POST /admin/ban`, `/admin/unban` `{email, note}`; `GET /admin/audit` | `ADMIN_TOKEN` | block an account / recent audit entries |
| `GET /config/public` | none | settings that are safe for any visitor (name, tagline, links); only values the operator set |
| `GET/PUT /admin/settings` | `ADMIN_TOKEN` | read and change operator settings; empty value resets to the default; validated; audited |
| `GET /admin/plans`; `PUT /admin/plans/:id`; `POST /admin/plans/:id/archive` and `/restore` | `ADMIN_TOKEN` | manage plans (name, description, price text, seats, Stripe price id). The price id cannot change after creation; plans are archived, not deleted |
| `POST /admin/signout` `{email}` | `ADMIN_TOKEN` | sign a person out of every device without blocking them (404 `not_found` if unknown) |
| `GET /billing/confirm?token=` | one-time token | invitee confirms their address (`INVITE_CONFIRM=true`); redirects to the app |
| `POST /billing/invites/role` `{email, role}`, `/billing/transfer` `{email}` | session (owner) | promote/demote a manager; hand the plan to a joined member |
| `POST /billing/invites/resend`, `/billing/leave` | session | resend a pending invitation email / member leaves a shared plan |
| `POST /auth/activity` `{seconds,type,id,title,start,completed,source,addon}` or `{event:'error',code,critical,...}` | session | player reports watch time (204 always; stored only when `WATCH_STATS` is not `false`) |
| `GET /auth/my-data` | session | the signed-in person's own account, sign-in, viewing and billing records as a JSON download (never the Stremio key; no erasure) |
| `GET /admin/stats/user?email=` | `ADMIN_TOKEN` | one person: first/last seen, login count, their last 20 sign-in times, watch totals |
| `GET /admin/stats?days=` | `ADMIN_TOKEN` | usage statistics: daily logins/active/new users, activation, retention, top content/viewers, never-watched list, plan/conversion counts; add `&format=csv` for the daily series |
| `GET /admin/sessions?q=&limit=&offset=` | `ADMIN_TOKEN` | who logged in / is online; `q` filters by part of the email, `limit` 1-500 (default 100), `offset` pages; `total`, `online` and `matched` counts are always returned |
| `GET /admin/billing` | `ADMIN_TOKEN` | owners, status, plain-text invites, duplicate subscriptions, comp grants |
| `GET /admin/users/export?email=`, `/admin/billing/export?email=` | `ADMIN_TOKEN` | everything stored about one email (access request) |
| `POST /admin/billing/erase`, `/admin/users/erase` | `ADMIN_TOKEN` | erase one email's billing / user data (`{"email"}`); see Privacy in HANDOVER.md |
| `POST /admin/billing/invites/remove` `{owner, email}` | `ADMIN_TOKEN` | remove one invitee from an owner's plan (audited; a joined member gets the courtesy email) |
| `POST /admin/grants`, `/admin/grants/remove` | `ADMIN_TOKEN` | give or revoke complimentary access to an email (`{"email", "note"}`) |
| `POST /admin/note` `{email, note}` | `ADMIN_TOKEN` | operator-only note on a person (500 characters; empty clears); in exports; erased with the person; text kept out of the audit log |
| `POST /admin/plans/price` `{name, amount, currency, interval}` | `ADMIN_TOKEN` | create a recurring Stripe price (amount in major units; interval month or year); returns `priceId` and `priceLabel`; 502 `stripe_unavailable` when Stripe refuses |
| `GET /admin/health` | `ADMIN_TOKEN` | setup and health checklist: per item status ok/warn/fail/off, fix hint, last webhook, backup, disk, version, uptime |
| `GET /healthz` | anyone | liveness |

## Error codes

Errors are JSON `{ "error": "<code>" }`. The client maps the ones users can act on; the rest are for logs and your own tooling.

| Code | Status | Meaning |
|---|---|---|
| `not_logged_in`, `invalid_session` | 401 | no/expired/revoked cookie; the client silently re-presents the Stremio key |
| `session_replaced` | 401 | signed out by a newer device (`MAX_DEVICES`) |
| `banned` | 403 | operator blocked the account |
| `invalid_auth_key` | 401 | Stremio rejected the key |
| `verification_unavailable` | 502 | Stremio unreachable/overloaded; retry (`Retry-After`) |
| `rate_limited` | 429 | too many failures/mutations from this IP |
| `bad_origin` | 403 | `Origin` does not match `PUBLIC_URL` |
| `payment_required` | 402 | route needs an entitlement |
| `subscription_exists` | 409 | Stripe already holds a subscription for this user: use the portal |
| `already_entitled`, `paywall_disabled`, `invalid_plan`, `no_subscription`, `stripe_unavailable` | 4xx/5xx | checkout/portal preconditions |
| `owners_only`, `managers_only` | 403 | caller's role is too low |
| `invalid_email`, `cannot_invite_self`, `already_invited`, `already_joined`, `not_invited`, `not_joined`, `invalid_role` | 400/409 | invite validation |
| `seat_limit_reached`, `email_limit_reached`, `email_disabled` | 409/429 | plan seats full / 10 emails per 24h / mail not configured |
| `target_has_plan`, `target_has_invites`, `not_a_member` | 409/400 | ownership transfer or leave preconditions |
| `subscription_live` | 409 | erase refused until the Stripe subscription is cancelled |
| `not_banned`, `not_granted` | 404 | unban / revoke on something that is not there |
| `note_too_long` | 400 | operator note over 500 characters |
| `storage_unavailable` | 500 | disk write failed; the change was rolled back, safe to retry |
| `invalid_signature` | 400 | webhook signature mismatch |

## Protecting your own paid content

```js
app.get('/api/stream/:id', billing.requireEntitlement, (req, res) => {
    // req.session = { id, email }, req.entitlement = { role: 'owner' | 'member', ... }
});
```

The in-browser gate is a UI gate only (the client code is public). Real enforcement is whatever your own
server hands out behind `requireSession` / `requireEntitlement`.

## Configuration

Every environment variable, with defaults and meaning, is in [`.env.example`](../.env.example) and the table in [`docs/HANDOVER.md`](../docs/HANDOVER.md#environment-variable-reference). The ones most often forgotten: `SESSION_SECRET`, `ADMIN_TOKEN`, `PUBLIC_URL`, `COOKIE_SECURE=true`, `TRUST_PROXY=1` behind a proxy, `SUPPORT_EMAIL`, `MAX_DEVICES`, `INVITE_EXPIRY_DAYS`, `STATS_FILE`/`WATCH_STATS`, `AUDIT_FILE`.

## Stripe setup

0. Optional: set `STRIPE_AUTOMATIC_TAX=true` to collect a billing address and let Stripe Tax add VAT/sales tax (turn on Stripe Tax first).
1. Create a recurring Price; put its id in `STRIPE_PRICE_ID`. For several plans set `PLANS` instead (JSON, see `.env.example`):
   each plan has its own Price and number of shared seats. The subscription's Stripe price decides the plan, so plan switches
   made in the Customer Portal (enable "customers can switch plans" and add all prices there) take effect via webhooks;
   after a downgrade only the first `seats` invitees keep access.
2. Webhook endpoint `https://YOUR_DOMAIN/billing/webhook` with events `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`;
   put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Enable the Customer Portal (Stripe Dashboard, Settings, Billing, Customer portal).
4. Use test-mode keys first.

## Invite emails (optional)

Set `RESEND_API_KEY`, `MAIL_FROM` and `PUBLIC_URL` to email invitees when an owner invites them (plain text, via Resend).
Without them, invites still work and the owner tells the invitee. A failed send never blocks the invite.

## Reliability notes

- Webhooks are verified, de-duplicated by event id, order-safe (an older event never overwrites a newer one)
  and persisted before Stripe gets its 200. Hourly (and at startup) the server re-reads subscriptions whose
  period ended from Stripe, so a missed webhook heals itself. A Stripe outage never revokes access.
- A second paid subscription by the same user is not applied; it is listed under `duplicateSubscriptions`
  in `/admin/billing` so you can refund it.
- Data is in `data/users.json` and `data/billing.json` (0600). A corrupt file is moved aside, never overwritten.
  Keep `data/` on persistent disk and back it up. Single instance only (no shared state between replicas).
- Behind a reverse proxy: set `TRUST_PROXY`, preserve the request body of `/billing/webhook`, and forward
  `/auth`, `/billing`, `/admin`, `/healthz` to Node.

## Local development

`pnpm start` serves the UI on https://localhost:8080 and proxies `/auth`, `/billing` and `/admin` to
`http://localhost:8081` (override with `AUTH_SERVER_URL`). In a second terminal run `PORT=8081 node http_server.js`.

## Tests

80 tests cover auth, billing, plans, invites, security, mail, statistics and data download. `pnpm run test:server` (Node's built-in runner; no network, Stripe is stubbed and webhook signatures are real).

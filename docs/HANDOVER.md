# Handover: login gate, Stripe paywall, plan sharing

This fork of `stremio-web` adds these things on top of upstream (see also [`FORK_CHANGES.md`](FORK_CHANGES.md) for every touched upstream file):

1. **Login required.** No guest mode; logged-out users only see the intro/login screen.
2. **The server knows who is logged in** (verified Stremio email + id) and the operator can list them.
3. **Optional Stripe subscription paywall** with one or more plans, where a subscriber can share their plan with invited emails (member/manager roles, ownership transfer, invite expiry, optional email confirmation).
4. **Operator tooling**: operator panel at `/operator/`, ban/unban, optional device limit, data export/erasure, audit log, backups, health check.

Everything is behind the Stremio account: we do not run our own user database for authentication.
Operator-facing setup lives in [`server/README.md`](../server/README.md) and [`.env.example`](../.env.example).
This file explains *how it fits together and why*, for whoever changes it next.

**New here? Start with [`README.md`](README.md) in this folder** (reading order by role, glossary, commands).

Contents: [Mental model](#mental-model) · [File map](#file-map) · [Decisions](#decisions-worth-knowing-and-why) · [Verified?](#what-was-and-was-not-verified-without-a-build) · [Go-live checklist](#go-live-checklist) · [Constants](#constants-you-may-want-to-tune) · [Running it](#running-it) · [Environment variables](#environment-variable-reference) · [How to extend](#how-to-extend) · [Limitations](#known-limitations) · [CI](#ci-and-previews) · [Troubleshooting](#troubleshooting) · [Behaviours](#behaviours-worth-knowing-added-after-review) · [Trust assumption](#known-trust-assumption-email-ownership) · [Data requests](#data-requests) · [Operator actions](#operator-actions) · [Statistics](#statistics) · [Backups](#backups) · [Privacy and erasure](#privacy-and-erasure)

## Mental model

```
 Browser (stremio-web)                          This server (http_server.js)             External
 ─────────────────────                          ───────────────────────────              ────────
 core WASM logs in ───────────────────────────────────────────────────────────────────▶ api.strem.io
 profile.auth.key (Stremio authKey)
        │  POST /auth/session {authKey}
        ├─────────────────────────────────────▶ auth.js: ask Stremio getUser ─────────▶ api.strem.io
        │                                        store id+email, DROP the key
        │◀──── Set-Cookie stremio_session (signed, 12h) + entitlement
        │  GET /auth/me every 2 min / on tab focus (heartbeat, renews cookie, refreshes entitlement)
        │
        │  POST /billing/checkout ────────────▶ billing.js ─────────────────────────────▶ Stripe Checkout
        │◀──────────────── redirect to Stripe, pay, redirect back (?checkout=success)
        │                                        Stripe ──POST /billing/webhook──▶ billing.js (source of truth)
```

Key point: **the Stremio core logs in directly against Stremio, never through us.** The server can only learn who
someone is when the page hands over its `authKey`, which we verify with Stremio and then discard. We never store
or log an authKey.

Entitlement (what `entitlementFor` in `server/billing.js` returns):

| role | meaning |
|---|---|
| `free` | paywall disabled (`PAYWALL_ENABLED` off): every logged-in user is allowed |
| `owner` | has an active/trialing subscription (or `past_due` inside the grace period) |
| `member` | invited by email to an active owner's plan (email match is against the **Stremio-verified** email). Carries `memberRole` (`member` or `manager`), `canManageInvites` and `sharedBy` |
| `granted` | complimentary access the operator gave to an email via `/admin/grants` (no Stripe; cannot invite others) |
| `none` | logged in, no access: the client shows the paywall |

Owners additionally get `plan`, `invites {used,max}` and billing dates. Managers (a member role) may invite, remove and resend, but cannot appoint/remove managers, touch billing or transfer the plan; only the owner can. Banned accounts never reach `entitlementFor`: login answers 403 `banned`.

## File map

Server (plain Node/Express, CommonJS, no build step):

| File | Responsibility |
|---|---|
| `http_server.js` | Wiring, env validation, security headers, health check, static files, graceful shutdown. Upstream file, heavily extended. |
| `server/auth.js` | Stremio verification (deduped, capped, queued), signed session cookie with device slot id, `requireSession`, `/auth/*`, user store, ban/unban, device limit, `/admin/{sessions,ban,unban,signout,note,audit,users/export,users/erase}`. |
| `server/billing.js` | Plans, Stripe Checkout/Portal, webhook, entitlements, invites (roles, expiry, resend, confirm link, leave), ownership transfer, grants, reconcile job, notices, `/admin/billing{,/export,/erase}`, `requireEntitlement`. |
| `server/stats.js` | Usage statistics (own file `data/stats.json` / `STATS_FILE`): per-day logins/active/watchers/hours (120 days kept), per-user watch totals, top 2000 titles, hour-of-day and per-type totals. `GET /admin/stats`. Included in user export and erase. |
| `server/audit.js` | Append-only JSON-lines audit trail of operator and ownership actions (`data/audit.log` or `AUDIT_FILE`), read via `/admin/audit`. |
| `server/mailer.js` | Optional emails via Resend's HTTP API (plain text only): `sendInvite({to, ownerEmail, confirmUrl})` and `sendNotice({to, kind: removed\|lapsed\|transferred, ownerEmail})`. Off unless configured. |
| `server/security.js` | Rate limiter, CSRF origin guard, security headers, JSON error handler. |
| `server/jsonFile.js` | Atomic JSON persistence (debounced `save()`, immediate `flush()`, corrupt-file quarantine). |
| `server/operator/` | Operator panel (static HTML/JS) served at `/operator/`: online users, blocked accounts, subscribers, grants, audit. Strict CSP, textContent only, token kept in `sessionStorage`. |
| `server/tools/loadtest.js` | Self-contained load test (`node server/tools/loadtest.js 3000`, optionally `MAX_DEVICES=3`). Spots regressions; not a sizing tool. |
| `server/*.check.js` | Tests (`pnpm run test:server`, Node's built-in runner; named `.check.js` so Jest ignores them). |

Client (React/TypeScript, part of the normal webpack build):

| File | Responsibility |
|---|---|
| `src/router/useServerSession.ts` | Hook: posts the authKey, tracks status (`checking/verified/error/rejected/blocked/replaced`), entitlement, jittered heartbeat, silent re-verification, auto-retry on 502. |
| `src/router/Routes.tsx` | The gate: logged-out → `/intro`; not verified → `ServerSessionGate`; no entitlement → `PaywallScreen`; else the app. |
| `src/router/ServerSessionGate/` | "Verifying…", "could not verify", "session expired", "blocked" and "signed out on this device" (device limit) screens (its `styles.less` is shared with the paywall). |
| `src/router/PaywallScreen/` | Plan cards, Subscribe / Renew / Manage billing; polls after returning from Stripe. |
| `src/router/serverApi.ts` | `apiFetch`/`apiPost` with a 10s timeout. Use these for any call to our server. |
| `src/routes/Settings/Subscription/` | Settings → Subscription page (native Group/Row/RowButton): plan status, manage billing, devices, shared plan + leave, invite list (resend/renew, roles, make owner, remove) and invite form. Registered via `PAGES.SUBSCRIPTION` in `constants.ts`, `useSettingsPages.ts`, `Settings.tsx`, `useSettingsSearch.ts`. |
| `src/routes/Player/useWatchReport.ts` | Counts seconds actually playing (visible tab, not paused) and POSTs batches to `/auth/activity` about once a minute and on leaving; fire-and-forget. Called from `Player.js`. |
| `src/routes/Intro/Intro.js` | Upstream login screen; the guest-login button was removed. |

Everything under `/data` (git-ignored) is runtime state: `users.json`, `billing.json`, `stats.json`, `audit.log` (plus dated `.bak` copies).

## Decisions worth knowing (and why)

- **Session cookie, not JWT-in-localStorage.** HttpOnly + SameSite=Lax, signed with HMAC (`SESSION_SECRET`). 12h life,
  renewed by the heartbeat only up to **7 days** since the authKey was last verified, so a Stremio session that was
  revoked cannot live on forever here. The page re-presents the authKey on every load, which re-verifies.
- **Stremio outage ≠ invalid login.** `fetchStremioUser` returns "rejected" (401) only when Stremio answers with an
  explicit error object; HTTP errors, timeouts or odd replies are 502 and the client keeps its state. The client never
  auto-logs-out on 401; it shows a "session expired" screen and lets the user choose.
- **The webhook is the source of truth for payment state.** It is signature-verified, idempotent (event ids are kept),
  order-safe (an older event never overwrites a newer one) and persisted *before* answering 200, because Stripe will
  not resend an acknowledged event.
- **Reconcile job.** Hourly and 5s after startup, subscriptions whose billing period has ended are re-read from Stripe
  (`stripe.subscriptions.retrieve`). This heals missed webhooks. A Stripe outage during reconcile changes nothing.
- **Grace period.** `past_due` (card failed, Stripe retrying) keeps access for `PAST_DUE_GRACE_DAYS` (default 3).
- **One active subscription per user.** If someone pays in two tabs, the second is *not* applied; it is listed in
  `/admin/billing` under `duplicateSubscriptions` for manual refund. We deliberately do not auto-cancel/refund money.
- **Invites are plain text on purpose** (the requirement was that the operator can read them). They are stored in
  `billing.json` and shown in `/admin/billing`. An invite is matched by the invitee's Stremio-verified email,
  case-insensitively, so it cannot be spoofed by claiming an email.
- **Fail closed in the UI.** Logged in but no entitlement reported → error screen, not the app.
- **Rate limiting counts failures only** for login/admin, so many users behind one IP (office, CGNAT, or a proxy
  without `TRUST_PROXY`) are not locked out together. Billing mutations are limited to 30/min/IP.
- **CSRF**: SameSite=Lax + JSON-only bodies, plus an `Origin` check that is only enabled when `PUBLIC_URL` is set
  (a proxy that rewrites `Host` would otherwise make every POST look cross-site).
- **No CSP header** on purpose: the Stremio app uses WASM, workers and arbitrary remote images/addons; a wrong CSP
  breaks playback. Add one only with thorough testing.

## What was and was not verified without a build

> **Update 2026-11-20:** the client has since been built (`webpack --mode production`), linted (0 errors) and run in headless Chromium against a stubbed Stremio API; see [`PROGRESS.md`](PROGRESS.md) and [`screenshots/`](screenshots/README.md). The paragraph below is the original note and is kept for history.

The client could not be built where this was written (`pnpm install` was blocked). Instead every new client file (`useServerSession.ts`, `serverApi.ts`, `ServerSessionGate`, `PaywallScreen`, `Subscription.tsx`, `useWatchReport.ts`) was type-checked with `tsc --strict` against the real upstream component sources and React's types: no errors in these files. Not covered: webpack/loader behaviour, ESLint, the `.less` files, `Player.js` (plain JS), and anything that only shows at runtime in a browser. `pnpm build && pnpm lint` and a manual click-through remain your first steps.

## Go-live checklist

Do these in order; each step is only verifiable by you, because none of it could be run where this was written.

1. `pnpm install`, commit `pnpm-lock.yaml`, then `pnpm build && pnpm lint && pnpm run test:server`.
2. Copy `.env.example`, set `SESSION_SECRET` (32+ random chars), `ADMIN_TOKEN`, `PUBLIC_URL`, `COOKIE_SECURE=true`, `TRUST_PROXY=1` (behind one proxy), `NODE_ENV=production`.
3. Mount a persistent volume on `data/` and snapshot it off-machine.
4. Stripe (test mode first): create price(s) and set `STRIPE_PRICE_ID` or `PLANS`; add a webhook to `PUBLIC_URL/billing/webhook` with `checkout.session.completed` and `customer.subscription.created/updated/deleted`; set `STRIPE_WEBHOOK_SECRET`; configure the Customer Portal (enable plan switching if you have several plans); set `PAYWALL_ENABLED=true`.
5. Optional email: `RESEND_API_KEY`, `MAIL_FROM` (verified sender domain), and `INVITE_CONFIRM=true` if you want invitees to prove mailbox ownership.
6. Proxy: TLS, compression, forward `/auth`, `/billing`, `/admin`, `/operator`, `/healthz` and static files to the server; point the uptime check at `/healthz`.
7. Smoke test: log in, hit the paywall, pay with a Stripe test card, invite a second account, accept, remove, check `/operator/`, ban/unban a test account.
8. Run `node server/tools/loadtest.js 3000` against a staging copy (it starts its own server, so run it on the same hardware class).
9. Switch Stripe to live keys and repeat steps 4 and 7 with a real small payment.

## Constants you may want to tune

`server/auth.js`: session 12h, max session age 7d, online window 5min, verify timeout 8s, login limiter 20 failures/min.
`server/billing.js`: grace 3d (`PAST_DUE_GRACE_DAYS`), seats 2 (`INVITE_SEATS`, or per plan via `PLANS`), stored event ids 500, mutation limiter 30/min.
`http_server.js`: reconcile every 1h, shutdown timeout 10s, HTTP timeouts. Env-tunable: `MAX_DEVICES`, `INVITE_EXPIRY_DAYS`, `INVITE_SEATS`, `PAST_DUE_GRACE_DAYS`. Also in billing: email cap 10/owner/24h, confirm link 7d, reconcile ≤500 owners/run. `server/jsonFile.js`: debounced save delay 3s.
`src/router/useServerSession.ts`: heartbeat 2min, min gap between focus-refreshes 30s.

## Running it

```bash
pnpm install
# Terminal 1: API server (the dev UI server owns :8080, so use another port)
PORT=8081 node http_server.js
# Terminal 2: UI with /auth, /billing, /admin proxied to :8081 (override with AUTH_SERVER_URL)
pnpm start
# Server tests
pnpm run test:server
```

Production: `pnpm build`, then `node http_server.js` (or the Dockerfile, which sets `NODE_ENV=production`, runs as
non-root and expects a volume on `data/`). In production a missing `SESSION_SECRET` is fatal. Stripe webhooks need the
raw request body, so a reverse proxy must not alter bodies on `/billing/webhook`.

Account management features (all server-enforced, all audited to `data/audit.log`, path overridable with `AUDIT_FILE` and `GET /admin/audit`):

- Owners can add, remove and **resend** invitations; **members can leave** a shared plan themselves (`POST /billing/leave`), which frees the seat.
- The operator can **block/unblock** an email (`POST /admin/ban`, `/admin/unban`): live sessions die immediately, login returns 403 `banned`, and the client shows a "blocked" screen instead of retrying.
- **Roles.** Every invited person is a `member` (uses the plan) or a `manager` (additionally invites, removes and resends for the owner's plan, but cannot appoint managers, remove other managers, touch billing or transfer). Only the owner changes roles (`POST /billing/invites/role`). There is deliberately no "viewer" role: watching happens client-side against Stremio, so the server cannot restrict it.
- **Ownership transfer** (`POST /billing/transfer {email}`, owner only): the target must have joined, must not pay for or share a plan of their own. The plan record, Stripe customer and invite list move to them; the previous owner stays on as a manager. Stripe events keep routing through `customers[customerId]`, which is why that map takes priority over subscription metadata in `applySubscription`. The subscription's `userId` metadata is updated best effort. The new owner gets the card on file in the Stripe customer, so only transfer to someone you trust with it.
- **Invite expiry** (`INVITE_EXPIRY_DAYS`, default 30, 0 = never): an invitation nobody used stops granting access; "Renew"/resend restarts it. People who already joined never expire.
- **Courtesy emails** (only with email configured, best effort, never blocking): a joined member is emailed when removed; members are emailed when the owner's plan stops being active (detected on Stripe events, not on the passive end of a grace period); a new owner is emailed on transfer.
- **Device limit** (`MAX_DEVICES`, default 0 = unlimited): cookie-session slots per account. A login from a new browser signs out the least recently used one; that device's next heartbeat gets 401 `session_replaced` and the client shows "You were signed out on this device" with a "Use this device" button (it does not silently re-login, otherwise two devices would keep signing each other out). It limits web sessions, not actual streaming, which the server cannot see. With a limit set, logging out signs out only that device. Without it, logout revokes all cookies of the user as before.
- Remaining design decisions: pending invitations still occupy a seat until removed or expired-and-renewed; invitations are keyed by Stremio account email, so a member who changes their Stremio email must be re-invited; when a plan simply runs past its grace period, members are not emailed (they see the paywall).

Operator panel: open `https://your.domain/operator/`, paste `ADMIN_TOKEN` (kept in that tab's sessionStorage only). It shows who is online, subscribers with their plan/status/invited emails (duplicate-subscription warnings included), comp grants (add/revoke) and an Erase button per person. It is plain static files in `server/operator/` (strict CSP, user data inserted via `textContent`) and holds no data itself: every call it makes needs the token. It also lists blocked accounts (block/unblock) and the recent audit trail. Without `ADMIN_TOKEN` set it is inert.

Useful operator calls:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://your.domain/admin/billing    # owners, plans, invited emails, comp grants
curl -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
     -d '{"email":"person@example.com"}' https://your.domain/admin/billing/erase   # erasure request (then /admin/users/erase)
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://your.domain/admin/sessions   # who logged in / online
curl https://your.domain/healthz

# Complimentary access (testers, friends, goodwill after a refund): no Stripe involved, revocable
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
     -d '{"email":"tester@example.com","note":"beta tester"}' https://your.domain/admin/grants
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
     -d '{"email":"tester@example.com"}' https://your.domain/admin/grants/remove
```

Grants are keyed by the Stremio-verified email (case-insensitive), listed in `/admin/billing` under `grants`, and the
operator `note` is never shown to the user. They are checked after an owner's own subscription and before invites.

See also `docs/FORK_CHANGES.md`: every difference from upstream Stremio Web, what was deliberately left alone, and how to merge upstream.

## Environment variable reference

Everything `http_server.js` reads. `.env.example` has commented examples; this is the complete list.

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_SECRET` | none (required in production, 32+ chars) | signs session cookies; changing it logs everyone out |
| `ADMIN_TOKEN` | unset (admin/operator disabled) | bearer token for `/admin/*` and the `/operator/` panel |
| `PORT` | 8080 | listen port (Docker healthcheck follows it) |
| `PUBLIC_URL` | unset | canonical https origin; enables the CSRF origin check and is used in Stripe return URLs and emails |
| `COOKIE_SECURE` | false | set `true` when served over HTTPS (also enables HSTS) |
| `TRUST_PROXY` | unset | `1` behind one reverse proxy so rate limits see real client IPs |
| `NODE_ENV` | unset | `production` makes unwritable data files and a missing `SESSION_SECRET` fatal |
| `STREMIO_API_URL` | https://api.strem.io | Stremio API used to verify logins |
| `USERS_FILE`, `BILLING_FILE`, `STATS_FILE`, `AUDIT_FILE` | `data/users.json`, `data/billing.json`, `data/stats.json`, `data/audit.log` | persistence locations (mount a volume on `data/`) |
| `WATCH_STATS` | true | `false` stops collecting usage statistics (see Statistics) |
| `SUPPORT_EMAIL` | unset | shown to blocked users on the blocked screen |
| `PAYWALL_ENABLED` | false | turns on the Stripe paywall |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | none (required when paywall on) | Stripe API key and webhook signing secret |
| `STRIPE_PRICE_ID`, `INVITE_SEATS` | none, 2 | single plan and its shareable seats (1-50) |
| `PLANS` | unset | JSON list of plans; replaces the two above |
| `PAST_DUE_GRACE_DAYS` | 3 | access kept after a failed renewal (0-30) |
| `STRIPE_AUTOMATIC_TAX` | false | collect billing address and use Stripe Tax |
| `RESEND_API_KEY`, `MAIL_FROM` | unset | invite emails (also need `PUBLIC_URL`) |
| `INVITE_CONFIRM` | false | invitees must confirm their address by emailed link |
| `INVITE_EXPIRY_DAYS` | 30 | unused invitations stop working after this many days (0 = never) |
| `MAX_DEVICES` | 0 | concurrent signed-in browsers per account; a new one signs out the least recently used (0 = unlimited) |

## How to extend

- **Protect your own paid content:** mount the route behind `billing.requireEntitlement` (or `auth.requireSession` for
  login-only). It sets `req.session = {id, email}` and `req.entitlement`. This is the *only* real enforcement.
- **Rentals / multiple tiers / per-item purchases:** `billing.js` models a single subscription per user
  (`state.owners[userId]`). For other products, add a new record type keyed by the same Stremio `user.id` rather than
  overloading `status`. Keep `entitlementFor` as the single decision point and extend what it returns.
- **Multiple profiles:** key them under the verified Stremio `user.id`; do not trust client-supplied ids.
- **Invite emails:** sent only when `RESEND_API_KEY`, `MAIL_FROM` and `PUBLIC_URL` are all set (`server/mailer.js`).
  The invite is saved first; a failed email never fails or undoes it (the response says `notified: false` and the UI
  tells the owner to let them know). To use another provider (SMTP, SES) implement the same
  `sendInviteEmail({ to, ownerEmail, confirmUrl })` (and `sendNotice`) in `http_server.js`; `confirmUrl` is only present with `INVITE_CONFIRM=true` and must be in the body. Not yet tested against the live Resend API.
- **Per-seat pricing:** needs Stripe `quantity` + `customer.subscription.updated` handling; the current flat price
  and `INVITE_SEATS` cap would be replaced.
- **More than one server instance:** state is in local JSON files. Replace `jsonFile.js` consumers with a real database
  (the `createJsonFile` surface is small: `data`, `save`, `flush`) before scaling out.
- **Translations:** the new screens use hardcoded English strings (upstream uses `t('KEY')` from `stremio-translations`).

## Known limitations

- **The in-browser gate is UI only.** The client code is public and the video/catalog traffic goes straight to Stremio
  and addons, not through this server. Someone who edits the page can bypass the login/paywall screens. Only your own
  server routes behind `requireEntitlement` are enforced.
- Guests cannot be identified at all (that is why guest mode is removed).
- Deep links: a logged-out visitor is sent to the login screen and returned to the link they opened after logging in
  (kept in `sessionStorage`, in `Routes.tsx`); it is dropped on explicit logout and silently skipped if storage is blocked.
- Single instance only; `data/` needs persistent disk and backups.
- `pnpm-lock.yaml` must be regenerated with `pnpm install` after the `express` and `stripe` additions to `package.json`
  (it could not be updated in the environment where this was written; `pnpm i --frozen-lockfile` fails until then).
- The client was first built and rendered in Chromium on 2026-11-20 (stubbed Stremio API; see `PROGRESS.md`). A real Stripe test checkout, real playback and the invite/device-limit flows in a browser are still to be checked before shipping.
- Stripe behaviour is covered by tests with a stubbed Stripe client (webhook signatures are real); a live
  test-mode end-to-end payment has not been done.
- License: stremio-web is GPL-2.0. A distributed fork has to stay open source.

## CI and previews

`.github/workflows/build.yml` runs `pnpm run test:server` next to the upstream build, test and lint steps. CI installs
with a frozen lockfile, so it fails until `pnpm-lock.yaml` is regenerated (see Known limitations).

The upstream workflows also publish a **static** GitHub Pages preview of every branch. That preview has no `/auth`
server behind it, so with this fork's login gate it shows "Could not verify your account". It is not a bug in the app:
test against a real `node http_server.js`, or remove/disable the Pages jobs in your fork if you do not want them.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Everyone stuck on "Verifying your account…" | `/auth/session` failing: check the server is reachable from the page (proxy paths, dev proxy port) and `STREMIO_API_URL`. |
| "Could not verify your account" | Server returned 502: Stremio API unreachable from the server, or `/auth/*` not proxied. |
| Everyone suddenly rate limited (429) | Proxy without `TRUST_PROXY`: all users share the proxy IP. The log warns about `X-Forwarded-For`. |
| All POSTs return 403 `bad_origin` | `PUBLIC_URL` does not match the site's real origin. |
| Paid user still sees the paywall | Webhook not arriving (wrong secret/URL/events, body altered by proxy). Check Stripe's webhook log, `/admin/billing`; reconcile heals it after the billing period ends. |
| `billing.json` / `users.json` renamed `.corrupt-<ts>` | The file was not valid JSON; the server started empty and kept the original for you to inspect. |
| Sessions reset on every restart | `SESSION_SECRET` not set (dev falls back to a random one). |
| Login answers 403 `banned` / client shows "account has been blocked" | Operator ban; lift with `POST /admin/unban {email}`. Set `SUPPORT_EMAIL` so the blocked screen tells the user whom to contact. |
| Client shows "signed out on this device" (401 `session_replaced`) | `MAX_DEVICES` reached and a newer device took the slot; "Use this device" swaps back. |
| Server exits at start: `INVITE_CONFIRM=true needs invite emails` | Set `RESEND_API_KEY`, `MAIL_FROM`, `PUBLIC_URL` or turn confirmation off. |
| `/healthz` returns 503 | Last disk write to `data/` failed (permissions/full disk); fix and it recovers on the next write. |

## Behaviours worth knowing (added after review)

- Owner semantics: role `owner` with `active:false` is a lapsed subscriber. They cannot invite, and `POST /billing/checkout` returns 409 `subscription_exists` while Stripe still holds their subscription (active/trialing/past_due/unpaid/paused); the paywall then sends them to the Customer Portal to fix the card instead of double-charging.
- Webhooks are acknowledged only after the data is flushed to disk; on a failed write the in-memory change is rolled back and 500 is returned so Stripe retries. Invite and grant changes roll back the same way (500 `storage_unavailable`). In production the server refuses to start if `data/` is not writable.
- `checkout.session.completed` writes only a provisional record; the subscription events / hourly reconcile are authoritative regardless of delivery order. Reconcile skips an owner whose webhook arrived while it waited on Stripe.
- `/healthz` returns 503 (`storage:false`) while the last write to a data file failed and recovers after the next successful write; wire your uptime monitor or container orchestrator to it.
- Logout revokes every session cookie issued before it (with `MAX_DEVICES` set it drops only that device). A correct `ADMIN_TOKEN` is never rate limited; wrong guesses are (10 failures/min/IP).
- Invite emails are capped at 10 per owner per 24h (invite is still saved, response has `notified:false`).
- Load behaviour (measured locally: 3000 simultaneous logins and 9000 heartbeats complete in a few seconds, RSS ~400 MB, also with `MAX_DEVICES=3`; reproduce with `node server/tools/loadtest.js`):
  - Concurrent logins with the same Stremio key share one upstream call; distinct keys are limited to 50 concurrent calls to api.strem.io with a queue of 5000 (entries older than 8s are dropped) behind them. Overflow gets a retryable 502 (`Retry-After: 5`); the client silently retries up to 5 times with jittered backoff before showing the error screen.
  - Upstream 502s never count against a client's login rate limit (only 400/401 do), so a Stremio outage cannot lock users out.
  - The heartbeat is jittered (±20%) and skipped while the tab is hidden. Rate limiter memory is capped (50k tracked IPs). The Stripe reconcile job handles at most 500 owners per run, 5 Stripe calls at a time.
  - HTTP timeouts are set (headers 15s, request 30s, keep-alive 65s). `index.html` is `no-cache` (so deploys take effect immediately); hashed assets are cached for a month. (The upstream header was malformed: `max-age: N`.)
  - Not covered: compression and TLS (do them in the reverse proxy), and more than one instance (data is in local JSON files; moving to Postgres/Redis is the path to scale out).
- The client has not been built or run in a browser in the environment where this was written (registry blocked `pnpm install`): run `pnpm install`, commit the lockfile, then `pnpm build && pnpm lint` and click through login, paywall, Settings → Subscription.

## Known trust assumption: email ownership

Invitations are matched on the email Stremio reports for the logged-in account. This server does not verify that the person owns that address; it trusts Stremio's account. If Stremio lets anyone register an account with an address without confirming it (check this against the current Stremio sign-up flow), then someone who knows an invited address that has no Stremio account yet could register it first and receive the shared access. The invitee's own existing account blocks this, and the owner can remove the invite at any time. **Mitigation, built in: set `INVITE_CONFIRM=true`** (requires `RESEND_API_KEY`, `MAIL_FROM`, `PUBLIC_URL`; the server refuses to start otherwise). Each invitation then emails a one-time link (`GET /billing/confirm?token=…`, valid 7 days, only a SHA-256 hash is stored, a resend invalidates the previous link). An invited email grants no access until its link is opened, which proves the invitee owns the mailbox. The Settings list shows "Awaiting email confirmation" until then. Turning it on later affects existing invites too: they count as unconfirmed, so use Resend for each. Without email configured this protection is unavailable and the assumption above applies.

## Data requests

- **Access:** users can download their own records themselves (Settings → Subscription → Your data → Download, i.e. `GET /auth/my-data`). The operator can produce the same per email with `GET /admin/users/export?email=` and `GET /admin/billing/export?email=`.
- **Erasure:** operator only (`POST /admin/users/erase`, `POST /admin/billing/erase`), refused while a Stripe subscription is live. There is deliberately no self-service erase button; add one only after deciding how you want to handle active subscriptions and invitees. The Subscription page tells users to contact the operator.

## Operator actions

Besides reading, the operator panel (`/operator/`) can: block/unblock an account, grant or revoke complimentary access, erase a person's data, and remove one invitee from an owner's plan (`POST /admin/billing/invites/remove {owner,email}`; audited, a joined member gets the usual "removed" courtesy email). Everything is also available as plain `ADMIN_TOKEN` API calls, listed in `server/README.md`.

## Statistics

Operator panel → Statistics (and `GET /admin/stats?days=1..120`) shows: users, active in 7 days, new users/logins/active/watching/hours per day, activation (share of users who ever played anything), "signed in but never watched" list (the bounce list, only users first seen over a day ago), median time from first sign-in to first play, average minutes per play, 7-day retention (users older than a week who were seen in the last week), daily/30-day actives and stickiness (today ÷ 30-day actives), how many users are owners / members / granted / stuck at the paywall and the resulting conversion percentage, top titles, top viewers, hours by content type and watch time by hour of day (shown in the operator's local time).

Retention is reported two ways: 7-day (users older than a week seen in the last week) and classic **day-1/7/30** (of users who first signed in N days ago, the share active exactly on day N; needs the 35 days of kept id lists, so day 30 only covers users who signed up 31-34 days ago). **Trends** compare the last 7 days with the 7 before (new users, logins, hours watched, active-user-days; a percentage change, or "new" when the previous week was zero). **Playback quality** (from the player): plays, share watched to the end (the player reported "ended" or reached 90%), errors and critical errors per 100 plays, the most common error codes, and per-title finished/error counts. **Sources**: stream type (torrent / http / youtube / external) and the **add-on host** that served each stream, with plays, hours and errors per host (the hostname only, never the add-on URL path or query, which can contain personal tokens; at most 200 hosts tracked). **Devices**: distinct people by form factor (phone/tablet/tv/desktop), operating system, browser and browser language, from the User-Agent and Accept-Language headers of their latest sign-in (no IP, no fingerprinting, nothing stored beyond those four coarse labels). **Watch depth** buckets the people who watch by total hours (under 1, 1-5, 5-20, 20+). The **at-risk** list names owners and members not seen for 14+ days: the people to email before they cancel.

The stats summary is computed on request (about 1 s of CPU at 50,000 users); the operator panel loads it once per refresh, so avoid polling it every few seconds.

For one person ("when did X log in, what did they watch") use `GET /admin/stats/user?email=`: first/last seen, login count, their last 20 sign-in times and watch totals (hours, plays, last watched). Sign-in times are removed by erasure.

What is and is not knowable:

- `GET /admin/stats?days=30&format=csv` downloads the daily series (day, new users, logins, active, watching, hours) for spreadsheets.
- **Logins and activity** are server-side facts (`/auth/session`, `/auth/me` heartbeat). "Active" means the app was open and visible at least once that day.
- **Watch time and titles are reported by the page** while the player is playing, so a modified client can lie or stay silent. Use it for product analytics, never for billing or enforcement. Reports are capped at 120 s each and 20 per minute per user. Content is identified by the stream request type and id (e.g. `movie` / `tt0111161`); the title is whatever the player shows.
- Series count as one title (episode ids `tt123:1:2` are reduced to `tt123`); the title sent is the series/movie name from the player's metadata. All day buckets are UTC days.
- **Not available:** passwords or password changes (the Stremio core logs in directly against Stremio; the server never sees a password and cannot tell one changed), and anything watched outside this web app (other Stremio clients). Per-subtitle/audio-track choices, seek behaviour, and buffering time are not collected (the web player does not expose them reliably).
- Per-day user-id lists are kept for 35 days (needed for the 30-day active count), older days keep only their counts (120 days of history). Statistics are written at most every 30 s because the whole file is rewritten; a crash loses at most that window, a clean shutdown flushes. Daily counts of compacted days cannot be attributed to a person, so erasure leaves them.
- Size at scale (measured): 50,000 people active over 35 days with watch reports is about 42 MB of `stats.json`, rewritten at most every 30 s (about 0.35 s of blocked event loop per write). Per-day lists store an 8-character fingerprint of each id, not the id. If you grow well beyond that, move statistics to a database or shorten `ID_LISTS_KEPT_DAYS` in `server/stats.js`.
- A restart loses at most the last ~30 s of statistics (debounced writes); `stats.json` is backed up daily like the other files.

Privacy: this records what each identifiable user watched. Tell users in your privacy policy, and note it is personal data under GDPR/PDPA-style rules. `WATCH_STATS=false` switches collection off (the player still sends reports, the server discards them). `GET /admin/users/export` includes a user's watch totals and `POST /admin/users/erase` removes them (per-title totals are aggregated and not attributable to a person).

## Backups

On every start each JSON file gets one dated copy next to it (`billing.json.bak-YYYY-MM-DD`, newest 7 kept). That covers bad deploys, not a lost disk: also snapshot the `data/` volume off-machine (`billing.json` is the record of who paid; `audit.log` is the action history). Erasure requests below do not reach these backups until they rotate out (about a week).

## Privacy and erasure

Access requests (including watch totals): `GET /admin/users/export?email=` and `GET /admin/billing/export?email=` return everything stored about an address (no session ids or confirmation secrets).

The server stores Stremio user ids, emails, login counters (`users.json`) and subscription/invite data including invited emails in plain text (`billing.json`). To honour an erasure request, call both (bearer `ADMIN_TOKEN`):

- `POST /admin/billing/erase {"email"}`: removes their invitations (as inviter and invitee), comp grant and owner record. Returns 409 `subscription_live` while their Stripe subscription is active/trialing/past_due: cancel it in Stripe first.
- `POST /admin/users/erase {"email"}`: wipes email and counters, leaves an id-only tombstone that revokes any session cookie still in circulation. If the person logs in again a fresh record is created.

Stripe and Resend keep their own copies; remove those in their dashboards. Deleting the Stremio account does not touch this server's data.

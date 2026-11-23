# Everything custom on top of Stremio Web

A complete catalogue of what this fork adds or changes compared to upstream `Stremio/stremio-web` (base commit `991c0de`). Stremio's own app, core (WASM), login, player, add-ons and library are unchanged except for the few files listed in section 14. For *how it fits together* read [`HANDOVER.md`](HANDOVER.md); for the exact upstream-file diff and merge steps read [`FORK_CHANGES.md`](FORK_CHANGES.md); for the API read [`../server/README.md`](../server/README.md).

## 1. Login required (no guest mode)
- The "continue as guest" button is removed from the intro screen; logged-out users only ever see Stremio's login/sign-up screen (a deep link they opened is remembered and restored after login).
- Users still log in with their own Stremio account, through Stremio's own screens.

## 2. The server knows who is logged in
- After a Stremio login the page hands the Stremio `authKey` to `POST /auth/session`. The server verifies it with `api.strem.io/api/getUser`, stores the verified **user id and email**, **discards the key**, and sets a signed HttpOnly session cookie (12 h, renewed by a heartbeat, capped at 7 days).
- A heartbeat (`GET /auth/me`, about every 2 minutes while the tab is visible) renews the cookie, marks the user online and refreshes their entitlement.
- Stremio being down gives a retry screen (502), never a wrongful logout. A rejected key shows "session expired".
- The operator sees online users and last-seen times in the panel and at `GET /admin/sessions`.
- Logout revokes earlier cookies; a restart does not log anyone out when `SESSION_SECRET` is set.

## 3. Stripe subscription paywall (optional, `PAYWALL_ENABLED=true`)
- One or more **plans** (`PLANS` JSON, or a single `STRIPE_PRICE_ID`), each with a price, a name, a description and a number of shareable seats.
- Subscribe through Stripe Checkout; manage, change plan or cancel through the Stripe Customer Portal; optional automatic tax (`STRIPE_AUTOMATIC_TAX`).
- A signed, idempotent, order-safe **webhook** is the source of truth; an hourly (and startup) **reconcile** catches missed events. Failed disk writes roll back and ask Stripe to retry.
- Past-due grace period (`PAST_DUE_GRACE_DAYS`, default 3); duplicate subscriptions are blocked (409) or flagged; downgrades enforce the seat limit.
- Without a plan the user sees a **paywall screen** with plan cards instead of the app (server-side enforcement for your own paid content: `requireEntitlement`).
- Operators can give **complimentary access** (grants, with a note) to any email until they revoke it.

## 4. Plan sharing by email ("family")
- A paying owner invites people by email (stored in plain text, readable by the operator). The invitee is matched against their **Stremio-verified** email and joins automatically at next login.
- **Roles:** `member` (uses the plan) and `manager` (also invites, resends and removes members). Only the owner appoints managers, manages billing or transfers the plan.
- **Controls:** invite, resend/renew, change role, remove, member **leave plan**, owner **transfer ownership** (target must have joined and have no plan of their own; the old owner becomes a manager).
- **Invite expiry** (`INVITE_EXPIRY_DAYS`, default 30) for unjoined invites; optional **email confirmation** (`INVITE_CONFIRM`): the invitee must click a one-time emailed link.
- Optional **emails** (Resend; plain text): invitations plus courtesy notices when someone is removed, when a plan lapses, or when ownership transfers. Limited to 10 emails per owner per 24 hours.
- Seats come from the plan; pending invites occupy seats until removed or renewed.

## 5. New Settings → Subscription page (native Stremio look)
Built with Stremio's own Settings components (Group, Row, RowButton, TextInput): plan and status, Manage billing, signed-in devices, shared-plan information with Leave plan, invite list with Resend / Renew, Make manager / member, Make owner (with confirmation), Remove (with confirmation), the invite form, errors and notices, and **Your data → Download my data**.

## 6. Account blocking
Operator can ban/unban an email (`/admin/ban`, `/admin/unban`, panel). A banned user's live sessions end, login answers 403, and the app shows a "blocked" screen with the support email (`SUPPORT_EMAIL` as default, or the value set in the dashboard Settings) if set.

## 7. Device limit (optional, `MAX_DEVICES`)
Limits simultaneous devices per account. A newer sign-in signs out the least recently used device, which sees "You were signed out on this device" with a **Use this device** button (so two devices never fight each other automatically). Logout drops only that device.

## 8. Usage statistics (`WATCH_STATS`, default on)
Operator panel → Statistics, `GET /admin/stats?days=…[&format=csv]`, `GET /admin/stats/user?email=`:
- **People:** total users, active today / 7 / 30 days, stickiness, new users, logins, day-1/7/30 and 7-day retention, activation (ever watched), "signed in but never watched" list, time to first play, week-over-week trends, watch depth buckets, at-risk paying users (not seen for 14+ days), plan roles and conversion.
- **Watching:** hours per day, per hour of day (your local time), per content type, average minutes per play, top titles (series grouped) with plays, hours, finished % and errors, top viewers.
- **Playback quality:** plays, share watched to the end, errors and critical errors per 100 plays, top error codes.
- **Sources:** stream type (torrent / http / youtube / external) and the **add-on host** that served streams, with plays, hours and error rates (hostname only, never URLs with tokens).
- **Devices:** people by form factor, OS, browser and language (User-Agent / Accept-Language, no IP, no fingerprinting).
- **Per person:** first/last seen, login count, last 20 sign-in times, watch totals.
- Watch time and titles are **reported by the player page** (about once a minute while playing) and are analytics, not proof. Passwords, other Stremio apps, subtitles/audio choices, seeking and buffering are not collected. Details and limits: [HANDOVER → Statistics](HANDOVER.md#statistics).

## 9. Operator tooling
- **Operator panel** at `/operator/` is split into eight pages with a side navigation (Overview, People, Subscribers, Plans, Settings, Statistics, Content and playback, Activity); the plan form can create the Stripe price itself; each person has a page with their activity, access and every action. Branding set on the Settings page (product name, tagline, terms and privacy links) shows in the browser tab, on the paywall and in email signatures without a rebuild. (static, strict CSP; the `ADMIN_TOKEN` stays in the browser tab): online users, blocked accounts, subscribers, grants, statistics, audit trail; actions: block/unblock, grant/revoke, remove an invitee, erase a person.
- **Audit trail** (`data/audit.log`): who did what (ban, grant, erase, ownership transfer, operator invite removal...), readable at `/admin/audit`.
- **Data requests:** users download their own data (`GET /auth/my-data`); operators export (`/admin/users/export`, `/admin/billing/export`) and erase (`/admin/users/erase`, `/admin/billing/erase`; refused while a Stripe subscription is live).

- **Health and setup checklist** (top of the panel, `GET /admin/health`): 15 checks across security, payments, email, branding and data, each ok / fix soon / fix now / off with the fix beside it. Secrets are never shown.

## 10. Reliability and scale work
- Atomic JSON persistence with corrupt-file quarantine, daily rotating **backups** (7 kept), `flush()` returning success, `/healthz` that answers 503 when the last write failed, startup check that the data directory is writable.
- Load protection: Stremio verification de-duplicated, capped (50 concurrent) and queued (5000, 8 s deadline); upstream 502s are not counted against login rate limits; limiter memory cap; HTTP header/request/keep-alive timeouts; graceful shutdown that flushes data; jittered heartbeats paused while the tab is hidden; automatic client retries with backoff.
- Origin checks on state-changing requests, security headers (CSP on the panel, HSTS when `COOKIE_SECURE`), no secrets in logs.
- Fixed upstream's malformed `Cache-Control: max-age: N`; `index.html` is `no-cache` so deploys apply immediately.
- Measured: 3000 simultaneous logins about 4 s and 9000 heartbeats about 2 s with zero failures (also with a device limit); `node server/tools/loadtest.js`.

## 11. Tests and tooling
- 80 server tests (`pnpm run test:server`): auth, billing and webhooks, invites and roles, transfer, expiry, mailer, security, statistics, data download.
- Self-contained load test, a Docker image that runs the server as a non-root user with a data volume, CI that runs the server tests, a dev-server proxy to the API.

## 12. Configuration added
All in [`.env.example`](../.env.example) and [HANDOVER → Environment variable reference](HANDOVER.md#environment-variable-reference): `SESSION_SECRET`, `ADMIN_TOKEN`, `PUBLIC_URL`, `COOKIE_SECURE`, `TRUST_PROXY`, `PAYWALL_ENABLED`, `STRIPE_*`, `PLANS`, `INVITE_SEATS`, `INVITE_EXPIRY_DAYS`, `INVITE_CONFIRM`, `PAST_DUE_GRACE_DAYS`, `RESEND_API_KEY`, `MAIL_FROM`, `MAX_DEVICES`, `WATCH_STATS`, `SUPPORT_EMAIL`, `SETTINGS_FILE`, `PLANS_FILE`, `USERS_FILE`, `BILLING_FILE`, `STATS_FILE`, `AUDIT_FILE`.

## 13. Data the server stores (all in `data/`)
| File | Contents |
|---|---|
| `users.json` | Stremio user id, email, first/last seen, login count, device slots, blocked emails (never the Stremio key or a password) |
| `billing.json` | Stripe customer/subscription ids and status, plan, invited emails and roles, grants |
| `stats.json` | Daily counts, per-person watch totals and recent sign-in times, titles, add-on hosts, error codes, device/language labels |
| `audit.log` | Operator and ownership actions |

## 14. Files of Stremio Web that were modified
`src/router/Routes.tsx` (login gate, session screen, paywall), `src/routes/Intro/Intro.js` (guest removed), `src/routes/Player/Player.js` (one `useWatchReport(...)` call), `src/routes/Settings/{constants.ts,useSettingsPages.ts,Settings.tsx,useSettingsSearch.ts}` (Subscription page registered), `http_server.js` (static server became the API server), `webpack.config.js` (dev proxy), `package.json`, `Dockerfile`, `.github/workflows/build.yml`, `.gitignore`, `README.md` (fork notice).

## 15. Known limits
Client never built/run in a browser by the author (strict type-check and ESLint only); no live Stripe/Resend calls made; single server instance (JSON files); the UI gate is a convenience and real enforcement exists only on routes using `requireEntitlement`; new screens are English-only; a member who changes their Stremio email must be re-invited; there is no self-service erase button. Full list: [HANDOVER → Known limitations](HANDOVER.md#known-limitations).

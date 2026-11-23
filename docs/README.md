# Start here

This repository is a fork of [Stremio Web](https://github.com/Stremio/stremio-web) that adds, around the unchanged Stremio app:

- a **login gate** (no guests) and a server that knows **who is logged in**,
- an optional **Stripe subscription paywall** with plans and **plan sharing by email** (members, managers, ownership transfer),
- **operator tooling**: panel, blocking, device limit, statistics, data export/erasure, audit log, backups.

Stremio's own login, player, add-ons and library are untouched. Everything we add hangs off the resulting Stremio login.

## Pick your path

| You are... | Read, in this order |
|---|---|
| **Taking it live** (operator) | [`HANDOVER.md` → Go-live checklist](HANDOVER.md#go-live-checklist) → [`.env.example`](../.env.example) → [`server/README.md` → Stripe setup](../server/README.md#stripe-setup) → [`HANDOVER.md` → Operator actions](HANDOVER.md#operator-actions) and [Statistics](HANDOVER.md#statistics) |
| **Changing the code** (developer) | [`HANDOVER.md` → Mental model](HANDOVER.md#mental-model) → [File map](HANDOVER.md#file-map) → [Decisions worth knowing](HANDOVER.md#decisions-worth-knowing-and-why) → [How to extend](HANDOVER.md#how-to-extend) → [Running it](HANDOVER.md#running-it) |
| **Seeing everything we built** | [`CUSTOM_FEATURES.md`](CUSTOM_FEATURES.md) |
| **Merging a new upstream Stremio release** | [`FORK_CHANGES.md`](FORK_CHANGES.md) (every upstream file we touched and why, plus merge hot-spots) |
| **Answering a user or a data request** | [Data requests](HANDOVER.md#data-requests), [Privacy and erasure](HANDOVER.md#privacy-and-erasure), [Troubleshooting](HANDOVER.md#troubleshooting) |
| **Calling the API** | [`server/README.md` → Endpoints and Error codes](../server/README.md#endpoints) |

## The documents

| File | What it is |
|---|---|
| [`docs/HANDOVER.md`](HANDOVER.md) | The main manual: how it fits together and why, file map, configuration, operating it, statistics, limits, troubleshooting. |
| [`docs/CUSTOM_FEATURES.md`](CUSTOM_FEATURES.md) | **Everything custom in one page**: every feature added on top of Stremio Web, what users and operators get, data stored, files touched. |
| [`docs/BACKLOG.md`](BACKLOG.md) | Trackable plan: 50 tasks by phase with dependencies, done-when and progress (generated from [`tracker.csv`](tracker.csv) by `node tools/tracker.js`). |
| [`docs/QUALITY_BAR.md`](QUALITY_BAR.md) | Definition of done, release gates, click-through checklist, health metrics. |
| [`docs/RISKS.md`](RISKS.md) | Risk register and the time-boxed spikes. |
| [`docs/DECISIONS.md`](DECISIONS.md) | Every open question settled with a decision, rationale and evidence (accounts, channels, prices, database, licence keys, languages, roadmap order). |
| [`docs/PERFECT_PRODUCT.md`](PERFECT_PRODUCT.md) | Executive-level vision: community evidence, the "Brand X x Stremio" verdict, the perfect end-user/operator/platform experience, demo script, metrics, roadmap. |
| [`docs/PRODUCT_VISION.md`](PRODUCT_VISION.md) | Brainstorm/audit: what the ideal sellable "Stremio as a SaaS" package and content-API service would look like, gaps in this code, roadmap, open decisions. |
| [`docs/PROGRESS.md`](PROGRESS.md) | Dated progress log: what was done, found and what is next. Start here to see where the work stands. |
| [`docs/OPERATOR_AUDIT.md`](OPERATOR_AUDIT.md) | What operators can and cannot manage today, gaps and priorities. |
| [`docs/PRODUCT_AUDIT.md`](PRODUCT_AUDIT.md) | What would make the product itself better: buyer, end user, reliability, security, selling. |
| [`docs/SPIKES.md`](SPIKES.md) | Results of the time-boxed experiments (own-account API, licence file, SQLite). |
| [`docs/screenshots/`](screenshots/README.md) | Reproducible screenshots of every new screen (for reviews and marketing drafts). |
| [`docs/FORK_CHANGES.md`](FORK_CHANGES.md) | Diff summary against upstream: modified files, added files, behaviour users will notice, how to merge upstream. |
| [`docs/BRANDING.md`](BRANDING.md) | How the Stremio name and images are replaced from the operator panel, and what is still Stremio. |
| [`docs/ACCOUNTS_API.md`](ACCOUNTS_API.md) | Our own account service that replaces api.strem.io for people, sessions, library and add-on collection. |
| [`docs/HOUSEHOLD_AND_PROFILES.md`](HOUSEHOLD_AND_PROFILES.md) | Family-plan sharing (`billingHousehold`, `billingInvite*`, `billingLeave`) and the per-profile / app-settings stores (`profilesGet/Set`, `appSettingsGet/Set`) with the household-shared list. |
| [`docs/SWITCHING_APPS.md`](SWITCHING_APPS.md) | Pointing other apps (built on the Stremio API) at our server by changing the address; core patch; compatibility checker. |
| [`docs/PREMORTEM.md`](PREMORTEM.md) | Why it could fail in a year, scale benchmark numbers, and the tasks that follow. |
| [`server/README.md`](../server/README.md) | Server reference: endpoints, error codes, Stripe and email setup, reliability notes, tests. |
| [`.env.example`](../.env.example) | Every environment variable with its default, commented. |
| [`README.md`](../README.md) | Upstream Stremio Web readme (build and run the web app itself). |

## Five-minute orientation

```
Browser (Stremio web UI)           This server (http_server.js)            Outside
  Stremio core logs in  ───────────────────────────────────────────▶  api.strem.io
  POST /auth/session {authKey} ──▶ verify with Stremio, store id+email,
                                   drop the key, set signed cookie
  /auth/me heartbeat (2 min)   ──▶ renew cookie, return entitlement
  paywall / Settings → Subscription ─▶ /billing/*  ◀── webhook ──── Stripe
  player reports watch time    ──▶ /auth/activity (statistics)
  operator panel /operator/    ──▶ /admin/*  (ADMIN_TOKEN)
```

Key ideas:

1. **Identity is Stremio's.** We never see passwords. The server learns the verified email only when the page hands over the Stremio `authKey`; it verifies it, keeps id and email, and discards the key.
2. **One decision point for access:** `entitlementFor` in `server/billing.js` returns `free`, `owner`, `member`, `granted` or `none`. The UI paywall is a convenience; real enforcement is the server-side `requireEntitlement` on any route that serves paid content (see [Protecting your own paid content](../server/README.md#protecting-your-own-paid-content)).
3. **Stripe is the source of truth** for payment; the webhook (plus an hourly reconcile) updates local state. Sharing, roles and invites are our own records in `data/billing.json`.
4. **State is plain JSON files** in `data/` (users, billing, statistics, audit log), written atomically with daily backups. Single instance only.
5. **Failure bias:** if Stremio or the disk is unavailable the answer is 502/500 (retry), never a wrongful logout or lost payment.

## Glossary

| Term | Meaning |
|---|---|
| authKey | Stremio's login token held by the core; handed to the server once, never stored |
| Entitlement | The server's answer to "may this user use the app": role + plan + invite info |
| Owner / Member / Manager | Owner pays; members are invited to share the plan; managers are members who may also invite/remove |
| Grant | Complimentary access an operator gives an email without Stripe |
| Operator | You: the person holding `ADMIN_TOKEN` and the panel at `/operator/` |
| Heartbeat | The periodic `/auth/me` call that keeps the session and entitlement fresh |
| Device limit | Optional `MAX_DEVICES`: a new sign-in signs out the least recently used device |

## Commands you will use

```bash
pnpm install                 # once; commit pnpm-lock.yaml
pnpm build && pnpm lint      # client
pnpm run test:server         # 80 server tests (no network, no Stripe)
node server/tools/loadtest.js 3000   # load test (MAX_DEVICES=3 to include the device limit)
node http_server.js          # run the server (see .env.example)
```

## What is verified and what is not

Server: automated tests, load test, live probes. Client: production build, ESLint and a headless-Chromium run with a stubbed Stremio API (see [`PROGRESS.md`](PROGRESS.md) and [`screenshots/`](screenshots/README.md)). Not yet verified: real playback, invite/device-limit flows in a browser, mobile layouts. Real Stripe and Resend calls have not been made. Do the [Go-live checklist](HANDOVER.md#go-live-checklist) in test mode first.
- [`APP_INTEGRATION.md`](APP_INTEGRATION.md): how apps like Alder use our accounts, API and QR sign-in (step by step, with real replies)
- [`INSTALL.md`](INSTALL.md): install, back up, restore, update on your own server

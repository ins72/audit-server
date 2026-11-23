# Audit and brainstorm: the ideal "Stremio as a SaaS" product

Scope: product and code architecture only. Licensing, content rights and legal are deliberately parked (one flag in section 8 because it shapes the architecture). Everything here is opinion plus a gap analysis against the code in this repository.

## 1. The shape of the business (the key insight)

You are really selling **two things**, and the code should be built so they plug together:

| | A. The app package | B. The content API service |
|---|---|---|
| What | Web app + operator backend + admin panel, deployable by a buyer | A hosted catalog/stream/subtitle service the app talks to |
| Model | One-time purchase (+ optional paid updates/support) | Monthly subscription per buyer (metered or tiered) |
| Role | The lead magnet and the distribution channel | The recurring revenue |
| Needs | Installer, branding, docs, licence key, updates | API keys, metering, SLAs, abuse control |

**Stremio already gives you the contract for B.** Its add-on protocol (a `manifest.json` plus `/catalog`, `/meta`, `/stream`, `/subtitles` endpoints over HTTP) *is* an API. Your future service is simply **a first-party add-on** hosted by you, whose manifest URL contains a per-customer key (`https://api.you.com/<customer-key>/manifest.json`). The app package ships with it pre-installed as the default add-on. Metering, rate limits, plan limits and revocation then all happen on one URL you control, and no app changes are needed when content or pricing change. This is the cleanest razor-and-blades design available.

## 2. The biggest architectural decision: whose accounts?

Today identity is **Stremio's** (`api.strem.io`). That is perfect for "an overlay on Stremio" and wrong for a product you sell, because:
- Every buyer's users depend on a third party you do not control (outage, rate limits, policy change, name/branding, their consent for you to sit on top).
- You cannot see or control passwords, profiles, library sync, or support flows. Statistics are limited to what the page reports.
- A buyer cannot white-label cleanly while sign-up screens say Stremio.

Options:

1. **Keep Stremio accounts** (current). Cheapest, but the product is only ever a Stremio add-on shop. Fine as a stepping stone.
2. **Own account system exposed through a Stremio-compatible API** (recommended target). The Stremio core talks to an API (login, user, library and add-on-collection sync). Provide your own server that speaks that API so the unmodified core logs in against *you*. Verify first how configurable the API URL is in the core version in use (`@stremio/stremio-core-web 0.67.1`); this is the single most important technical spike. Payoff: your own users, passwords, email verification, password reset, 2FA, profiles, parental controls, sync, real per-user analytics, true white-label.
3. **Hybrid**: accept both (Stremio login or native account), map both to one internal user id.

Recommendation: ship A on option 1 now, build option 2 as the v2 "own auth" module behind the same interface the server already uses (`verify(authKey) -> {id, email}` becomes `verify(credential)`), so nothing else in this repository changes.

## 3. What this repository already is, and what a buyer would expect that is missing

Already good: login gate, entitlement engine, Stripe plans + webhook + reconcile, plan sharing with roles, device limit, ban, statistics, operator panel, audit, backups, load-tested server, documentation, tests.

Missing for a sellable package (by priority):

**P0 (cannot sell without)**
- **Setup wizard / installer.** First run asks for domain, admin account, Stripe keys, mail provider, branding; writes config; verifies each (Stripe test call, test email). Today it is `.env` and docs.
- **Database.** JSON files are a fine demo, a bad product. Move to SQLite by default (zero-ops, one file) with PostgreSQL as an option, behind one storage interface; migrations; the existing JSON becomes an import path.
- **Branding and theming.** Name, logo, colours, favicon, legal pages, email templates, all from admin settings (no rebuild). Remove "Stremio" strings from the new screens.
- **Full admin dashboard** (the current panel is a read-mostly page): users, subscriptions, refunds/comps, coupons, plans CRUD (create Stripe prices from the UI), invoices, support lookup, settings, audit, export.
- **Licence and update mechanism** for your package (section 6).
- **Proper auth hygiene** if option 2: email verification, password reset, rate limits, optional 2FA, session management page.
- **Observability:** structured logs, error reporting hook, metrics endpoint, uptime/health, admin alerts (webhook failures, disk, Stripe errors).

**P1 (expected by serious buyers)**
- **Profiles** (up to N per account, avatars, per-profile library/continue watching) and **parental controls** (PIN, age ratings, kids profile).
- **Coupons, trials, annual plans, pay-per-view/rentals** (your earlier idea), taxes/VAT via Stripe Tax, dunning emails, cancellation flow with reasons, win-back.
- **Email system:** templated, queued, bounces handled, multiple providers (Resend, SES, SMTP).
- **Push/web-push and in-app announcements**, maintenance banner, terms acceptance.
- **Multi-language** (the core already translates its own screens; new screens are English-only today).
- **Role-based admin** (owner, support, finance read-only) with audit.
- **Automated backups to S3-compatible storage**, restore command, one-click export of everything.
- **Docker Compose / one-liner install**, plus a managed "deploy on X" button path.

**P2 (differentiators)**
- Curated homepage rows / editorial CMS, "because you watched", trending (your own stats make this possible).
- Reseller / multi-tenant mode: one install serving many brands by domain (this is what turns a package into a platform).
- Referral program, gift subscriptions, family plan analytics.
- Public status page, in-app support chat/tickets, NPS prompts.
- Mobile/TV wrappers (PWA first; Capacitor shells; smart-TV webOS/Tizen packages).
- Webhooks out (to buyer's CRM/Slack), public admin API with keys.

## 4. The content API service (product B), designed as an add-on

- **Endpoints:** standard add-on resources. Per-customer key in the path; keys created, rotated and revoked in your own console.
- **Plans:** requests/month, concurrent streams, catalog scope (regions, genres), resolution caps, SLA tier. Metering via counters in Redis, flushed to billing monthly.
- **Abuse control:** per-key and per-IP rate limits, anomaly detection (key shared across many IPs), automatic soft-throttle then notify.
- **Reliability story is the product:** multi-region, caching (CDN in front of catalog/meta), signed short-lived stream URLs, status page, incident comms.
- **Buyer console:** keys, usage graphs, invoices, webhooks, test console ("try this catalog").
- **Package integration:** the setup wizard asks for the API key, tests it, installs the first-party add-on, and the admin dashboard shows the buyer's usage and bill right inside their panel.

## 5. Ideal web app (end-user experience), beyond stock Stremio

Keep the proven Stremio UI (board, discover, library, detail, player). Add: own branding and onboarding, profiles with a profile picker, parental PIN, a clear "my plan / my devices / my data" area (this repository's Subscription page is the seed), watch-party and shared lists for families, per-profile continue watching across devices, a polished paywall with plan comparison, trial and coupon entry, localised pricing, accessible UI (keyboard/screen-reader pass), PWA install, offline-friendly shell, and performance budgets (first load, player start time).

## 6. Selling the package

- **Channels.** (a) CodeCanyon/Envato: reach and trust, but it takes roughly half the price, imposes its licence terms and support expectations (about 6-12 months of support), and customers expect a self-explanatory installer. (b) Your own site: higher margin and a direct relationship; use a merchant of record (Paddle, Lemon Squeezy) so tax/VAT and invoicing are handled. (c) Both: Envato as the entry product, own site for "Pro" and the API subscription.
- **Tiers.** Single domain / unlimited domains (or reseller) / source with white-label rights. Add-ons: paid updates, priority support, installation service, managed hosting.
- **Licence keys** (Keygen, Lemon Squeezy or your own): domain-bound, offline-tolerant grace period, a "phone home" for update checks only (be transparent). Do not make the app unusable on a licence-server outage.
- **Updates.** Versioned releases, a changelog, migrations that run automatically, an in-admin "update available" notice and one-click update (or documented `docker compose pull`).
- **Docs and support.** Video install guide, docs site, FAQ, a demo instance with a reset-every-hour sandbox (the single biggest conversion lever), a ticket system with templates.
- **The economics worth modelling:** the code is the loss-leader and the funnel; recurring revenue is B (API) plus support and updates. Price A to maximise installs, B to carry the business.

## 7. Suggested roadmap

1. **Foundations (4-6 weeks):** storage interface + SQLite/Postgres, setup wizard, branding settings, admin dashboard v1, observability, Docker Compose. Run the technical spike on a custom API URL for the core.
2. **Sellable v1 (4-6 weeks):** profiles + parental PIN, coupons/trials/annual plans, email templates, S3 backups, docs site, demo instance, licence key + update check, i18n scaffolding.
3. **Content API v1 (parallel track):** first-party add-on, key console, metering, rate limits, status page.
4. **Own accounts v2:** Stremio-compatible auth/sync server, email verification, 2FA, password reset.
5. **Platform:** reseller/multi-tenant, public API, mobile/TV shells, recommendations from your own stats.

## 8. Risks and open questions

- **One flag you asked to park but it shapes the design:** upstream Stremio Web is **GPL-2.0**. A buyer of a GPL-derived package normally also receives the right to the source and to redistribute it. That makes "one-time code sale" a weak moat on its own, and it is a strong argument for the design above: keep the *code* cheap and open-ish, and charge for what is not copyable: the hosted API, updates, support, hosting and the brand. Resolve it with counsel before launch; it does not change the engineering plan.
- Dependence on the Stremio core WASM (versioning, API compatibility) until option 2 exists.
- Single-instance JSON storage must go before any buyer runs this at real scale.
- Support load of a code product is large; build the installer, diagnostics page ("copy debug info") and docs first, or support will eat the margin.
- Content API is an operations business (uptime, abuse, costs); price it accordingly.

## 9. Decisions needed from you

> **All of these are now settled in [`DECISIONS.md`](DECISIONS.md).** The list below is kept for context.

1. Own accounts (option 2) as the target, or stay on Stremio accounts for v1?
2. First channel: Envato, own site, or both?
3. Price anchors for A (one-time) and B (monthly), and whether updates are paid.
4. Single-brand package first, or multi-tenant reseller from the start?
5. Hosting offer: do you also run it for buyers (managed), or only sell code?

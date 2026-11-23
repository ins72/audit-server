# Decisions: every open question, settled

Each open design or business question from the earlier documents, with the choice made, why, and the evidence. Legal/licensing is still deliberately parked (see D20). Prices and thresholds are **starting points to test**, chosen from the public anchors cited; they are not measured facts about your market. Companion documents: [`PERFECT_PRODUCT.md`](PERFECT_PRODUCT.md), [`PRODUCT_VISION.md`](PRODUCT_VISION.md).

## Summary table

| # | Question | Decision |
|---|---|---|
| D1 | Whose accounts? | Stremio accounts in v1; own accounts in v2 behind the existing `verify()` seam |
| D2 | First sales channel | Own site first (Paddle as merchant of record); Envato second, priced higher |
| D3 | Prices | Package $199 / $499 / $999; API $29 / $99 / $299 per month; updates included 12 months, renewal 40% |
| D4 | Single or multi-tenant | Single-tenant first; multi-tenant is the top tier in phase 6 |
| D5 | Managed hosting | Yes, but only after the package is stable (phase 3) |
| D6 | "Brand X x Stremio" | Own brand; optional "Powered by" badge, default off, A/B tested |
| D7 | Database | SQLite (WAL) + Litestream default; PostgreSQL adapter for multi-tenant or large installs |
| D8 | Licence keys | In-house signed licence file issued from the Paddle webhook; no hard lock |
| D9 | Languages | English first; i18n scaffolding in phase 2; six more languages after |
| D10 | Self-service erase | Add "request deletion" with grace period (phase 2) |
| D11 | Defaults for invites, devices, support | Keep 30-day expiry; device limit off by default (4 in templates); 6 months support |
| D12 | Statistics storage | Move to SQLite tables with an event log in phase 1 |
| D13 | Client platforms order | PWA, Android TV/Android, iOS, Tizen/webOS, Apple TV |
| D14 | Content API stack | Add-on protocol, per-customer key in URL, Node on two regions behind a CDN, counters in memory then Redis |
| D15 | Reliability layer design | Client-side health-scored fallback using playback reports |
| D16 | Accessibility target | WCAG 2.2 AA |
| D17 | Refund policy | 14 days, licence deactivated on refund |
| D18 | Support obligation | 6 months included, 12 on top tier |
| D19 | Open-source posture | Open core decision deferred with legal (D20) |
| D20 | Legal, licences, content rights | Parked by instruction; the only item intentionally left open |
| D31 | What operators manage themselves | Everything a buyer would want to change lives in a runtime settings store edited from the operator dashboard; env keeps only secrets and bootstrap |

## D1. Whose accounts

**Decision:** ship v1 on Stremio accounts (what this repository does today); build own accounts in v2 behind the existing seam (`verify(authKey) -> {id, email}` in `server/auth.js`, widened to `verify(credential)`).

**Why / evidence.** Findings from this repository: the web app initialises the core with application info only (`transport.init(props.appInfo)` in `src/core/CoreProvider.tsx`), so the account API host is **not configurable from the web layer**. The login screen also hard-codes `https://www.strem.io` for password reset, Facebook and Apple login, Trakt and the calendar feed (`src/routes/Intro/`, `src/routes/Settings/`). So own accounts require two things, both feasible but unproven: (a) redirect the core's `api.strem.io` requests to your server, either with a service worker that rewrites those fetches or by rebuilding the core with another API constant; (b) replace the hard-coded `strem.io` pages with your own. Doing that is a real spike (about two weeks), not a quick switch, so it does not belong in v1. Everything else in the product (entitlements, billing, statistics) is already keyed on `{id, email}`, so swapping the identity provider later changes one module.

**First task of v2:** the service-worker rewrite spike. Success = unmodified core logs in, loads library and syncs add-ons against your stub API. If the spike fails, fall back to rebuilding the core.

## D2. Sales channel

**Decision:** your own site first; list on Envato second at a higher price.

**Evidence.** Envato changed its model in July 2026 ([ChargePanda summary](https://www.chargepanda.com/blog/post/envato-july-2026-changes-wordpress-authors-guide)): a flat 50% author fee on the item price (list price minus the fixed buyer fee; PHP scripts carry a $5 buyer fee), exclusivity removed. Removing exclusivity means you can sell on Envato **and** elsewhere, so there is no reason to give up the own-site margin. On Envato a $199 sale nets roughly $97 (50% of $194); on your own site through a merchant of record at 5% + $0.50 it nets about $188.

**Envato listing price:** about 1.7x the own-site price (e.g. $339) to reach similar net revenue, or accept lower net there as a marketing channel. Check Envato's price-parity rules before publishing (I could not confirm them).

**Merchant of record: Paddle.** [Comparison](https://alexcloudstar.com/md/blog/merchant-of-record-indie-saas-2026/): Paddle 5% + $0.50 and handles global tax; Lemon Squeezy has the same fee but the author advises against starting there because Stripe is building a successor; Stripe alone is cheaper (about 3.4% with tax) but you would register and file VAT everywhere. For a Thailand-based seller shipping worldwide, handing tax to a merchant of record is worth the 1.6-2% difference. **Inside the product, end-user subscriptions stay on the buyer's own Stripe** (already built).

## D3. Pricing

**Anchors.** White-label OTT SaaS: about $99-399 a month, on-premise enterprise $50,000-$500,000+ ([MwareTV guide](https://mwaretv.com/en/blog/white-label-ott-platform-buyers-guide), a vendor). Streaming app templates on CodeCanyon sit at the low end (one sampled template: [$19](https://codecanyon.net/item/cinemaify-movie-streaming-app-react-native-expo-template/56175821), 6 sales). Stremio-based end-user bundles run about $18-29 a month ([ELFHosted](https://docs.elfhosted.com/stremio-addons/guide/beyond-stremio/)). The product is a complete platform (billing, admin, sharing, analytics), so it should sit far above templates and far below enterprise OTT.

**Package (one-time, includes 12 months of updates and support):**
| Tier | Price | Includes |
|---|---|---|
| Starter | $199 | One domain, all features, branding, 12 months updates |
| Agency | $499 | Unlimited domains of your own, priority support, white-label (no badge) |
| Platform | $999 | Multi-tenant/reseller mode (when released), source licence, onboarding call |
| Renewal | 40% of price per year | Updates and support continue; software keeps working without it |

**Content API (monthly):**
| Plan | Price | Includes (initial limits to tune) |
|---|---|---|
| Starter | $29 | 1 key, 100k requests, 25 concurrent streams |
| Pro | $99 | 5 keys, 1M requests, 150 concurrent streams, status SLA 99.9% |
| Business | $299 | 20 keys, 5M requests, 500 concurrent streams, priority incident channel |
| Overage | metered | per 1,000 requests and per concurrent-stream bucket |

Reasoning: the package is the funnel; the API is the recurring business. Test price points with a 7-day trial on the API and a refundable package.

## D4. Single or multi-tenant
**Decision:** single-tenant first. One installation, one brand, one database file. It is simpler to support, trivially isolated, and sells today. Multi-tenant (many brands on one install, by domain) is the Platform tier in phase 6, after the storage layer is abstracted (D7), because it needs tenant-scoped everything (plans, data, branding, statistics, admin roles).

## D5. Managed hosting
**Decision:** yes, as an add-on from phase 3 (about $29-49 a month per install on top of the API plan), once the installer, backups and updates are proven. Doing it earlier makes you a support desk before the product is stable. Starter path until then: Docker Compose and a one-line installer.

## D6. "Brand X x Stremio"
**Decision:** each buyer uses **their own brand**. Admin setting `brandMode = own | powered-by`; default `own`; "Powered by" shows a small, honest "Built on the open Stremio add-on standard" line. A/B test the badge for conversion before changing the default.
**Why:** users are already warned that modified "premium" Stremio builds are a red flag ([RapidSeedbox](https://www.rapidseedbox.com/blog/is-stremio-safe)); co-branding would put every buyer into that pattern and tie them to a third party's reputation and platform risk. Full reasoning in [`PERFECT_PRODUCT.md` section 3](PERFECT_PRODUCT.md).

## D7. Database
**Decision:** SQLite in WAL mode with Litestream streaming backups to object storage as the default; a PostgreSQL adapter for multi-tenant and very large installs; use a portable query layer (Kysely or Drizzle) from the start; migrate the current JSON files with an import command.
**Evidence:** [RaidFrame's guide](https://raidframe-web.pages.dev/articles/postgres-vs-sqlite-2026) (own benchmarks, 2-vCPU instance): SQLite handles about 50-100 write transactions per second, roughly 5,000-10,000 concurrent users for a read-heavy app; Postgres is warranted for many concurrent writers, multiple services or row-level security for multi-tenancy; Litestream is the standard backup tool. This product is read-heavy (heartbeats are cheap, payments are rare), so SQLite fits a buyer's single install and removes an install dependency. The current measured design (JSON, about 42 MB of statistics at 50,000 people) is the reason to move in phase 1.

## D8. Licence keys
**Decision:** in-house, no vendor. At purchase the Paddle webhook issues a signed licence file (Ed25519; domain, tier, expiry of updates). The app verifies it offline. A background check contacts you only for update notices. **No hard lock**: an expired or missing licence shows a banner and disables the update button, never the product. Buyers hate lock-out; piracy of a cheap platform is not worth angering paying customers.

## D9. Languages
**Decision:** English for v1 (as already chosen). Phase 2 adds i18n scaffolding for the new screens (keys, plural rules, RTL layout), then Spanish, Portuguese, French, German, Arabic and Thai first, because the core's own screens are already translated and these cover the largest streaming audiences plus your home market. Community-contributed packs after that.

## D10. Self-service deletion
**Decision:** add "Request deletion" to Settings → Your data in phase 2: confirmation by email, a 14-day grace period, refused while a subscription is live (with a button to the billing portal), invitees are notified, and the operator sees a queue. Until then the Subscription page already directs people to the operator, and operators have the erase endpoints.

## D11. Defaults
- Invite expiry stays **30 days** (already the default; long enough for a family to respond, short enough to free seats).
- **Device limit** is off by default (it annoys more than it protects when many people share legitimately); templates for family plans suggest 4.
- Past-due grace 3 days; reconcile hourly; email cap 10 per owner per day: all unchanged.
- Support policy: see D18.

## D12. Statistics storage
**Decision:** phase 1 moves statistics from one rewritten JSON file to SQLite: an append-only `events` table (play, stop, error, switch, login) plus rollup tables per day. This removes the 42 MB rewrite-everything cost and enables arbitrary queries. Keep the same endpoints and panel.

## D13. Client platforms, in order
1. **PWA** (install prompt, offline shell): ships with the product.
2. **Android and Android TV** via a WebView/Capacitor shell: closes the largest TV gap fastest.
3. **iOS** shell (Capacitor): the store-review path is slow, start early.
4. **Samsung Tizen and LG webOS** packaged web apps: cheap because they are HTML5, and the Trustpilot reviews specifically ask for Samsung support ([reviews](https://ca.trustpilot.com/review/strem.io)).
5. **Apple TV** native (Swift): last, highest effort. 
Rule from the buyer guide: native or well-built shells, not slow generic wrappers on TVs.

## D14. Content API stack
**Decision:** the Stremio add-on protocol is the contract (`/manifest.json`, `/catalog`, `/meta`, `/stream`, `/subtitles`), with the customer key inside the URL path. Node service in two regions behind a CDN, per-key and per-IP rate limits, in-memory counters flushed to storage every minute, Redis once more than one instance runs; signed short-lived stream URLs; public status page; provider failover with a circuit breaker per upstream.

## D15. Reliability layer
**Decision:** build in phase 3 on data this repository already collects (plays, errors, error codes and add-on host per play). Scoring: rolling success rate and median time-to-first-frame per source; the client sorts streams by score; on error or a stall longer than 8 seconds the player switches to the next healthy stream at the same timestamp and shows a quiet toast; the next episode's best stream is resolved ahead of time. This targets the most-cited complaint ([Reddit summary](https://redcurate.com/blog/stremio-reddit)).

## D16. Accessibility
**Decision:** WCAG 2.2 AA for all new screens (keyboard, screen reader labels, contrast, reduced motion, focus order), plus 10-foot navigation for TV shells. The new Subscription page already uses labelled form controls and status roles; extend that pattern.

## D17. Refunds
**Decision:** 14-day refund on the package, no questions asked, which also deactivates the licence file. Matches buyer expectations and reduces purchase friction; the support and update value is what keeps customers afterwards.

## D18. Support obligation
**Decision:** 6 months of email support included (12 on Agency and Platform), 1 business day response target, public docs, a diagnostics page ("copy debug info") and a demo instance reset every hour. Matches the common marketplace expectation and keeps the support load bounded.

## D19. Open-source posture
Deferred together with legal (D20): the choice between a source-available package, a GPL-compatible open core with paid services, or something else depends on counsel's reading of the upstream licence (GPL-2.0). The engineering plan does not change either way.

## D20. The only intentionally open item
Legal: licences, Stremio trademark and terms, content rights, privacy regime per market, tax registration. Parked by your instruction and recorded here so it is not forgotten. It needs a lawyer, not more research.

## Addendum: statistics, login and operator management

Smaller open points found by re-reading the docs and `server/` against the original request.

| # | Question | Decision |
|---|---|---|
| D21 | Password changes and password logins in statistics | Not trackable today; tracked once own accounts exist (D1, v2) |
| D22 | Watching in other Stremio apps | Not trackable in the web app; add-on side counts (stream requests per key) arrive with the content API (D14) |
| D23 | Operator identity | One shared `ADMIN_TOKEN` stays for v1; named operator accounts in phase 2 |
| D24 | Operator roles | `viewer` (read stats), `support` (invites, grants, ban, export), `admin` (erase, billing, settings) |
| D25 | Operator security | Panel behind HTTPS only, optional IP allow-list, and TOTP two-factor on named accounts |
| D26 | Audit trail | Already records actions; once named operators exist each entry gets the operator, not just "admin" |
| D27 | Sign-out of a user by the operator | Add "Sign out everywhere" (the server already has `revokedBefore`, so this is one endpoint and one button) in phase 1 |
| D28 | Login history for the operator | Keep the last 20 logins with browser and language (exists); add country only through a reverse proxy header, never IP storage |
| D29 | Bulk operations | CSV import/export of grants and a multi-select ban/unban in phase 2 |
| D30 | Stats retention | 120 days of counts and 35 days of id lists stay as defaults; the setting becomes an env value, with a "delete older than N days" button |

**D21.** The Stremio core signs in directly against Stremio, so this server never sees a password, and a password change at Stremio is invisible to it (stated in `HANDOVER.md`, Statistics). Nothing honest can be shown for it today. With own accounts the server owns the credential, so it will log password changes and failed logins, email the user on each change, and show both in the user's detail view.

**D22.** The web client only reports what is played inside this app. Other clients (phone, TV, desktop) of the same account never reach this server. The only complete source is the content API: counting stream and catalog requests per customer key gives the cross-client view. Until that exists the panel keeps labelling these numbers "in this web app".

**D23 to D26.** Today every operator shares one token, so the audit log cannot say who did what, and a leaked token is full access. That is acceptable for a single-owner install (your v1) and not for agencies or teams. Named accounts with three roles, TOTP and attributed audit entries fix it without changing the panel's layout.

**D27.** The one gap that matters most day to day: when an account is compromised or shared by mistake, the operator can ban but not just sign people out. The server already revokes sessions by timestamp on logout, so this is small.

**What is still open and cannot be settled here:** nothing in this addendum needs your input. D27 is the only one I would build immediately; the rest are scheduled in the phases.

## D31. Operator-managed settings (added 2026-11-20)

**Trigger:** while testing the screens it became clear that names, texts, plans, links and limits are hard-coded or set in environment variables. A buyer of the package must be able to run the product from the dashboard without editing code or restarting.

**Audit of what is hard-coded today**
| Area | Today | Where |
|---|---|---|
| Plans | `PLANS` JSON in env, needs a restart and Stripe price ids copied by hand | `http_server.js`, `server/billing.js` |
| Screen text | about 15 English strings in the paywall, gate and Subscription screens, plus 15 error messages | `src/router/PaywallScreen`, `ServerSessionGate`, `src/routes/Settings/Subscription` |
| Intro screen | tagline, "Stremio" wording, Terms and Privacy links point at stremio.com | `src/routes/Intro/Intro.js` (upstream file) |
| Emails | subject and body of invites and notices, sender name | `server/mailer.js` |
| Limits | seats, devices, invite expiry, grace days, stats on/off | env, restart needed |
| Support address | env only | `SUPPORT_EMAIL` |
| Operator access | one shared `ADMIN_TOKEN` | D23 to D26 |

**Decision:** add a **settings store** (JSON file now, SQLite table after P1-02) with a schema, defaults and validation. The client fetches a public subset at boot (`GET /config/public`: product name, logo, colours, tagline, legal links, plan display fields, screen copy). Operators edit everything in an operator-panel Settings tab (`GET/PUT /admin/settings`), every change audited and applied without restart. Rules:
1. **Secrets stay in env** (session secret, Stripe keys, Resend key, admin token). The dashboard may show whether they are set, never their value.
2. **Env still works** as the bootstrap default, so existing installs keep running; a dashboard value overrides it.
3. **Plans are records, not JSON in env**: name, description, price display, seats, Stripe price id; the dashboard can create the Stripe price through the API (needs the secret key) and archive a plan without breaking existing subscribers.
4. **Copy is keyed**, with the built-in English as default and an override per key; this is the same key set P2-07 (i18n) needs, so build them together.
5. **Intro screen is upstream code**: overriding its text and links needs a small hook in `Intro.js`, which adds one more merge hot-spot (record it in `FORK_CHANGES.md` when done).
6. Stremio trademark and terms are part of D20 (legal); the settings make it possible to remove Stremio wording, but whether to is a legal question.

**Order of work:** P1-11 store and public config, then P1-06 brand and links, P1-12 plans (also fixes P1-10, the paywall without prices), P1-13 copy and emails, P1-14 live limits, P1-15 the panel tab that ties them together.

## What still needs you (cannot be decided from here)
1. A GitHub account link or your fork's `owner/repo` so the 58 local commits can be pushed.
2. Your real Stripe, Resend and Paddle accounts for the live tests.
3. A go/no-go on starting phase 1 (database, wizard, branding).

# Backlog and progress

> Generated from [`tracker.csv`](tracker.csv) by `node tools/tracker.js`. **Edit the CSV, not this file.** `--check` validates only.

Overall: **26/129 done (20%)**.

## Next up (todo with every dependency done)

- **V-04** Play a video 1 min and see it in Statistics (S, phase 0)
- **V-05** One Stripe test checkout + webhook + portal (M, phase 0)
- **V-06** One real Resend invite email (S, phase 0)
- **V-07** Push history to own fork (S, phase 0)
- **P1-02** Storage interface with SQLite WAL adapter (L, phase 1)
- **P1-07** Signed licence file verify + update notice (no hard lock) (M, phase 1)
- **P2-06** Self-service deletion request with 14-day grace (M, phase 2)
- **P2-07** i18n scaffolding for new screens incl RTL (L, phase 2)
- **P2-09** PWA install and offline shell (M, phase 2)
- **P2-10** Accessibility pass WCAG 2.2 AA on new screens (M, phase 2)
- **P3-04** Diagnostics page copy debug info (S, phase 3)
- **P4-01** Add-on protocol service manifest catalog meta stream subtitles (L, phase 4)
- **P5-02** Own accounts: password reset and change with notices (L, phase 5)
- **P5-03** Replace hard-coded strem.io links (M, phase 5)
- **P5-04** Android and Android TV shell (L, phase 5)
- **P5-05** iOS shell (L, phase 5)
- **P5-06** Tizen and webOS packages (L, phase 5)
- **V-10** Bundle size budget: main.js 9.8 MB and 790.js 8.1 MB (plus 5.3 MB wasm) (M, phase 0)
- **P2-11** Show statistics days in operator local time or label them UTC (S, phase 2)
- **P1-13** Editable screen copy and email templates (paywall; gate screens; invites; notices) (M, phase 1)
- **P1-14** Live-tunable limits in the dashboard (seats; devices; invite expiry; grace days; stats on/off) (S, phase 1)
- **P1-16** Feature switches (new sign-ups on/off; statistics on/off; maintenance mode) (S, phase 1)
- **P1-17** Per-plan limits (devices; seats) editable per plan (S, phase 1)
- **P1-18** Curated default add-ons for new accounts (operator picks the list) (M, phase 1)
- **P2-13** Audit log viewer: search; filter; date range; export; kept on disk (S, phase 2)
- **P2-15** Revenue statistics: MRR; ARR; churn; ARPU; LTV; trial conversion; plan mix (L, phase 2)
- **P2-18** Payment-failure (dunning) view with grace countdown and resend notice (S, phase 2)
- **P2-19** Announcements banner shown in the app (info; warning; maintenance) (S, phase 2)
- **P2-23** Alerts: email or webhook on error spike; failing webhook; disk almost full (M, phase 2)
- **P2-27** Panel redesign: sidebar tabs (Overview; People; Revenue; Content; Settings; System); charts; mobile; light/dark (L, phase 2)
- **P2-28** Panel quick wins: confirm dialogs for destructive actions; copy email; relative times; loading and error states; CSV export on every table (S, phase 2)
- **P2-31** Live view: who is watching right now; titles in progress; concurrent peak per day (S, phase 2)
- **X-01** Decide and test behaviour when the auth server is unreachable (fail-closed today: Try again screen) (S, phase 1)
- **X-08** Legal pack for buyers: terms; privacy and takedown templates; add-on policy (bring your own content) (M, phase 2)
- **X-09** Free trial; annual plans; regional pricing; referral credit; cancellation reason survey (L, phase 2)
- **X-10** Alternative payment routes for markets where cards are scarce (local wallets; bank transfer; crypto invoice) (L, phase 2)
- **X-11** Error reporting (opt-in) and a public status page template; synthetic check of login and checkout (M, phase 2)
- **P1-19** Export and import of settings and plans as one file (clone or move an instance; config backup) (S, phase 1)
- **P2-37** End-user device manager: see own devices; sign out others (M, phase 2)
- **P2-38** Abuse signals: simultaneous streams limit; many-location sign-ins; chargeback auto-flag (M, phase 2)
- **X-13** Runbooks: incident; restore; rotate secrets; upstream breakage; linked from the health panel (S, phase 1)
- **X-14** Stremio API contract tests: record what the core calls and fail CI when a core update changes it (M, phase 1)
- **X-15** Cookie and consent note; subprocessor list (Stripe; Resend; hosting); DPA template (S, phase 2)
- **P2-47** Panel polish: light theme; loading and empty states; table sort and column filters; unsaved-changes warning (M, phase 2)
- **V-12** Real Trakt check: create the Trakt app; connect an account; confirm watchlist catalog and a watched title in Trakt history (S, phase 1)

## Phase 0: Verify and close what exists (50%)

| ID | Task | Size | Decision | Depends | Done when | Status |
|---|---|---|---|---|---|---|
| V-01 | Install deps and commit lockfile | S | - | - | pnpm install succeeds; pnpm-lock.yaml committed (blocked in the build sandbox: codeload.github.com returns 403 for the 3 github: dependencies; run `pnpm install` on a normal machine and commit the lockfile) | blocked |
| V-02 | Build and lint the client | S | - | V-01 | pnpm build and pnpm lint exit 0 | done |
| V-03 | Click-through of login/paywall/Subscription/blocked/replaced screens | M | - | V-02 | Checklist in QUALITY_BAR.md section 3 all ticked | doing |
| V-04 | Play a video 1 min and see it in Statistics | S | - | V-02 | Watch seconds and title visible in operator panel | todo |
| V-05 | One Stripe test checkout + webhook + portal | M | - | V-02 | Plan active after checkout; cancel via portal flips to lapsed | todo |
| V-06 | One real Resend invite email | S | - | V-02 | Invite email received and accept link works | todo |
| V-07 | Push history to own fork | S | - | - | git push succeeds to owner fork (needs repo name) | todo |
| B-01 | Login gate and server session | L | - | - | server tests pass | done |
| B-02 | Stripe billing plans seats webhook reconcile | L | - | - | billing tests pass | done |
| B-03 | Plan sharing roles transfer expiry | L | - | - | invite tests pass | done |
| B-04 | Operator panel grants ban erase export audit | L | - | - | operator checks pass | done |
| B-05 | Statistics module and panel | L | - | - | stats.check passes | done |
| B-06 | Self-service data download | S | - | - | mydata.check passes | done |
| B-07 | Handover decisions vision perfect-product docs | M | - | - | docs linked from README | done |
| V-08 | CI ran only 4 of 6 server test files; run all and de-flake | S | - | - | test:server globs server/*.check.js; suite green 5 runs in a row | done |
| V-09 | Automated browser smoke test (Playwright) of login-only intro; gate and operator panel | M | - | V-02 | tools/e2e/capture.js runs in CI against a fake API module; 7 screens captured (script exists; CI wiring and shared fake-API module still open) | doing |
| V-10 | Bundle size budget: main.js 9.8 MB and 790.js 8.1 MB (plus 5.3 MB wasm) | M | - | V-02 | Cause identified (source maps or unminified chunk?) and a size budget in CI | todo |
| V-11 | Scale benchmark with budgets (tools/bench/stats.js); statistics summary cached 30 s | S | PM | - | Benchmark script and 30 s cache exist (done); budgets enforced in CI: 100k users summary under 200 ms; flush under 50 ms | doing |

## Phase 1: Foundation to sell (32%)

| ID | Task | Size | Decision | Depends | Done when | Status |
|---|---|---|---|---|---|---|
| P1-01 | Sign out everywhere (operator button + endpoint) | S | D27 | - | Operator click revokes all sessions; user next heartbeat gets 401; test added | done |
| P1-02 | Storage interface with SQLite WAL adapter | L | D7 | - | All server tests pass on SQLite; JSON import command works | todo |
| P1-03 | Statistics as events table + daily rollups | L | D12 | P1-02 | Same endpoints; 50k-user load test under 1 s p95 and file not rewritten | todo |
| P1-04 | Litestream backup recipe + restore drill | M | D7 | P1-02 | Documented restore tested on a fresh machine | todo |
| P1-05 | Docker Compose + one-line installer + setup wizard | L | D5 | P1-02 | Fresh VPS to working login in under 15 minutes | doing |
| P1-06 | Branding settings (name; logo; colours; tagline; legal links; support email) and brandMode | M | D6 D31 | P1-11 | Operator sets name; tagline; login lines; logo; symbol; app icon; legal links from the panel; client shows them in every language without a rebuild (done; shots 18-20; 6 tests); remaining Stremio pages: see P1-22 | done |
| P1-07 | Signed licence file verify + update notice (no hard lock) | M | D8 | - | Expired licence shows banner only; tamper detected | todo |
| P1-08 | Paddle product + webhook issuing licence files | M | D2 | P1-07 | Test purchase yields working licence | todo |
| P1-09 | Demo instance reset hourly + sales page | M | D18 | P1-05 | Public demo live and resets | todo |
| P1-10 | Paywall shows price and description per plan | S | - | - | Plan cards show price from Stripe and the PLANS description; screenshot 04 retaken | done |
| P1-11 | Settings store and public config endpoint (runtime settings with defaults; env as bootstrap) | M | D31 | - | Settings store; public config endpoint; the app reads it (done) | done |
| P1-12 | Plans managed in the dashboard (create; edit; archive; Stripe prices created from the UI) | L | D31 | P1-11 | Plans add/edit/archive live from the panel; Stripe price created from the panel (POST /admin/plans/price; real SDK against a fake Stripe in the screenshot run); paywall and Subscription page show them | done |
| P1-13 | Editable screen copy and email templates (paywall; gate screens; invites; notices) | M | D31 | P1-11 | Every user-facing string of the new screens and emails has a default and an operator override; preview in the panel | todo |
| P1-14 | Live-tunable limits in the dashboard (seats; devices; invite expiry; grace days; stats on/off) | S | D31 | P1-11 | Each env tunable in HANDOVER constants has a settings field with validation and takes effect live | todo |
| P1-15 | Operator panel split into pages with side navigation (Overview; People; Subscribers; Plans; Settings; Statistics; Content and playback; Activity) | M | D31 | P1-11 | Each section is its own bookmarkable page; mobile nav bar; overview tiles and health dot (done); still open: copy and email template editors | done |
| P1-16 | Feature switches (new sign-ups on/off; statistics on/off; maintenance mode) | S | OA | P1-11 | Each switch is a setting; the server and client honour it live; maintenance shows a branded page | todo |
| P1-17 | Per-plan limits (devices; seats) editable per plan | S | OA | P1-12 | Limits live on the plan record and the Subscription page shows them | todo |
| P1-18 | Curated default add-ons for new accounts (operator picks the list) | M | OA | P1-11 | New accounts start with the operator list; changing the list does not touch existing accounts | todo |
| X-01 | Decide and test behaviour when the auth server is unreachable (fail-closed today: Try again screen) | S | PA | - | Written policy (grace window for paying users or not) and a test for each case | todo |
| X-02 | Dependency audit and secret scanning in CI; secret rotation guide (session secret; admin token; Stripe) | S | PA | V-01 | CI fails on high advisories; HANDOVER has a rotation section | todo |
| X-03 | Visual regression: compare tools/e2e screenshots to a stored baseline in CI | M | PA | V-09 | CI flags unintended UI changes with a diff image | todo |
| X-04 | Mobile and light/dark screenshot sets for marketing (E2E_SCALE=2 and phone viewport) | S | PA | V-09 | docs/screenshots has desktop and phone sets of each screen | todo |
| X-05 | Upstream sync check: CI job that tries to merge upstream stremio-web and reports conflicts in the fork hot-spots | M | PA | V-07 | Weekly report listing conflicting files from FORK_CHANGES | todo |
| X-06 | First-run guide for end users (what add-ons are; install starter pack; connect streaming server) and good empty states | M | PA | P1-18 | New account sees a checklist instead of an empty Home | todo |
| P1-19 | Export and import of settings and plans as one file (clone or move an instance; config backup) | S | PM | P1-11 | Export from one instance; import to another; secrets never included | todo |
| P1-20 | Statistics scale: incremental daily rollups and no full-file rewrite | M | PM | P1-03 | 100k users: summary under 200 ms and no write over 50 ms (benchmark) | todo |
| X-13 | Runbooks: incident; restore; rotate secrets; upstream breakage; linked from the health panel | S | PM | - | Each runbook tested once on a staging instance | todo |
| X-14 | Stremio API contract tests: record what the core calls and fail CI when a core update changes it | M | PM | P5-01 | CI fails when a new core version calls an endpoint or shape the stub does not know | todo |
| P1-21 | Demo instance seeded with tools/demo/seed-stats.js and reset hourly | S | OA | P1-09 | Demo shows 30 days of believable history after every reset | doing |
| P1-22 | Replace or hide the remaining Stremio links: Help page; About page; store badges; calendar feed; Trakt; social logins | M | BR | P1-06 | node tools/branding/audit.js shows no Stremio host in visible UI (done for own accounts; was partly: terms; privacy and support links follow the operator settings; Facebook and Apple buttons hidden with own accounts; with own accounts nothing links to Stremio hosts on the main screens: checked by a browser link scan; legal support download and source links are operator settings; remaining stock strings: the add-on id of the Trakt add-on (internal) and docs) | done |
| P1-23 | Own account service: email and password; sign-in keys; library; add-on collection; profile (replaces api.strem.io) | L | BR | P1-06 | OWN_ACCOUNTS=true: browser signs up and syncs with no api.strem.io traffic (done; 8 tests + tools/e2e/accounts.js) | done |
| P1-24 | Own accounts next: password reset by email; hide Facebook/Apple/Trakt; QR link sign-in; data export; operator accounts view; import for existing users | M | BR | P1-23 | Each item works with OWN_ACCOUNTS=true and is covered by a test (done: reset by email; hide Facebook Apple and Trakt; own calendar feed; operator account block with export; own account page for export and delete; health checks; still: QR sign-in; import of existing users) | done |
| P1-25 | Move accounts from JSON file to a database | L | D3 | P1-23 | accounts on SQLite (node:sqlite) with daily backups and the same tests passing (done; needs Node 22.13+; Postgres later if several servers are needed) | done |
| P1-26 | Own versions of what was left out: calendar feed of upcoming episodes (done); Trakt link catalogs and history (done); QR sign-in link for other apps (done) | L | BR | P1-24 | Each works without any strem.io address (calendar and Trakt done: tests and e2e with a fake Trakt) | done |
| V-12 | Real Trakt check: create the Trakt app; connect an account; confirm watchlist catalog and a watched title in Trakt history | S | BR | P1-26 | A real Trakt account shows the watchlist in the app and a finished movie in its Trakt history | todo |
| P1-27 | Other apps switch by changing the address: link sign-in QR service; CORS; core patch; compatibility checker | M | BR | P1-24 | tools/compat/check.js passes 22 checks; docs/SWITCHING_APPS.md; patch applies to core d3e05c2 (done) | done |
| P1-28 | Try a real third-party app against the server and fill gaps (routes or error codes it needs that the core does not use) | M | BR | P1-27 | One real app signs in and syncs with only the address changed | doing |

## Phase 2: Operate and localise (7%)

| ID | Task | Size | Decision | Depends | Done when | Status |
|---|---|---|---|---|---|---|
| P2-01 | Named operator accounts with viewer/support/admin roles | L | D23 D24 | P1-02 | Role matrix enforced by tests | todo |
| P2-02 | TOTP two-factor and optional IP allow-list | M | D25 | P2-01 | Login without code refused | todo |
| P2-03 | Audit entries record the operator | S | D26 | P2-01 | Audit shows operator name | todo |
| P2-04 | Bulk grants CSV and multi-select ban | M | D29 | P2-01 | CSV of 500 grants imports with report | todo |
| P2-05 | Retention as env setting + delete-older-than button | S | D30 | P1-03 | Setting honoured and logged | todo |
| P2-06 | Self-service deletion request with 14-day grace | M | D10 | - | Flow tested incl. active subscription refusal | todo |
| P2-07 | i18n scaffolding for new screens incl RTL | L | D9 | - | All strings keyed; Arabic renders RTL | todo |
| P2-08 | Translations es pt fr de ar th | M | D9 | P2-07 | Native review of each pack | todo |
| P2-09 | PWA install and offline shell | M | D13 | V-02 | Lighthouse PWA installable | todo |
| P2-10 | Accessibility pass WCAG 2.2 AA on new screens | M | D16 | - | axe zero serious issues; keyboard-only walkthrough | todo |
| P2-11 | Show statistics days in operator local time or label them UTC | S | - | - | Panel labels the timezone; test covers the label | todo |
| P2-12 | User directory: search; sort; filters; pagination; user detail page | M | OA | - | Search and paging on the server (done 2026-11-20); sort and filters; user detail page (open); panel handles 100k users; person page done | doing |
| P2-13 | Audit log viewer: search; filter; date range; export; kept on disk | S | OA | - | Whole log searchable (today the panel shows the last 50 from memory) | todo |
| P2-14 | System health panel and setup checklist (Stripe; webhook; mail; backup; disk; version) | M | OA | - | Panel shows ok/warn/fail/off per item; last webhook; last backup; data size; free disk; uptime; version (done: GET /admin/health; 3 tests; shot 13); not yet: Stripe API reachability probe | done |
| P2-15 | Revenue statistics: MRR; ARR; churn; ARPU; LTV; trial conversion; plan mix | L | OA | P1-12 | Numbers reconcile to Stripe within 1 percent on test data | todo |
| P2-16 | Billing actions from the panel: cancel; refund; pause; extend; coupons | L | OA | P2-15 | Each action calls Stripe; is audited; asks for confirmation | todo |
| P2-17 | Funnels: paywall viewed to checkout to paid; invites sent to accepted; seat use | M | OA | P2-15 | Funnel table with drop-off per step for a chosen period | todo |
| P2-18 | Payment-failure (dunning) view with grace countdown and resend notice | S | OA | - | Lists past_due accounts and time left; one click resends the notice | todo |
| P2-19 | Announcements banner shown in the app (info; warning; maintenance) | S | OA | P1-11 | Operator writes text + expiry; app shows it; audited | todo |
| P2-20 | Email tools: segments (at-risk; never watched; expiring) and templates | L | OA | P1-13 | Operator sends a templated email to a segment with preview and a send log | todo |
| P2-21 | Cohort retention table; per-plan stats; date range and period compare; timezone choice | M | OA | P2-11 | Panel range picker; weekly cohorts week 0 to 12; numbers match exports | todo |
| P2-22 | Content insights: per-title drilldown; add-on install and removal counts; search terms | M | OA | P1-03 | Needs client events; privacy reviewed (D28) | todo |
| P2-23 | Alerts: email or webhook on error spike; failing webhook; disk almost full | M | OA | P2-14 | Thresholds editable in settings; one test alert button | todo |
| P2-24 | Backups screen: list; download; restore points; run now | M | OA | P1-04 | Operator can download the latest backup and see its age | todo |
| P2-25 | Privacy requests queue (my-data; erase) with log and consent record; stats retention setting | M | OA | P2-05 | Every request and its outcome is listed and exportable | todo |
| P2-26 | Operator API keys and outgoing webhooks (new subscriber; cancel; ban) | M | OA | P2-01 | Keys scoped read or write; webhook delivery log with retry | todo |
| P2-27 | Panel redesign: sidebar tabs (Overview; People; Revenue; Content; Settings; System); charts; mobile; light/dark | L | OA | - | Replaces the single long page; each tab screenshot-ready; keyboard accessible | todo |
| P2-28 | Panel quick wins: confirm dialogs for destructive actions; copy email; relative times; loading and error states; CSV export on every table | S | OA | - | Every table has export; every destructive button asks first | todo |
| P2-29 | Customer timeline per person: sign-ins; plays; payments; invites; operator actions; internal notes and tags | M | OA | P2-12 | One page per user shows everything in time order; notes and tags are searchable | todo |
| P2-30 | Global search and command bar (email; title; invite; plan) with keyboard shortcut | S | OA | P2-12 | Press / to search across people; plans and audit; opens the result | todo |
| P2-31 | Live view: who is watching right now; titles in progress; concurrent peak per day | S | OA | - | Panel tab refreshes every 10 s; peak concurrency stored in daily stats | todo |
| P2-32 | Daily or weekly digest email to the operator (new; paying; churned; errors; top titles) | S | OA | P1-13 | Operator chooses day and time in settings; preview and send-now button | todo |
| P2-33 | Goals and targets (MRR; active users; activation) with progress bars on Overview | S | OA | P2-15 | Targets editable in settings; progress shown with trend | todo |
| P2-34 | Privacy mode for the panel: mask emails by default; reveal per click is audited; viewer role sees masked only | S | OA | P2-01 | Screenshots and screen-shares safe by default | todo |
| P2-35 | Update centre: current version; new release notice; changelog; one-click update and rollback note | M | OA | P1-07 | Panel shows version and whether an update exists; changelog readable | todo |
| P2-36 | Live preview of branding and copy in the panel (sign-in; paywall; emails) before saving | M | OA | P1-13 | Operator sees each screen with the draft values; save applies them | todo |
| X-07 | Buyer documentation: install guide; operator guide; FAQ; video walkthrough from the screenshot flow | M | PA | P1-05 | A buyer installs and configures without contacting you | todo |
| X-08 | Legal pack for buyers: terms; privacy and takedown templates; add-on policy (bring your own content) | M | PA | - | Templates reviewed by a lawyer and linked from settings | todo |
| X-09 | Free trial; annual plans; regional pricing; referral credit; cancellation reason survey | L | PA | P1-12 | Each is a plan or Stripe setting with a panel control | todo |
| X-10 | Alternative payment routes for markets where cards are scarce (local wallets; bank transfer; crypto invoice) | L | PA | P1-12 | At least one non-card route issues an entitlement through the same grant mechanism | todo |
| X-11 | Error reporting (opt-in) and a public status page template; synthetic check of login and checkout | M | PA | P2-14 | Operator gets an alert before users complain | todo |
| P2-37 | End-user device manager: see own devices; sign out others | M | PM | - | Subscription page lists devices; sign out one or all others; audited | todo |
| P2-38 | Abuse signals: simultaneous streams limit; many-location sign-ins; chargeback auto-flag | M | PM | P2-14 | Operator sees a flagged list with reason; one click to warn or block | todo |
| P2-39 | Danger-zone safeguards: typed confirmation; 24 h undo for erase; change history with revert for settings and plans | M | PM | P2-03 | No irreversible click without typing the email; a settings change can be reverted from history | todo |
| P2-40 | Report a problem button with diagnostics and an operator inbox with email reply | L | PM | P3-04 | End user sends; operator replies from the panel; thread kept | todo |
| P2-41 | Unit economics tab: revenue minus Stripe fees and entered costs; margin; cost per active user | M | PM | P2-15 | Operator sees monthly margin and cost per active user | todo |
| P2-42 | Chat notifications (Telegram; Discord; Slack): new subscriber; failed payment; error spike | S | PM | P2-26 | Operator pastes a webhook URL and gets a test message | todo |
| X-15 | Cookie and consent note; subprocessor list (Stripe; Resend; hosting); DPA template | S | PM | - | Documents exist and are linked from settings | todo |
| P2-43 | Statistics page as tiles and charts instead of one text line (trend lines; retention curve; cohort table) | M | OA | - | Totals as tiles (done); daily active chart (done); still open: retention curve; cohort table; hover values on tiles | doing |
| P2-44 | Person detail page (click a person: sign-ins; devices; watch history; plan; notes; actions) | M | OA | P2-12 | Click a person in People: first and last seen; sign-ins; hours; access (plan; invite; grant); block; sign out; grant; erase; audit history (done; shot 16); still open: notes field and watch history list | done |
| P2-45 | Global search box in the header (people; plans; audit entries) and keyboard shortcuts (g then p for People) | S | OA | P2-44 | Header jump box finds people and pages from any page; Enter opens the first match; slash focuses it; Escape closes (done; shot 17); still open: search the audit log and plans | done |
| P2-46 | Operator accounts: named logins instead of one shared token; roles (owner; support; read-only); audit shows who | L | OA | P1-02 | Support staff can block and grant but not edit plans or see revenue | todo |
| P2-47 | Panel polish: light theme; loading and empty states; table sort and column filters; unsaved-changes warning | M | OA | - | Every table sorts; every empty state explains what it is | todo |
| P2-48 | Notes on a person (operator-only text; included in export and erase) | S | OA | P2-44 | Operator writes a note on the person page (500 characters); it is in the data export; erased with the person; the text is not copied into the audit log (done; shot 16; 1 test) | done |

## Phase 3: Reliability and hosting (0%)

| ID | Task | Size | Decision | Depends | Done when | Status |
|---|---|---|---|---|---|---|
| P3-01 | Source health scoring from playback reports | L | D15 | P1-03 | Score per source visible in panel | todo |
| P3-02 | Player auto-switch on failure/stall and next-episode preload | L | D15 | P3-01 | Stall over 8 s switches stream at same time code | todo |
| P3-03 | Managed hosting offer and provisioning script | L | D5 | P1-05 P1-04 | New install provisioned in under 10 minutes | todo |
| P3-04 | Diagnostics page copy debug info | S | D18 | - | Page returns version config health | todo |
| X-12 | Bundle diet: lazy-load wasm and routes; smaller service-worker precache; CDN guide | M | PA | V-10 | Initial JS under an agreed budget; precache under 10 MB | todo |
| P3-05 | Fleet console for agencies and managed hosting: many instances; one login; combined health and revenue | L | PM | P3-03 | One screen lists every instance with status and MRR | todo |
| P3-06 | Optional AI assistant in the panel: ask questions of the stats; weekly insights; draft win-back emails (opt-in; no personal data leaves by default) | L | PM | P2-15 | Operator asks a question and gets an answer from aggregate data only | todo |

## Phase 4: Content API (0%)

| ID | Task | Size | Decision | Depends | Done when | Status |
|---|---|---|---|---|---|---|
| P4-01 | Add-on protocol service manifest catalog meta stream subtitles | L | D14 | - | Loads in stock Stremio as an add-on | todo |
| P4-02 | Per-customer keys limits metering and plans | L | D3 D14 | P4-01 | Limits enforced; usage visible | todo |
| P4-03 | Two regions CDN status page circuit breaker | L | D14 | P4-01 | Failover tested | todo |
| P4-04 | Cross-client usage from stream requests | M | D22 | P4-02 | Panel shows add-on side totals | todo |

## Phase 5: Own accounts and clients (17%)

| ID | Task | Size | Decision | Depends | Done when | Status |
|---|---|---|---|---|---|---|
| P5-01 | Spike: unmodified core logs in against own stub API | L | D1 | V-02 | GO on approach recorded in SPIKES.md (done); service-worker redirect tried in a real browser; endpoint contract written | done |
| P5-02 | Own accounts: password reset and change with notices | L | D1 D21 | P5-01 | Password events in user detail | todo |
| P5-03 | Replace hard-coded strem.io links | M | D1 | P5-01 | No strem.io URL remains in the client | todo |
| P5-04 | Android and Android TV shell | L | D13 | V-02 | Installable APK plays video | todo |
| P5-05 | iOS shell | L | D13 | V-02 | TestFlight build | todo |
| P5-06 | Tizen and webOS packages | L | D13 | V-02 | Runs on a real TV | todo |

## Phase 6: Multi-tenant (0%)

| ID | Task | Size | Decision | Depends | Done when | Status |
|---|---|---|---|---|---|---|
| P6-01 | Tenant-scoped data branding admin and domains | L | D4 | P1-02 P2-01 | Two brands isolated on one install | todo |
| P6-02 | PostgreSQL adapter | L | D7 | P1-02 | Same suite passes on Postgres | todo |
| P6-03 | Platform tier packaging and onboarding | M | D3 | P6-01 | Tier purchasable | todo |


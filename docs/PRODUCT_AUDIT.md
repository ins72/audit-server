# Product audit: what else would make the idea "perfect"

Date: 2026-11-20. Beyond the operator dashboard (see [`OPERATOR_AUDIT.md`](OPERATOR_AUDIT.md)): what a buyer, an end user and a maintainer will run into. Tasks have decision `PA` in [`tracker.csv`](tracker.csv). Facts below were checked in the code unless marked *assumption*.

## 1. The product the buyer sells
| Finding | Consequence | Task |
|---|---|---|
| A new Stremio account has no add-ons, so Home is empty (seen when the stub had none). End users will think the product is broken. | Biggest first-impression risk for the buyer's customers | P1-18, X-06 |
| Plans had no prices on the paywall and needed a restart to change (fixed 2026-11-20: plans are managed in the dashboard and show price + description) | Conversion | P1-12, P1-10 |
| No trial, no annual plan, no regional pricing, no coupons, no cancellation reason | Standard levers for revenue and churn | X-09, P2-16 |
| Card-only checkout | Many markets (including Southeast Asia and Africa) pay by wallet or transfer | X-10 |
| "Stremio" wording and links are visible in the UI; terms and privacy links point to upstream | Trademark and credibility; covered by D20 and D31 | P1-06, P5-03 |
| Legal exposure is the buyer's problem but they will ask for help: terms, takedown process, add-on policy | A legal pack makes the package safer to sell | X-08 |

## 2. Reliability
- **Auth server down:** the client shows a gate screen with *Try again* (it fails closed). A paying user is locked out during any outage. Decide whether to allow a grace window (for example 15 minutes of cached entitlement) and test it. (X-01)
- **Single JSON-file instance** is the scaling ceiling (SQLite is planned, P1-02). The panel's own `/admin/sessions` returns every user (P2-12).
- No error reporting, status page or synthetic check of login and checkout. (X-11, P2-14, P2-23)

## 3. Security
Already in place (verified): CSP on the operator page, `nosniff`, frame options, HSTS option, rate limiting on login and admin, constant-time token checks, audit log, secrets never shown in the panel.
Missing: dependency audit and secret scanning in CI, rotation guide for the session secret / admin token / Stripe keys, named operators with two-factor (P2-01, P2-02), masked emails in the panel (P2-34). (X-02)

## 4. Quality and maintenance
- **Visual regression:** `tools/e2e/capture.js` already produces a screenshot of every new screen; comparing them to a baseline in CI catches accidental UI changes. (X-03, V-09)
- **Marketing assets:** a phone-size and light/dark set from the same script, plus 2x images, cost almost nothing. (X-04)
- **Upstream drift:** a fork of an active project needs a weekly "does upstream still merge cleanly?" job aimed at the hot-spots listed in `FORK_CHANGES.md`. (X-05)
- **Bundle:** 9.8 MB + 8.1 MB JS and a 30 MB service-worker precache hurt first load on mobile data. (V-10, X-12)
- Lockfile still missing in the repo (V-01); CI cannot pass without it.

## 5. Selling it
- A buyer needs documentation they can follow alone: install guide, operator guide, FAQ, a short video made from the screenshot flow. (X-07)
- Demo instance and sales page are already planned (P1-09); the screenshot script can regenerate demo visuals after every release.
- Licence file and updates are planned (P1-07, P2-35).

## 6. Suggested order
1. Finish **P1-12** (Stripe prices from the UI), then **P1-18** + **X-06** (starter add-ons and first-run guide): they remove the empty-product problem.
2. **X-01** and **V-01** (decide outage behaviour; lockfile): small, remove two real risks.
3. **P2-14**, **P2-12**, **P2-15** from the operator audit.
4. **X-02**, **X-03**, **V-09** to make every later change safe.
5. **X-07**, **X-08** before the first sale.

## 7. Open questions for the owner
1. Outage policy (X-01): lock out, or short grace window for paying users?
2. Which markets first? That decides payment routes (X-10) and languages (P2-08).
3. Will buyers be allowed to remove all Stremio wording? Needs the lawyer (D20).

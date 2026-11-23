# Operator capability audit

Date: 2026-11-20. Question: what can an operator (the person who runs an instance) see and manage today, what is missing, and what should come first? Code read: `server/*.js`, `server/operator/*`, `http_server.js`. Task ids refer to [`tracker.csv`](tracker.csv) (rows with decision `OA`). Screenshots: [`screenshots/`](screenshots/README.md).

## 1. What operators can do today
| Area | Today |
|---|---|
| People | See who is online and last seen (first 200 only); block / unblock with a note; **sign out everywhere**; erase a person's data; export users as CSV |
| Money | Subscribers table (plan, status, renewal, invites); remove an invite; complimentary access (grant / revoke); export billing as CSV |
| Statistics | Totals (users, activation, stickiness, hours); 14-day trend; at-risk payers; top content and viewers; never-watched users; playback quality; add-ons by plays and errors; devices and languages; watching by hour |
| Audit | Last 50 actions |
| Settings | Support email, product name, tagline, terms and privacy links (new, `/admin/settings`) |

## 2. Gaps found
**Scale and safety of the panel itself**
- The panel loads every user in one request and shows 200 rows. At the size of a real customer base this is slow and hides most people; there is no search. (P2-12)
- The audit log is kept in memory (last entries) and the panel shows 50; nothing is searchable or exportable from the UI. (P2-13)
- One shared admin token for everybody and no record of *which* operator acted. Roles and two-factor exist only as tasks. (P2-01, P2-02, P2-03)
- Destructive buttons are inconsistent about asking first; tables have no export. (P2-28)

**Health and setup**
- No place that says whether Stripe, the webhook, mail and backups are actually working. The only signal is `/healthz`. A new buyer cannot tell why invites are not sent. (P2-14)
- No backups screen, no alerts when something breaks. (P2-24, P2-23)

**Revenue**
- No MRR, ARR, churn, ARPU, lifetime value, trial conversion or plan mix, although the data is in Stripe. (P2-15)
- No funnel (paywall seen, checkout started, paid; invite sent, accepted) and no seat-use view. (P2-17)
- No refunds, cancellations, pauses, coupons or plan changes from the panel; the operator has to open Stripe. (P2-16)
- `past_due` accounts are not listed, so grace periods cannot be managed. (P2-18)

**Growth and communication**
- No announcement banner, maintenance mode or switch to close sign-ups. (P1-16, P2-19)
- No way to email a segment (at-risk, never watched, expiring) and no editable email templates. (P2-20, P1-13)

**Statistics depth**
- Fixed 14-day window, no range picker, no compare-to-previous-period, no cohort retention, no per-plan view; days are UTC (P2-11, P2-21).
- No per-title drilldown, add-on install counts or search terms (needs client events, privacy review). (P2-22)

**Settings still hard-coded** (beyond D31): per-plan device and seat limits, default add-ons for new accounts, statistics on/off, retention. (P1-16, P1-17, P1-18, P2-05)

**Legal**
- No queue or log of privacy requests (my-data downloads, erasures) and no consent record. (P2-25)

**Automation**
- No operator API keys or outgoing webhooks, so nothing connects to Zapier, Slack or accounting. (P2-26)

**Panel design**
- One long page. A buyer's first impression is this screen; it should be tabs (Overview, People, Revenue, Content, Settings, System), responsive, with charts. (P2-27)

## 3. Priority
Ranked by value to a buyer divided by effort, assuming P1-11 (settings store, done) is in place:

| # | Task | Why now |
|---|---|---|
| 1 | P1-12 plans in the dashboard (+P1-10 prices) | The paywall has no prices and plans need a restart to change |
| 2 | P2-14 health and setup checklist | Cuts support load for every new buyer |
| 3 | P2-12 user directory | Panel breaks down at scale |
| 4 | P2-15 revenue statistics | The first thing an operator asks for |
| 5 | P2-27 panel redesign (tabs) | Sells the product; do after the data it displays exists |
| 6 | P2-01 / P2-03 named operators and audit by operator | Needed before more than one person administers |
| 7 | P2-16 billing actions, P2-18 dunning | Saves trips to Stripe |
| 8 | P1-16 / P2-19 switches and announcements | Cheap, high-value for incidents |

Quick wins that need no design decision: P2-28, P2-13, P1-16, P2-18.

## 4. Second pass (ideas beyond the first audit)
| Idea | Why an operator wants it | Task |
|---|---|---|
| Customer timeline with notes and tags | Answering a support email needs sign-ins, plays, payments and past actions on one page | P2-29 |
| Global search / command bar | Fastest way to find a person, invite or plan | P2-30 |
| Live view (watching now, peak concurrency) | Capacity planning and launch-day confidence; strong demo screen | P2-31 |
| Daily or weekly digest email | Operators do not open the panel every day | P2-32 |
| Goals and targets on the overview | Turns numbers into progress | P2-33 |
| Privacy mode (masked emails, audited reveal) | Safe screen-shares and screenshots; matches the GDPR stance in D28 | P2-34 |
| Update centre | Buyers need to know a new version exists and what changed | P2-35 |
| Live preview of branding and copy | Makes the settings in D31 safe to change | P2-36 |

## 5. Notes
- Anything that stores more personal data (search terms, per-title viewing by person, regions) must pass the privacy check in D28 before building.
- Every new operator action must be audited with the operator's name once P2-03 exists.

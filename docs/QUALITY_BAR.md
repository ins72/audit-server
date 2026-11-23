# Quality bar: how we know something is "perfect"

Used with [`BACKLOG.md`](BACKLOG.md). A task is only `done` in `tracker.csv` when sections 1 and 2 hold.

## 1. Definition of done (every task)
1. Its `done_when` line in the tracker is demonstrably true.
2. Server change: a test in `server/*.check.js` fails without it and passes with it; the full suite is green.
3. Client change: strict type-check and ESLint clean; screen checked in a browser (Chromium render at minimum).
4. Failure behaviour defined: Stremio outage = 502 (never a logout), Stripe/Resend outage degrades gracefully.
5. Docs updated: `HANDOVER.md` (behaviour, env), `server/README.md` (endpoints, error codes), `.env.example`.
6. No personal data added without a retention rule and inclusion in export and erase.
7. Committed with a message saying what and why.

## 2. Release gates (before every sale-ready version)
| Gate | Target |
|---|---|
| Server test suite | 100% pass |
| Load test (`server/tools/loadtest.js`) | no errors; p95 under 300 ms at 50k users |
| Statistics storage at 50k users | under 5 MB growth/day after P1-03 |
| Fresh install time | under 15 minutes (P1-05) |
| Restore drill | backup restored on a clean machine |
| Accessibility | zero serious axe issues; keyboard-only path works |
| Security | no secrets in logs; cookies HttpOnly+Secure; rate limits on; dependency audit reviewed |
| Docs | a new person reaches a running install using only `docs/README.md` |

## 3. Manual click-through checklist (task V-03)
- [ ] Logged out visitor sees only the login screen
- [ ] Login works; wrong password shows Stremio's error
- [ ] Account without plan sees the paywall; checkout opens
- [ ] Plan owner sees Subscription page; invite, resend, remove, role change, transfer
- [ ] Invited person accepts and gets access
- [ ] Removed/expired person sees the blocked screen
- [ ] Second browser beyond the device limit sees "signed in elsewhere"
- [ ] Banned account sees the support message
- [ ] Download my data returns a file
- [ ] Operator panel: statistics, grants, ban/unban, audit, export, erase

## 4. Product health metrics (read from the operator panel)
| Metric | Why | Starting target |
|---|---|---|
| Day-7 retention | people stay | above 40% |
| Never-watched share | login but no value | below 25% |
| Playback error rate | top complaint in the market | below 3% |
| Conversion to paid | business | track, then set |
| Seats used vs paid | sharing value | track |
| Support tickets per 100 users | polish | falling |
Targets are guesses to be replaced after the first month of real data.

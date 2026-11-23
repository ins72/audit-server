# Pre-mortem and scale benchmark (2026-11-20)

Question asked: "what else would make this the perfect product?" Method: imagine it failed one year after launch and write down why, then measure the parts that could break first.

## Why it could fail, and what we do about it

| Failure story | Cause | Task |
|---|---|---|
| Operators move instances and lose their setup | No way to copy settings and plans | P1-19 |
| Panel gets slow at 100k users | Statistics rewritten whole; summary blocks the event loop | P1-20, V-11 (30 s cache done) |
| One bad click erases a customer | No typed confirmation, no undo | P2-39 |
| Accounts get shared on forums | No device view for users, no abuse signals | P2-37, P2-38 |
| Chargebacks pile up unseen | No dispute handling | P2-38 |
| Operator learns of problems from angry users | No chat alerts | P2-42 |
| Support lives in the operator's personal inbox | No report-a-problem flow or inbox | P2-40 |
| Margin is unknown | No cost view | P2-41 |
| A core update silently breaks login | No contract test against the Stremio API | X-14 |
| Night-time incident, nobody knows what to do | No runbooks | X-13 |
| Agency with 20 instances drowns | No fleet view | P3-05 |
| Legal questions from business customers | No subprocessor list or DPA | X-15 |

## Scale benchmark (`node tools/bench/stats.js [repo] [users]`)

| | 10k users | 100k users |
|---|---|---|
| `summary(30)` (statistics section) | 168 ms | 1441 ms |
| `summary(14)` | 87 ms | 764 ms |
| `recordWatch`, per event | | about 0.25 ms |
| `stats.json` size | 2.7 MB | 24.9 MB |
| Full flush to disk | 20 ms | 194 ms |
| Filter users by email | | 4 ms |
| Sort users | | 30 ms |
| Old `/admin/sessions` payload | 1.0 MB | 10.5 MB |

Findings:
1. The statistics summary blocks the event loop for 1.4 s at 100k users. Mitigated now: `/admin/stats` is cached for 30 s (`server/ttlCache.js`; `?fresh=1` bypasses). Lasting fix: daily rollups (P1-20, P1-03).
2. `stats.json` is rewritten whole on every debounced save. Fine to roughly 50k users; plan the database move before that.
3. The people list sent 10.5 MB; it is now paged (100 per page, with search).

Budgets to enforce in CI (V-11): summary under 200 ms and one flush under 50 ms at 100k users. Both fail today; that is the point of P1-20.

## Still open (needs the owner)
- Paying users when the auth server is down: lock out, or a short grace window?
- Which markets first?
- Fork `owner/repo` so the 65+ local commits can be pushed (origin is upstream Stremio).

## Recommended order (2026-11-20, fourth audit)
The audits now repeat each other (`OPERATOR_AUDIT.md`, `PRODUCT_AUDIT.md`, this file). More ideas add less than proving what exists. Order by value per effort:

1. **Prove it with real services (owner needed):** V-05 Stripe test checkout, webhook and portal; V-06 one real invite email; V-04 play one video and see it in Statistics; V-01 lockfile; V-07 push to the fork. Until these pass, every paid feature is untested against the real thing.
2. **Decide the outage rule (X-01):** one answer from the owner, then a test.
3. **P1-12 rest:** create the Stripe price from the panel (removes the biggest setup step).
4. **P1-11/P1-06:** the app itself reads `/config/public` (name, logo, colours), so a buyer can rebrand without a rebuild.
5. **P1-18 and X-06:** starter add-ons and a first-run guide; empty Home is the top end-user risk.
6. **P1-20 then P1-03:** statistics scale before 50k users.
7. **P2-39 and P1-19:** undo and config export, cheap safety for operators.
8. **X-14 and X-05:** contract and upstream-merge checks, so a Stremio update cannot break the fork silently.
Everything else waits for the first real customer's feedback.

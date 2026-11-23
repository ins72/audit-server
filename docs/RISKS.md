# Risks and spikes

## Risk register
| ID | Risk | Likelihood | Impact | Mitigation | Task |
|---|---|---|---|---|---|
| R1 | Core cannot be pointed at own account API | Medium | High (blocks own accounts) | Time-boxed spike; fallback rebuild core or stay on Stremio accounts | P5-01 |
| R2 | Client never built or run in a browser (reduced 2026-11-20: it builds, lints and renders in Chromium, 7 screens in `docs/screenshots/`; real playback and live Stripe still untested) | Medium | High | V-03 to V-05 | V-03..V-05 |
| R3 | Stremio changes its API or terms | Medium | High | Single `verify()` seam; outage never logs out; own accounts path | P5-01 |
| R4 | Upstream GPL-2.0 limits how code is sold | Unknown | High | Counsel decision (D20); engineering plan unaffected | D20 |
| R5 | JSON files fail at scale or crash | Medium | Medium | SQLite, backups, restore drill | P1-02..P1-04 |
| R6 | Buyers distrust "modified Stremio" | Medium | Medium | Own brand default; honest badge text | P1-06 |
| R7 | Support load overwhelms a solo seller | Medium | Medium | Diagnostics page, demo, docs, bounded support | P3-04, P1-09 |
| R8 | Content API depends on third-party providers | High | High | Circuit breakers, provider failover | P4-03 |
| R9 | Marketplace fees or rules change again | Medium | Low | Own site is primary | D2 |
| R10 | Single operator token leaks | Low | High | Named accounts, TOTP, allow-list | P2-01, P2-02 |

## Spike S1: own-account API (P5-01), time-box 2 weeks
Question: can the unmodified Stremio core be pointed at a stub API we host?
1. Stand up a stub of the endpoints the core calls at login and library sync (observe them in the browser network tab).
2. Try, in order: service-worker rewrite of `api.strem.io`; rebuilding the core with another API constant; a reverse proxy at a custom domain.
3. Success: login, library load, add-on sync, and one stream play against the stub.
4. Output: go/no-go, chosen method and effort, written here.
Result: **GO on the approach, server still to build** (2026-11-20). The unmodified core signs in against a stub when `api.strem.io` calls are intercepted. Details, reply shapes and next steps in [`SPIKES.md`](SPIKES.md).

## Spike S2: licence file (P1-07), time-box 2 days
Ed25519 sign/verify offline; expired file shows banner only. Result: _not run yet_.

## Spike S3: SQLite load (P1-02), time-box 3 days
Replay the 50k-user load test against SQLite WAL; record p95 and write rate. Result: _not run yet_.

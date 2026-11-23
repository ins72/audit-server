# Spike results

Time-boxed experiments from [`RISKS.md`](RISKS.md). Each states the question, what was done, the evidence and a go/no-go.

## S1 / P5-01: can the unmodified Stremio core run against our own account API?

**Date:** 2026-11-20. **Status:** first half answered (GO), second half (our own API server) not built yet.

### Question
Decision D1 says own accounts (v2) depend on pointing the Stremio core at our server instead of `api.strem.io`. Is that possible without forking the core?

### What the core is (and is not)
`stremio-core` (Rust, compiled to WASM as `stremio-core-web`) is the **client engine**. It is open source and editable. The **server it talks to (`api.strem.io`) is not open source**, so owning accounts means writing our own server that speaks the same API. Cloning the core does not give us that server.

### Findings from reading `stremio-core` (commit `d3e05c2`)
- The API origin is one constant: `API_URL` in `src/constants.rs` (`https://api.strem.io`). Related hard-coded hosts: `LINK_API_URL` (`https://link.stremio.com`, QR-style login), `USER_LIKES_API_URL`, and a literal `https://api.strem.io/data-export/...` in `src/models/data_export.rs`.
- Rebuilding with another constant is a small source change, but the WASM build needs `wasm-pack`/`wasm-bindgen` pinned at `=0.2.78` (see `stremio-core-web/Cargo.toml`), which is not installed in the build sandbox. Not attempted.
- The API surface the core calls is finite. POST `/api/<name>`: `login`, `loginWithToken`, `authWithFacebook`, `authWithApple`, `register`, `logout`, `deleteUser`, `getUser`, `saveUser`, `addonCollectionGet`, `addonCollectionSet`, `datastoreMeta`, `datastoreGet`, `datastorePut`, `dataExport`, `events`, `seekLog`, `getSkipGaps`, `getModal`, `getGeo`, `configEvents`; plus `GET /config`; and the link API (`create`, `read`).

### Experiment: network interception, no core change
`tools/e2e/capture.js` loads the real production build in Chromium and answers every call to `api.strem.io` with a stub (Playwright route). Result: **the unmodified core signs in, our server verifies the key against the stub, and the app opens** (`docs/screenshots/03-app-after-login-no-paywall.png`). So the core does not care who answers, as long as the replies have the right shape.

Reply shapes that mattered (learned by failing):
- `login` / `register` -> `{"result":{"authKey":"...","user":{...}}}`; the `user` **must include `gdpr_consent {tos, privacy, marketing, from}`**, otherwise the core silently stays on the login screen with no error.
- `datastoreGet` -> `{"result":[]}` (an array). An object makes the core show "UserLibraryMissing".
- `getModal`, `getGeo` -> `{"result":null}` is accepted.

### Verdict
- **GO** for the approach. Two ways to redirect the core in production, in order of effort: (1) a reverse proxy or service worker that maps `api.strem.io` calls to our host (the stub proves the core accepts it; not yet tried from a service worker or a real proxy); (2) rebuild the core with our `API_URL` (needs the pinned wasm toolchain).
- The real work is the **server**: implement the endpoints above with real storage (users, passwords, library, add-on collection). A stub that answers the login flow took an afternoon; a faithful library/addon sync with conflict handling (`lastModified`, datastore meta) is the L-sized part.
- Also needed regardless: replace hard-coded `strem.io` links in the client (P5-03).

### Next steps
1. Promote the stub in `tools/e2e/capture.js` into a small reusable fake-API module and run the E2E in CI (V-09).
2. Try the service-worker redirect in a real browser session (does a Worker created by a controlled page get intercepted?).
3. Decide server stack (SQLite per D7) and write the endpoint contract from the core's request/response types.

## S2: licence file (P1-07), S3: SQLite load (P1-02)
Not run yet.

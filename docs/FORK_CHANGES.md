# What this fork changes in Stremio Web

Base: upstream `Stremio/stremio-web` at commit `991c0de`. Everything below is the complete list of differences, so a future upstream merge only has to reconcile these files.

## Upstream files modified (merge hot-spots)

| File | Change | Why |
|---|---|---|
| `src/router/Routes.tsx` | Calls `useServerSession(profile)` and `useBranding()` (sets the browser tab title from the operator's product name); logged-out users only ever see `/intro` (remembering a deep link in `sessionStorage` to return to after login); renders `ServerSessionGate` until the server verified the user, then `PaywallScreen` when there is no active entitlement. All hooks stay above the early returns. | no guest mode, server-visible login, paywall |
| `src/routes/Player/Player.js` | One added hook call, `useWatchReport(...)`, directly after `useVideo()` (unconditional, so hook order is unchanged), plus its `require`. It only reads player state and sends watch-time reports; playback is untouched. | usage statistics |
| `src/routes/Intro/Intro.js` | Removed the "continue as guest" button and its handler. | no guest mode |
| `src/routes/Settings/{constants.ts,useSettingsPages.ts,Settings.tsx,useSettingsSearch.ts}` | Registered a Subscription page (`PAGES.SUBSCRIPTION`) the same way the other pages are. | plan / sharing UI |
| `http_server.js` | Upstream was a static file server. Now also mounts the session, billing, admin and operator routes, security headers, graceful shutdown, `/healthz`, valid cache headers (upstream sent the malformed `max-age: N`). Static serving and the SPA fallback behave as before. | server-side identity and billing |
| `webpack.config.js` | Dev server proxies `/auth`, `/billing`, `/admin` to the API server (default `http://localhost:8081`). | local development |
| `package.json` | `express` and `stripe` dependencies, `test:server` script. | server |
| `Dockerfile`, `.github/workflows/build.yml`, `.gitignore` | Image runs the server with its two dependencies as a non-root user with a data volume; CI runs server tests; `/data` ignored. | deployment |

## Files added

- Client: `src/router/{useServerSession.ts,useBranding.ts,serverApi.ts,ServerSessionGate/,PaywallScreen/}`, `src/routes/Settings/Subscription/`, `src/routes/Player/useWatchReport.ts`.
- Server and tooling: `server/` (auth, billing, mailer, audit, stats, security, jsonFile, operator panel, load-test tool, tests), `.env.example`, `docs/`.

## What is deliberately unchanged

The Stremio core (WASM) and its login against `api.strem.io`, the player, add-ons, library, streaming server settings, translations and every other route. Users still log in, sign up and out through Stremio's own screens. The fork only observes the resulting `profile.auth` and decides whether to show the app.

## Behaviour differences a user of the original app would notice

1. Opening the app while logged out always shows the login/sign-up screen (no guest browsing).
2. After login there is a short "checking your session" screen while the server verifies the account; a retry/blocked/expired screen replaces the app if that fails.
3. With the paywall on, people without a plan (or invitation) see a subscribe screen instead of the app.
4. Settings has a new Subscription page (plan, devices, shared plan, and a "Download my data" button).
5. Extra periodic network calls: the 2-minute heartbeat to `/auth/me`, and while a video is playing a small watch-time report to `/auth/activity` about once a minute (server can discard it with `WATCH_STATS=false`).
6. Optional device limit, account blocking and shared-plan roles can sign someone out or show a blocked screen.

## Merging upstream

1. `git fetch upstream && git merge upstream/development` (or rebase).
2. Conflicts are most likely in `Routes.tsx`, `Intro.js` and `Player.js` (re-add the one `useWatchReport` call); keep upstream's logic and re-apply the gating block and the guest-button removal described above.
3. Run `pnpm install`, `pnpm build && pnpm lint` and `pnpm run test:server`, then click through login, paywall and Settings → Subscription.

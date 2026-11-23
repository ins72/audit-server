# Our own account service (replaces api.strem.io for people and their data)

**Status:** working, switched on with `OWN_ACCOUNTS=true`. Sign-up, sign-in, sessions, add-on collection and library sync run against this server; the unmodified Stremio core does the talking. Proof: `node tools/e2e/accounts.js` (real browser, nothing stubbed, fails if any request goes to `api.strem.io`).

## What moved to us, what stayed public
| Moved to this server | Stays a public service |
|---|---|
| Email and password, sign-up, sign-in, sign-out, delete account | Cinemeta and every other add-on (they are ordinary add-ons in the user's collection) |
| Sign-in keys (`authKey`) and who they belong to | Images, subtitles, streaming server |
| Profile: avatar, Trakt link, marketing consent | Facebook / Apple sign-in (not offered: the buttons are hidden when `OWN_ACCOUNTS` is on) |
| Library (watch history, saved titles), add-on collection | |

## How it is wired
- `server/accounts.js` answers `POST /api/<name>` in the core's own format: `{ "result": ... }` or `{ "error": { "message", "code" } }`, always HTTP 200. Shapes were read from the core source (`login`/`register` -> `{authKey, user}`; `datastoreMeta/Get/Put` for the `libraryItem` collection; `addonCollectionGet/Set`; the rest are accepted and dropped).
- The browser app is unchanged. Its web worker starts with `?api=own` when the page was rendered with `ownAccounts` (`src/core/redirectApi.js` rewrites `https://api.strem.io/...` to this site's `/api/...`). Everything else the core fetches is untouched.
- The login gate (`server/auth.js`) asks `accounts.lookup(authKey)` in-process instead of calling Stremio (`verifyKey` option). An outage of an outside service can no longer lock paying people out; the remaining outage question is only our own server (X-01).
- Operator erase (`/admin/users/erase`) also deletes the account and its library.
- Account data is `accounts.db` (SQLite), see Storage below.

## Security
- Passwords: scrypt (N=16384) with a random salt; never stored or logged in clear. Constant work whether or not the email exists.
- Sign-in keys: 32 random bytes, only the SHA-256 is stored, at most 20 per person (oldest unused dropped), logout removes the key.
- Login attempts: 8 failures per IP+email per 15 minutes, then "too many attempts".
- Sign-up needs a valid email, 8+ character password and consent to terms and privacy.
- Limits: library 20,000 items, add-ons 200, request body 12 MB.

## Operator settings
- **New sign-ups** `open | closed`.
- **Starting add-ons**: one `manifest.json` address per line, installed for every new account; empty = Cinemeta. Read at the first collection request (cached one hour).

## Storage
SQLite through Node's built-in `node:sqlite` (**Node 22.13 or newer**, no native package to install; it prints an "experimental" notice at start). File: `data/accounts.db` (`ACCOUNTS_FILE`), tables `users`, `keys`, `library` (one row per library item, so a sync writes only what changed), WAL mode, foreign keys so erasing a person removes their keys and library with them. A consistent copy is written once a day next to it (`accounts.db.bak-YYYY-MM-DD`, the newest 7 kept). All access sits in `server/accountsStore.js`; moving to Postgres later means writing that one file against the same tests.

## Password reset
`/account/reset` is a small page in the product's own name (no stock site). Asking for a link always answers the same whether or not the email is registered; it is limited to 3 per email per hour. The link works once for one hour, only its hash is stored, and using it signs the person out on every device. It needs the email settings (`RESEND_API_KEY`, `MAIL_FROM`, `PUBLIC_URL`); without them the page says reset is not set up. The app's "Forgot password?" and Settings > Account links open this page when own accounts are on.

## Operator tools
Person page, "Account on our service": registration date, signed-in devices, library items, add-ons; buttons to send a reset email, sign out their devices on our service and download their data as JSON (profile, add-ons, library; never password or key hashes). Every use is in the audit log. "Erase all data" also deletes the account.

## Account settings page
`/account/manage` replaces the stock account-settings site: the person confirms with email and password, then downloads their data (profile, add-ons, library) or deletes the account. Wrong passwords count against the same limit as sign-in. The app's "Delete account" row and the menu's account link open it.

## Library and Continue Watching
They are the person's `libraryItem` rows: the core pulls what is newer here and pushes what is newer on the device, so watching on one device updates the others. `tools/e2e/accounts.js` puts titles in through the API, reloads, and checks they show under Continue Watching (screenshot 26).

## Calendar feed
Settings > Integrations > Subscribe gives the person a secret address `/calendar/<token>.ics` (replaces the stock site's feed). It lists upcoming episodes (from 3 days ago to 3 months ahead) of the series in their library as all-day events. Episode dates come from Cinemeta (cached 6 hours; if it is down the last copy is used). The token is created on first use, kept in `users.calendar_token`, and the address is not cached by proxies or sent in referrers. Code: `server/calendar.js`.

## Trakt (optional integration)
Trakt is a third-party service people link themselves, so it stays, run by our server (`server/trakt.js`). Setup: create an app at trakt.tv/oauth/applications with the redirect address `PUBLIC_URL/trakt/callback`, then set `TRAKT_CLIENT_ID` and `TRAKT_CLIENT_SECRET`. Without them the Trakt row is hidden and the Overview says "Trakt: off".
- **Connect:** Settings > Integrations > Authenticate asks our server for Trakt's sign-in address (one-time `state`, 10 minutes), Trakt returns to `/trakt/callback`, we keep the tokens. The refresh token never goes to the browser and is refreshed automatically a day before expiry. Disconnect revokes the token at Trakt.
- **Trakt catalogs:** the app installs an add-on from `/trakt/addon/<account id>/manifest.json` (the worker redirect rewrites the stock address). It gives Trakt watchlist, recommended and trending, movies and series, shown on the board.
- **History:** titles a device reports as finished (80% or flagged watched, watched in the last two days) are added to the person's Trakt history with their real watch time (movies, and episodes by season and number); repeats are ignored.
- The app can only disconnect; a pushed profile can never set Trakt tokens.
Also: links the app does not trust now open our own "You are leaving" page (`/warning`) instead of the stock site's, and this site and trakt.tv count as trusted.

## Other stock services now on our server
| Was | Now |
|---|---|
| likes.stremio.com (watched / liked / loved on a title) | `/likes/api/get_status`, `/likes/api/send`, stored per person (`ratings` table), removed with the account |
| api.strem.io/config (announcements, experiments) | `GET /config`: one operator-written announcement, no experiments (`server/announcement.js`) |
| api.strem.io/data-export | `dataExport` gives a 15-minute address `/data-export/<id>/export.json` (profile, add-ons, library, ratings) |
| stremio.com/warning ("you are leaving") | `/warning` |
| stremio.com/download-service | the operator's "Streaming server download link" setting; the Install button is hidden when empty |
| stremio.com terms, privacy, help desk | the operator's own links; with own accounts a link that is not set is left out instead of showing another company's |
| github.com/stremio/stremio-web (source) | the operator's "Source code link" (the licence requires offering the source of this build) |

The worker redirect (`src/core/redirectApi.js`) maps the account API, the Trakt add-on and the ratings service; the core also knows `link.stremio.com` (QR sign-in for TV and phone apps), which this web app never calls.

## Link sign-in (QR) for TV and phone apps
`GET /v2/create` gives `{code, link, qrcode}`; the device shows the QR code, the person opens `/account/link?code=...` on any browser and confirms with email and password, and the device's `GET /v2/read?code=...` then returns `{authKey}` once (it answers error 101 both while waiting and for an unknown or used code, as the real link service does (Alder relies on this)). Codes last 10 minutes; creating is limited to 30 per address; confirming shares the sign-in failure limit. The QR picture comes from our own small encoder (`server/qr.js`, versions 1 to 6, checked against a real decoder). Screenshot 32. The web app's login screen uses it too ("Sign in with QR code", screenshots 34 to 36). A phone that is already signed in on our site can approve with one tap: `POST /account/link` accepts `{code, authKey}` (the phone's own session key) instead of email and password.

## Other apps
See [`SWITCHING_APPS.md`](SWITCHING_APPS.md): address table, a patch for stremio-core, and `node tools/compat/check.js <address>` which tests a server against everything a stock-API app calls.

## Announcements
Operator panel > Settings: Announcement title, text, button, link and last day. The app shows it once as a prompt (people who close it do not see it again until you change the text) and asks for the config at most every 5 minutes. Screenshot 30.

## Family plans and per-profile sync
The account-key endpoints for sharing a plan by email (`billingHousehold`, `billingInvites`, `billingInvite*`, `billingLeave`, `billingCheckout`) and the per-profile / app-settings stores (`profilesGet/Set`, `appSettingsGet/Set`), including the household-shared profile list, are documented in [`HOUSEHOLD_AND_PROFILES.md`](HOUSEHOLD_AND_PROFILES.md).

## Left out on purpose with own accounts
Facebook and Apple sign-in (they need the stock service).

## Not done yet
importing existing Stremio users (they register again; their old library cannot be pulled without their stock password), Postgres for several servers. Overview shows an "Account service" check and a "Password reset emails" check.

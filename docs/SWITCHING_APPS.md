# Pointing other apps at our server

Goal: an app built for the Stremio API keeps working when only the address changes. This page says what that takes, what is verified, and what is not.

## The addresses
Our server answers everything under one host. Replace the stock address with your own (`https://YOUR-HOST`):

| Stock address | Replace with | What it is |
|---|---|---|
| `https://api.strem.io/api/<name>` | `https://YOUR-HOST/api/<name>` | accounts, sign-in, library, add-on collection, profile |
| `https://api.strem.io/config` | `https://YOUR-HOST/config` | announcements (we send the operator's one announcement, no experiments) |
| `https://api.strem.io/data-export/<id>/export.json` | `https://YOUR-HOST/data-export/<id>/export.json` | "export my data" download |
| `https://link.stremio.com/api/v2/create`, `/api/v2/read` | `https://YOUR-HOST/api/v2/create`, `/api/v2/read` (also answered at `/v2/…`) | sign in a TV or phone by QR code |
| `https://likes.stremio.com/api/get_status`, `/api/send` | `https://YOUR-HOST/likes/api/get_status`, `/likes/api/send` | watched / liked / loved on a title |
| `https://www.strem.io/trakt/addon/<id>/manifest.json` | `https://YOUR-HOST/trakt/addon/<id>/manifest.json` | Trakt add-on (needs a Trakt app, see ACCOUNTS_API.md) |

Everything else those apps call (Cinemeta, other add-ons, images, subtitles, the streaming server) is untouched.
The API allows calls from any web address (CORS) and keeps the sign-in key in the request body, never in a cookie.

## Apps built from stremio-core (Rust)
All five addresses are constants in the core. `docs/patches/stremio-core-own-server.patch` changes them (replace `YOUR-HOST` first). It touches three files and applies cleanly to the core commit this project was built against (d3e05c2):
```
sed -i 's/YOUR-HOST/tv.example.com/g' stremio-core-own-server.patch
git apply stremio-core-own-server.patch
```
Rebuild the app against the patched core. For the web app in this repository nothing needs patching: a small worker preamble (`src/core/redirectApi.js`) redirects the same five addresses, switched on by `OWN_ACCOUNTS=true`.

## Apps with a configurable server address
Some community clients and add-ons let you set the API address (or read it from a config file). Set it to `https://YOUR-HOST`; the link and ratings services live on the same host under `/v2` (and also `/api/v2`, for apps whose link address is `<api address>/v2/`) and `/likes`.

## Apps that hardcode the address
Official store apps (Android, iOS, TV) are built with the stock address and cannot be re-pointed without a rebuild. That means a fork of the app built on the patched core.

## Cinemeta and other add-ons: do they need the account API?
No. Checked two ways: the add-on protocol (plain `GET <add-on>/<resource>/<type>/<id>.json` with CORS, no account, token or Stremio address anywhere) and the core itself, whose only built-in Stremio-run add-ons (Cinemeta, Cinemeta catalogs, OpenSubtitles, WatchHub, Channels, a public-domain catalog) are ordinary add-on addresses. They stay as they are. Where the account service does touch add-ons, we do the same:
- the **add-on collection** (`addonCollectionGet/Set`): stored per account, new accounts get the operator's starting add-ons (never an empty list, see PROGRESS);
- **manifest refresh**: with `update:true` the stock service refreshes installed add-ons (new version, new catalogs); we now do too, read from public hosts only (no private/loopback addresses, no redirects, one shared copy per address for an hour), a manifest with a different id is refused, official/protected entries are skipped (inferred from the stock behaviour, not confirmed);
- the **Trakt add-on** and **ratings**: served by us (see the address table).

## Worked example: Alder (Android TV client, open source)
Alder (github.com/aradhyas8/Alder, GPL-3.0) talks to the account service only through `Stremio.kt`, with two constants: `API = "https://api.strem.io/api/"` and `LINK = "https://link.stremio.com/api/v2/"`. It uses: link `create`/`read`, `addonCollectionGet/Set`, `datastoreGet/Put` (library, with `ids` or `all`), `getUser`, `logout`. Everything else (catalogs, streams, subtitles) goes to add-ons, which are not affected.

**Result: changing the two constants is enough, once the server matches the real service on two details Alder relies on** (both found by replaying its calls with `tools/thirdparty/alder.js`, 14 steps, now all passing):
1. link `read` answers error **101** while the code is waiting (Alder polls on 101); we had 111.
2. a signed-out key answers error **1** (Alder's `NO_SESSION`); we had 3.
Also needed: our server answers the link calls under `/api/v2/` as well. Practically: in `Stremio.kt` set `API = "https://YOUR-HOST/api/"` and `LINK = "https://YOUR-HOST/api/v2/"` (Alder's `ProfilesActivity` also shows the text "link.stremio.com" in a string, which should become YOUR-HOST). One rebuild, no code change. Not done: building the Android app and running it on a TV (no Android SDK here), so UI behaviour is not verified, only every request and reply it depends on. With no default add-ons set in the operator panel a new account has an empty add-on list, so set defaults first.

Re-run: `node tools/thirdparty/alder.js https://YOUR-HOST`.

## Check before you switch
```
node tools/compat/check.js https://YOUR-HOST
```
signs up a throw-away account, uses every call above, and deletes the account again (22 checks; the same list runs in the test suite and in `tools/e2e/accounts.js`, screenshot `31-stock-api-compatibility.png`). Open sign-ups are needed for it to run.

## What is verified and what is not
- Verified: the unmodified web app (real browser, nothing stubbed); request and reply shapes taken from the core source; the checker above.
- Inferred, not seen against the real service: the exact error codes and texts for wrong password, unknown user and so on (shape `{error:{message,code}}` is exact, the numbers are ours; apps that branch on a specific stock code may behave differently), the link service's reply while waiting (we answer an error with code 111) and its `qrcode` field (we send a `data:image/svg+xml` picture of the link), and the other apps' own extra calls that the core does not make.
- Not carried over: people's existing Stremio accounts and libraries. They register again on our server; their old data cannot be read without their stock password.

When you point a real app at the server, run the checker, then sign in and watch the audit log and server output for routes it asks for that we do not have (an unknown route answers `{error:{code:108}}` and is easy to spot). Add what is missing to `server/accounts.js` handlers.

For a step-by-step description of the QR sign-in and every call, see `APP_INTEGRATION.md`.

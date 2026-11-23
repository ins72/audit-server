# How other apps (like Alder) use our accounts, API and QR sign-in

For app developers and for the operator who wants an existing app to work with this server. The short version: **the app keeps working as it is, and you change its server address.** The example throughout is Alder, an open-source Android TV client (github.com/aradhyas8/Alder), tested by replaying its exact calls (`tools/thirdparty/alder.js`).

```
 TV app (Alder)                   our server (https://YOUR-HOST)                  phone / browser
 ─────────────                    ───────────────────────────────                 ───────────────
 GET  /api/v2/create  ───────────► code + link + QR image
 shows QR + code ◄────────────────
 polls GET /api/v2/read?code ────► error 101 "waiting"  (every 2-3 s, max 10 min)
                                                                   scan QR ───────► GET /account/link?code=…
                                                                   one tap if signed in here,
                                                                   else email + password ──► POST /account/link
 polls GET /api/v2/read?code ────► {result:{authKey}}   (once)
 POST /api/addonCollectionGet ───► the account's add-ons
 POST /api/datastoreGet/Put ─────► library and watch progress
 POST /api/logout ───────────────► key ends
```

Everything else the app does (catalogs, details, streams, subtitles) goes to add-ons such as Cinemeta directly. Those are open services and never touch our API.

## 1. What the app has to change

Only the two address constants (Alder: `Stremio.kt`):

| In the app | Stock value | Set to |
|---|---|---|
| account API base | `https://api.strem.io/api/` | `https://YOUR-HOST/api/` |
| link (QR) base | `https://link.stremio.com/api/v2/` | `https://YOUR-HOST/api/v2/` |

Apps that keep a different layout can also use `https://YOUR-HOST/v2/…` for link and `https://YOUR-HOST/likes/api/…` or `https://YOUR-HOST/api/get_status|send` for ratings. Any text shown to people that names the old link address (Alder shows "link.stremio.com" under the QR) should show `YOUR-HOST` instead. Rebuild; there is no other code change. Apps built on stremio-core can use `docs/patches/stremio-core-own-server.patch`.

## 2. Rules every call follows

- All account calls are `POST https://YOUR-HOST/api/<name>` with a JSON body. The body may also repeat the name as `"type": "<Name>"`. Content type does not matter (JSON labelled as a form is still read as JSON).
- **The answer is always HTTP 200** with either `{"result": …}` or `{"error": {"message": "…", "code": N}}`. Never rely on the HTTP status.
- The sign-in key (`authKey`) travels **in the body**, never in a cookie or header. CORS is open, so web clients on other addresses can call too.
- Treat `error.code 1` as "this sign-in no longer exists": sign the person out locally (Alder: `NO_SESSION`).

| Code | Meaning |
|---|---|
| 1 | No such session (sign in again), or no such user on login |
| 2 | Wrong password |
| 101 | Invalid email; on link `read`: **still waiting, or code unknown/expired/used** |
| 102 | Password too short |
| 103 | Terms and privacy not accepted (register) |
| 104 | Email already registered |
| 105 | New registrations are closed by the operator |
| 106 | Too many attempts, wait a few minutes |
| 107 | Sign-in method not available here (Facebook/Apple) |
| 108 | Unknown route or unreadable request |
| 109 | Too much data |
| 110 | Server could not save, try again |

Codes 1 and 101 follow the stock service (Alder relies on them); the others are ours and partly inferred from the stock service; apps should only depend on 1 and 101.

## 3. QR / code sign-in step by step

**Device creates a code.** `GET /api/v2/create?type=Create`
```json
{"result": {"code": "T9NE2C", "link": "https://tv.example.com/account/link?code=T9NE2C", "qrcode": "data:image/svg+xml;base64,PHN2Zy…"}}
```
Show `qrcode` (an SVG data address; or draw your own QR from `link`) and the `code`, plus the host from `link`. The link is built from `PUBLIC_URL` (or the forwarded host behind a proxy), so it always names your server. At most 30 codes per address in 10 minutes.

**Device waits.** `GET /api/v2/read?type=Read&code=T9NE2C` every 2 to 3 seconds:
```json
{"error": {"message": "Waiting for the sign-in to be confirmed", "code": 101}}
```
Stop after 10 minutes (the code expires; offer "new code"). Code 101 means both "not yet" and "unknown or expired", exactly as the stock service does.

**Phone approves.** The person scans the QR (or types the address and code). The page `/account/link`:
- if the phone is already signed in to this site, shows the account and **one button** (no email or password), with "Use another account" underneath;
- otherwise asks for email and password (shares the sign-in attempt limit).

**Device collects the key.** The next `read`:
```json
{"result": {"authKey": "4Uz88gzS…"}}
```
Returned once; the device gets **its own key** (separate from the phone's), so signing out on the TV does not sign out the phone. Keep it in private app storage. A person has at most 20 keys; the oldest is dropped.

The web app's own login screen uses the same service ("Sign in with QR code").

## 4. Calls an app like Alder makes

`authKey` below is the key from step 3 (or from `login`).

| Call | Body | Result |
|---|---|---|
| `login` | `{"type":"Login","email","password"}` | `{authKey, user}` |
| `register` | `{"type":"Register","email","password","gdpr_consent":{"tos":true,"privacy":true,"marketing":false,"from":"tv"}}` | `{authKey, user}` (sign-ups may be closed by the operator) |
| `getUser` | `{"type":"GetUser","authKey"}` | the user: `_id` (use it to tell accounts apart: two keys can be the same account), `email`, `trakt`, `premium_expire`, … |
| `logout` | `{"type":"Logout","authKey"}` | `{success:true}`; the key stops working |
| `addonCollectionGet` | `{"type":"AddonCollectionGet","authKey","update":true}` | `{addons:[{manifest, transportUrl, flags}], lastModified}`; new accounts get the operator's starting add-ons; `update:true` refreshes installed add-ons' manifests |
| `addonCollectionSet` | `{"type":"AddonCollectionSet","authKey","addons":[…]}` | `{success:true}`; replaces the list and its order |
| `datastoreGet` | `{"authKey","collection":"libraryItem","ids":[],"all":true}` (or `ids:[…],"all":false`) | the library items (unknown ids are simply absent) |
| `datastorePut` | `{"authKey","collection":"libraryItem","changes":[item,…]}` | `{success:true}` |
| `datastoreMeta` | `{"authKey","collection":"libraryItem"}` | `[[id, modified], …]` for cheap syncing (stremio-core uses it) |

Example, watch progress for one title (what Alder sends when the player closes):
```json
{"authKey":"…","collection":"libraryItem","changes":[{"_id":"tt0111161","name":"Example","type":"movie","poster":null,"posterShape":"poster","removed":false,"temp":false,"_ctime":"2026-11-22T00:00:00.000Z","_mtime":"2026-11-22T00:00:00.000Z","state":{"timeOffset":600000,"duration":7200000,"lastWatched":"2026-11-22T00:00:00.000Z"},"behaviorHints":{}}]}
```
**Merge rule:** the item with the newest `_mtime` wins, per id. Always set `_mtime` to the current time when you change an item, and compare `_mtime` / `state.lastWatched` before overwriting something newer from another device (Alder keeps its own pending copy for a few seconds for this reason).

Other routes stremio-core apps use and we answer: `loginWithToken`, `saveUser`, `deleteUser`, `events`, `seekLog`, `configEvents`, `getSkipGaps`, `getModal`, `getGeo`, `dataExport`, `calendarToken`, `traktAuthUrl`, and `GET /config` (the operator's announcement). The full list with shapes is in `docs/ACCOUNTS_API.md`.

## 5. Check before you ship

1. Start your server (`docs/INSTALL.md`), set the starting add-ons in the operator panel (otherwise new accounts have only Cinemeta).
2. `node tools/compat/check.js https://YOUR-HOST` checks every call of the stock protocol (20 checks, signs up a throw-away account and removes it).
3. `node tools/thirdparty/alder.js https://YOUR-HOST` replays Alder's calls (14 steps). Copy it as a starting point for other apps: it is one short file.
4. Test the real thing: on the TV open the QR screen, scan it with a phone that is signed in and with one that is not, check the TV lands on its home screen with the right account and the add-ons you expect.

## 6. What is and is not proven

- Proven (automated): every request and reply Alder depends on; the QR address names only our server; one-tap and password approval; the web app's QR login in a real browser (screenshots 34 to 36); stock-shaped errors for odd requests.
- Not proven: Alder itself built and running on a TV (no Android SDK in our test environment); a real phone camera scanning the code; behaviour of other apps. The stock service's exact error codes other than 1 and 101 are inferred.
- Apps that need things we do not offer: Facebook/Apple sign-in (answers 107), premium features of the original service (`premium_expire` is always `null` here; paid access is our own paywall).

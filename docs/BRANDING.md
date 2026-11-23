# Removing the Stremio branding

Goal: an operator can sell the app under their own name without rebuilding the client. Everything below is set in the operator panel (Settings page) and applies on the next page load.

## What the operator controls
| What | Where it shows | How |
|---|---|---|
| Product name | Browser tab, installed-app name (web manifest), every "Stremio" in all 51 languages, paywall heading, email signature | Settings, Product name |
| Tagline | Tab title suffix, manifest description, paywall | Settings, Tagline |
| Login headline and subtitle | The big lines on the login screen | Settings, Login headline and Login subtitle |
| Logo (wide) | Login screen | Settings, Logo and icons |
| Symbol (square) | Top bar, loading and buffering screens | Settings, Logo and icons |
| App icon (square) | Home-screen icon, tab icon, install icons | Settings, Logo and icons |
| Terms and Privacy links, support email | Paywall; blocked screen | Settings |

Nothing set means the stock Stremio look, so existing installs do not change.

## How it works (no client rebuild)
- `server/brand.js` rewrites `index.html` (title, the config the page reads at start as `window.__BRAND__`) and `manifest.json` on the way out, and answers the stock image addresses (`/images/logo.png`, `/images/stremio_symbol.png`, `/images/icon*.png`, `/images/maskable_icon*.png`, `/favicons/favicon.ico`) with the uploaded PNG when there is one.
- `src/common/rebrand.js` runs once at start over every translation: it renames the bare word "Stremio" (not addresses, e-mails, file names or compound words like `stremio-core`) and lets the operator's own login wording win over the translation in every language.
- `src/router/useBranding.ts` reads the same config for our own screens, so there is no flash of the old name.
- Uploads live in `data/brand/` (`BRAND_DIR`), are PNG only (checked by header, 1 MB, size rules per slot) and are audited.

## What is still Stremio (and why)
| Item | Status |
|---|---|
| Sign-in, sign-up, password reset, Facebook and Apple login, Trakt, calendar feed | Run on Stremio's account service and website (`www.strem.io`). Being replaced by our own account service: see `ACCOUNTS_API.md`. |
| Help page links, "About" page, store badges | Stremio's pages. Need operator-set links or removal. Open: task P1-22 |
| Chromecast channel `urn:x-cast:com.stremio`, `stremio://` links | Technical identifiers that other Stremio software expects; not visible to people. Left alone. |
| Source code and licence | GPL-2.0. The `LICENSE.md`, copyright notices and the right to the source stay. Legal review of names and marks is parked (D20). |
| Default content (Cinemeta catalogues, public add-ons) | Public services, kept on purpose. |

## Check it yourself
`node tools/branding/audit.js` lists every remaining reference to Stremio hosts and visible text in the client.

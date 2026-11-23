# Household plans and per-profile sync

**Status:** working. Two account-side stores the client uses to keep a family's settings and profiles in step across devices (`appSettingsGet/Set`, `profilesGet/Set`), and a family-plan sharing API for account-key clients (`billingCheckout`, `billingHousehold`, `billingInvites`, `billingInvite*`, `billingLeave`).

These routes answer the same way as the rest of the account API: `POST /api/<name>` with the signed-in `authKey` in the JSON body, always HTTP 200, reply `{ "result": ... }` or `{ "error": { "message", "code" } }`. The browser (cookie) flow and the app (account-key) flow share one implementation; this page documents the account-key endpoints the Alder Android app calls.

Related pages: [`ACCOUNTS_API.md`](ACCOUNTS_API.md) (accounts, library, add-on collection), [`APP_INTEGRATION.md`](APP_INTEGRATION.md) (how Alder uses this server step by step), and the Alder repo's `docs/HOUSEHOLD_AND_PROFILE_SYNC.md` (the client half).

## Why this exists

- A family plan has **one paying owner** and up to N **seats**. Seats are invited by email; a member who accepts becomes a `member`, and the owner may promote members to `manager` (managers can invite/remove but cannot change roles or hand over ownership).
- A device keeps a **profile list** (each profile is its own Stremio-style account with its own key) and an **active profile**. Without a shared store, every device would keep its own list and the family would have to re-enter every profile on every device.
- The shared list is stored **under the household owner's account**, so any member's device reads and writes the same rows. The *merge* is done client-side by modification time (`mod`) so simultaneous edits on two devices do not clobber each other; the server only has to store the whole list atomically.

## Storage

Both new stores live in `data/accounts.db` (SQLite via `node:sqlite`), in `server/accountsStore.js` (`users.app_settings`, `users.profiles` columns; added by migration). `server/accounts.js` reads and writes them through `db.saveUser`, so a person's settings and profile list are erased together with the account (`/admin/users/erase`).

## Per-profile sync (`profilesGet`, `profilesSet`)

`POST /api/profilesGet` — `{ authKey }`

Returns the stored list and which profile is active:

```json
{ "result": { "list": [ ... ], "active": "1", "rev": 1732300000000 } }
```

`POST /api/profilesSet` — `{ authKey, list, active }`

Stores the whole list (validated and bounded) and returns the new revision:

```json
{ "result": { "success": true, "rev": 1732300000123 } }
```

Each entry in `list`:

| Field | Type | Notes |
|---|---|---|
| `id` | string | required, sliced to 24 chars; duplicate ids collapse (first wins) |
| `authKey` / `credential` | string | required for a **live** profile, sliced to 512 chars |
| `deleted` | bool | a **tombstone**: carries only `id` (+ `mod`), no key; lets a delete on one device reach the others |
| `mod` | number | modification time used by the client's merge (higher `mod` wins; equal `mod` → live beats tombstone) |
| `name` | string | optional, sliced to 60 chars |
| `color` | int32 | optional |
| `pin` | string | optional, sliced to 8 chars |

Rules:

- `list` must be an array of at most **16** entries, of which at most **8** may be live (not deleted).
- The whole payload must fit `MAX_SETTINGS_BYTES` (16 KB).
- A live entry with no key is dropped; a tombstone with no key is kept.
- `active` must name a live id; otherwise it falls back to the first live profile (or `null`).

### App settings (`appSettingsGet`, `appSettingsSet`)

`POST /api/appSettingsGet` — `{ authKey }` → `{ result: { settings, lastModified } }`. Empty `{}` until first save.

`POST /api/appSettingsSet` — `{ authKey, settings }` → `{ result: { success: true } }`. Replaces the whole map (up to 200 keys, 16 KB, keys must be plain identifiers). The client keeps things like `maxHeight`, `dubbed`, `audioLang`, `subLang`, `subPref`, `uiScale` here so they follow the person between devices.

## Household-shared store (the important part)

Whether a caller's profile list is stored **per account** or **shared with the household** is decided at read/write time:

- `server/billing.js` exposes `householdOwnerId(user)`:
  - no gating (no plans / `PAYWALL_ENABLED=false`) → the caller's own id (per-account list);
  - an active **owner** → the caller's own id;
  - a **member** → the owner's id of the plan they joined;
  - otherwise → `null` (caller keeps its own list).
- `server/accounts.js` exposes `setHouseholdResolver(fn)` (defaults to `() => null`) and a `profileStoreUser(user)` helper. `profilesGet`/`profilesSet` resolve the **owner's** user record through it, so every member's device reads and writes the same `profiles` row.
- `http_server.js` wires them together at start-up:

  ```js
  accounts.setHouseholdResolver((user) => billing.householdOwnerId(user));
  ```

  When billing is absent the resolver is cleared, keeping per-account lists. Changing this wiring does not touch the route shapes.

Consequence: a profile added on the owner's TV appears on a member's phone, and vice versa; the client merge (`ProfileSync` in Alder) keeps edits from different devices from overwriting each other.

## Family-plan endpoints

All require a valid `authKey` (unknown key → `{ error: { message: 'Session expired', code: 1 } }`). The signed-in account is the owner or a member of a shared plan; the rules are identical to the cookie routes — only an active owner or a member-manager may invite/remove/resend, only the owner may change roles or transfer.

### `billingCheckout` — `{ authKey, planId? }`

Creates a Stripe Checkout Session for the account and returns its URL, so the app hands the browser straight to payment (the `authKey` never enters a URL; payment is linked to the account by `client_reference_id`). Reply `{ result: { url } }` or `{ result: { error } }`.

### `billingHousehold` — `{ authKey }`

The group view the app renders (owner, member, or nothing). Reply shapes:

Owner (active):

```json
{ "result": {
  "role": "owner", "active": true, "paywall": true, "plan": "family",
  "canManage": true, "canManageBilling": true,
  "seats": 3, "used": 2, "inviteeSeats": 2, "invitees": 1,
  "emailEnabled": true, "confirmationRequired": false, "expiryDays": 7,
  "owner": { "name": "...", "email": "..." },
  "members": [ { "email": "...", "name": null, "color": null, "role": "member", "joined": false, "expired": false, "confirmed": null } ]
} }
```

Member (active):

```json
{ "result": {
  "role": "member", "active": true, "paywall": true, "plan": "family",
  "sharedBy": "...", "memberRole": "manager",
  "canManage": true, "canManageBilling": false,
  "seats": 3, "used": 2, "inviteeSeats": 2, "invitees": 1,
  "emailEnabled": true, "confirmationRequired": false,
  "members": [ ... ]
} }
```

No active plan: `{ result: { role, active: false, paywall, plan, canManage: false, canManageBilling: false } }`.

`seats` and `used` include the owner, so "2 of 3 seats" counts the person who pays. `members` is the pending+joined invite list (keyed by email); `joined` is true once the invitee accepted, `expired` once the invite aged out, `confirmed` is non-null only when email confirmation is required.

### Invite endpoints

| Route | Body | Reply (`result`) | Error (string `error`) |
|---|---|---|---|
| `billingInvites` | `{ authKey }` | `{ ok, max, invites, emailEnabled, confirmationRequired }` | `managers_only` |
| `billingInviteCreate` | `{ authKey, email, role?, name?, color? }` | invite view + `notified` | `invalid_email`, `cannot_invite_self`, `already_invited`, `seat_limit_reached` (+`max`), `managers_only`, `storage_unavailable` |
| `billingInviteRemove` | `{ authKey, email }` | invite view | `not_invited`, `owners_only` (removing a manager as non-owner), `managers_only` |
| `billingInviteRole` | `{ authKey, email, role }` | invite view | `invalid_role`, `not_invited`, `owners_only`, `managers_only` |
| `billingInviteUpdate` | `{ authKey, email, name?, color? }` | invite view | `not_invited`, `managers_only` |
| `billingInviteResend` | `{ authKey, email }` | invite view + `notified` | `not_invited`, `already_joined`, `email_disabled`, `email_limit_reached`, `managers_only` |
| `billingInviteTransfer` | `{ authKey, email }` | `{ ok: true }` | `not_invited`, `not_joined`, `target_has_plan`, `target_has_invites`, `owners_only` |
| `billingLeave` | `{ authKey }` | `{ ok: true }` | `not_a_member` |

Rules worth knowing:

- Only the **owner** may set `role: "manager"` on create, change roles, or transfer; a member-manager inviting gets `role: "member"` regardless of the request.
- The owner and the plan owner cannot be invited (`cannot_invite_self`); a duplicate email is `already_invited` (no second seat consumed).
- Seats are the plan's invitee seats (`max`); when full, `seat_limit_reached` with the `max`.
- `billingInviteTransfer` hands the plan to a member **who has joined**, the old owner stays on as a manager, and the Stripe subscription metadata (`userId`) is updated to follow. It refuses if the target already has a live plan or invites.
- `billingInviteResend` renews the expiry and replaces the confirmation link; it refuses once the invitee has joined.
- Email sending honours the same operator email settings and per-owner send limit as the cookie flow; `notified` reports whether mail actually went out.

## Error codes

| Code | Meaning |
|---|---|
| `1` | `invalid_key` / session expired (HTTP-layer and account-layer `invalid_key`) |
| `108` | `too_large` (settings/profile payload too big or too many keys) |
| `109` | `too_large` (too many profiles) |
| string | the per-route `error` values in the table above (billing) |

## Tests

- `server/accounts.check.js` — app settings round-trip and overwrite, profile save/get, id/key validation, too-many refusal, **mod + tombstone round-trip**, and the **household-shared list** (owner and member see the same profiles; `setHouseholdResolver` stand-in).
- `server/billing-link.check.js` — `billingHousehold` (owner view, seats), invite create/remove/role/promote/demote, resend rules, transfer (owner-only, joined-only), leave; unknown key refused at the door.
- `server/billing.check.js` — the shared invite/manager/transfer logic the account endpoints call.

Run them with `node --test server/*.check.js` (150 pass).

## File map

| File | What it holds |
|---|---|
| `server/accounts.js` | `profilesGet/Set`, `appSettingsGet/Set`, `profileStoreUser`, `setHouseholdResolver` |
| `server/accountsStore.js` | `users.app_settings` / `users.profiles` columns and migration; `saveUser` |
| `server/billing.js` | `householdOwnerId`, `householdFor`, `accountInvite*` (create/remove/role/update/resend/transfer), `accountLeave` |
| `http_server.js` | wires `accounts.setHouseholdResolver((u) => billing.householdOwnerId(u))`; the `/api/billingCheckout`, `/api/billingHousehold`, `/api/billingInvites`, `/api/billingInvite*`, `/api/billingLeave` routes |
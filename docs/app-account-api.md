# Account API for the scanner app

The Overpriced Cardboard Scanner no longer uses licence keys. A customer has an **account** on
overpricedcardboard.com (login by e-mail link, no password) and a **subscription** sold by
Antalyse GmbH. The app is connected to the account by **scanning a QR code** from the web portal;
there is no login in the app.

This document is the contract between the shop (server) and the app. Part 1 is the API, part 2
the requirements for the app, part 3 the usage API for the video pipeline.

| Environment | Base URL                                  | Stripe    |
| ----------- | ----------------------------------------- | --------- |
| Production  | `https://overpricedcardboard.com`         | live      |
| Staging     | `https://staging.overpricedcardboard.com` | test mode |
| Local       | `http://localhost:3000` (debug builds)    | stand-in  |

All app endpoints are under `/api/app/v1`. Bodies are JSON (`Content-Type: application/json`),
times are ISO 8601 in UTC (`2026-11-15T09:30:00.000Z`), money is integer cents in EUR.

## Plans and features

| Plan          | Price incl. VAT | Extra device | Features                                                                       |
| ------------- | --------------- | ------------ | ------------------------------------------------------------------------------ |
| **Collector** | € 7 / month     | € 4 / month  | Scanner, Trading mode, web portal (collection, prices, missing cards, sharing) |
| **Creator**   | € 12 / month    | € 7 / month  | Everything in Collector + YouTube mode with recording                          |

Each subscription includes **one device**; extra devices are added in the portal. On request
(switched on by the shop per customer, billed by usage):

- **S3 storage** for recordings (per GB uploaded) – Creator only
- **Automatic Content Processing** (video pipeline, per video minute) – Creator only
- **Webshop as a Service**: Webshop mode appears once a webshop is connected to the account

The server decides what is unlocked; the app only reads `features` (below) and never derives
features from the plan name.

---

# Part 1: API

## Authentication

Pairing returns a **device token** (43 characters, base64url). Every other call sends it:

```http
Authorization: Bearer 9fJ2kQ…
```

Every call may also send `X-App-Version: 1.3.4`; the portal shows it with the device.

The server stores only a hash of the token. A token stays valid until the device is removed in
the portal, transferred to another device, paired to another account, or disconnected by the app.
It does **not** expire with the subscription: when the subscription ends the token keeps working
and `status` says `inactive`, so renewing in the portal unlocks the app again without a new QR code.

## Errors

```json
{ "error": "device_limit", "message": "All 2 devices of this subscription are in use." }
```

| Status | `error`                      | Meaning                                                                               |
| ------ | ---------------------------- | ------------------------------------------------------------------------------------- |
| 400    | `invalid_request`            | Body or query wrong; `fields` names them: `{ "fields": { "quantity": "too_large" } }` |
| 400    | `invalid_code`               | Not a pairing code (format)                                                           |
| 401    | `invalid_token`              | Token missing or unknown                                                              |
| 401    | `unpaired`                   | This device was disconnected; see `reason` (below)                                    |
| 402    | `subscription_required`      | The account has no active subscription (pairing, collection, missing cards)           |
| 403    | `feature_not_included`       | The plan does not include this (e.g. S3 settings without the service)                 |
| 404    | `unknown_code` / `not_found` | Pairing code or item does not exist                                                   |
| 409    | `device_limit`               | All devices of the subscription are in use (pairing)                                  |
| 410    | `code_expired`               | Pairing code expired or already used                                                  |
| 429    | `rate_limited`               | Too many calls; `Retry-After` header in seconds                                       |
| 5xx    | `internal`                   | Retry later with backoff                                                              |

`unpaired` carries why, so the app can say what happened:

```json
{
  "error": "unpaired",
  "reason": "transferred",
  "since": "2026-11-15T09:30:00.000Z",
  "device_name": "Pixel 9",
  "message": "This device was replaced by Pixel 9."
}
```

`reason` is one of `removed` (removed in the portal), `transferred` (another device scanned this
device's transfer code; `device_name` is the new one), `replaced` (paired to another account, or
paired again on the same account with a new token), `disconnected` (the app disconnected itself),
`account_deleted`.

## Pairing

### The QR code

The portal (Account › Devices › **Connect a device**) shows a QR code that holds a URL:

```
https://overpricedcardboard.com/pair/K7Q2-9MZ4-D01A
```

- The code is 12 characters of Crockford base32 (`0-9`, `A-Z` without I, L, O, U), shown and
  encoded in groups of four. When typed, case, spaces and dashes do not matter; O counts as 0,
  I and L as 1.
- It is valid for **10 minutes** and can be used **once**.
- The host tells the app which server to talk to. The app accepts only
  `overpricedcardboard.com`, `staging.overpricedcardboard.com` and, in debug builds, `localhost`
  / `10.0.2.2` with port. Codes typed by hand go to the build's default server.
- Opened in a phone's normal camera, the URL shows a page that says to scan it in the app.

The QR code is shown only while a device slot is free. If all slots are in use the portal says so
and offers to remove a device or add one.

### `POST /api/app/v1/pair`

```json
{
  "code": "K7Q2-9MZ4-D01A",
  "device_id": "5b0c1d8e-2f4a-4c55-9a11-7f0d3c2b9e61",
  "device_name": "Google Pixel 8",
  "platform": "android",
  "app_version": "1.3.4"
}
```

| Field         | Rules                                                                     |
| ------------- | ------------------------------------------------------------------------- |
| `code`        | required; the code from the QR URL or typed                               |
| `device_id`   | required; a random UUID the app creates once and keeps (survives updates) |
| `device_name` | optional, ≤ 80 characters; the phone model, shown in the portal           |
| `platform`    | `android` (others later)                                                  |
| `app_version` | optional, ≤ 40 characters                                                 |

`201 Created`:

```json
{
  "token": "9fJ2kQ…",
  "device": {
    "id": "dev_3k9x0q7m2a",
    "name": "Google Pixel 8",
    "paired_at": "2026-11-15T09:30:00.000Z"
  },
  "status": { "…": "the same object as GET /status" }
}
```

- Pairing the same `device_id` again on the same account gives it a new token in the same slot
  (the old token then answers `unpaired` / `replaced`).
- Pairing a `device_id` that belongs to another account moves it: it leaves the other account.
- Errors: `invalid_code`, `unknown_code`, `code_expired`, `device_limit` (with `"seats": 2`),
  `subscription_required`, `rate_limited` (10 attempts per address and 15 minutes; other
  calls: 600 per address and 15 minutes).

### `POST /api/app/v1/transfer` – switch to a new phone

For a phone change without the computer: the old device shows a QR code, the new one scans it.

`201 Created`:

```json
{
  "code": "Q2M8-4KD1-0ZXA",
  "url": "https://overpricedcardboard.com/pair/Q2M8-4KD1-0ZXA",
  "expires_at": "2026-11-15T09:40:00.000Z"
}
```

The app renders `url` as a QR code. When another device pairs with this code it takes over this
device's slot (no free slot needed); this device then gets `unpaired` / `transferred` with the new
device's name. A transfer code works even when the subscription has ended (the new device then
sees `inactive` like the old one did).

### `DELETE /api/app/v1/device` – disconnect this device

`204 No Content`. Frees the slot; the token stops working (`unpaired` / `disconnected`).

## Status

### `GET /api/app/v1/status`

Call it at every start and at most once an hour while the app is in use (more often only after the
user taps something like "Check again"). It is cheap; offline the app keeps working until
`valid_until`.

```json
{
  "status": "active",
  "server_time": "2026-11-15T09:30:00.000Z",
  "valid_until": "2026-12-18T09:30:00.000Z",
  "account": { "id": "acc_7h2k9q0x3m", "email": "anna@example.com", "name": "Anna" },
  "device": {
    "id": "dev_3k9x0q7m2a",
    "name": "Google Pixel 8",
    "paired_at": "2026-11-15T09:30:00.000Z"
  },
  "subscription": {
    "plan": "creator",
    "state": "active",
    "renews_at": "2026-12-15T09:30:00.000Z",
    "ends_at": null,
    "devices": { "included": 1, "extra": 1, "in_use": 2 }
  },
  "features": {
    "scanner": true,
    "trading": true,
    "youtube": true,
    "recording": true,
    "s3_upload": false,
    "pipeline": false,
    "webshop": false,
    "collection": true,
    "wanted": true
  },
  "webshop": null,
  "services": {
    "s3": { "enabled": false },
    "pipeline": { "enabled": false }
  },
  "portal_url": "https://overpricedcardboard.com/account"
}
```

| Field                    | Meaning                                                                                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                 | `active`: features as listed. `inactive`: no running subscription; every feature is `false`                                                                                                                                              |
| `valid_until`            | Until when the app may run on this answer without asking again (offline). After it, the app needs one successful check; without a connection it shows "Connect to the internet once to check your subscription" and locks the paid modes |
| `subscription.plan`      | `collector`, `creator` or `null`                                                                                                                                                                                                         |
| `subscription.state`     | `active`, `past_due` (payment failed, Stripe retries; features stay on), `canceled` (ends at `ends_at`, features stay on until then), `ended`, `complimentary` (given by the shop), `none`                                               |
| `subscription.renews_at` | next billing date, `null` when it does not renew                                                                                                                                                                                         |
| `subscription.ends_at`   | when it ends (cancelled), else `null`                                                                                                                                                                                                    |
| `features.scanner`       | Scanner mode (recognition, prices, search)                                                                                                                                                                                               |
| `features.trading`       | Trading mode                                                                                                                                                                                                                             |
| `features.youtube`       | YouTube mode                                                                                                                                                                                                                             |
| `features.recording`     | ● REC in YouTube mode (save to the Gallery)                                                                                                                                                                                              |
| `features.s3_upload`     | "Upload to S3" in Recording & upload                                                                                                                                                                                                     |
| `features.pipeline`      | The submit screen with templates (needs `s3_upload` too)                                                                                                                                                                                 |
| `features.webshop`       | Webshop mode; `webshop.host` is the connected shop                                                                                                                                                                                       |
| `features.collection`    | "Add to collection" and the collection endpoints                                                                                                                                                                                         |
| `features.wanted`        | "Add to missing cards" and the missing-card endpoints                                                                                                                                                                                    |
| `webshop`                | `{ "host": "shop.example.com" }` when a webshop is connected, else `null`. The API key for it is still set up in ⚙ → Webshop as today                                                                                                    |
| `services.s3.enabled`    | the shop set up S3 storage for this customer; settings via `/services/s3`                                                                                                                                                                |
| `portal_url`             | open in the browser for "Manage subscription"                                                                                                                                                                                            |

`valid_until` is the end of the paid period plus 3 days, at most 35 days from now. For an
`inactive` answer it is `server_time`.

### `GET /api/app/v1/services/s3`

Creator only, and only when the shop switched the service on (`features.s3_upload`); otherwise
`403 feature_not_included`. `404 not_configured` while the shop has not entered the settings yet.

```json
{
  "provider": "exoscale",
  "endpoint": "https://sos-at-vie-1.exo.io",
  "region": "at-vie-1",
  "bucket": "oc-recordings",
  "prefix": "acc_7h2k9q0x3m/",
  "access_key_id": "EXO…",
  "secret_access_key": "…",
  "updated_at": "2026-11-15T09:30:00.000Z"
}
```

`provider` is `aws`, `exoscale` or `other` (same as the app's S3 settings). The app fills its
Recording & upload settings from this (secret into the Keystore as today), and fetches it again when
`updated_at` changes or uploads fail with an access error.

## Cards

A card is identified exactly as in the app's data pack:

| Field       | Values                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `card_id`   | `cards.id` of the data pack (TCGdex id), e.g. `sv03.5-199`, `base1-2`. Korean cards use the Japanese card's id, like the app |
| `language`  | printed language, the shop's codes: `DE EN FR IT ES PT NL PL RU JA KO ZH-HANT ZH-HANS ID TH`                                 |
| `finish`    | `normal`, `holo`, `reverse_holo`, `first_edition`, `shadowless`, `stamped`, `pokeball`, `masterball`                         |
| `condition` | `M`, `NM`, `EX`, `GD`, `LP`, `PL`, `PO`                                                                                      |

App printing → `finish`: NORMAL → `normal`, HOLO → `holo`, REVERSE → `reverse_holo`,
FIRST_EDITION → `first_edition`. These are the codes Webshop mode already uses.

The server prices cards from the **same nightly data pack** the app ships with (imported every
night), with the app's rules: Cardmarket trend of the printing, else TCGplayer converted at the
pack's rate; times the condition (M/NM 100 · EX 85 · GD 75 · LP 65 · PL 50 · PO 30 %); PSA 10/9/8
from the graded prices for graded cards.

## Collection

Requires `features.collection`, else `402 subscription_required`.

### Item

```json
{
  "id": 4821,
  "client_ref": "d3c0e6f2-9a51-4f7c-8c0e-1b2a3c4d5e6f",
  "card_id": "sv03.5-199",
  "language": "DE",
  "finish": "holo",
  "condition": "NM",
  "grading": null,
  "quantity": 2,
  "purchase_price_cents": 4000,
  "note": null,
  "binder_id": null,
  "source": "app",
  "name": "Glurak-ex",
  "set_name": "151",
  "number": "199/165",
  "image_url": "https://assets.tcgdex.net/de/sv/sv03.5/199",
  "value_cents": 13450,
  "created_at": "2026-11-15T09:30:00.000Z",
  "updated_at": "2026-11-15T09:30:00.000Z"
}
```

- `grading`: `null` or `{ "company": "PSA", "grade": "10" }` (company ≤ 20, grade ≤ 10 characters).
- `quantity`: 1–999. `purchase_price_cents`: per copy, optional. `note`: ≤ 500 characters.
- `source`: `app`, `portal` or `shop` (bought in the webshop, added automatically).
- `name`, `set_name`, `number`, `image_url`, `value_cents` are filled by the server (read only);
  `value_cents` is per copy and `null` when there is no price.

### `GET /api/app/v1/collection/items`

Query: `updated_since` (ISO time, optional), `cursor` (from the last page), `limit` (1–500, default 200).

```json
{
  "items": [
    { "id": 4821, "…": "…" },
    { "id": 4790, "deleted": true, "updated_at": "…" }
  ],
  "next_cursor": "eyJ1IjoiMjAyNi0xMS0xNVQwOTozMDowMC4wMDBaIiwiaSI6NDgyMX0",
  "server_time": "2026-11-15T09:30:00.000Z"
}
```

Sorted by `updated_at`, then `id`. With `updated_since`, items deleted since then come as
`{ "id", "deleted": true, "updated_at" }` (kept 90 days; older than that, sync from scratch).
To keep a local copy: first sync without `updated_since`, then pass the `server_time` of the last
complete sync.

### `GET /api/app/v1/collection/cards/{card_id}`

All items of one card (any language and finish), for "In your collection: 2 × DE holo NM" on the
result panel. `{ "items": [Item, …] }`.

### `POST /api/app/v1/collection/items`

```json
{
  "client_ref": "d3c0e6f2-9a51-4f7c-8c0e-1b2a3c4d5e6f",
  "card_id": "sv03.5-199",
  "language": "DE",
  "finish": "holo",
  "condition": "NM",
  "quantity": 1,
  "grading": null,
  "purchase_price_cents": null,
  "note": null,
  "binder_id": null,
  "merge": true
}
```

- `client_ref` (UUID) makes the call safe to repeat: the same `client_ref` again returns the item
  it created (`200`) and changes nothing. Create a new one per tap; keep it when retrying.
- `merge` (default `true`): when an item with the same card, language, finish, condition,
  grading and binder and no purchase price or note exists, its quantity goes up instead of a new
  line (`200`, the merged item). `false` always makes a new line.
- `201 Created` with the item; `400 invalid_request` (unknown `card_id` → `fields.card_id = "unknown"`).

### `PATCH /api/app/v1/collection/items/{id}`

Any of `quantity`, `language`, `finish`, `condition`, `grading`, `purchase_price_cents`, `note`,
`binder_id`; `null` clears an optional field. `200` with the item, `404 not_found`.

### `DELETE /api/app/v1/collection/items/{id}`

`204 No Content` (also when it was already deleted).

### `GET /api/app/v1/collection/binders`

`{ "binders": [ { "id": 12, "name": "Trade binder" } ] }` – the customer's binders (made in the
portal). Items without `binder_id` are in the main collection.

## Missing cards

Cards the customer is looking for. The shop sees the list, makes offers and the customer gets an
e-mail when a matching card is in the shop. Requires `features.wanted`.

### Missing card

```json
{
  "id": 77,
  "client_ref": "0b8f…",
  "card_id": "base1-4",
  "language": "EN",
  "finish": null,
  "min_condition": "EX",
  "max_price_cents": 30000,
  "note": "Unlimited is fine",
  "name": "Charizard",
  "set_name": "Base Set",
  "number": "4/102",
  "image_url": "https://assets.tcgdex.net/en/base/base1/4",
  "value_cents": 41200,
  "state": "searching",
  "created_at": "2026-11-15T09:30:00.000Z"
}
```

`language`, `finish`, `min_condition` (that condition or better), `max_price_cents` are optional
(`null` = any); `value_cents` is the data pack's value of a copy as wished (NM when no condition is
given). `state`: `searching`, `offer` (the shop made an offer: the customer takes it or declines it
in the portal under Missing cards), `available` (a matching card is in the shop right now).

A card the customer buys in the shop leaves the list by itself (and goes into the collection).
At most 500 cards on a list (`fields.card_id = "too_many"`).

### Endpoints

| Call                             | Body / answer                                                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/app/v1/wanted`         | `{ "items": [Missing card, …] }` (open ones, newest first)                                                                                                                                                        |
| `POST /api/app/v1/wanted`        | `client_ref`, `card_id`, optional `language`, `finish`, `min_condition`, `max_price_cents`, `note` → `201` (`200` for a repeated `client_ref`, or when the same card with the same wishes is already on the list) |
| `DELETE /api/app/v1/wanted/{id}` | `204` (also when it is already gone)                                                                                                                                                                              |

`POST` errors: `400 invalid_request` with `fields`, e.g. `{ "card_id": "unknown" }`,
`{ "min_condition": "invalid" }`, `{ "max_price_cents": "invalid" }` (1 – 100,000,000 cents).

---

# Part 2: Requirements for the app

## Replace the licence

1. Remove the licence key screen, key parsing (`CS-…`), `/v1/activate` and `/v1/check`, and
   `cardscanner.licenceUrl`. New build setting `cardscanner.accountUrl`
   (`https://overpricedcardboard.com`; staging builds `https://staging.overpricedcardboard.com`).
   `cardscanner.licenceRequired` becomes `cardscanner.accountRequired` (on).
2. **First start / not connected**: a screen "Connect the app to your account" with
   - **Scan QR code** (camera; accepts the pair URL of an allowed host, see Pairing),
   - **Type the code** (12 characters, the build's default server),
   - a line "No account yet? Subscribe at overpricedcardboard.com/app" (opens the browser).
     On success the app shows the account e-mail and plan and continues to the camera.
3. Keep `device_id` (the existing random id). Store the token encrypted with a Keystore key, like
   the S3 and webshop secrets; never log it or put it into CSV/exports.
4. **Status check**: at start and at most hourly while open; also right after pairing and when the
   app comes back to the foreground after more than an hour. Save the last answer; offline use it
   until `valid_until`.
   - `active`: unlock exactly the `features` that are `true`.
   - `inactive`: lock all modes; screen "Your subscription has ended" with **Manage subscription**
     (opens `portal_url`) and **Check again**. Keep the token.
   - `401 unpaired`: forget token and saved status, show the reason ("This phone was removed in
     your account", "Moved to Pixel 9 on 15 Nov", …) and go to the connect screen.
   - `401 invalid_token`: same as unpaired without a reason.
   - Network error or 5xx: keep going on the saved answer while `valid_until` is ahead.
5. **⚙ → Account** (replaces ⚙ → Licence): e-mail, plan, state ("renews on 15 Dec", "ends on …",
   "payment failed – please update your payment method"), devices "2 of 2 in use", buttons
   **Manage subscription** (browser, `portal_url`), **Move to a new phone** (`POST /transfer`,
   shows the QR code with the expiry time; polls `/status` every 5 s while shown so it can say
   "Moved" when the new phone has scanned it), **Disconnect this phone** (confirm, `DELETE /device`).

## Modes by feature

| Mode / setting                    | Shown when                                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scanner (default mode), Search    | `scanner`                                                                                                                                                   |
| Trading mode                      | `trading`                                                                                                                                                   |
| YouTube mode                      | `youtube`; ● REC only with `recording`                                                                                                                      |
| Recording & upload → Upload to S3 | `s3_upload`; fill the S3 fields from `GET /services/s3` (read only, with a note "Set up by Overpriced Cardboard"); without the service the toggle is hidden |
| Submit screen (templates)         | `pipeline` (and `s3_upload`); without it, Stop goes straight to "Save to Gallery"                                                                           |
| Webshop mode                      | `webshop`; host pre-filled from `webshop.host` (key and secret still entered by hand)                                                                       |

Modes the plan does not include are not hidden silently: Mode lists them greyed out with
"Creator" / "With a connected webshop" and a tap opens `portal_url`. A mode that was active and is
no longer included falls back to Scanner.

## Collection and missing cards

1. On the result panel (Scanner and Search; Trading mode for _I get_ cards), when
   `features.collection`: **+ Collection** adds the shown card with its language, the selected
   printing as `finish`, condition NM (Trading: the chosen condition), quantity 1, `merge: true`,
   `source` is set by the server. A small line shows "In collection: 2" from
   `GET /collection/cards/{card_id}` (cached; refreshed after each add).
2. Long-press **+ Collection** opens a small sheet: condition, quantity, purchase price, binder,
   note.
3. When `features.wanted`: **☆ Missing** on the result panel and in Search adds the card to the
   missing cards (language = the card's, finish = selected printing, other fields empty);
   a second tap on the filled ☆ removes it (`DELETE /wanted/{id}`). The filled ☆ comes from
   `GET /wanted` (cached, refreshed at start and after each change). A card with `state: offer`
   shows "Offer from the shop" and opens `portal_url` + `/missing`
   (`https://overpricedcardboard.com/account/missing`); `available` shows "In the shop now".
4. Offline: queue adds and removes with their `client_ref` and send them in order when online;
   show queued items as "waiting to sync". Never drop a queued add because of a 5xx; drop it only
   on a `400` (show why) or when the user deletes it.
5. Trading mode: when a cart is marked **Paid**, offer "Add the N cards to your collection"
   (one `POST` per line, purchase price = the line's price per copy).

## Strings

The app speaks English; the portal says "Account", "Collection", "Missing cards", "Devices",
"Connect a device". Use the same words in the app.

## Tests the app should have

- QR parsing: allowed hosts only, typed codes with spaces/lowercase/O/I/L, rejects other URLs.
- Pair → status → features unlock; `inactive` locks; `unpaired` forgets the token.
- Offline after a successful check: works until `valid_until`, then asks to connect once.
- Transfer: old device gets `unpaired`/`transferred` on its next check.
- Collection add with `client_ref` retried after a timeout creates one item.
- Staging end-to-end against `staging.overpricedcardboard.com` with a test subscription
  (Stripe test card 4242 4242 4242 4242).

---

# Part 3: Usage API for the video pipeline

The pipeline reports what it used per customer; the shop adds it to the customer's next invoice
(Stripe metered billing). It uses the signed product API (`/api/v1`, [api-signing.md](api-signing.md))
with an API key that has the scope **`usage:write`** (Admin › API-Schlüssel › "Für:
Video-Pipeline"; that key can only report usage).

### `POST /api/v1/usage`

```http
Idempotency-Key: 4f7b0d2e-…
```

```json
{
  "account_id": "acc_7h2k9q0x3m",
  "service": "s3",
  "quantity": 1843,
  "unit": "mb",
  "occurred_at": "2026-11-15T09:30:00.000Z",
  "reference": "recordings/20261115T092201Z-7f3a"
}
```

| Field         | Rules                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `account_id`  | the customer's account id (Admin › Kunden, also the S3 prefix)                                                |
| `service`     | `s3` (unit `mb`: megabytes uploaded, 1 GB = 1024 MB) or `pipeline` (unit `second`: seconds of finished video) |
| `quantity`    | whole number, 1 – 10,000,000                                                                                  |
| `occurred_at` | when it happened; at most 35 days ago, not in the future                                                      |
| `reference`   | optional, ≤ 200 characters: recording id or file                                                              |

`201 Created`: `{ "id": 912, "account_id": "acc_…", "service": "s3", "quantity": 1843, "unit": "mb", "occurred_at": "…", "reference": "…", "billed": "queued" }`.
`billed` is `queued` on arrival; the shop then sends it to Stripe (`sent`), or keeps it without
billing for a free subscription (`not_billed`).
The same `Idempotency-Key` within 24 h returns the first answer. Errors:
`404 unknown_account`, `409 service_not_enabled` (the shop has not switched the service on for
this customer), `400 invalid_request` (with `fields`, e.g. `{"unit": "invalid"}` or
`{"occurred_at": "out_of_range"}`), and the signed API's own errors (`401`, `403 scope_missing`,
`409 idempotency_conflict`, …).

Prices per GB and per minute are set in Admin › Abos; Stripe bills the month's total with the
customer's next invoice. The customer sees the month's usage in the portal.

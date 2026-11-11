# License service (scanner app)

One-off licences for the scanner app. A licence never expires and is active on **one device at
a time**: activating it on another device suspends the device that had it. The app keeps working
offline; it stops only after the service has told it that another device took over (or that the
licence was revoked).

The service is `apps/license`: a small Node HTTP server in its own container (`license` in
`infra/compose.yaml`), with its own database. It migrates that database on every start.

## How a licence travels

1. The customer buys a licence in the shop (`/app`, quick checkout, Stripe).
2. After payment the shop's worker (job `license.issue`) calls `POST /v1/shop/licenses` and
   receives the key.
3. The shop e-mails the key as text **and as a QR code** (the QR code holds exactly the `qr`
   field), together with the app's download link (`/api/app/download/<order token>`, the APK
   uploaded in Admin › App, or the Play Store once its link is set) and the invoice.
4. On first start the app asks for the licence: the customer scans the QR code or types the key.
   The app calls `POST /v1/activate`.
5. The app checks `POST /v1/check` now and then (at start, at most every few hours). Offline is
   fine. If the answer is `suspended` (another device was activated) or `revoked`, the app locks
   and forgets the key on this device.
6. **Switch to new device**: the app shows the licence's QR code again (Settings › Licence); the
   new device scans it. The old device stops on its next check. A suspended device can only come
   back by scanning a QR code again (from the active device or from the licence e-mail).
7. **Lost device**: the customer asks the shop to send the licence again ("Lizenz-E-Mail
   verloren?" on `/app`, by order e-mail, at most once per address and hour, same answer either
   way); the shop looks it up with `GET /v1/shop/licenses?email=…` and e-mails it. The admin can
   also resend it from the order.
8. **Refund**: a full refund (Admin › order › "Erstatten und sperren", or in the Stripe
   dashboard) revokes the order's keys (job `license.revoke`).

## Keys

`CS-` and four groups of five characters, e.g. `CS-7K2QX-9MZ4D-01ABC-1XYZW` (Crockford base32,
100 random bits). Typing is forgiving: case, spaces and dashes don't matter, O counts as 0, I and
L as 1. Keys are stored encrypted (`LICENSE_MASTER_KEY`, so they can be sent again) and looked up
by their SHA-256. Devices hold a random activation token; only its hash is stored. Keys and tokens
are never logged.

## API for the shop

Base URL inside the stack: `LICENSE_SERVICE_URL` (`http://license:3100`). These endpoints are not
reachable from the internet (Caddy routes only the app's endpoints).

Every request: `Authorization: Bearer <LICENSE_SHOP_TOKEN>`, JSON bodies. Errors are
`{ "error": "<code>", "message": "…" }` with a fitting status.

### Issue licences after payment

```http
POST /v1/shop/licenses
{ "order_ref": "2026-000123", "email": "kunde@example.com", "name": "Max Muster", "count": 1, "note": "optional" }
```

- `201` with `{ "licenses": [Licence, …] }` when created, `200` with the same licences when this
  `order_ref` already has them: **retries are safe**, an order never gets a second set.
- `409 order_mismatch` when the order already has a different number of licences.
- `order_ref` is optional (licences issued by hand have none); `count` is 1–50.

### Find licences (self-service "send my licence again", support)

```http
GET /v1/shop/licenses?email=kunde@example.com     (case-insensitive)
GET /v1/shop/licenses?key=CS-7K2QX-9MZ4D-01ABC-1XYZW
GET /v1/shop/licenses/lic_0123456789abcdef
```

`{ "licenses": [Licence, …] }` (an empty list when nothing matches); the single one returns the
Licence itself or `404 unknown_license`. The self-service page should answer the same whether or
not the address has licences ("if there is a licence for this address, it is on its way") and be
rate-limited, so it can't be used to probe addresses.

### Revoke (refund, chargeback)

```http
POST /v1/shop/licenses/lic_0123456789abcdef/revoke
{ "reason": "refund 2026-000123" }
```

`200 { "id": "lic_…", "revoked_at": "…" }`. The device using it locks on its next check; the key
can't be activated again. Revoking twice keeps the first time and reason.

### Licence

```json
{
  "id": "lic_0123456789abcdef",
  "key": "CS-7K2QX-9MZ4D-01ABC-1XYZW",
  "qr": "CS-7K2QX-9MZ4D-01ABC-1XYZW",
  "email": "kunde@example.com",
  "name": "Max Muster",
  "order_ref": "2026-000123",
  "note": null,
  "created_at": "2026-11-08T19:40:00.000Z",
  "revoked_at": null,
  "revoke_reason": null,
  "active_device": { "name": "Pixel 8", "since": "…", "last_seen": "…" },
  "activations": 2
}
```

`qr` is the text for the QR code (render it as a PNG or SVG in the e-mail, error correction M or
higher). `active_device` is null until the first activation; `activations` counts every device so far.

## API for the app (public)

`https://license.overpricedcardboard.com` (staging: `https://license.staging.overpricedcardboard.com`).

| Request                                                              | Answer                                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /health`                                                        | `{ "ok": true }`                                                                               |
| `POST /v1/activate` `{ key, device_id, device_name?, app_version? }` | `{ license_id, token, since }`; `404 unknown_key`, `410 revoked`, `400 invalid_key`, `429`     |
| `POST /v1/check` `{ token, app_version? }`                           | `{ status: "active" }`, `{ status: "suspended", since, device_name }`, `{ status: "revoked" }` |

`device_id` is a random id the app makes once; `device_name` is the phone model, shown to the
device that gets replaced. Activating on the device that already has the licence just gives it a
new token. `/v1/activate` allows 30 calls per address and hour.

## Administration

Inside the container (`infra/stack.sh production exec license …`):

```sh
node apps/license/src/cli.ts issue --email you@example.com --name "Owner" --note "own phone"
node apps/license/src/cli.ts show <licence id | key | e-mail>
node apps/license/src/cli.ts revoke <licence id> [reason …]
```

## Setting it up

1. Database and user on the PostgreSQL server (like the shop's, see [deploy.md](deploy.md)):
   `CREATE ROLE pokeshop_license LOGIN PASSWORD '…'; CREATE DATABASE pokeshop_license OWNER pokeshop_license;`
   (staging: `pokeshop_license_staging`).
2. In `production.env` / `staging.env`: `LICENSE_DATABASE_URL`, `LICENSE_MASTER_KEY`
   (`openssl rand -base64 32`), `LICENSE_SHOP_TOKEN` (`openssl rand -base64 32`),
   `LICENSE_SERVICE_URL=http://license:3100`. Keep a copy of `LICENSE_MASTER_KEY` with the
   database backup: without it the stored keys can't be sent again (activations keep working).
3. DNS: `license.overpricedcardboard.com` and `license.staging.overpricedcardboard.com` to the server.
4. Reload Caddy (`infra/caddy/Caddyfile` has both sites), then `infra/stack.sh <stack> up -d`.
5. Check: `curl https://license.overpricedcardboard.com/health` → `{"ok":true}`.
6. Admin › App shows "Lizenzdienst: erreichbar". Upload the APK there (Caddy allows 400 MB on
   `/admin/app/upload` only); from then on the app page sells licences. Until the service is
   set up and an APK (or a Play Store link) exists, the page says sales start shortly.

# Signing requests to the product API

Every request to `/api/v1` carries three headers. The shop rejects a request when any of them is
missing, the signature does not match, or the timestamp is more than 5 minutes off.

| Header            | Value                                                                    |
| ----------------- | ------------------------------------------------------------------------ |
| `X-Key-Id`        | key id of the API client, e.g. `kid_9x2…`                                |
| `X-Timestamp`     | current Unix time in seconds                                             |
| `X-Signature`     | `v1=` + hex HMAC-SHA256 (below)                                          |
| `Idempotency-Key` | a new UUID per write; **reuse the same one when retrying** (writes only) |

## Signature

Join four lines with `\n` (no trailing newline):

```
<X-Timestamp>
<HTTP method in upper case>
<path and query exactly as sent, e.g. /api/v1/products?status=active>
<hex SHA-256 of the raw request body; of the empty string when there is no body>
```

Compute HMAC-SHA256 over that string with the client secret (as UTF-8 bytes, exactly as shown in
the admin) as the key, hex-encode it and send `X-Signature: v1=<hex>`.

Sign the exact bytes you send: serialise the JSON body once, hash that string and send that string.

## Test vector

| Input         | Value                                                                      |
| ------------- | -------------------------------------------------------------------------- |
| secret        | `sk_example`                                                               |
| timestamp     | `1793883600`                                                               |
| method        | `GET`                                                                      |
| path          | `/api/v1/products/sv03.5-199-DE-NM-H`                                      |
| body          | empty (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`) |
| **signature** | `v1=074aa943428ea866471942182a5e5d1b9e8b58cf22edc8b080afa045e9d63edd`      |

Check from a shell:

```sh
printf '1793883600\nGET\n/api/v1/products/sv03.5-199-DE-NM-H\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' \
  | openssl dgst -sha256 -hmac 'sk_example'
```

## curl

```sh
KEY_ID=kid_… ; SECRET=sk_… ; HOST=https://staging.overpricedcardboard.com
PATH_Q=/api/v1/stock/intake
BODY='{"card_ref":"sv03.5-199","card_language":"DE","condition":"NM","finish":"holo","delta":1,"storage_location":"014","price":{"amount":12900,"currency":"EUR"}}'
TS=$(date +%s)
BODY_HASH=$(printf '%s' "$BODY" | openssl dgst -sha256 | awk '{print $2}')
SIG=$(printf '%s\n%s\n%s\n%s' "$TS" POST "$PATH_Q" "$BODY_HASH" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

curl -sS "$HOST$PATH_Q" -X POST \
  -H "Content-Type: application/json" \
  -H "X-Key-Id: $KEY_ID" -H "X-Timestamp: $TS" -H "X-Signature: v1=$SIG" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data-raw "$BODY"
```

## TypeScript

[docs/examples/sign-request.ts](examples/sign-request.ts) – a small client using only Node's
built-in `crypto` and `fetch`. Its output is checked against the shop's own verification in the
test suite.

## Errors

| Status | `error`                                                                          | Meaning                                                                 |
| ------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 401    | `missing_headers`, `bad_timestamp`, `bad_signature_format`, `signature_mismatch` | Signing problem                                                         |
| 401    | `timestamp_out_of_range`                                                         | Device clock more than 5 minutes off – sync the clock                   |
| 403    | `key_revoked`, `scope_missing`, `ip_not_allowed`                                 | Key not allowed to do this                                              |
| 409    | `idempotency_conflict`                                                           | Same Idempotency-Key reused with a different body                       |
| 429    | `rate_limited`                                                                   | More than the key's per-minute limit; retry after `Retry-After` seconds |

/**
 * Minimal client for the pokemonkarten.at product API, for the scanning app.
 * Only Node's built-in crypto and fetch are used; the same steps work in any language.
 *
 *   node docs/examples/sign-request.ts
 *   (env: POKESHOP_API_BASE, POKESHOP_KEY_ID, POKESHOP_SECRET)
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';

export type SignedHeaders = Record<'X-Key-Id' | 'X-Timestamp' | 'X-Signature', string>;

/** Builds the three signing headers for one request. `pathWithQuery` starts with /api/v1. */
export function signRequest(opts: {
  keyId: string;
  secret: string;
  method: string;
  pathWithQuery: string;
  body: string; // the exact bytes you send; '' for GET
  timestamp?: number; // Unix seconds; defaults to now
}): SignedHeaders {
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const bodyHash = createHash('sha256').update(opts.body).digest('hex');
  const canonical = [timestamp, opts.method.toUpperCase(), opts.pathWithQuery, bodyHash].join('\n');
  const mac = createHmac('sha256', Buffer.from(opts.secret, 'utf8'))
    .update(canonical)
    .digest('hex');
  return { 'X-Key-Id': opts.keyId, 'X-Timestamp': timestamp, 'X-Signature': `v1=${mac}` };
}

/** Sends a signed JSON request. Writes also need an Idempotency-Key (reuse it on retries). */
export async function callApi(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  pathWithQuery: string,
  payload?: unknown,
  idempotencyKey: string = randomUUID(),
): Promise<Response> {
  const base = process.env.POKESHOP_API_BASE ?? 'https://staging.pokemonkarten.at';
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const headers: Record<string, string> = {
    ...signRequest({
      keyId: process.env.POKESHOP_KEY_ID ?? '',
      secret: process.env.POKESHOP_SECRET ?? '',
      method,
      pathWithQuery,
      body,
    }),
    Accept: 'application/json',
  };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = idempotencyKey;
  }
  return fetch(base + pathWithQuery, {
    method,
    headers,
    body: method === 'GET' ? undefined : body,
  });
}

// Example: one Glurak-ex 199/165, German, Near Mint, holo, into box 014.
if (import.meta.url === `file://${process.argv[1]}`) {
  const res = await callApi('POST', '/api/v1/stock/intake', {
    card_ref: 'sv03.5-199',
    card_language: 'DE',
    condition: 'NM',
    finish: 'holo',
    delta: 1,
    storage_location: '014',
    price: { amount: 12900, currency: 'EUR' },
    high_value: true,
    images: [{ role: 'front', url: 'https://example.com/scans/front.jpg' }],
  });
  console.log(res.status, await res.text());
}

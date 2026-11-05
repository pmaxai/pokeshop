import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signRequest } from '../../../docs/examples/sign-request.ts';
import { verify } from '../src/signing.ts';

// The example handed to the scanning-app developer must produce signatures the shop accepts.
test('documented client example verifies against the shop', () => {
  const now = new Date();
  const body = JSON.stringify({ card_ref: 'sv03.5-199', delta: 1, storage_location: '014' });
  const h = signRequest({
    keyId: 'kid_example',
    secret: 'sk_example',
    method: 'post',
    pathWithQuery: '/api/v1/stock/intake',
    body,
  });
  assert.deepEqual(
    verify({
      secret: 'sk_example',
      timestampHeader: h['X-Timestamp'],
      signatureHeader: h['X-Signature'],
      method: 'POST',
      pathWithQuery: '/api/v1/stock/intake',
      body,
      now,
    }),
    { ok: true },
  );
});

test('fixed test vector for other languages', () => {
  const h = signRequest({
    keyId: 'kid_example',
    secret: 'sk_example',
    method: 'GET',
    pathWithQuery: '/api/v1/products/sv03.5-199-DE-NM-H',
    body: '',
    timestamp: 1793883600,
  });
  assert.equal(h['X-Timestamp'], '1793883600');
  // Same value as in docs/api-signing.md, cross-checked with `openssl dgst -sha256 -hmac`.
  assert.equal(
    h['X-Signature'],
    'v1=074aa943428ea866471942182a5e5d1b9e8b58cf22edc8b080afa045e9d63edd',
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { canonicalString, generateApiCredentials, sign, verify } from '../src/signing.ts';
import { decryptSecret, encryptSecret, parseMasterKey } from '../src/secrets.ts';

const secret = 'sk_test_secret';
const now = new Date('2026-11-05T13:00:00Z');
const ts = String(Math.floor(now.getTime() / 1000));
const body = JSON.stringify({ card_ref: 'sv03.5-199', delta: 1, storage_location: '014' });
const path = '/api/v1/stock/intake';

test('canonical string layout', () => {
  assert.equal(
    canonicalString({ timestamp: 1, method: 'get', pathWithQuery: '/x?a=1', body: '' }),
    '1\nGET\n/x?a=1\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('a correctly signed request verifies', () => {
  const sig = sign(secret, { timestamp: ts, method: 'POST', pathWithQuery: path, body });
  const r = verify({
    secret,
    timestampHeader: ts,
    signatureHeader: sig,
    method: 'POST',
    pathWithQuery: path,
    body,
    now,
  });
  assert.deepEqual(r, { ok: true });
});

test('changed body, path, method or secret fails', () => {
  const sig = sign(secret, { timestamp: ts, method: 'POST', pathWithQuery: path, body });
  const base = {
    secret,
    timestampHeader: ts,
    signatureHeader: sig,
    method: 'POST',
    pathWithQuery: path,
    body,
    now,
  };
  assert.deepEqual(verify({ ...base, body: body.replace('1,', '2,') }), {
    ok: false,
    reason: 'signature_mismatch',
  });
  assert.deepEqual(verify({ ...base, pathWithQuery: '/api/v1/products' }), {
    ok: false,
    reason: 'signature_mismatch',
  });
  assert.deepEqual(verify({ ...base, method: 'PUT' }), { ok: false, reason: 'signature_mismatch' });
  assert.deepEqual(verify({ ...base, secret: 'other' }), {
    ok: false,
    reason: 'signature_mismatch',
  });
  assert.deepEqual(verify({ ...base, secret: null }), { ok: false, reason: 'signature_mismatch' });
});

test('timestamps older or newer than 5 minutes are rejected', () => {
  const old = String(Number(ts) - 301);
  const sig = sign(secret, { timestamp: old, method: 'POST', pathWithQuery: path, body });
  assert.deepEqual(
    verify({
      secret,
      timestampHeader: old,
      signatureHeader: sig,
      method: 'POST',
      pathWithQuery: path,
      body,
      now,
    }),
    { ok: false, reason: 'timestamp_out_of_range' },
  );
});

test('missing or malformed headers', () => {
  const base = { secret, method: 'GET', pathWithQuery: path, body: '', now };
  assert.equal(verify({ ...base, timestampHeader: null, signatureHeader: 'v1=00' }).ok, false);
  assert.deepEqual(verify({ ...base, timestampHeader: 'abc', signatureHeader: 'v1=00' }), {
    ok: false,
    reason: 'bad_timestamp',
  });
  assert.deepEqual(verify({ ...base, timestampHeader: ts, signatureHeader: 'sha256=abc' }), {
    ok: false,
    reason: 'bad_signature_format',
  });
});

test('generated credentials have the expected shape', () => {
  const c = generateApiCredentials();
  assert.match(c.keyId, /^kid_[a-z0-9]{16}$/);
  assert.match(c.secret, /^sk_[A-Za-z0-9_-]{43}$/);
});

test('secrets round-trip through AES-256-GCM and detect tampering', () => {
  const key = parseMasterKey(randomBytes(32).toString('base64'));
  const stored = encryptSecret('sk_abc', key);
  assert.match(stored, /^v1\./);
  assert.equal(decryptSecret(stored, key), 'sk_abc');
  const parts = stored.split('.');
  parts[2] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decryptSecret(parts.join('.'), key));
  assert.throws(() => parseMasterKey('c2hvcnQ='), /32 bytes/);
});

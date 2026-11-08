import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatKey, generateKey, keyHash, normalizeKey } from '../src/keys.ts';
import { RateLimiter } from '../src/server.ts';
import { licenseMasterKey } from '../src/config.ts';

test('a key is CS- and four groups of five, and reads back the same', () => {
  const key = generateKey();
  assert.match(key, /^CS-([0-9A-HJKMNP-TV-Z]{5}-){3}[0-9A-HJKMNP-TV-Z]{5}$/);
  const body = normalizeKey(key);
  assert.equal(body?.length, 20);
  assert.equal(formatKey(body!), key);
  assert.notEqual(generateKey(), key);
});

test('typed keys are forgiving: case, spaces, dashes, O for 0, I and L for 1', () => {
  const key = 'CS-7K2QX-9MZ4D-01ABC-1XYZW';
  const body = normalizeKey(key);
  assert.equal(body, '7K2QX9MZ4D01ABC1XYZW');
  assert.equal(normalizeKey('cs 7k2qx 9mz4d oiabc lxyzw'), body);
  assert.equal(normalizeKey('7K2QX9MZ4D01ABC1XYZW'), body);
  assert.deepEqual(keyHash(normalizeKey('cs-7k2qx-9mz4d-01abc-1xyzw')!), keyHash(body!));
});

test('what is not a key', () => {
  assert.equal(normalizeKey(''), null);
  assert.equal(normalizeKey('CS-7K2QX-9MZ4D-01ABC'), null); // too short
  assert.equal(normalizeKey('CS-7K2QX-9MZ4D-01ABC-1XYZU'), null); // U is not in the alphabet
  assert.equal(normalizeKey('CS-7K2QX-9MZ4D-01ABC-1XYZW-12345'), null);
});

test('the rate limiter counts per address and window', () => {
  let now = 0;
  const r = new RateLimiter(2, 1000, () => now);
  assert.ok(r.take('a'));
  assert.ok(r.take('a'));
  assert.ok(!r.take('a'));
  assert.ok(r.take('b'));
  now = 1000;
  assert.ok(r.take('a'));
});

test('the master key must be 32 bytes', () => {
  assert.throws(() => licenseMasterKey(''), /not set/);
  assert.throws(() => licenseMasterKey(Buffer.alloc(16).toString('base64')), /32 bytes/);
  assert.equal(licenseMasterKey(Buffer.alloc(32, 7).toString('base64')).length, 32);
});

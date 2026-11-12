import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  CONTACT_MAX_SECONDS,
  CONTACT_MIN_SECONDS,
  createChallenge,
  leadingZeroBits,
  solveChallenge,
  validateContact,
  verifyChallenge,
} from '../src/contact.ts';

const key = randomBytes(32);
const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);

test('zero bits are counted from the front', () => {
  assert.equal(leadingZeroBits(Uint8Array.from([0, 0, 0xff])), 16);
  assert.equal(leadingZeroBits(Uint8Array.from([0, 0x10, 0])), 11);
  assert.equal(leadingZeroBits(Uint8Array.from([0x80])), 0);
});

test('a solved challenge passes once enough time has gone by', () => {
  const issued = new Date('2026-11-12T12:00:00Z');
  const token = createChallenge(key, issued, 8);
  const nonce = solveChallenge(token);
  const ok = verifyChallenge(key, token, nonce, at(issued, CONTACT_MIN_SECONDS + 1));
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.salt, token.split('.')[0]);
  assert.deepEqual(verifyChallenge(key, token, nonce, at(issued, 1)), {
    ok: false,
    problem: 'too_fast',
  });
  assert.deepEqual(verifyChallenge(key, token, nonce, at(issued, CONTACT_MAX_SECONDS + 1)), {
    ok: false,
    problem: 'expired',
  });
});

test('wrong work, a changed challenge or another key are refused', () => {
  const issued = new Date('2026-11-12T12:00:00Z');
  const later = at(issued, 10);
  const token = createChallenge(key, issued, 12);
  const nonce = solveChallenge(token);
  // A nonce that does not reach the difficulty.
  let bad = 0;
  while (verifyChallenge(key, token, String(bad), later).ok) bad++;
  assert.deepEqual(verifyChallenge(key, token, String(bad), later), {
    ok: false,
    problem: 'unsolved',
  });
  assert.deepEqual(verifyChallenge(key, token, 'abc', later), { ok: false, problem: 'unsolved' });
  // Lowering the difficulty breaks the signature.
  const [salt, ts, , sig] = token.split('.');
  assert.deepEqual(verifyChallenge(key, `${salt}.${ts}.1.${sig}`, nonce, later), {
    ok: false,
    problem: 'invalid',
  });
  assert.deepEqual(verifyChallenge(randomBytes(32), token, nonce, later), {
    ok: false,
    problem: 'invalid',
  });
  assert.deepEqual(verifyChallenge(key, '', nonce, later), { ok: false, problem: 'missing' });
});

test('the form needs name, a valid e-mail and a message', () => {
  const v = validateContact({ name: ' ', email: 'nope', subject: '', message: '' });
  assert.ok(!v.ok);
  assert.deepEqual(!v.ok && v.errors, {
    name: 'required',
    email: 'invalid_email',
    message: 'required',
  });
  const ok = validateContact({
    name: 'Misty',
    email: ' Misty@Example.com ',
    subject: '',
    message: 'Habt ihr Glurak?',
  });
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.data.email, 'misty@example.com');
  assert.equal(ok.ok && ok.data.subject, undefined);
});

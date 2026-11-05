import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdState, reservedUntil, stripeSessionExpiresAt } from '../src/reservation.ts';
import { formatDocumentNumber, newOrderNumber } from '../src/numbering.ts';

const now = new Date('2026-11-05T13:00:00Z');

test('cards are held 10 minutes by default', () => {
  assert.equal(reservedUntil(now).toISOString(), '2026-11-05T13:10:00.000Z');
  assert.equal(reservedUntil(now, 15).toISOString(), '2026-11-05T13:15:00.000Z');
  assert.throws(() => reservedUntil(now, 0), RangeError);
});

test('Stripe session expiry is at least Stripe’s 30-minute minimum', () => {
  const exp = stripeSessionExpiresAt(now);
  assert.ok(exp - now.getTime() / 1000 >= 30 * 60);
});

test('hold state over time', () => {
  const until = reservedUntil(now);
  const at = (min: number) => new Date(now.getTime() + min * 60_000);
  assert.equal(holdState({ reservedUntil: until, now: at(9), paymentPending: false }), 'active');
  assert.equal(
    holdState({ reservedUntil: until, now: at(10), paymentPending: false }),
    'expired_unpaid',
  );
  assert.equal(
    holdState({ reservedUntil: until, now: at(11), paymentPending: true }),
    'pending_payment',
  );
});

test('order numbers are readable and use no ambiguous characters', () => {
  const n = newOrderNumber(now);
  assert.match(n, /^PK-2611-[2-9A-HJKMNP-Z]{5}$/);
  assert.equal(
    newOrderNumber(now, () => 0),
    'PK-2611-22222',
  );
});

test('invoice and credit-note numbers', () => {
  assert.equal(formatDocumentNumber('invoice', 2026, 123), 'RE-2026-000123');
  assert.equal(formatDocumentNumber('credit_note', 2026, 17), 'GS-2026-000017');
  assert.throws(() => formatDocumentNumber('invoice', 2026, 0));
});

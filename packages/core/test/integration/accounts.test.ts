import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import {
  accountOrders,
  createAccountSession,
  deleteAccount,
  MAX_LINKS_PER_HOUR,
  peekLoginLink,
  redeemLoginLink,
  requestLoginLink,
  saveProfile,
  saveShippingAddress,
  sessionAccount,
} from '../../src/accounts.ts';

let sql: Sql;
let drop: () => Promise<void>;

before(async () => {
  ({ sql, drop } = await freshDatabase());
});
after(async () => drop());

const BASE = 'https://overpricedcardboard.com';

/** The token from the queued login mail (as the customer would click it). */
async function lastLinkToken(email: string): Promise<string> {
  const [m] = await sql<{ payload: { url: string } }[]>`
    SELECT payload FROM outbox WHERE template = 'account_login' AND to_address = ${email}
     ORDER BY id DESC LIMIT 1`;
  return new URL(m!.payload.url).searchParams.get('t')!;
}

let n = 0;
async function order(email: string, status = 'paid') {
  n++;
  await sql`
    INSERT INTO orders (number, lookup_token, status, locale, country, email, customer_name,
                        goods_cents, shipping_cents, total_cents, shipping_method, vat_regime,
                        vat_rate_bp, vat_cents)
    VALUES (${`PK-T-${n}`}, ${`tok_${n}_${'x'.repeat(24)}`}, ${status}, 'de', 'AT', ${email}, 'Misty',
            1000, 200, 1200, 'standard', 'small_business', 0, 0)`;
}

test('a login link logs in once, creates the account and links earlier orders', async () => {
  await order('Misty@Example.com');
  await order('misty@example.com', 'expired');
  const r = await requestLoginLink(sql, {
    email: ' Misty@Example.com ',
    locale: 'de',
    next: '/de/kasse',
    baseUrl: BASE,
  });
  assert.equal(r, 'sent');
  const token = await lastLinkToken('misty@example.com');
  const [mail] = await sql<{ payload: { url: string; new_account: boolean } }[]>`
    SELECT payload FROM outbox WHERE template = 'account_login'`;
  assert.ok(mail!.payload.url.startsWith(`${BASE}/de/anmelden/link?t=`));
  assert.equal(mail!.payload.new_account, true);

  assert.deepEqual(await peekLoginLink(sql, token), { ok: true, email: 'misty@example.com' });
  const used = await redeemLoginLink(sql, token);
  assert.ok(used.ok);
  assert.equal(used.created, true);
  assert.equal(used.next, '/de/kasse');
  assert.match(used.account.publicId, /^acc_[0-9a-z]{10}$/);
  assert.equal(used.account.locale, 'de');
  // the paid guest order is now in the account, the expired attempt is not
  const orders = await accountOrders(sql, used.account.id);
  assert.equal(orders.length, 1);
  assert.equal(orders[0]!.totalCents, 1200);

  // once only
  assert.deepEqual(await redeemLoginLink(sql, token), { ok: false, problem: 'used' });
  assert.deepEqual(await peekLoginLink(sql, token), { ok: false, problem: 'used' });

  // the second login finds the same account
  await requestLoginLink(sql, { email: 'misty@example.com', locale: 'en', baseUrl: BASE });
  const again = await redeemLoginLink(sql, await lastLinkToken('misty@example.com'));
  assert.ok(again.ok);
  assert.equal(again.account.id, used.account.id);
  assert.equal(again.created, false);
  assert.equal(again.account.locale, 'de');
});

test('links expire after 20 minutes and unknown tokens are invalid', async () => {
  const t0 = new Date('2026-11-15T10:00:00Z');
  await requestLoginLink(sql, { email: 'brock@example.com', locale: 'en', baseUrl: BASE, now: t0 });
  const token = await lastLinkToken('brock@example.com');
  const late = new Date(t0.getTime() + 21 * 60_000);
  assert.deepEqual(await redeemLoginLink(sql, token, late), { ok: false, problem: 'expired' });
  assert.deepEqual(await redeemLoginLink(sql, 'x'.repeat(43)), { ok: false, problem: 'invalid' });
  assert.deepEqual(await redeemLoginLink(sql, 'short'), { ok: false, problem: 'invalid' });
});

test('at most five links per address and hour', async () => {
  const t0 = new Date();
  for (let i = 0; i < MAX_LINKS_PER_HOUR; i++) {
    assert.equal(
      await requestLoginLink(sql, {
        email: 'gary@example.com',
        locale: 'en',
        baseUrl: BASE,
        now: t0,
      }),
      'sent',
    );
  }
  assert.equal(
    await requestLoginLink(sql, {
      email: 'gary@example.com',
      locale: 'en',
      baseUrl: BASE,
      now: t0,
    }),
    'throttled',
  );
  const [c] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM outbox WHERE to_address = 'gary@example.com'`;
  assert.equal(c!.n, MAX_LINKS_PER_HOUR);
});

test('sessions find the account, move their expiry on and end with the account', async () => {
  await requestLoginLink(sql, { email: 'erika@example.com', locale: 'en', baseUrl: BASE });
  const r = await redeemLoginLink(sql, await lastLinkToken('erika@example.com'));
  assert.ok(r.ok);
  const token = await createAccountSession(sql, r.account.id);
  assert.equal((await sessionAccount(sql, token))?.email, 'erika@example.com');
  assert.equal(await sessionAccount(sql, 'nope'), null);
  // 59 days later it still works (each visit renews it), 61 days without a visit it doesn't
  const later = new Date(Date.now() + 59 * 86400_000);
  assert.ok(await sessionAccount(sql, token, later));
  assert.equal(await sessionAccount(sql, token, new Date(later.getTime() + 61 * 86400_000)), null);

  assert.deepEqual(await saveProfile(sql, r.account.id, { name: 'x'.repeat(101), locale: 'de' }), {
    ok: false,
    errors: { name: 'too_long' },
  });
  assert.deepEqual(await saveProfile(sql, r.account.id, { name: ' Erika ', locale: 'de' }), {
    ok: true,
  });
  const bad = await saveShippingAddress(sql, r.account.id, {
    name: 'Erika',
    street: 'Hauptstraße 1',
    postcode: '12',
    city: 'Wien',
    country: 'AT',
  });
  assert.deepEqual(bad, { ok: false, errors: { postcode: 'invalid_postcode' } });
  const good = await saveShippingAddress(sql, r.account.id, {
    name: 'Erika',
    street: 'Hauptstraße 1',
    postcode: '1010',
    city: 'Wien',
    country: 'AT',
  });
  assert.ok(good.ok);
  const me = await sessionAccount(sql, token);
  assert.equal(me?.name, 'Erika');
  assert.equal(me?.shippingAddress?.city, 'Wien');

  await deleteAccount(sql, r.account.id);
  assert.equal(await sessionAccount(sql, token), null);
});

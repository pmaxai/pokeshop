import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import {
  deleteAccount,
  redeemLoginLink,
  requestLoginLink,
  type Account,
} from '../../src/accounts.ts';
import {
  accountAffiliate,
  affiliateCsv,
  affiliateDiscount,
  affiliateRegistrations,
  normalizeAffiliateCode,
  registerAffiliate,
  saveAffiliate,
  saveAffiliateLink,
} from '../../src/affiliates.ts';
import { fakeBilling } from '../../src/billing.ts';
import {
  parseGoogleSubscription,
  processGooglePurchase,
  PurchaseInvalid,
  saveStoreProducts,
  storeOffers,
  storeProducts,
  type GooglePlay,
  type GoogleSubscription,
} from '../../src/store.ts';
import {
  handleBillingEvent,
  startSubscription,
  validateSubscribe,
  type SubscribeForm,
} from '../../src/subscriptions.ts';

let sql: Sql;
let drop: () => Promise<void>;
const BASE = 'http://localhost:3000';
const DAY = 86400_000;
const billing = fakeBilling(BASE);
let mistyLink = 0;
let ashLink = 0;

class FakePlay implements GooglePlay {
  subs = new Map<string, Record<string, unknown>>();
  async getSubscription(token: string): Promise<GoogleSubscription> {
    const raw = this.subs.get(token);
    if (!raw) throw new PurchaseInvalid('HTTP 404');
    return parseGoogleSubscription(raw);
  }
  async acknowledge() {}
  async cancel() {}
}

async function account(email: string): Promise<Account> {
  await requestLoginLink(sql, { email, locale: 'de', baseUrl: BASE });
  const [m] = await sql<{ payload: { url: string } }[]>`
    SELECT payload FROM outbox WHERE to_address = ${email} ORDER BY id DESC LIMIT 1`;
  const r = await redeemLoginLink(sql, new URL(m!.payload.url).searchParams.get('t')!);
  assert.ok(r.ok);
  return r.account;
}

const form = (): SubscribeForm => {
  const v = validateSubscribe({
    plan: 'collector',
    extraDevices: '0',
    buyer: 'consumer',
    name: 'Misty Fan',
    street: 'Hauptstraße 1',
    postcode: '1010',
    city: 'Wien',
    country: 'AT',
    acceptTerms: true,
    immediateStart: true,
  });
  assert.ok(v.ok);
  return v.data;
};

before(async () => {
  ({ sql, drop } = await freshDatabase());
  await sql`
    INSERT INTO settings (key, value) VALUES ('license_seller', ${sql.json({
      name: 'Antalyse GmbH',
      street: 'Teststraße 1',
      postcode: '1010',
      city: 'Wien',
      country: 'AT',
      email: 'info@example.com',
    } as never)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  assert.ok(
    (
      await saveStoreProducts(sql, {
        google: {
          collector: {
            product_id: 'oc_collector',
            base_plans: { monthly: 'monthly', yearly: 'yearly' },
          },
          creator: {
            product_id: 'oc_creator',
            base_plans: { monthly: 'monthly', yearly: 'yearly' },
          },
        },
        apple: {
          collector: { monthly: null, yearly: null },
          creator: { monthly: null, yearly: null },
        },
      })
    ).ok,
  );
});
after(async () => drop());

test('influencers and links: saved, codes normalised and unique', async () => {
  assert.equal(normalizeAffiliateCode(' misty-yt '), 'MISTY-YT');
  assert.equal(normalizeAffiliateCode('a b'), null);
  assert.equal(normalizeAffiliateCode('xy'), null);

  const misty = await saveAffiliate(sql, {
    name: 'Misty (YouTube)',
    email: 'misty@example.com',
    country: 'us',
    commission: '20 % des ersten Jahres',
  });
  assert.ok(misty.ok);
  const bad = await saveAffiliate(sql, { name: '', email: 'nope' });
  assert.deepEqual(bad, { ok: false, errors: { name: 'required', email: 'invalid' } });

  const l = await saveAffiliateLink(sql, {
    affiliateId: misty.id,
    code: 'misty',
    label: 'YouTube',
    discountPercent: 20,
    discountMonths: 3,
    googleOfferId: 'creator-20-3m',
  });
  assert.ok(l.ok);
  mistyLink = l.id;
  const taken = await saveAffiliateLink(sql, {
    affiliateId: misty.id,
    code: 'MISTY',
    discountPercent: 0,
  });
  assert.deepEqual(taken, { ok: false, errors: { code: 'taken' } });
  const monthsAlone = await saveAffiliateLink(sql, {
    affiliateId: misty.id,
    code: 'MISTY2',
    discountPercent: 0,
    discountMonths: 3,
  });
  assert.deepEqual(monthsAlone, { ok: false, errors: { discountMonths: 'without_discount' } });

  const ash = await saveAffiliate(sql, { name: 'Ash', country: 'JP' });
  assert.ok(ash.ok);
  const a = await saveAffiliateLink(sql, { affiliateId: ash.id, code: 'ASH', discountPercent: 0 });
  assert.ok(a.ok);
  ashLink = a.id;
});

test('registering: the first code counts, only before the first purchase', async () => {
  const brock = await account('brock@example.com');
  assert.deepEqual(
    await registerAffiliate(sql, { accountId: brock.id, code: 'nope', via: 'code' }),
    {
      ok: false,
      problem: 'unknown_code',
    },
  );
  const r = await registerAffiliate(sql, { accountId: brock.id, code: 'misty', via: 'link' });
  assert.ok(r.ok && r.created);
  const again = await registerAffiliate(sql, { accountId: brock.id, code: 'MISTY', via: 'app' });
  assert.ok(again.ok && !again.created, 'the same code again is fine');
  assert.deepEqual(
    await registerAffiliate(sql, { accountId: brock.id, code: 'ASH', via: 'code' }),
    {
      ok: false,
      problem: 'already_registered',
    },
  );
  assert.deepEqual(await affiliateDiscount(sql, brock.id), {
    code: 'MISTY',
    percent: 20,
    months: 3,
    googleOfferId: 'creator-20-3m',
    appleOfferCode: null,
  });
  // an inactive link gives no discount (the registration stays)
  await sql`UPDATE affiliate_links SET active = false WHERE id = ${mistyLink}`;
  assert.equal(await affiliateDiscount(sql, brock.id), null);
  await sql`UPDATE affiliate_links SET active = true WHERE id = ${mistyLink}`;
});

test('website: the checkout carries the coupon, the first purchase is noted', async () => {
  const gary = await account('gary@example.com');
  assert.ok((await registerAffiliate(sql, { accountId: gary.id, code: 'MISTY', via: 'code' })).ok);
  const url = await startSubscription(sql, billing, {
    account: gary,
    form: form(),
    tax: { regime: 'domestic', behavior: 'incl', taxId: null, viesName: null },
    locale: 'de',
    successUrl: `${BASE}/ok`,
    cancelUrl: `${BASE}/no`,
  });
  const session = billing.store.sessions.get(url.split('/').pop()!)!;
  assert.deepEqual(session.input.discount, {
    code: 'MISTY',
    percent: 20,
    months: 3,
    googleOfferId: 'creator-20-3m',
    appleOfferCode: null,
  });
  const paid = billing.pay(session.id);
  assert.equal(billing.store.subs.get(paid.subscriptionId)?.affiliateCode, 'MISTY');
  assert.equal(billing.store.invoices.get(paid.invoiceId)?.total, Math.round(700 * 0.8));
  await handleBillingEvent(sql, billing, {
    type: 'checkout_completed',
    subscriptionId: paid.subscriptionId,
  });
  const a = await accountAffiliate(sql, gary.id);
  assert.ok(a?.firstPurchaseAt);
  assert.equal(a?.discountUsed, true);
  // a customer now: no more discount, no other code
  assert.equal(await affiliateDiscount(sql, gary.id), null);

  // a customer without a code can't get one any more
  const old = await account('old@example.com');
  const url2 = await startSubscription(sql, billing, {
    account: old,
    form: form(),
    tax: { regime: 'domestic', behavior: 'incl', taxId: null, viesName: null },
    locale: 'de',
    successUrl: `${BASE}/ok`,
    cancelUrl: `${BASE}/no`,
  });
  const s2 = billing.store.sessions.get(url2.split('/').pop()!)!;
  assert.equal(s2.input.discount, null);
  const p2 = billing.pay(s2.id);
  await handleBillingEvent(sql, billing, {
    type: 'checkout_completed',
    subscriptionId: p2.subscriptionId,
  });
  assert.deepEqual(await registerAffiliate(sql, { accountId: old.id, code: 'ASH', via: 'code' }), {
    ok: false,
    problem: 'already_customer',
  });
});

test('Google Play: the offer id goes to the app, the purchase with it counts', async () => {
  const play = new FakePlay();
  const tracey = await account('tracey@example.com');
  assert.ok((await registerAffiliate(sql, { accountId: tracey.id, code: 'MISTY', via: 'app' })).ok);
  const offers = storeOffers(await storeProducts(sql), await affiliateDiscount(sql, tracey.id));
  assert.equal(offers[1]!.google?.offer_id, 'creator-20-3m');
  assert.equal(storeOffers(await storeProducts(sql), null)[1]!.google?.offer_id, null);

  play.subs.set('tok-tracey', {
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    regionCode: 'US',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    externalAccountIdentifiers: { obfuscatedExternalAccountId: tracey.storeRef },
    lineItems: [
      {
        productId: 'oc_creator',
        expiryTime: new Date(Date.now() + 30 * DAY).toISOString(),
        autoRenewingPlan: { autoRenewEnabled: true },
        offerDetails: { basePlanId: 'monthly', offerId: 'creator-20-3m' },
      },
    ],
  });
  assert.ok(
    (await processGooglePurchase(sql, play, { token: 'tok-tracey', accountId: tracey.id })).ok,
  );
  const a = await accountAffiliate(sql, tracey.id);
  assert.equal(a?.discountUsed, true);
  const [r] = await sql<
    { first_purchase_source: string; first_country: string; first_plan: string }[]
  >`
    SELECT first_purchase_source, first_country, first_plan FROM affiliate_registrations
     WHERE account_id = ${tracey.id}`;
  assert.deepEqual(r, {
    first_purchase_source: 'google_play',
    first_country: 'US',
    first_plan: 'creator',
  });
});

test('export: every registration of the period, deleted accounts too', async () => {
  const lt = await account('lt.surge@example.com');
  await registerAffiliate(sql, {
    accountId: lt.id,
    code: 'ASH',
    via: 'link',
    now: new Date('2026-10-15T10:00:00Z'),
  });
  await deleteAccount(sql, lt.id);

  const now = new Date();
  const rows = await affiliateRegistrations(sql, {
    from: new Date(now.getTime() - DAY),
    to: new Date(now.getTime() + DAY),
  });
  assert.deepEqual(
    rows.map((r) => [r.code, r.source, r.discountUsed, r.now]),
    [
      ['MISTY', null, null, 'none'], // brock: registered, no purchase
      ['MISTY', 'stripe', true, 'running'], // gary
      ['MISTY', 'google_play', true, 'running'], // tracey
    ],
  );
  const october = await affiliateRegistrations(sql, {
    from: new Date('2026-10-01T00:00:00+02:00'),
    to: new Date('2026-11-01T00:00:00+01:00'),
  });
  assert.equal(october.length, 1);
  assert.equal(october[0]!.affiliate, 'Ash');
  assert.equal(october[0]!.accountDeleted, true);

  const csv = affiliateCsv(rows);
  assert.ok(csv.startsWith('﻿Registriert am;Influencer;'));
  const line = csv.split('\r\n')[2]!;
  assert.match(
    line,
    /;Misty \(YouTube\);US;20 % des ersten Jahres;MISTY;YouTube;20 % für 3 Monate, Play-Angebot creator-20-3m;Code \(Website\);/,
  );
  assert.match(line, /;Website;Collector;monatlich;AT;ja;läuft$/);
  assert.equal(csv.split('\r\n').length, 5, 'header, 3 rows, final newline');
});

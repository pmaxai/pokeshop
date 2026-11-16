import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import { redeemLoginLink, requestLoginLink, type Account } from '../../src/accounts.ts';
import { fakeBilling } from '../../src/billing.ts';
import {
  changeDeviceSubscription,
  DevicesRejected,
  settleDeviceSubscriptions,
  startDeviceCheckout,
} from '../../src/device-subscriptions.ts';
import { appStatus, createPairingCode, pairDevice } from '../../src/devices.ts';
import {
  parseGoogleSubscription,
  processGooglePurchase,
  PurchaseInvalid,
  saveStoreProducts,
  setTestStoreState,
  storeOffers,
  storeProducts,
  type GooglePlay,
  type GoogleSubscription,
} from '../../src/store.ts';
import {
  deviceSubscriptionOf,
  entitlements,
  handleBillingEvent,
  subscriptionOf,
  validateSubscribe,
  type SubscribeForm,
} from '../../src/subscriptions.ts';

let sql: Sql;
let drop: () => Promise<void>;
const BASE = 'http://localhost:3000';
const DAY = 86400_000;
const billing = fakeBilling(BASE);

class FakePlay implements GooglePlay {
  subs = new Map<string, Record<string, unknown>>();
  acks: string[] = [];
  async getSubscription(token: string): Promise<GoogleSubscription> {
    const raw = this.subs.get(token);
    if (!raw) throw new PurchaseInvalid('HTTP 404');
    return parseGoogleSubscription(raw);
  }
  async acknowledge(productId: string, token: string) {
    this.acks.push(`${productId}:${token}`);
  }
  async cancel() {}
}

const line = (productId: string, days = 30, renew = true) => ({
  productId,
  expiryTime: new Date(Date.now() + days * DAY).toISOString(),
  autoRenewingPlan: { autoRenewEnabled: renew },
  offerDetails: { basePlanId: 'monthly' },
});
const purchase = (ref: string, lines: unknown[], state = 'SUBSCRIPTION_STATE_ACTIVE') => ({
  subscriptionState: state,
  latestOrderId: 'GPA.1234-5678-9012-34567',
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
  externalAccountIdentifiers: { obfuscatedExternalAccountId: ref },
  lineItems: lines,
});

async function account(email: string): Promise<Account> {
  await requestLoginLink(sql, { email, locale: 'de', baseUrl: BASE });
  const [m] = await sql<{ payload: { url: string } }[]>`
    SELECT payload FROM outbox WHERE to_address = ${email} ORDER BY id DESC LIMIT 1`;
  const r = await redeemLoginLink(sql, new URL(m!.payload.url).searchParams.get('t')!);
  assert.ok(r.ok);
  return r.account;
}

const form = (extraDevices: number): SubscribeForm => {
  const v = validateSubscribe({
    plan: 'collector',
    extraDevices: String(extraDevices),
    buyer: 'consumer',
    name: 'Brock',
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
const tax = { regime: 'domestic' as const, behavior: 'incl' as const, taxId: null, viesName: null };

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
  const r = await saveStoreProducts(sql, {
    google: {
      collector: {
        product_id: 'oc_collector',
        base_plans: { monthly: 'monthly', yearly: 'yearly' },
        device_product_ids: ['oc_collector_device_1', 'oc_collector_device_2', '', ''],
      },
      creator: {
        product_id: 'oc_creator',
        base_plans: { monthly: 'monthly', yearly: 'yearly' },
        device_product_ids: ['oc_creator_device_1'],
      },
    },
    apple: { collector: { monthly: null, yearly: null }, creator: { monthly: null, yearly: null } },
  });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
});
after(async () => drop());

test('device products: saved, unique, offered to the app', async () => {
  const p = await storeProducts(sql);
  assert.deepEqual(p.google.collector.device_product_ids, [
    'oc_collector_device_1',
    'oc_collector_device_2',
  ]);
  const dup = await saveStoreProducts(sql, {
    ...p,
    google: {
      ...p.google,
      creator: { ...p.google.creator, device_product_ids: ['oc_collector_device_1'] },
    },
  });
  assert.deepEqual(dup, { ok: false, errors: ['google.creator.device_product_ids.0'] });
  const tooMany = await saveStoreProducts(sql, {
    ...p,
    google: {
      ...p.google,
      creator: { ...p.google.creator, device_product_ids: ['a1', 'a2', 'a3', 'a4', 'a5'] },
    },
  });
  assert.equal(tooMany.ok, false);
  const offers = storeOffers(p);
  assert.deepEqual(offers[0]!.google?.device_product_ids, [
    'oc_collector_device_1',
    'oc_collector_device_2',
  ]);
});

test('add-ons of the plan count as extra devices', async () => {
  const play = new FakePlay();
  const a = await account('misty@example.com');
  play.subs.set(
    'tok-misty',
    purchase(a.storeRef, [
      line('oc_collector_device_1'),
      line('oc_collector'),
      line('oc_collector_device_2'),
      line('oc_creator_device_1'), // another plan's device: does not count
      line('oc_collector_device_9'), // not a product of ours
    ]),
  );
  const r = await processGooglePurchase(sql, play, {
    token: 'tok-misty',
    productId: 'oc_collector',
    accountId: a.id,
  });
  assert.ok(r.ok);
  assert.equal(r.purchase.productId, 'oc_collector', 'the plan item, not the first line');
  assert.equal(r.purchase.deviceAddOns.length, 2);
  assert.deepEqual(play.acks, ['oc_collector:tok-misty']);
  const sub = await subscriptionOf(sql, a.id);
  assert.equal(sub?.devicesInStore, 2);
  assert.equal(entitlements(sub, a).seats, 3);

  // a removed add-on runs to the end of its period, then no longer counts
  play.subs.set(
    'tok-misty',
    purchase(a.storeRef, [
      line('oc_collector'),
      line('oc_collector_device_1'),
      line('oc_collector_device_2', -1, false),
    ]),
  );
  await processGooglePurchase(sql, play, { token: 'tok-misty', accountId: null });
  assert.equal(entitlements(await subscriptionOf(sql, a.id), a).seats, 2);

  // the app reports the add-on's product id: still the same purchase
  const again = await processGooglePurchase(sql, play, {
    token: 'tok-misty',
    productId: 'oc_collector_device_1',
    accountId: a.id,
  });
  assert.ok(again.ok);

  // a purchase of a device product alone is not a subscription
  const b = await account('gary@example.com');
  play.subs.set('tok-gary', purchase(b.storeRef, [line('oc_collector_device_1')]));
  const alone = await processGooglePurchase(sql, play, {
    token: 'tok-gary',
    productId: 'oc_collector_device_1',
    accountId: b.id,
  });
  assert.deepEqual(alone, { ok: false, problem: 'invalid_purchase' });
});

test('test hooks: test_active-d2 and store-event devices', async () => {
  const a = await account('hooks@example.com');
  const r = await processGooglePurchase(sql, null, {
    token: 'test_active-d2',
    productId: 'oc_creator',
    accountId: a.id,
    storeRef: a.storeRef,
    testHooks: true,
  });
  assert.ok(r.ok);
  assert.equal(entitlements(await subscriptionOf(sql, a.id), a).seats, 3);
  await setTestStoreState(sql, a.storeRef, 'renewed', new Date(), 4);
  assert.equal(entitlements(await subscriptionOf(sql, a.id), a).seats, 5);
  await setTestStoreState(sql, a.storeRef, 'renewed');
  assert.equal(entitlements(await subscriptionOf(sql, a.id), a).seats, 5, 'kept without devices');
});

test('devices in the portal for a Play subscription: buy, change, end with a refund', async () => {
  const play = new FakePlay();
  const a = await account('brock@example.com');

  // no store subscription: nothing to add devices to
  await assert.rejects(
    startDeviceCheckout(sql, billing, {
      account: a,
      form: form(2),
      tax,
      locale: 'de',
      successUrl: `${BASE}/ok`,
      cancelUrl: `${BASE}/no`,
    }),
    (e: unknown) => e instanceof DevicesRejected && e.reason === 'no_store_subscription',
  );

  play.subs.set('tok-brock', purchase(a.storeRef, [line('oc_creator')]));
  assert.ok((await processGooglePurchase(sql, play, { token: 'tok-brock', accountId: a.id })).ok);
  const url = await startDeviceCheckout(sql, billing, {
    account: a,
    form: form(2), // the form says collector; the store plan (creator) decides the price
    tax,
    locale: 'de',
    successUrl: `${BASE}/ok`,
    cancelUrl: `${BASE}/no`,
  });
  const paid = billing.pay(url.split('/').pop()!);
  const s = billing.store.subs.get(paid.subscriptionId)!;
  assert.equal(s.kind, 'devices');
  assert.equal(s.plan, null);
  assert.equal(s.devicePlan, 'creator');
  await handleBillingEvent(sql, billing, {
    type: 'checkout_completed',
    subscriptionId: paid.subscriptionId,
  });
  await handleBillingEvent(sql, billing, {
    type: 'invoice_paid',
    invoiceId: paid.invoiceId,
    subscriptionId: paid.subscriptionId,
    reason: 'subscription_create',
  });
  const [mail] = await sql<{ template: string }[]>`
    SELECT template FROM outbox WHERE to_address = 'brock@example.com' ORDER BY id DESC LIMIT 1`;
  assert.equal(mail!.template, 'subscription_invoice', 'no welcome mail for devices');
  // the website subscription row is untouched; the devices count for the store subscription
  const [web] = await sql`SELECT 1 FROM subscriptions WHERE account_id = ${a.id}`;
  assert.equal(web, undefined);
  let sub = await subscriptionOf(sql, a.id);
  assert.equal(sub?.source, 'google_play');
  assert.equal(sub?.devicesOnWeb, 2);
  assert.equal(entitlements(sub, a).seats, 3);

  // a second checkout is refused; the count is changed instead
  await assert.rejects(
    startDeviceCheckout(sql, billing, {
      account: a,
      form: form(1),
      tax,
      locale: 'de',
      successUrl: `${BASE}/ok`,
      cancelUrl: `${BASE}/no`,
    }),
    (e: unknown) => e instanceof DevicesRejected && e.reason === 'already_active',
  );
  await changeDeviceSubscription(sql, billing, a, 3);
  assert.equal(entitlements(await subscriptionOf(sql, a.id), a).seats, 4);

  // fewer than connected: refused
  const paired = [];
  for (let i = 0; i < 4; i++) {
    const code = await createPairingCode(sql, a);
    assert.ok(code.ok, JSON.stringify(code));
    const r = await pairDevice(sql, {
      code: code.code,
      deviceUuid: `0000000${i}-0000-4000-8000-000000000000`,
      platform: 'android',
    });
    assert.ok(r.ok, JSON.stringify(r));
    paired.push(r.device);
  }
  await assert.rejects(
    changeDeviceSubscription(sql, billing, a, 1),
    (e: unknown) => e instanceof DevicesRejected && e.reason === 'devices_in_use' && e.inUse === 4,
  );
  await sql`UPDATE devices SET ended_at = now(), end_reason = 'removed' WHERE id = ${paired[0]!.id}`;

  // the app sees where the devices come from
  const st = await appStatus(sql, a, paired[1]!, { baseUrl: BASE });
  assert.deepEqual(st.subscription.devices, {
    included: 1,
    extra: 3,
    in_store: 0,
    on_web: 3,
    in_use: 3,
  });

  // the Play plan changes to Collector: the device price follows
  play.subs.set('tok-brock', purchase(a.storeRef, [line('oc_collector')]));
  await processGooglePurchase(sql, play, { token: 'tok-brock', accountId: null });
  const s1 = await settleDeviceSubscriptions(sql, billing);
  assert.deepEqual(s1, { ended: 0, repriced: 1, failed: 0 });
  assert.equal((await deviceSubscriptionOf(sql, a.id))?.plan, 'collector');

  // the Play subscription ends: the devices end at once, the rest is refunded
  play.subs.set(
    'tok-brock',
    purchase(a.storeRef, [line('oc_collector', -1, false)], 'SUBSCRIPTION_STATE_EXPIRED'),
  );
  await processGooglePurchase(sql, play, { token: 'tok-brock', accountId: null });
  const s2 = await settleDeviceSubscriptions(sql, billing, new Date(Date.now() + 10 * DAY));
  assert.deepEqual(s2, { ended: 1, repriced: 0, failed: 0 });
  const d = await deviceSubscriptionOf(sql, a.id);
  assert.equal(d?.endedReason, 'store_ended');
  assert.ok((d?.refundedCents ?? 0) > 0, 'about two thirds of the month back');
  assert.equal(billing.store.refunds?.at(-1)?.cents, d?.refundedCents);
  const [ended] = await sql<{ template: string; payload: { refunded_cents: number } }[]>`
    SELECT template, payload FROM outbox WHERE to_address = 'brock@example.com'
     ORDER BY id DESC LIMIT 1`;
  assert.equal(ended!.template, 'devices_ended');
  assert.equal(ended!.payload.refunded_cents, d?.refundedCents);
  assert.deepEqual(await settleDeviceSubscriptions(sql, billing), {
    ended: 0,
    repriced: 0,
    failed: 0,
  });
  sub = await subscriptionOf(sql, a.id);
  assert.equal(entitlements(sub, a).active, false);
});

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import {
  deleteUnconfirmedAppAccounts,
  revokeAppleTokens,
  signInWithIdentity,
} from '../../src/app-signin.ts';
import { deleteAccount, type Account } from '../../src/accounts.ts';
import { appStatus, deviceByToken } from '../../src/devices.ts';
import { appStoreClient, type AppleSignInKey, type AppStore } from '../../src/apple.ts';
import {
  applePlanOf,
  processGooglePurchase,
  PurchaseInvalid,
  saveStoreProducts,
  setTestStoreState,
  storeDevicesOf,
  storeOffers,
  storeProducts,
  StoreUnavailable,
} from '../../src/store.ts';
import {
  handleAppleNotification,
  noticeUncountedAppleDevices,
  processApplePurchase,
  recheckApplePurchases,
} from '../../src/store-apple.ts';
import { subscriptionOf } from '../../src/subscriptions.ts';
import {
  accountAffiliate,
  affiliateDiscount,
  registerAffiliate,
  saveAffiliate,
  saveAffiliateLink,
} from '../../src/affiliates.ts';
import { encryptSecret } from '../../src/secrets.ts';
import { appleTx, BUNDLE, FakeAppleApi, signApple, TEST_ROOT, testP8 } from '../apple-fixture.ts';

let sql: Sql;
let drop: () => Promise<void>;
const BASE = 'http://localhost:3000';
const DAY = 86400_000;
const api = new FakeAppleApi();
let store: AppStore;
const masterKey = randomBytes(32);

const PRODUCTS = {
  google: {
    collector: { product_id: 'oc_collector', base_plans: { monthly: 'monthly', yearly: 'yearly' } },
    creator: { product_id: 'oc_creator', base_plans: { monthly: 'monthly', yearly: 'yearly' } },
  },
  apple: {
    collector: {
      monthly: 'oc.collector.monthly',
      yearly: 'oc.collector.yearly',
      device_product_ids: {
        monthly: ['oc.collector.devices1.monthly', 'oc.collector.devices2.monthly'],
        yearly: [],
      },
    },
    creator: {
      monthly: 'oc.creator.monthly',
      yearly: 'oc.creator.yearly',
      device_product_ids: {
        monthly: ['oc.creator.devices1.monthly', '', 'oc.creator.devices3.monthly'],
        yearly: [],
      },
    },
  },
};

async function signIn(email: string, n: number, provider: 'google' | 'apple' = 'apple') {
  const r = await signInWithIdentity(
    sql,
    { provider, subject: `${provider}-${email}`, email, name: null },
    { deviceUuid: `device-${n}-0000-4000-8000-000000000000`, platform: 'ios' },
    { baseUrl: BASE },
  );
  assert.ok(r.ok);
  return r;
}

const status = async (token: string) => {
  const d = await deviceByToken(sql, token);
  assert.ok(d.ok);
  return appStatus(sql, d.account, d.device, { baseUrl: BASE });
};

/** The app reports a signed transaction (a real one, checked against the test root). */
const report = (a: Account, jws: string) =>
  processApplePurchase(sql, store, {
    signedTransaction: jws,
    accountId: a.id,
    storeRef: a.storeRef,
  });

const hook = (a: Account, token: string) =>
  processApplePurchase(sql, null, {
    signedTransaction: token,
    accountId: a.id,
    storeRef: a.storeRef,
    testHooks: true,
  });

before(async () => {
  ({ sql, drop } = await freshDatabase());
  assert.ok((await saveStoreProducts(sql, PRODUCTS)).ok);
  const p8 = testP8();
  store = appStoreClient({
    bundleId: BUNDLE,
    issuerId: 'issuer',
    keyId: 'KEY',
    privateKey: p8.pem,
    fetch: api.fetch,
    roots: [TEST_ROOT],
  });
});
after(async () => drop());

test('products: plans and extra devices per period, offers for the app', async () => {
  const p = await storeProducts(sql);
  assert.deepEqual(applePlanOf(p, 'oc.creator.yearly'), {
    kind: 'plan',
    plan: 'creator',
    period: 'yearly',
  });
  assert.deepEqual(applePlanOf(p, 'oc.creator.devices3.monthly'), {
    kind: 'devices',
    plan: 'creator',
    period: 'monthly',
    devices: 3,
  });
  assert.equal(applePlanOf(p, 'oc.other'), null);
  // a gap keeps the positions: [i] is always the product for i + 1 devices
  assert.deepEqual(p.apple.creator.device_product_ids.monthly, [
    'oc.creator.devices1.monthly',
    null,
    'oc.creator.devices3.monthly',
  ]);
  const offers = storeOffers(p);
  assert.deepEqual(offers[0]!.apple, {
    product_ids: { monthly: 'oc.collector.monthly', yearly: 'oc.collector.yearly' },
    device_product_ids: {
      monthly: ['oc.collector.devices1.monthly', 'oc.collector.devices2.monthly'],
      yearly: [],
    },
  });
  const dup = structuredClone(PRODUCTS);
  (dup.apple.creator.device_product_ids as { yearly: string[] }).yearly = ['oc.collector.monthly'];
  assert.equal((await saveStoreProducts(sql, dup)).ok, false, 'one product id twice');
});

test('a transaction reported by the app: checked, read from Apple, unlocks the app', async () => {
  const r = await signIn('ada@example.com', 1);
  const ada = r.account;
  const end = new Date(Date.now() + 30 * DAY);
  const tx = appleTx({
    original: '3000000001',
    product: 'oc.collector.monthly',
    expires: end,
    token: ada.storeRef,
  });
  api.subs.set('3000000001', { status: 1, tx });
  const res = await report(ada, signApple(tx));
  assert.ok(res.ok);
  assert.equal(res.purchase.store, 'app_store');
  assert.equal(res.purchase.purchaseToken, '3000000001');
  let s = await status(r.token);
  assert.equal(s.status, 'active');
  assert.equal(s.subscription.source, 'app_store');
  assert.equal(s.subscription.plan, 'collector');
  assert.equal(s.subscription.base_plan, 'monthly');
  assert.equal(s.subscription.manage_url, 'https://apps.apple.com/account/subscriptions');
  assert.equal(s.valid_until, end.toISOString());
  // the same again: the same answer
  assert.ok((await report(ada, signApple(tx))).ok);
  // an upgrade in the group: same original transaction, now Creator yearly
  const up = appleTx({
    original: '3000000001',
    product: 'oc.creator.yearly',
    expires: new Date(Date.now() + 365 * DAY),
    token: ada.storeRef,
    transactionId: '3000000002',
  });
  api.subs.set('3000000001', { status: 1, tx: up });
  assert.ok((await report(ada, signApple(up))).ok);
  s = await status(r.token);
  assert.equal(s.subscription.plan, 'creator');
  assert.equal(s.subscription.base_plan, 'yearly');
  assert.equal(s.features.youtube, true);

  // extra devices: their own subscription, counted for the same plan
  const dev = appleTx({
    original: '3000000010',
    product: 'oc.creator.devices3.monthly',
    expires: new Date(Date.now() + 30 * DAY),
    token: ada.storeRef,
  });
  api.subs.set('3000000010', { status: 1, tx: dev });
  const d = await report(ada, signApple(dev));
  assert.ok(d.ok);
  assert.equal(d.purchase.kind, 'devices');
  assert.equal(d.purchase.devices, 3);
  s = await status(r.token);
  assert.equal(s.subscription.plan, 'creator', 'the devices are not the subscription');
  assert.equal(s.subscription.devices.in_store, 3);
  assert.equal(s.subscription.devices.extra, 3);
  const sub = await subscriptionOf(sql, ada.id);
  assert.equal(sub?.devicesInStore, 3);

  // refused: not signed by Apple, another app, not a subscription, unknown at Apple
  const forged = signApple(tx).slice(0, -6) + 'AAAAAA';
  await assert.rejects(report(ada, forged), PurchaseInvalid);
  await assert.rejects(report(ada, signApple({ ...tx, bundleId: 'com.other' })), {
    message: 'another app',
  });
  await assert.rejects(report(ada, signApple({ ...tx, type: 'Consumable' })), {
    message: 'not a subscription',
  });
  await assert.rejects(
    report(ada, signApple(appleTx({ original: '3000009999', product: 'x', expires: end }))),
    PurchaseInvalid,
  );
  api.down = true;
  await assert.rejects(report(ada, signApple(tx)), StoreUnavailable);
  api.down = false;
  await assert.rejects(
    processApplePurchase(sql, null, { signedTransaction: signApple(tx), accountId: ada.id }),
    StoreUnavailable,
  );
});

test('bought for another account; offer-code sheet purchases belong to the reporter', async () => {
  const bo = (await signIn('bo@example.com', 2)).account;
  const cy = (await signIn('cy@example.com', 3)).account;
  const tx = appleTx({
    original: '3000000020',
    product: 'oc.collector.monthly',
    expires: new Date(Date.now() + 30 * DAY),
    token: bo.storeRef,
  });
  api.subs.set('3000000020', { status: 1, tx });
  const r = await report(cy, signApple(tx));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.problem, 'linked_elsewhere');
  assert.equal(!r.ok && r.problem === 'linked_elsewhere' && r.owner, 'b***@example.com');
  // a notification still stores it for its account
  assert.equal(
    await handleAppleNotification(
      sql,
      store,
      {
        signedPayload: signApple({
          notificationType: 'SUBSCRIBED',
          subtype: 'INITIAL_BUY',
          data: {
            bundleId: BUNDLE,
            environment: 'Production',
            signedTransactionInfo: signApple(tx),
          },
          signedDate: Date.now(),
        }),
      },
      new Date(),
    ),
    200,
  );
  assert.equal((await subscriptionOf(sql, bo.id))?.source, 'app_store');

  // Apple's offer-code sheet: no appAccountToken
  const code = appleTx({
    original: '3000000030',
    product: 'oc.creator.monthly',
    expires: new Date(Date.now() + 30 * DAY),
    token: null,
    offerType: 3,
    offerIdentifier: 'NOBODY',
  });
  api.subs.set('3000000030', { status: 1, tx: code });
  const c = await report(cy, signApple(code));
  assert.ok(c.ok);
  assert.equal(c.accountId, cy.id);
  // …and it stays with that account
  const r2 = await report(bo, signApple(code));
  assert.equal(!r2.ok && r2.problem, 'linked_elsewhere');
});

test('one paid source at a time: refused, and counted once the other has ended', async () => {
  const r = await signIn('dee@example.com', 4);
  const dee = r.account;
  await processGooglePurchase(sql, null, {
    token: 'test_active-dee',
    accountId: dee.id,
    storeRef: dee.storeRef,
    testHooks: true,
  });
  assert.equal((await subscriptionOf(sql, dee.id))?.source, 'google_play');
  const tx = appleTx({
    original: '3000000040',
    product: 'oc.creator.monthly',
    expires: new Date(Date.now() + 30 * DAY),
    token: dee.storeRef,
  });
  api.subs.set('3000000040', { status: 1, tx });
  const refused = await report(dee, signApple(tx));
  assert.equal(!refused.ok && refused.problem, 'already_subscribed');
  assert.equal(
    !refused.ok && refused.problem === 'already_subscribed' && refused.source,
    'google_play',
  );
  assert.equal((await subscriptionOf(sql, dee.id))?.source, 'google_play');
  // Google's ends; at the next read the App Store subscription counts
  await sql`UPDATE store_purchases SET state = 'expired', expires_at = now() - interval '1 minute'
             WHERE store = 'google_play' AND account_id = ${dee.id}`;
  const later = await report(dee, signApple(tx));
  assert.ok(later.ok);
  assert.equal(later.purchase.refused, null);
  const s = await status(r.token);
  assert.equal(s.subscription.source, 'app_store');
  assert.equal(s.subscription.plan, 'creator');
});

test('states over time: grace, billing retry, refund, notifications and the re-read', async () => {
  const r = await signIn('eli@example.com', 5);
  const eli = r.account;
  const end = new Date(Date.now() + DAY);
  const tx = appleTx({
    original: '3000000050',
    product: 'oc.collector.monthly',
    expires: end,
    token: eli.storeRef,
  });
  api.subs.set('3000000050', { status: 1, tx, autoRenew: false });
  assert.ok((await report(eli, signApple(tx))).ok);
  let s = await status(r.token);
  assert.equal(s.status, 'active');
  assert.equal(s.subscription.state, 'canceled');
  assert.equal(s.subscription.ends_at, end.toISOString(), 'cancelled: runs to its end');

  const note = (type: string) =>
    handleAppleNotification(sql, store, {
      signedPayload: signApple({
        notificationType: type,
        data: { bundleId: BUNDLE, environment: 'Production', signedTransactionInfo: signApple(tx) },
        signedDate: Date.now(),
      }),
    });
  const grace = new Date(Date.now() + 3 * DAY);
  api.subs.set('3000000050', { status: 4, tx, grace });
  assert.equal(await note('DID_FAIL_TO_RENEW'), 200);
  s = await status(r.token);
  assert.equal(s.status, 'active');
  assert.equal(s.valid_until, grace.toISOString());

  api.subs.set('3000000050', { status: 3, tx });
  assert.equal(await note('DID_FAIL_TO_RENEW'), 200);
  assert.equal((await status(r.token)).status, 'inactive');

  api.subs.set('3000000050', { status: 1, tx: { ...tx, revocationDate: Date.now() } });
  assert.equal(await note('REFUND'), 200);
  const [row] = await sql<{ state: string }[]>`
    SELECT state FROM store_purchases WHERE purchase_token = '3000000050'`;
  assert.equal(row!.state, 'revoked');

  // what the server can't use: still 200; not Apple's: 400; Apple down: 503 (Apple retries)
  assert.equal(
    await handleAppleNotification(sql, store, {
      signedPayload: signApple({ notificationType: 'TEST', data: { bundleId: BUNDLE } }),
    }),
    200,
  );
  assert.equal(
    await handleAppleNotification(sql, store, {
      signedPayload: signApple({
        notificationType: 'DID_RENEW',
        data: { bundleId: 'com.other', signedTransactionInfo: signApple(tx) },
      }),
    }),
    200,
  );
  assert.equal(await handleAppleNotification(sql, store, { signedPayload: 'a.b.c' }), 400);
  assert.equal(await handleAppleNotification(sql, store, {}), 400);
  api.down = true;
  assert.equal(await note('DID_RENEW'), 503);
  api.down = false;
  assert.equal(await handleAppleNotification(sql, null, {}), 503);

  // the daily re-read: a renewal whose notification never came
  api.subs.set('3000000050', {
    status: 1,
    tx: { ...tx, expiresDate: Date.now() + 30 * DAY, transactionId: '3000000059' },
  });
  await sql`UPDATE store_purchases SET state = 'active', checked_at = now() - interval '1 day'
             WHERE purchase_token = '3000000050'`;
  const re = await recheckApplePurchases(sql, store);
  assert.ok(re.checked >= 1);
  assert.equal((await status(r.token)).status, 'active');
});

test('staging hooks: test_ transactions per group, store-event moves them', async () => {
  const r = await signIn('fay@example.com', 6);
  const fay = r.account;
  assert.ok((await hook(fay, 'test_active')).ok);
  let s = await status(r.token);
  assert.equal(s.subscription.source, 'app_store');
  assert.equal(s.subscription.plan, 'collector');
  // an upgrade: the same purchase
  assert.ok((await hook(fay, 'test_active-creator-yearly')).ok);
  s = await status(r.token);
  assert.equal(s.subscription.plan, 'creator');
  assert.equal(s.subscription.base_plan, 'yearly');
  const d = await hook(fay, 'test_active-creator-d2');
  assert.ok(d.ok);
  assert.equal(d.purchase.kind, 'devices');
  assert.equal((await status(r.token)).subscription.devices.in_store, 2);
  // changing the number: the same devices subscription
  assert.ok((await hook(fay, 'test_active-creator-d1')).ok);
  assert.equal((await status(r.token)).subscription.devices.in_store, 1);
  const [{ n }] = await sql<[{ n: number }]>`
    SELECT count(*)::int AS n FROM store_purchases WHERE account_id = ${fay.id}`;
  assert.equal(n, 2);
  await assert.rejects(hook(fay, 'test_nonsense'), PurchaseInvalid);

  // POST /test/store-event
  let p = await setTestStoreState(sql, fay.storeRef, 'grace', new Date(), 3);
  assert.equal(p?.store, 'app_store');
  assert.equal(p?.state, 'grace');
  assert.equal(await storeDevicesOf(sql, p!), 3);
  s = await status(r.token);
  assert.equal(s.subscription.state, 'past_due');
  assert.equal(s.subscription.devices.in_store, 3);
  p = await setTestStoreState(sql, fay.storeRef, 'renewed', new Date(), 0);
  assert.equal(await storeDevicesOf(sql, p!), 0);
  p = await setTestStoreState(sql, fay.storeRef, 'expired');
  assert.equal((await status(r.token)).status, 'inactive');
});

test('extra devices that no longer count: the person is told once a period', async () => {
  const gus = (await signIn('gus@example.com', 7)).account;
  assert.ok((await hook(gus, 'test_active')).ok);
  assert.ok((await hook(gus, 'test_active-d2')).ok);
  const later = new Date(Date.now() + 2 * 3600_000);
  assert.equal(await noticeUncountedAppleDevices(sql, later), 0, 'they count');
  // upgraded to Creator: the Collector devices renew without counting
  assert.ok((await hook(gus, 'test_active-creator')).ok);
  assert.equal((await subscriptionOf(sql, gus.id))?.devicesInStore, 0);
  assert.equal(await noticeUncountedAppleDevices(sql, later), 1);
  assert.equal(await noticeUncountedAppleDevices(sql, later), 0, 'once');
  const [m] = await sql<{ template: string; payload: Record<string, unknown> }[]>`
    SELECT template, payload FROM outbox WHERE to_address = 'gus@example.com'
     ORDER BY id DESC LIMIT 1`;
  assert.equal(m!.template, 'store_devices_running');
  assert.equal(m!.payload.reason, 'other_plan');
  assert.equal(m!.payload.current_plan, 'creator');
  assert.equal(m!.payload.devices, 2);
  // they renew again; the subscription has ended meanwhile
  await sql`UPDATE store_purchases SET expires_at = expires_at + interval '30 days'
             WHERE account_id = ${gus.id} AND kind = 'devices'`;
  assert.ok((await hook(gus, 'test_expired-creator')).ok);
  assert.equal(await noticeUncountedAppleDevices(sql, later), 1);
  const [m2] = await sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM outbox WHERE to_address = 'gus@example.com' ORDER BY id DESC LIMIT 1`;
  assert.equal(m2!.payload.reason, 'no_subscription');
});

test('creator codes: the App Store offer code, attribution and the first purchase', async () => {
  const aff = await saveAffiliate(sql, { name: 'Misty', country: 'US' });
  assert.ok(aff.ok);
  const link = await saveAffiliateLink(sql, {
    affiliateId: aff.ok ? aff.id : 0,
    code: 'misty',
    discountPercent: 20,
    discountMonths: 3,
    appleOfferCode: 'misty20',
  });
  assert.ok(link.ok);
  assert.equal(
    (
      await saveAffiliateLink(sql, {
        affiliateId: aff.ok ? aff.id : 0,
        code: 'bad',
        discountPercent: 0,
        appleOfferCode: 'has-dash',
      })
    ).ok,
    false,
  );
  // registered in the app before buying: the offer code comes with the discount
  const hal = (await signIn('hal@example.com', 8)).account;
  assert.ok((await registerAffiliate(sql, { accountId: hal.id, code: 'MISTY', via: 'app' })).ok);
  assert.equal((await affiliateDiscount(sql, hal.id))?.appleOfferCode, 'MISTY20');
  assert.ok((await hook(hal, 'test_active-codeMISTY20')).ok);
  let a = await accountAffiliate(sql, hal.id);
  assert.ok(a?.firstPurchaseAt);
  assert.equal(a?.discountUsed, true);
  const [reg] = await sql<{ first_purchase_source: string; first_country: string }[]>`
    SELECT first_purchase_source, first_country FROM affiliate_registrations
     WHERE account_id = ${hal.id}`;
  assert.deepEqual({ ...reg }, { first_purchase_source: 'app_store', first_country: 'AT' });

  // the code redeemed in the App Store itself, outside the app: found by the offer
  const ivy = (await signIn('ivy@example.com', 9)).account;
  assert.ok((await hook(ivy, 'test_active-codeMISTY20')).ok);
  a = await accountAffiliate(sql, ivy.id);
  assert.equal(a?.link.code, 'MISTY');
  assert.equal(a?.via, 'app');
  assert.equal(a?.discountUsed, true);
  // not for someone who had paid before
  const jo = (await signIn('jo@example.com', 10)).account;
  assert.ok((await hook(jo, 'test_active')).ok);
  await sql`UPDATE store_purchases SET state = 'expired', expires_at = now() - interval '1 day'
             WHERE account_id = ${jo.id}`;
  const tx = appleTx({
    original: '3000000070',
    product: 'oc.collector.monthly',
    expires: new Date(Date.now() + 30 * DAY),
    token: jo.storeRef,
    offerType: 3,
    offerIdentifier: 'MISTY20',
  });
  api.subs.set('3000000070', { status: 1, tx });
  assert.ok((await report(jo, signApple(tx))).ok);
  assert.equal(await accountAffiliate(sql, jo.id), null);
});

test('deleting: Sign in with Apple is revoked at Apple, the App Store one is the person’s', async () => {
  const kai = await signInWithIdentity(
    sql,
    { provider: 'apple', subject: '001.kai', email: 'kai@privaterelay.appleid.com', name: null },
    { deviceUuid: 'device-11-0000-4000-8000-000000000000', platform: 'ios' },
    { baseUrl: BASE, refreshTokenEnc: encryptSecret('r.kai', masterKey) },
  );
  assert.ok(kai.ok);
  // a later sign-in without a new token keeps the old one
  assert.ok(
    (
      await signInWithIdentity(
        sql,
        { provider: 'apple', subject: '001.kai', email: null, name: null },
        { deviceUuid: 'device-12-0000-4000-8000-000000000000', platform: 'ios' },
        { baseUrl: BASE },
      )
    ).ok,
  );
  assert.ok((await hook(kai.account, 'test_active')).ok);
  const del = await deleteAccount(sql, kai.account.id);
  assert.deepEqual(
    del.cancelInStore.map((c) => c.store),
    ['app_store'],
  );
  const [{ n }] = await sql<
    [{ n: number }]
  >`SELECT count(*)::int AS n FROM apple_token_revocations`;
  assert.equal(n, 1);

  const key: AppleSignInKey = {
    teamId: 'T',
    keyId: 'K',
    privateKey: testP8().pem,
    clientId: BUNDLE,
  };
  const tokens: string[] = [];
  let up = false;
  const fake: typeof fetch = async (_u, init) => {
    if (!up) return new Response('', { status: 503 });
    tokens.push(new URLSearchParams(String(init?.body)).get('token') ?? '');
    return new Response('', { status: 200 });
  };
  let r = await revokeAppleTokens(sql, key, masterKey, { fetch: fake });
  assert.deepEqual(r, { revoked: 0, failed: 1, dropped: 0 });
  // waits before the next try
  r = await revokeAppleTokens(sql, key, masterKey, { fetch: fake });
  assert.deepEqual(r, { revoked: 0, failed: 0, dropped: 0 });
  up = true;
  r = await revokeAppleTokens(sql, key, masterKey, {
    fetch: fake,
    now: new Date(Date.now() + 2 * 3600_000),
  });
  assert.deepEqual(r, { revoked: 1, failed: 0, dropped: 0 });
  assert.deepEqual(tokens, ['r.kai']);

  // the staging hook's tokens never reach Apple
  await sql`INSERT INTO apple_token_revocations (token_enc, test) VALUES ('x', true)`;
  r = await revokeAppleTokens(sql, null, null);
  assert.deepEqual(r, { revoked: 1, failed: 0, dropped: 0 });
});

test('unconfirmed app accounts that bought in a store are kept', async () => {
  const lu = (await signIn('lu@example.com', 13)).account;
  const mo = (await signIn('mo@example.com', 14)).account;
  assert.ok((await hook(lu, 'test_active')).ok);
  await sql`UPDATE accounts SET created_at = now() - interval '40 days' WHERE id IN (${lu.id}, ${mo.id})`;
  await sql`UPDATE account_identities SET refresh_token_enc = 'enc' WHERE account_id = ${mo.id}`;
  await sql`DELETE FROM apple_token_revocations`;
  assert.equal(await deleteUnconfirmedAppAccounts(sql), 1);
  const left = await sql<
    { id: number }[]
  >`SELECT id FROM accounts WHERE id IN (${lu.id}, ${mo.id})`;
  assert.deepEqual(
    left.map((x) => Number(x.id)),
    [lu.id],
  );
  const [{ n }] = await sql<
    [{ n: number }]
  >`SELECT count(*)::int AS n FROM apple_token_revocations`;
  assert.equal(n, 1, 'its Apple sign-in is revoked too');
});

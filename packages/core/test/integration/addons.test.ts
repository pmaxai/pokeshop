import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import { signInWithIdentity } from '../../src/app-signin.ts';
import { deleteAccount } from '../../src/accounts.ts';
import { appStatus, deviceByToken } from '../../src/devices.ts';
import { appStoreClient, type AppStore } from '../../src/apple.ts';
import {
  applePlanOf,
  saveStoreProducts,
  storeAddonOffers,
  storeProducts,
} from '../../src/store.ts';
import {
  handleAppleNotification,
  noticeUncountedAppleAddons,
  processApplePurchase,
} from '../../src/store-apple.ts';
import { accountEntitlements, grantComplimentary } from '../../src/subscriptions.ts';
import { accountAddons, addonRecords, endAddon, grantAddon } from '../../src/addons.ts';
import { appleTx, BUNDLE, FakeAppleApi, signApple, TEST_ROOT, testP8 } from '../apple-fixture.ts';

let sql: Sql;
let drop: () => Promise<void>;
const BASE = 'http://localhost:3000';
const DAY = 86400_000;
const api = new FakeAppleApi();
let store: AppStore;

const PLANS = {
  collector: { monthly: 'oc.collector.monthly', yearly: 'oc.collector.yearly' },
  creator: { monthly: 'oc.creator.monthly', yearly: 'oc.creator.yearly' },
};
const NO_GOOGLE = {
  collector: { product_id: null, base_plans: { monthly: null, yearly: null } },
  creator: { product_id: null, base_plans: { monthly: null, yearly: null } },
};
const products = (addon: Record<string, unknown>) => ({
  google: NO_GOOGLE,
  apple: PLANS,
  addons: { psa_prices: addon },
});
const PSA = {
  on_sale: true,
  plans: ['collector', 'creator'],
  apple: { monthly: 'oc_psa_monthly', yearly: 'oc_psa_yearly' },
};

let n = 0;
async function signIn(email: string) {
  n++;
  const r = await signInWithIdentity(
    sql,
    { provider: 'apple', subject: `apple-${email}`, email, name: null },
    {
      deviceUuid: `addon-${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`,
      platform: 'ios',
    },
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

/** An App Store subscription as the fake App Store Server API holds it, reported by the app. */
async function buy(
  account: { id: number; storeRef: string },
  original: string,
  product: string,
  o: { days?: number; status?: number; autoRenew?: boolean; token?: string } = {},
) {
  const tx = appleTx({
    original,
    product,
    expires: new Date(Date.now() + (o.days ?? 30) * DAY),
    token: o.token ?? account.storeRef,
  });
  api.subs.set(original, { status: o.status ?? 1, tx, autoRenew: o.autoRenew });
  return processApplePurchase(sql, store, {
    signedTransaction: signApple(tx),
    accountId: account.id,
    storeRef: account.storeRef,
  });
}

/** Apple changed the subscription and notifies the server. */
async function notify(original: string, change: { status: number; days: number }) {
  const sub = api.subs.get(original)!;
  const tx = { ...sub.tx, expiresDate: Date.now() + change.days * DAY };
  api.subs.set(original, { ...sub, status: change.status, tx });
  return handleAppleNotification(sql, store, {
    signedPayload: signApple({
      notificationType: 'EXPIRED',
      data: { bundleId: BUNDLE, environment: 'Production', signedTransactionInfo: signApple(tx) },
      signedDate: Date.now(),
    }),
  });
}

before(async () => {
  ({ sql, drop } = await freshDatabase());
  assert.ok((await saveStoreProducts(sql, products(PSA))).ok);
  store = appStoreClient({
    bundleId: BUNDLE,
    issuerId: 'issuer',
    keyId: 'KEY',
    privateKey: testP8().pem,
    fetch: api.fetch,
    roots: [TEST_ROOT],
  });
});
after(async () => drop());

test('offers: the add-on with its plans and App Store products, null without ids', async () => {
  const p = await storeProducts(sql);
  assert.deepEqual(storeAddonOffers(p), [
    {
      id: 'psa_prices',
      name: 'PSA prices',
      feature: 'psa_prices',
      plans: ['collector', 'creator'],
      google: null,
      apple: { product_ids: { monthly: 'oc_psa_monthly', yearly: 'oc_psa_yearly' } },
    },
  ]);
  assert.deepEqual(applePlanOf(p, 'oc_psa_yearly'), {
    kind: 'addon',
    addon: 'psa_prices',
    period: 'yearly',
  });
  // older settings without add-ons still read, with the add-on not on sale in the stores yet
  await sql`UPDATE settings SET value = value - 'addons' WHERE key = 'store_products'`;
  const old = await storeProducts(sql);
  assert.equal(storeAddonOffers(old)[0]!.apple, null);
  assert.deepEqual(old.addons.psa_prices.plans, ['collector', 'creator']);
  // off sale: left out
  assert.ok((await saveStoreProducts(sql, products({ ...PSA, on_sale: false }))).ok);
  assert.deepEqual(storeAddonOffers(await storeProducts(sql)), []);
  // one App Store id once, plans and add-ons together
  const dup = await saveStoreProducts(
    sql,
    products({ ...PSA, apple: { monthly: 'oc.collector.monthly', yearly: null } }),
  );
  assert.deepEqual(dup, { ok: false, errors: ['addons.psa_prices.apple.monthly'] });
  assert.ok((await saveStoreProducts(sql, products(PSA))).ok);
});

test('bought beside a running plan: stored as the add-on, the plan unchanged', async () => {
  const r = await signIn('ada@example.com');
  let s = await status(r.token);
  assert.deepEqual(s.addons, []);
  assert.equal(s.features.psa_prices, false);
  assert.ok((await buy(r.account, '4000000001', 'oc.collector.monthly')).ok);
  s = await status(r.token);
  assert.equal(s.features.psa_prices, false, 'the plan alone has no PSA prices');

  const a = await buy(r.account, '4000000002', 'oc_psa_yearly', { days: 365 });
  assert.ok(a.ok, 'no already_subscribed for an add-on');
  assert.equal(a.purchase.kind, 'addon');
  assert.equal(a.purchase.addon, 'psa_prices');
  assert.equal(a.purchase.plan, null);
  s = await status(r.token);
  assert.equal(s.subscription.plan, 'collector');
  assert.equal(s.subscription.base_plan, 'monthly');
  assert.equal(s.features.psa_prices, true);
  assert.equal(s.addons.length, 1);
  assert.deepEqual(
    { ...s.addons[0], renews_at: typeof s.addons[0]!.renews_at },
    {
      id: 'psa_prices',
      state: 'active',
      source: 'app_store',
      base_plan: 'yearly',
      renews_at: 'string',
      ends_at: null,
      manage_url: 'https://apps.apple.com/account/subscriptions',
    },
  );
  // the same report again: the same answer
  assert.ok((await buy(r.account, '4000000002', 'oc_psa_yearly', { days: 365 })).ok);
  const again = (await status(r.token)).addons;
  assert.equal(again.length, 1);
  assert.equal(again[0]!.state, 'active');
  assert.equal(again[0]!.base_plan, 'yearly');
  // bought for another account
  const bo = await signIn('bo@example.com');
  const tx = api.subs.get('4000000002')!.tx;
  const other = await processApplePurchase(sql, store, {
    signedTransaction: signApple(tx),
    accountId: bo.account.id,
    storeRef: bo.account.storeRef,
  });
  assert.equal(!other.ok && other.problem, 'linked_elsewhere');

  // a plan the add-on isn't for switches the flag off while it runs
  assert.ok((await saveStoreProducts(sql, products({ ...PSA, plans: ['creator'] }))).ok);
  assert.equal((await status(r.token)).features.psa_prices, false);
  assert.ok((await saveStoreProducts(sql, products(PSA))).ok);
  assert.equal((await status(r.token)).features.psa_prices, true);

  // the plan ends first: everything off, the add-on still listed as running (it still bills)
  assert.equal(await notify('4000000001', { status: 2, days: -1 }), 200);
  s = await status(r.token);
  assert.equal(s.status, 'inactive');
  assert.equal(s.features.psa_prices, false);
  assert.equal(s.addons[0]!.state, 'active');
  // the person is told once a period that it renews without counting
  const later = new Date(Date.now() + 2 * 3600_000);
  assert.equal(await noticeUncountedAppleAddons(sql, later), 1);
  assert.equal(await noticeUncountedAppleAddons(sql, later), 0);
  const [m] = await sql<{ template: string; payload: Record<string, unknown> }[]>`
    SELECT template, payload FROM outbox WHERE to_address = 'ada@example.com'
     ORDER BY id DESC LIMIT 1`;
  assert.equal(m!.template, 'store_addon_running');
  assert.equal(m!.payload.reason, 'no_subscription');
  assert.equal(m!.payload.addon, 'psa_prices');
  // with a plan again (here one from the website), it counts again
  await grantComplimentary(
    sql,
    r.account.id,
    { plan: 'creator', extraDevices: 0, until: '', note: '' },
    'admin',
  );
  assert.equal((await status(r.token)).features.psa_prices, true);

  // the add-on is refunded: ended, the plan untouched
  assert.equal(await notify('4000000002', { status: 5, days: 300 }), 200);
  s = await status(r.token);
  assert.equal(s.features.psa_prices, false);
  assert.equal(s.addons[0]!.state, 'ended');
  assert.equal(s.status, 'active');
  assert.equal(s.subscription.plan, 'creator');
});

test('bought without a plan: stored and listed, on once a plan runs', async () => {
  const r = await signIn('cy@example.com');
  const a = await buy(r.account, '4000000011', 'oc_psa_monthly');
  assert.ok(a.ok);
  let s = await status(r.token);
  assert.equal(s.status, 'none');
  assert.equal(s.features.psa_prices, false);
  assert.equal(s.addons[0]!.id, 'psa_prices');
  assert.equal(s.addons[0]!.state, 'active');
  // a cancelled add-on still counts until its end
  await buy(r.account, '4000000011', 'oc_psa_monthly', { autoRenew: false, days: 10 });
  assert.ok((await buy(r.account, '4000000012', 'oc.creator.yearly', { days: 365 })).ok);
  s = await status(r.token);
  assert.equal(s.features.psa_prices, true);
  assert.equal(s.addons[0]!.state, 'canceled');
  assert.ok(s.addons[0]!.ends_at);
  // the add-on expires: off, the plan untouched
  assert.equal(await notify('4000000011', { status: 2, days: -1 }), 200);
  s = await status(r.token);
  assert.equal(s.features.psa_prices, false);
  assert.equal(s.addons[0]!.state, 'ended');
  assert.equal(s.subscription.plan, 'creator');
  assert.equal(s.status, 'active');
});

test('a gift from the admin: on for a running plan, off at its end date', async () => {
  const r = await signIn('dee@example.com');
  assert.ok((await buy(r.account, '4000000021', 'oc.collector.monthly')).ok);
  const until = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);
  const g = await grantAddon(
    sql,
    r.account.id,
    { addon: 'psa_prices', until, note: 'Messe' },
    'me',
  );
  assert.ok(g.ok);
  let s = await status(r.token);
  assert.equal(s.features.psa_prices, true);
  assert.equal(s.addons[0]!.state, 'complimentary');
  assert.equal(s.addons[0]!.source, 'web');
  assert.equal(s.addons[0]!.base_plan, null);
  assert.equal(s.addons[0]!.manage_url, null);
  // the portal reads the same flag
  assert.equal((await accountEntitlements(sql, r.account)).features.psa_prices, true);
  // after its end date
  const d = await deviceByToken(sql, r.token);
  assert.ok(d.ok);
  const after = await appStatus(sql, d.account, d.device, {
    baseUrl: BASE,
    now: new Date(Date.now() + 7 * DAY),
  });
  assert.equal(after.features.psa_prices, false);
  assert.equal(after.addons[0]!.state, 'ended');
  // an end in the past is refused; a new gift replaces the running one; ended at once
  assert.deepEqual(
    await grantAddon(sql, r.account.id, { addon: 'psa_prices', until: '2020-01-01' }, 'me'),
    { ok: false, errors: ['until'] },
  );
  assert.ok((await grantAddon(sql, r.account.id, { addon: 'psa_prices' }, 'me')).ok);
  const gifts = (await addonRecords(sql, r.account.id)).filter((x) => x.kind === 'complimentary');
  assert.equal(gifts.filter((x) => x.runs).length, 1);
  assert.equal(await endAddon(sql, r.account.id, 'psa_prices'), 1);
  s = await status(r.token);
  assert.equal(s.features.psa_prices, false);

  // deleting the account takes its add-ons with it
  assert.ok((await grantAddon(sql, r.account.id, { addon: 'psa_prices' }, 'me')).ok);
  await deleteAccount(sql, r.account.id);
  const [{ n: gone }] = await sql<[{ n: number }]>`
    SELECT count(*)::int AS n FROM account_addons WHERE account_id = ${r.account.id}`;
  assert.equal(gone, 0);
  assert.deepEqual(
    (await accountAddons(sql, r.account.id)).filter((a) => a.source === 'web'),
    [],
  );
  const dev = await deviceByToken(sql, r.token);
  assert.equal(dev.ok, false);
});

test('staging hooks: test_active-psa is the add-on', async () => {
  const r = await signIn('eli@example.com');
  const hook = (t: string) =>
    processApplePurchase(sql, null, {
      signedTransaction: t,
      accountId: r.account.id,
      storeRef: r.account.storeRef,
      testHooks: true,
    });
  assert.ok((await hook('test_active')).ok);
  const a = await hook('test_active-psa-yearly');
  assert.ok(a.ok);
  assert.equal(a.purchase.kind, 'addon');
  let s = await status(r.token);
  assert.equal(s.features.psa_prices, true);
  assert.equal(s.addons[0]!.base_plan, 'yearly');
  assert.equal(s.subscription.plan, 'collector');
  // the same group: expired
  assert.ok((await hook('test_expired-psa')).ok);
  s = await status(r.token);
  assert.equal(s.features.psa_prices, false);
  assert.equal(s.addons[0]!.state, 'ended');
});

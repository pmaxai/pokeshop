import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import { signInWithIdentity } from '../../src/app-signin.ts';
import type { Account } from '../../src/accounts.ts';
import { appStatus, deviceByToken } from '../../src/devices.ts';
import {
  accountEntitlements,
  grantComplimentary,
  subscriptionOf,
} from '../../src/subscriptions.ts';
import {
  googlePlanOf,
  googlePlayClient,
  parseDeveloperNotification,
  parseGoogleSubscription,
  processGooglePurchase,
  PurchaseInvalid,
  recheckGooglePurchases,
  revokeGooglePurchase,
  saveStoreProducts,
  setTestStoreState,
  StoreUnavailable,
  storeOffers,
  storeProducts,
  type GooglePlay,
  type GoogleSubscription,
} from '../../src/store.ts';

let sql: Sql;
let drop: () => Promise<void>;
const BASE = 'http://localhost:3000';
const DAY = 86400_000;

/** Google as the test wants it: tokens → subscriptions; records acknowledgements. */
class FakePlay implements GooglePlay {
  subs = new Map<string, Record<string, unknown>>();
  acks: string[] = [];
  cancels: string[] = [];
  down = false;
  async getSubscription(token: string): Promise<GoogleSubscription> {
    if (this.down) throw new StoreUnavailable('down');
    const raw = this.subs.get(token);
    if (!raw) throw new PurchaseInvalid('HTTP 404');
    return parseGoogleSubscription(raw);
  }
  async acknowledge(_p: string, token: string) {
    this.acks.push(token);
    const raw = this.subs.get(token);
    if (raw) raw.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  }
  async cancel(token: string) {
    this.cancels.push(token);
  }
}
const play = new FakePlay();

function googleSub(o: {
  state?: string;
  product?: string;
  basePlan?: string;
  expires?: Date;
  autoRenew?: boolean;
  ref?: string | null;
  linked?: string;
  test?: boolean;
}) {
  return {
    kind: 'androidpublisher#subscriptionPurchaseV2',
    regionCode: 'AT',
    startTime: new Date().toISOString(),
    subscriptionState: `SUBSCRIPTION_STATE_${o.state ?? 'ACTIVE'}`,
    latestOrderId: 'GPA.3333-4444-5555-66666',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    ...(o.linked ? { linkedPurchaseToken: o.linked } : {}),
    ...(o.ref === null
      ? {}
      : { externalAccountIdentifiers: { obfuscatedExternalAccountId: o.ref } }),
    ...(o.test ? { testPurchase: {} } : {}),
    lineItems: [
      {
        productId: o.product ?? 'oc_creator',
        expiryTime: (o.expires ?? new Date(Date.now() + 30 * DAY)).toISOString(),
        autoRenewingPlan: { autoRenewEnabled: o.autoRenew ?? true },
        offerDetails: { basePlanId: o.basePlan ?? 'monthly' },
      },
    ],
  };
}

let anna: Account;
let ben: Account;
let cara: Account;
let dora: Account;
let annaToken: string;

async function signIn(email: string, n: number) {
  const r = await signInWithIdentity(
    sql,
    { provider: 'google', subject: `g-${email}`, email, name: null },
    { deviceUuid: `device-${n}-0000-4000-8000-000000000000`, platform: 'android' },
    { baseUrl: BASE },
  );
  assert.ok(r.ok);
  return r;
}

before(async () => {
  ({ sql, drop } = await freshDatabase());
  const products = {
    google: {
      collector: {
        product_id: 'oc_collector',
        base_plans: { monthly: 'monthly', yearly: 'yearly' },
      },
      creator: { product_id: 'oc_creator', base_plans: { monthly: 'monthly', yearly: 'yearly' } },
    },
    apple: { collector: { monthly: null, yearly: null }, creator: { monthly: null, yearly: null } },
  };
  assert.ok((await saveStoreProducts(sql, products)).ok);
  const a = await signIn('anna@example.com', 1);
  anna = a.account;
  annaToken = a.token;
  ben = (await signIn('ben@example.com', 2)).account;
  cara = (await signIn('cara@example.com', 3)).account;
  dora = (await signIn('dora@example.com', 4)).account;
});
after(async () => drop());

const status = async (token: string) => {
  const d = await deviceByToken(sql, token);
  assert.ok(d.ok);
  return appStatus(sql, d.account, d.device, { baseUrl: BASE });
};

test('products: plan lookup, offers, validation', async () => {
  const p = await storeProducts(sql);
  assert.deepEqual(googlePlanOf(p, 'oc_creator', 'yearly'), { plan: 'creator', period: 'yearly' });
  assert.deepEqual(googlePlanOf(p, 'oc_collector', 'monthly'), {
    plan: 'collector',
    period: 'monthly',
  });
  assert.equal(googlePlanOf(p, 'oc_other', 'monthly'), null);
  const offers = storeOffers(p);
  assert.deepEqual(
    offers.map((o) => [o.plan, o.google?.product_id, o.apple]),
    [
      ['collector', 'oc_collector', null],
      ['creator', 'oc_creator', null],
    ],
  );
  const bad = await saveStoreProducts(sql, {
    ...p,
    google: { ...p.google, creator: { ...p.google.creator, product_id: 'oc_collector' } },
  });
  assert.equal(bad.ok, false, 'one product for two plans');
  assert.equal(
    (
      await saveStoreProducts(sql, {
        ...p,
        google: { ...p.google, collector: { ...p.google.collector, product_id: 'Has Spaces' } },
      })
    ).ok,
    false,
  );
});

test('a purchase reported by the app: checked, acknowledged once, unlocks the app', async () => {
  const expires = new Date(Date.now() + 30 * DAY);
  play.subs.set('tok-anna-1', googleSub({ ref: anna.storeRef, expires }));
  const r = await processGooglePurchase(sql, play, {
    token: 'tok-anna-1',
    productId: 'oc_creator',
    accountId: anna.id,
  });
  assert.ok(r.ok);
  assert.deepEqual(play.acks, ['tok-anna-1']);
  const s = await status(annaToken);
  assert.equal(s.status, 'active');
  assert.equal(s.subscription.plan, 'creator');
  assert.equal(s.subscription.source, 'google_play');
  assert.equal(
    s.subscription.manage_url,
    'https://play.google.com/store/account/subscriptions?sku=oc_creator&package=com.overpricedcardboard.app',
  );
  assert.equal(s.subscription.renews_at, expires.toISOString());
  assert.equal(s.valid_until, expires.toISOString());
  assert.equal(s.features.youtube, true);
  assert.equal(s.subscription.devices.included, 1);
  // again (the app repeats until it gets an answer): same, no second acknowledgement
  assert.ok(
    (
      await processGooglePurchase(sql, play, {
        token: 'tok-anna-1',
        productId: 'oc_creator',
        accountId: anna.id,
      })
    ).ok,
  );
  assert.deepEqual(play.acks, ['tok-anna-1']);
  // another account can't take it
  const other = await processGooglePurchase(sql, play, {
    token: 'tok-anna-1',
    productId: 'oc_creator',
    accountId: ben.id,
  });
  assert.deepEqual(other, { ok: false, problem: 'linked_elsewhere', owner: 'a***@example.com' });
  // a second subscription on the same account is refused, not acknowledged (Google refunds it)
  play.subs.set('tok-anna-2', googleSub({ ref: anna.storeRef, product: 'oc_collector' }));
  const second = await processGooglePurchase(sql, play, {
    token: 'tok-anna-2',
    productId: 'oc_collector',
    accountId: anna.id,
  });
  assert.ok(
    !second.ok && second.problem === 'already_subscribed' && second.source === 'google_play',
  );
  assert.deepEqual(play.acks, ['tok-anna-1']);
  assert.equal((await subscriptionOf(sql, anna.id))!.plan, 'creator');
});

test('plan change: the new token replaces the linked one', async () => {
  play.subs.set(
    'tok-anna-3',
    googleSub({
      ref: anna.storeRef,
      product: 'oc_collector',
      basePlan: 'yearly',
      linked: 'tok-anna-1',
    }),
  );
  const r = await processGooglePurchase(sql, play, {
    token: 'tok-anna-3',
    productId: 'oc_collector',
    accountId: anna.id,
  });
  assert.ok(r.ok && r.purchase.plan === 'collector' && r.purchase.period === 'yearly');
  const [old] = await sql<{ replaced_by: number | null }[]>`
    SELECT replaced_by FROM store_purchases WHERE purchase_token = 'tok-anna-1'`;
  assert.equal(Number(old!.replaced_by), r.purchase.id);
  assert.equal((await subscriptionOf(sql, anna.id))!.plan, 'collector');
});

test('one paid source: a store purchase on an account with a website subscription is refused', async () => {
  await sql`
    INSERT INTO subscriptions (account_id, source, plan, status, stripe_subscription_id, current_period_end)
    VALUES (${cara.id}, 'stripe', 'collector', 'active', 'sub_cara', now() + interval '20 days')`;
  play.subs.set('tok-cara', googleSub({ ref: cara.storeRef }));
  const r = await processGooglePurchase(sql, play, {
    token: 'tok-cara',
    productId: 'oc_creator',
    accountId: cara.id,
  });
  assert.ok(!r.ok && r.problem === 'already_subscribed' && r.source === 'web');
  assert.ok(!play.acks.includes('tok-cara'));
  const sub = await subscriptionOf(sql, cara.id);
  assert.equal(sub!.source, 'stripe');
});

test('a free subscription does not block a store purchase and comes back after it', async () => {
  await grantComplimentary(
    sql,
    ben.id,
    { plan: 'collector', extraDevices: 0, until: '', note: '' },
    'test',
  );
  play.subs.set(
    'tok-ben',
    googleSub({ ref: ben.storeRef, expires: new Date(Date.now() + 5 * DAY) }),
  );
  assert.ok(
    (
      await processGooglePurchase(sql, play, {
        token: 'tok-ben',
        productId: 'oc_creator',
        accountId: ben.id,
      })
    ).ok,
  );
  assert.equal((await subscriptionOf(sql, ben.id))!.source, 'google_play');
  play.subs.set(
    'tok-ben',
    googleSub({
      ref: ben.storeRef,
      state: 'EXPIRED',
      expires: new Date(Date.now() - DAY),
      autoRenew: false,
    }),
  );
  assert.ok((await processGooglePurchase(sql, play, { token: 'tok-ben', accountId: null })).ok);
  assert.equal((await subscriptionOf(sql, ben.id))!.source, 'complimentary');
});

test('notifications find the account by store_ref; states map to the app', async () => {
  const at = (state: string, days: number, autoRenew = true) =>
    googleSub({ ref: dora.storeRef, state, expires: new Date(Date.now() + days * DAY), autoRenew });
  const ent = () => accountEntitlements(sql, dora);
  // pending first purchase: nothing yet
  play.subs.set('tok-dora', at('PENDING', 30));
  assert.ok((await processGooglePurchase(sql, play, { token: 'tok-dora', accountId: null })).ok);
  assert.equal((await ent()).state, 'none');
  assert.ok(!play.acks.includes('tok-dora'));
  // paid: a notification alone links and acknowledges it
  play.subs.set('tok-dora', at('ACTIVE', 30));
  assert.ok((await processGooglePurchase(sql, play, { token: 'tok-dora', accountId: null })).ok);
  assert.equal((await ent()).state, 'active');
  assert.ok(play.acks.includes('tok-dora'));
  // cancelled: runs to its end
  play.subs.set('tok-dora', at('CANCELED', 10, false));
  await processGooglePurchase(sql, play, { token: 'tok-dora', accountId: null });
  let e = await ent();
  assert.equal(e.state, 'canceled');
  assert.ok(e.active && e.endsAt && e.renewsAt === null);
  // grace period: on, until its end
  play.subs.set('tok-dora', at('IN_GRACE_PERIOD', 3));
  await processGooglePurchase(sql, play, { token: 'tok-dora', accountId: null });
  e = await ent();
  assert.equal(e.state, 'past_due');
  assert.ok(e.active);
  // on hold: off
  play.subs.set('tok-dora', at('ON_HOLD', -1));
  await processGooglePurchase(sql, play, { token: 'tok-dora', accountId: null });
  e = await ent();
  assert.ok(!e.active && e.state === 'ended');
  // back to active, then refunded: off at once, and a later read doesn't undo it
  play.subs.set('tok-dora', at('ACTIVE', 30));
  await processGooglePurchase(sql, play, { token: 'tok-dora', accountId: null });
  assert.equal((await ent()).active, true);
  assert.equal(await revokeGooglePurchase(sql, 'tok-dora'), true);
  assert.equal((await ent()).active, false);
  await processGooglePurchase(sql, play, { token: 'tok-dora', accountId: null });
  assert.equal((await ent()).active, false);
  // unknown products are not ours
  play.subs.set('tok-other', googleSub({ ref: dora.storeRef, product: 'someone_else' }));
  assert.deepEqual(
    await processGooglePurchase(sql, play, { token: 'tok-other', accountId: dora.id }),
    {
      ok: false,
      problem: 'invalid_purchase',
    },
  );
  // Google doesn't know the token
  await assert.rejects(
    processGooglePurchase(sql, play, { token: 'nope', accountId: dora.id }),
    PurchaseInvalid,
  );
});

test('daily re-read catches what is about to run out', async () => {
  const soon = new Date(Date.now() + DAY);
  play.subs.set(
    'tok-recheck',
    googleSub({ ref: anna.storeRef, product: 'oc_collector', expires: soon, linked: 'tok-anna-3' }),
  );
  await processGooglePurchase(sql, play, { token: 'tok-recheck', accountId: anna.id });
  await sql`UPDATE store_purchases SET checked_at = now() - interval '1 day' WHERE purchase_token = 'tok-recheck'`;
  const renewed = new Date(Date.now() + 31 * DAY);
  play.subs.set(
    'tok-recheck',
    googleSub({ ref: anna.storeRef, product: 'oc_collector', expires: renewed }),
  );
  const r = await recheckGooglePurchases(sql, play);
  assert.deepEqual(r, { checked: 1, failed: 0 });
  const [p] = await sql<
    { expires_at: Date }[]
  >`SELECT expires_at FROM store_purchases WHERE purchase_token = 'tok-recheck'`;
  assert.equal(p!.expires_at.toISOString(), renewed.toISOString());
  assert.deepEqual(
    await recheckGooglePurchases(sql, play),
    { checked: 0, failed: 0 },
    'not again within 12 hours',
  );
});

test('staging: test tokens and test events, without asking Google', async () => {
  const e = await signIn('erik@example.com', 5);
  const r = await processGooglePurchase(sql, null, {
    token: 'test_active',
    productId: 'oc_creator',
    accountId: e.account.id,
    storeRef: e.account.storeRef,
    testHooks: true,
  });
  assert.ok(r.ok && r.purchase.test && r.purchase.acknowledged);
  assert.equal((await status(e.token)).status, 'active');
  assert.equal((await setTestStoreState(sql, e.account.storeRef, 'expired'))!.state, 'expired');
  assert.equal((await status(e.token)).status, 'inactive');
  assert.equal((await setTestStoreState(sql, e.account.storeRef, 'renewed'))!.state, 'active');
  assert.equal((await status(e.token)).status, 'active');
  assert.equal((await setTestStoreState(sql, e.account.storeRef, 'refunded'))!.state, 'revoked');
  assert.equal((await status(e.token)).status, 'inactive');
  // without the hooks a test token goes to Google (which doesn't know it); unknown test tokens fail
  await assert.rejects(
    processGooglePurchase(sql, null, { token: 'test_active', accountId: e.account.id }),
    StoreUnavailable,
  );
  await assert.rejects(
    processGooglePurchase(sql, null, {
      token: 'test_bogus',
      accountId: e.account.id,
      testHooks: true,
    }),
    PurchaseInvalid,
  );
});

test('Pub/Sub messages', () => {
  const push = (n: unknown) => ({
    message: { data: Buffer.from(JSON.stringify(n)).toString('base64'), messageId: '1' },
    subscription: 'x',
  });
  assert.deepEqual(
    parseDeveloperNotification(
      push({
        packageName: 'com.overpricedcardboard.app',
        subscriptionNotification: {
          notificationType: 4,
          purchaseToken: 'abc',
          subscriptionId: 'oc_creator',
        },
      }),
    ),
    { kind: 'subscription', packageName: 'com.overpricedcardboard.app', token: 'abc', type: 4 },
  );
  assert.deepEqual(
    parseDeveloperNotification(
      push({
        packageName: 'p',
        voidedPurchaseNotification: { purchaseToken: 'v', productType: 1 },
      }),
    ),
    { kind: 'voided', packageName: 'p', token: 'v' },
  );
  assert.deepEqual(
    parseDeveloperNotification(push({ packageName: 'p', testNotification: { version: '1.0' } })),
    { kind: 'test', packageName: 'p' },
  );
  assert.equal(parseDeveloperNotification({ nothing: true }), null);
});

test('the Google Play client: service-account token, calls, errors', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? 'GET'} ${u.replace(/^https:\/\/[^/]+/, '')}`);
    if (u === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      return new Response(JSON.stringify({ access_token: 'ya29.x', expires_in: 3600 }), {
        status: 200,
      });
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ya29.x');
    if (u.endsWith('/tokens/gone')) return new Response('{}', { status: 410 });
    if (u.endsWith('/tokens/busy')) return new Response('{}', { status: 503 });
    if (u.includes('subscriptionsv2'))
      return new Response(JSON.stringify(googleSub({ ref: anna.storeRef })), { status: 200 });
    return new Response('', { status: 200 });
  }) as typeof fetch;
  const client = googlePlayClient({
    packageName: 'com.overpricedcardboard.app',
    account: {
      client_email: 'play@x.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
    fetch: fetchFn,
  });
  const s = await client.getSubscription('tok/1');
  assert.equal(s.state, 'active');
  assert.equal(s.storeRef, anna.storeRef);
  await client.acknowledge('oc_creator', 'tok/1');
  await client.cancel('tok/1');
  await assert.rejects(client.getSubscription('gone'), PurchaseInvalid);
  await assert.rejects(client.getSubscription('busy'), StoreUnavailable);
  assert.deepEqual(calls.slice(0, 4), [
    'POST /token',
    'GET /androidpublisher/v3/applications/com.overpricedcardboard.app/purchases/subscriptionsv2/tokens/tok%2F1',
    'POST /androidpublisher/v3/applications/com.overpricedcardboard.app/purchases/subscriptions/oc_creator/tokens/tok%2F1:acknowledge',
    'POST /androidpublisher/v3/applications/com.overpricedcardboard.app/purchases/subscriptionsv2/tokens/tok%2F1:cancel',
  ]);
  assert.equal(calls.filter((c) => c === 'POST /token').length, 1, 'the access token is reused');
});

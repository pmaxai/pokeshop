import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import { redeemLoginLink, requestLoginLink, type Account } from '../../src/accounts.ts';
import {
  fakeBilling,
  meteredLookupKey,
  parseLookupKey,
  parseMeteredKey,
  unitAmountDecimal,
} from '../../src/billing.ts';
import {
  accountEntitlements,
  grantComplimentary,
  saveSubscriptionPrices,
  syncStripeSubscription,
} from '../../src/subscriptions.ts';
import {
  recordUsage,
  reportUsage,
  s3Config,
  saveS3Config,
  serviceStates,
  setService,
  usageJson,
  usageSince,
} from '../../src/usage.ts';

let sql: Sql;
let drop: () => Promise<void>;
let paid: Account;
let free: Account;
const BASE = 'http://localhost:3000';
const billing = fakeBilling(BASE);
const key = randomBytes(32);

async function account(email: string): Promise<Account> {
  await requestLoginLink(sql, { email, locale: 'de', baseUrl: BASE });
  const [m] = await sql<{ payload: { url: string } }[]>`
    SELECT payload FROM outbox WHERE to_address = ${email} ORDER BY id DESC LIMIT 1`;
  const r = await redeemLoginLink(sql, new URL(m!.payload.url).searchParams.get('t')!);
  assert.ok(r.ok);
  return r.account;
}

before(async () => {
  ({ sql, drop } = await freshDatabase());
  paid = await account('creator@example.com');
  free = await account('friend@example.com');
  const s = await billing.startCheckout({
    accountId: paid.id,
    publicId: paid.publicId,
    customerId: 'cus_creator',
    locale: 'de',
    plan: 'creator',
    extraDevices: 0,
    baseCents: 1200,
    deviceCents: 700,
    behavior: 'incl',
    successUrl: `${BASE}/ok`,
    cancelUrl: `${BASE}/cancel`,
  });
  const p = billing.pay(s.id);
  assert.ok(await syncStripeSubscription(sql, billing, p.subscriptionId));
  await grantComplimentary(
    sql,
    free.id,
    { plan: 'creator', extraDevices: 0, until: '', note: 'friend' },
    'test',
  );
});
after(async () => drop());

const now = () => new Date().toISOString();

test('metered price keys and amounts', () => {
  assert.equal(meteredLookupKey('s3', 10, 'incl'), 'oc_s3_gb_10_incl');
  assert.equal(meteredLookupKey('pipeline', 30, 'excl'), 'oc_pipeline_minute_30_excl');
  assert.deepEqual(parseMeteredKey('oc_s3_gb_10_incl'), {
    service: 's3',
    cents: 10,
    behavior: 'incl',
  });
  assert.equal(parseMeteredKey('oc_creator_1200_incl'), null);
  assert.equal(parseLookupKey('oc_s3_gb_10_incl'), null, 'not mistaken for a plan');
  // € 0.10 per GB = 0.009765625 cents per MB; € 0.30 per minute = 0.5 cents per second
  assert.equal(unitAmountDecimal('s3', 10), '0.009765625');
  assert.equal(unitAmountDecimal('pipeline', 30), '0.5');
  assert.equal(unitAmountDecimal('pipeline', 60), '1');
});

test('services on and off; S3 settings stored encrypted and served to Creator', async () => {
  assert.deepEqual(await saveS3Config(sql, paid.id, { provider: 'exoscale' }, key), {
    ok: false,
    errors: {
      endpoint: 'invalid',
      region: 'invalid',
      bucket: 'invalid',
      prefix: 'invalid',
      access_key_id: 'invalid',
      secret_access_key: 'invalid',
    },
  });
  const cfg = {
    provider: 'exoscale',
    endpoint: 'https://sos-at-vie-1.exo.io/',
    region: 'at-vie-1',
    bucket: 'oc-recordings',
    prefix: `${paid.publicId}/`,
    access_key_id: 'EXO1234567890abcdef',
    secret_access_key: 'secret-0123456789',
  };
  assert.deepEqual(await saveS3Config(sql, paid.id, cfg, key), {
    ok: false,
    errors: { _: 'not_enabled' },
  });
  await setService(sql, paid.id, 's3', true, 'admin@example.com');
  await setService(sql, paid.id, 'pipeline', true, 'admin@example.com');
  assert.deepEqual(await saveS3Config(sql, paid.id, { ...cfg, secret_access_key: '' }, key), {
    ok: false,
    errors: { secret_access_key: 'required' },
  });
  assert.deepEqual(await saveS3Config(sql, paid.id, cfg, key), { ok: true });
  const [raw] = await sql<{ config_enc: string }[]>`
    SELECT config_enc FROM account_services WHERE account_id = ${paid.id} AND service = 's3'`;
  assert.ok(!raw!.config_enc.includes('secret-0123456789'), 'the secret is not stored in clear');
  // an empty secret keeps the saved one
  assert.deepEqual(
    await saveS3Config(sql, paid.id, { ...cfg, bucket: 'oc-other', secret_access_key: '' }, key),
    { ok: true },
  );
  const c = await s3Config(sql, paid.id, key);
  assert.equal(c?.bucket, 'oc-other');
  assert.equal(c?.endpoint, 'https://sos-at-vie-1.exo.io');
  assert.equal(c?.secret_access_key, 'secret-0123456789');
  const ent = await accountEntitlements(sql, paid);
  assert.equal(ent.features.s3_upload, true);
  assert.equal(ent.features.pipeline, true);
  const st = await serviceStates(sql, paid.id);
  assert.ok(st.s3.enabled && st.s3.configured && st.pipeline.enabled);
  await setService(sql, paid.id, 'pipeline', false, 'admin@example.com');
  assert.equal((await accountEntitlements(sql, paid)).features.pipeline, false);
  await setService(sql, paid.id, 'pipeline', true, 'admin@example.com');
});

test('usage reports: checks, totals', async () => {
  const report = (over: Record<string, unknown> = {}) =>
    recordUsage(sql, {
      account_id: paid.publicId,
      service: 's3',
      quantity: 2048,
      unit: 'mb',
      occurred_at: now(),
      reference: 'recordings/1',
      ...over,
    });
  assert.deepEqual(await report({ unit: 'second' }), {
    ok: false,
    status: 400,
    code: 'invalid_request',
    fields: { unit: 'invalid' },
  });
  assert.deepEqual(await report({ quantity: 0, occurred_at: 'yesterday' }), {
    ok: false,
    status: 400,
    code: 'invalid_request',
    fields: { quantity: 'invalid', occurred_at: 'invalid' },
  });
  assert.deepEqual(
    await report({ occurred_at: new Date(Date.now() - 40 * 86400_000).toISOString() }),
    { ok: false, status: 400, code: 'invalid_request', fields: { occurred_at: 'out_of_range' } },
  );
  assert.deepEqual(await report({ account_id: 'acc_0000000000' }), {
    ok: false,
    status: 404,
    code: 'unknown_account',
  });
  assert.deepEqual(await report({ account_id: free.publicId }), {
    ok: false,
    status: 409,
    code: 'service_not_enabled',
  });
  const one = await report();
  assert.ok(one.ok);
  assert.deepEqual(
    { ...usageJson(one.event), id: 0, occurred_at: '' },
    {
      id: 0,
      account_id: paid.publicId,
      service: 's3',
      quantity: 2048,
      unit: 'mb',
      occurred_at: '',
      reference: 'recordings/1',
      billed: 'queued',
    },
  );
  const two = await report({ service: 'pipeline', unit: 'second', quantity: 90, reference: null });
  assert.ok(two.ok);
  await saveSubscriptionPrices(sql, {
    collector: 700,
    creator: 1200,
    collector_device: 400,
    creator_device: 700,
    s3_gb: 10,
    pipeline_minute: 30,
  });
  const t = await usageSince(sql, paid.id, new Date(Date.now() - 86400_000));
  assert.deepEqual(
    { s3: t.s3, pipeline: t.pipeline },
    { s3: { mb: 2048, cents: 20 }, pipeline: { seconds: 90, cents: 45 } },
  );
});

test('to Stripe: metered items added once, events once; free subscriptions are not billed', async () => {
  await setService(sql, free.id, 's3', true, 'admin@example.com');
  const f = await recordUsage(sql, {
    account_id: free.publicId,
    service: 's3',
    quantity: 500,
    unit: 'mb',
    occurred_at: now(),
  });
  assert.ok(f.ok);
  // a report that got too old while Stripe was unreachable
  await sql`
    INSERT INTO usage_events (account_id, service, quantity, unit, occurred_at)
    VALUES (${paid.id}, 's3', 10, 'mb', now() - interval '36 days')`;
  const r = await reportUsage(sql, billing);
  assert.deepEqual(r, { sent: 2, notBilled: 1, failed: 1, waiting: 0 });
  const [sub] = await sql<{ stripe_subscription_id: string }[]>`
    SELECT stripe_subscription_id FROM subscriptions WHERE account_id = ${paid.id}`;
  const s = await billing.getSubscription(sub!.stripe_subscription_id);
  assert.ok(s?.metered.s3 && s.metered.pipeline);
  const events = billing.store.meterEvents ?? [];
  assert.deepEqual(
    events.map((e) => [e.service, e.customerId, e.value]),
    [
      ['s3', 'cus_creator', 2048],
      ['pipeline', 'cus_creator', 90],
    ],
  );
  const [item] = await sql<{ stripe_item_id: string }[]>`
    SELECT stripe_item_id FROM account_services WHERE account_id = ${paid.id} AND service = 's3'`;
  assert.equal(item!.stripe_item_id, s.metered.s3);
  // nothing left; a new report goes out on the next run without a second item
  assert.deepEqual(await reportUsage(sql, billing), {
    sent: 0,
    notBilled: 0,
    failed: 0,
    waiting: 0,
  });
  assert.ok(
    (
      await recordUsage(sql, {
        account_id: paid.publicId,
        service: 's3',
        quantity: 1,
        unit: 'mb',
        occurred_at: now(),
      })
    ).ok,
  );
  assert.equal((await reportUsage(sql, billing)).sent, 1);
  assert.equal((billing.store.meterEvents ?? []).length, 3);
  const states = await sql<{ billing: string; n: number }[]>`
    SELECT billing, count(*)::int AS n FROM usage_events GROUP BY billing ORDER BY billing`;
  assert.deepEqual(
    states.map((x) => [x.billing, x.n]),
    [
      ['failed', 1],
      ['not_billed', 1],
      ['sent', 3],
    ],
  );
});

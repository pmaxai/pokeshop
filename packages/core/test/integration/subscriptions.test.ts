import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import { redeemLoginLink, requestLoginLink, type Account } from '../../src/accounts.ts';
import { fakeBilling } from '../../src/billing.ts';
import {
  accountEntitlements,
  changeSubscription,
  ChangeRejected,
  entitlements,
  grantComplimentary,
  handleBillingEvent,
  netPrice,
  setCancelAtPeriodEnd,
  startSubscription,
  subscriptionOf,
  validateSubscribe,
  type SubscribeForm,
} from '../../src/subscriptions.ts';
import {
  appStatus,
  createPairingCode,
  createTransferCode,
  deviceByToken,
  endDevice,
  formatCode,
  listDevices,
  normalizeCode,
  pairDevice,
} from '../../src/devices.ts';

let sql: Sql;
let drop: () => Promise<void>;
const billing = fakeBilling('http://localhost:3000');
const BASE = 'http://localhost:3000';

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
});
after(async () => drop());

async function account(email: string): Promise<Account> {
  await requestLoginLink(sql, { email, locale: 'de', baseUrl: BASE });
  const [m] = await sql<{ payload: { url: string } }[]>`
    SELECT payload FROM outbox WHERE to_address = ${email} ORDER BY id DESC LIMIT 1`;
  const r = await redeemLoginLink(sql, new URL(m!.payload.url).searchParams.get('t')!);
  assert.ok(r.ok);
  return r.account;
}

const form = (over: Partial<Record<string, unknown>> = {}): SubscribeForm => {
  const v = validateSubscribe({
    plan: 'collector',
    extraDevices: '1',
    buyer: 'consumer',
    name: 'Misty',
    street: 'Hauptstraße 1',
    postcode: '1010',
    city: 'Wien',
    country: 'AT',
    acceptTerms: true,
    immediateStart: true,
    ...over,
  });
  assert.ok(v.ok, JSON.stringify(!v.ok && v.errors));
  return v.data;
};

/** Subscribe and pay on the stand-in, then deliver the webhooks Stripe would send. */
async function subscribe(a: Account, f: SubscribeForm = form()) {
  const url = await startSubscription(sql, billing, {
    account: a,
    form: f,
    tax: { regime: 'domestic', behavior: 'incl', taxId: null, viesName: null },
    locale: 'de',
    successUrl: `${BASE}/de/konto/abo?ok=1`,
    cancelUrl: `${BASE}/de/konto/abo`,
  });
  const sessionId = url.split('/').pop()!;
  const paid = billing.pay(sessionId);
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
  return paid;
}

test('the form: EU only, company for businesses, both consents', () => {
  const bad = validateSubscribe({
    plan: 'gold',
    extraDevices: '99',
    buyer: 'business',
    country: 'CH',
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.errors.plan, 'required');
    assert.equal(bad.errors.extraDevices, 'too_many');
    assert.equal(bad.errors.company, 'required');
    assert.equal(bad.errors.country, 'country');
    assert.equal(bad.errors.acceptTerms, 'terms');
    assert.equal(bad.errors.immediateStart, 'consent');
  }
  assert.equal(netPrice(700), 583);
  assert.equal(netPrice(1200), 1000);
});

test('subscribing unlocks the plan’s features, sends the welcome mail with the invoice', async () => {
  const a = await account('misty@example.com');
  assert.equal((await accountEntitlements(sql, a)).active, false);
  const paid = await subscribe(a);
  const sub = await subscriptionOf(sql, a.id);
  assert.equal(sub?.plan, 'collector');
  assert.equal(sub?.extraDevices, 1);
  const ent = await accountEntitlements(sql, a);
  assert.equal(ent.state, 'active');
  assert.equal(ent.seats, 2);
  assert.equal(ent.features.trading, true);
  assert.equal(ent.features.youtube, false);
  assert.equal(ent.features.webshop, false);
  const [cust] = await sql<{ stripe_customer_id: string; billing: { regime: string } }[]>`
    SELECT stripe_customer_id, billing FROM accounts WHERE id = ${a.id}`;
  assert.ok(cust!.stripe_customer_id.startsWith('cus_fake_'));
  assert.equal(cust!.billing.regime, 'domestic');
  const [mail] = await sql<{ template: string; attachments: { kind: string; id: string }[] }[]>`
    SELECT template, attachments FROM outbox WHERE dedupe_key = ${`subscription_invoice:${paid.invoiceId}`}`;
  assert.equal(mail!.template, 'subscription_welcome');
  assert.equal(mail!.attachments[0]!.id, paid.invoiceId);
  // the same events again change nothing
  await handleBillingEvent(sql, billing, {
    type: 'invoice_paid',
    invoiceId: paid.invoiceId,
    subscriptionId: paid.subscriptionId,
    reason: 'subscription_create',
  });
  const [n] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM outbox WHERE template = 'subscription_welcome'`;
  assert.equal(n!.n, 1);
  // a second subscription can't be started
  await assert.rejects(subscribe(a), /already_active/);
});

test('pairing: QR code, device limit, same phone again, transfer, removal', async () => {
  const a = await account('brock@example.com');
  assert.deepEqual(await createPairingCode(sql, a), {
    ok: false,
    problem: 'subscription_required',
    seats: 0,
  });
  await subscribe(a, form({ extraDevices: '0' }));

  const c1 = await createPairingCode(sql, a);
  assert.ok(c1.ok);
  // scanned from the QR URL, typed in lower case with O for 0 also works
  assert.equal(normalizeCode(`${BASE}/pair/${formatCode(c1.code)}`), c1.code);
  assert.equal(normalizeCode(formatCode(c1.code).toLowerCase()), c1.code);
  assert.equal(normalizeCode('https://evil.example/x'), null);

  const p1 = await pairDevice(sql, {
    code: formatCode(c1.code),
    deviceUuid: 'phone-one-uuid',
    name: 'Pixel 8',
  });
  assert.ok(p1.ok);
  assert.match(p1.device.publicId, /^dev_/);
  // a code works once
  assert.deepEqual(await pairDevice(sql, { code: c1.code, deviceUuid: 'phone-two-uuid' }), {
    ok: false,
    problem: 'code_expired',
  });
  // one device included: no code for a second one
  assert.deepEqual(await createPairingCode(sql, a), {
    ok: false,
    problem: 'device_limit',
    seats: 1,
  });

  // status for the app
  const look = await deviceByToken(sql, p1.token, { appVersion: '1.3.4' });
  assert.ok(look.ok);
  const st = await appStatus(sql, look.account, look.device, { baseUrl: BASE });
  assert.equal(st.status, 'active');
  assert.equal(st.subscription.plan, 'collector');
  assert.deepEqual(st.subscription.devices, {
    included: 1,
    extra: 0,
    in_store: 0,
    on_web: 0,
    in_use: 1,
  });
  assert.equal(st.portal_url, `${BASE}/de/konto`);
  assert.ok(new Date(st.valid_until) > new Date());

  // move to a new phone with a transfer code
  const tr = await createTransferCode(sql, p1.device);
  const p2 = await pairDevice(sql, {
    code: tr.code,
    deviceUuid: 'phone-two-uuid',
    name: 'Pixel 9',
  });
  assert.ok(p2.ok);
  const old = await deviceByToken(sql, p1.token);
  assert.equal(old.ok, false);
  if (!old.ok && old.problem === 'unpaired') {
    assert.equal(old.reason, 'transferred');
    assert.equal(old.successorName, 'Pixel 9');
  } else assert.fail('expected unpaired');
  assert.equal((await listDevices(sql, a.id)).length, 1);

  // removing it in the portal frees the slot
  assert.equal(await endDevice(sql, a.id, p2.device.publicId, 'removed'), true);
  const gone = await deviceByToken(sql, p2.token);
  assert.ok(!gone.ok && gone.problem === 'unpaired' && gone.reason === 'removed');
  assert.ok((await createPairingCode(sql, a)).ok);

  assert.deepEqual(await deviceByToken(sql, 'x'.repeat(43)), {
    ok: false,
    problem: 'invalid_token',
  });
});

test('plan changes, fewer devices than connected, cancel at period end, ended', async () => {
  const a = await account('erika@example.com');
  const paid = await subscribe(a, form({ extraDevices: '1' }));
  for (const uuid of ['dev-a-uuid-1', 'dev-b-uuid-2']) {
    const c = await createPairingCode(sql, a);
    assert.ok(c.ok);
    assert.ok((await pairDevice(sql, { code: c.code, deviceUuid: uuid })).ok);
  }
  await assert.rejects(
    changeSubscription(sql, billing, a, { plan: 'collector', extraDevices: 0 }),
    (e: unknown) => e instanceof ChangeRejected && e.reason === 'devices_in_use' && e.inUse === 2,
  );
  const up = await changeSubscription(sql, billing, a, { plan: 'creator', extraDevices: 1 });
  assert.equal(up.plan, 'creator');
  assert.equal((await accountEntitlements(sql, a)).features.youtube, true);

  const c = await setCancelAtPeriodEnd(sql, billing, a, true);
  assert.equal(c.cancelAtPeriodEnd, true);
  let ent = await accountEntitlements(sql, a);
  assert.equal(ent.state, 'canceled');
  assert.equal(ent.active, true);
  assert.ok(ent.endsAt);

  // Stripe ends it
  await billing.cancelNow(paid.subscriptionId);
  await handleBillingEvent(sql, billing, {
    type: 'subscription',
    subscriptionId: paid.subscriptionId,
  });
  ent = await accountEntitlements(sql, a);
  assert.equal(ent.active, false);
  assert.equal(ent.state, 'ended');
  assert.equal(ent.features.scanner, false);
  const [m] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM outbox WHERE template = 'subscription_ended' AND to_address = 'erika@example.com'`;
  assert.equal(m!.n, 1);
  // devices stay paired, the app is told "inactive"
  const devices = await listDevices(sql, a.id);
  assert.equal(devices.length, 2);
  const st = await appStatus(sql, a, devices[0]!, { baseUrl: BASE });
  assert.equal(st.status, 'inactive');
  assert.equal(st.valid_until, st.server_time);
});

test('complimentary subscriptions and a connected webshop', async () => {
  const a = await account('gary@example.com');
  await sql`UPDATE accounts SET webshop_host = 'shop.example.com' WHERE id = ${a.id}`;
  await grantComplimentary(
    sql,
    a.id,
    { plan: 'creator', extraDevices: 2, until: '2099-12-31', note: 'Freund' },
    'owner@example.com',
  );
  const me = { ...a, webshopHost: 'shop.example.com' };
  const ent = await accountEntitlements(sql, me);
  assert.equal(ent.state, 'complimentary');
  assert.equal(ent.seats, 3);
  assert.equal(ent.features.youtube, true);
  assert.equal(ent.features.webshop, true);
  assert.equal(ent.features.s3_upload, false);
  // switched on by the shop: S3 (and the pipeline, which needs S3)
  await sql`INSERT INTO account_services (account_id, service) VALUES (${a.id}, 'pipeline')`;
  assert.equal((await accountEntitlements(sql, me)).features.pipeline, false);
  await sql`INSERT INTO account_services (account_id, service) VALUES (${a.id}, 's3')`;
  const withS3 = await accountEntitlements(sql, me);
  assert.equal(withS3.features.s3_upload, true);
  assert.equal(withS3.features.pipeline, true);
  // valid until is capped, so the app asks again within 35 days
  assert.ok(withS3.validUntil.getTime() <= Date.now() + 35 * 86400_000 + 1000);
  // ended complimentary
  const past = entitlements(
    { ...(await subscriptionOf(sql, a.id))!, endsAt: new Date(Date.now() - 1000) },
    me,
  );
  assert.equal(past.state, 'ended');
});

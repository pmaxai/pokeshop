import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import { signInWithIdentity } from '../../src/app-signin.ts';
import {
  deleteAccount,
  deleteExpiredLogins,
  DELETED_KEEP_DAYS,
  purgeDeletedAccounts,
} from '../../src/accounts.ts';
import { deviceByToken } from '../../src/devices.ts';
import { enqueueMail } from '../../src/outbox.ts';
import {
  cancelRequestedRenewals,
  parseGoogleSubscription,
  processGooglePurchase,
  PurchaseInvalid,
  saveStoreProducts,
  type GooglePlay,
  type GoogleSubscription,
} from '../../src/store.ts';
import { subscriptionOf } from '../../src/subscriptions.ts';

let sql: Sql;
let drop: () => Promise<void>;
const BASE = 'http://localhost:3000';
const DAY = 86400_000;

class FakePlay implements GooglePlay {
  subs = new Map<string, Record<string, unknown>>();
  cancels: string[] = [];
  down = false;
  async getSubscription(token: string): Promise<GoogleSubscription> {
    const raw = this.subs.get(token);
    if (!raw) throw new PurchaseInvalid('HTTP 404');
    return parseGoogleSubscription(raw);
  }
  async acknowledge() {}
  async cancel(_p: string, token: string) {
    if (this.down) throw new Error('Google is down');
    this.cancels.push(token);
  }
}

const googleSub = (ref: string) => ({
  kind: 'androidpublisher#subscriptionPurchaseV2',
  regionCode: 'AT',
  startTime: new Date().toISOString(),
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  latestOrderId: 'GPA.1111-2222-3333-44444',
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
  externalAccountIdentifiers: { obfuscatedExternalAccountId: ref },
  lineItems: [
    {
      productId: 'oc_collector',
      expiryTime: new Date(Date.now() + 30 * DAY).toISOString(),
      autoRenewingPlan: { autoRenewEnabled: true },
      offerDetails: { basePlanId: 'monthly' },
    },
  ],
});

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
  const ok = await saveStoreProducts(sql, {
    google: {
      collector: { product_id: 'oc_collector', base_plans: { monthly: 'monthly', yearly: null } },
      creator: { product_id: 'oc_creator', base_plans: { monthly: 'monthly', yearly: null } },
    },
    apple: { collector: { monthly: null, yearly: null }, creator: { monthly: null, yearly: null } },
  });
  assert.ok(ok.ok);
});
after(async () => drop());

test('deleting scrubs the account, signs out its devices and stops the Google renewal', async () => {
  const play = new FakePlay();
  const { account, token } = await signIn('erika@example.com', 1);
  play.subs.set('tok-erika', googleSub(account.storeRef));
  assert.ok(
    (
      await processGooglePurchase(sql, play, {
        token: 'tok-erika',
        productId: 'oc_collector',
        accountId: account.id,
      })
    ).ok,
  );
  await sql`
    INSERT INTO collection_items (account_id, card_id, language, finish, condition, quantity, source)
    VALUES (${account.id}, 'base1-4', 'EN', 'holo', 'NM', 1, 'app')`;
  await sql`INSERT INTO wanted_cards (account_id, card_id) VALUES (${account.id}, 'base1-2')`;

  const r = await deleteAccount(sql, account.id);
  assert.deepEqual(r, { deleted: true, cancelInStore: [] }, 'Google is cancelled by the server');
  assert.equal((await deleteAccount(sql, account.id)).deleted, false, 'only once');

  const [a] = await sql<
    {
      email: string;
      name: string | null;
      deleted_at: Date | null;
      email_verified_at: Date | null;
    }[]
  >`SELECT email, name, deleted_at, email_verified_at FROM accounts WHERE id = ${account.id}`;
  assert.match(a!.email, /^deleted-.+@deleted\.invalid$/);
  assert.equal(a!.name, null);
  assert.ok(a!.deleted_at);
  for (const t of ['collection_items', 'wanted_cards', 'account_identities', 'account_sessions']) {
    const [c] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(t)} WHERE account_id = ${account.id}`;
    assert.equal(c!.n, 0, t);
  }
  // the app learns why it was signed out
  const d = await deviceByToken(sql, token);
  assert.equal(d.ok, false);
  assert.ok(!d.ok && d.problem === 'unpaired' && d.reason === 'account_deleted');

  // the renewal: requested at deletion, cancelled at Google once it answers
  play.down = true;
  assert.deepEqual(await cancelRequestedRenewals(sql, play), { cancelled: 0, failed: 1 });
  play.down = false;
  assert.deepEqual(await cancelRequestedRenewals(sql, play), { cancelled: 1, failed: 0 });
  assert.deepEqual(play.cancels, ['tok-erika']);
  assert.deepEqual(await cancelRequestedRenewals(sql, play), { cancelled: 0, failed: 0 });
  const [p] = await sql<{ state: string; auto_renew: boolean; account_id: number | null }[]>`
    SELECT state, auto_renew, account_id FROM store_purchases WHERE purchase_token = 'tok-erika'`;
  assert.deepEqual(p, { state: 'canceled', auto_renew: false, account_id: account.id });
  // the paid month still counts for the (deleted) account until the store says it ended
  assert.equal((await subscriptionOf(sql, account.id))?.status, 'canceled');

  // no mail goes to the scrubbed address
  assert.equal(
    await enqueueMail(sql, { template: 'account_login', to: a!.email, locale: 'en', payload: {} }),
    null,
  );

  // a new sign-in with the same Google account makes a new account
  const again = await signIn('erika@example.com', 2);
  assert.notEqual(again.account.id, account.id);
  assert.equal(again.created, true);
});

test('deleted accounts are removed after 30 days, unless something still runs', async () => {
  const play = new FakePlay();
  const now = new Date();
  const later = new Date(now.getTime() + (DELETED_KEEP_DAYS + 1) * DAY);
  const { account: plain } = await signIn('plain@example.com', 3);
  const { account: pending } = await signIn('pending@example.com', 4);
  play.subs.set('tok-pending', googleSub(pending.storeRef));
  assert.ok(
    (
      await processGooglePurchase(sql, play, {
        token: 'tok-pending',
        productId: 'oc_collector',
        accountId: pending.id,
      })
    ).ok,
  );
  await deleteAccount(sql, plain.id, now);
  await deleteAccount(sql, pending.id, now);

  assert.equal(await purgeDeletedAccounts(sql, now), 0, 'not before 30 days');
  // pending: the renewal is not stopped at Google yet → kept
  const purged = await purgeDeletedAccounts(sql, later);
  assert.ok(purged >= 1);
  const left = await sql<{ id: number }[]>`
    SELECT id FROM accounts WHERE id IN (${plain.id}, ${pending.id})`;
  assert.deepEqual(
    left.map((r) => r.id),
    [pending.id],
  );
  await cancelRequestedRenewals(sql, play);
  await purgeDeletedAccounts(sql, later);
  const [gone] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM accounts WHERE id = ${pending.id}`;
  assert.equal(gone!.n, 0);
  // the store's record stays, without the account
  const [p] = await sql<{ account_id: number | null }[]>`
    SELECT account_id FROM store_purchases WHERE purchase_token = 'tok-pending'`;
  assert.equal(p!.account_id, null);
});

test('test-hook purchases are cancelled without asking Google', async () => {
  const play = new FakePlay();
  const { account } = await signIn('hooks@example.com', 5);
  assert.ok(
    (
      await processGooglePurchase(sql, play, {
        token: 'test_active-del',
        productId: 'oc_collector',
        accountId: account.id,
        testHooks: true,
      })
    ).ok,
  );
  await deleteAccount(sql, account.id);
  assert.deepEqual(await cancelRequestedRenewals(sql, null), { cancelled: 1, failed: 0 });
  assert.deepEqual(play.cancels, []);
});

test('old app sign-in codes are cleaned up', async () => {
  await sql`
    INSERT INTO app_login_codes (email, code_hash, created_at, expires_at)
    VALUES ('old@example.com', 'x', now() - interval '2 days', now() - interval '2 days'),
           ('new@example.com', 'y', now(), now() + interval '10 minutes')`;
  await deleteExpiredLogins(sql);
  const rows = await sql<{ email: string }[]>`SELECT email FROM app_login_codes`;
  assert.deepEqual(
    rows.map((r) => r.email),
    ['new@example.com'],
  );
});

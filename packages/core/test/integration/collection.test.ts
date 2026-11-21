import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDatabase } from './helpers.ts';
import { makeCatalog } from './pack-fixture.ts';
import type { Sql } from '../../src/db.ts';
import { importPack } from '../../src/pricepack.ts';
import { redeemLoginLink, requestLoginLink, type Account } from '../../src/accounts.ts';
import {
  addItem,
  appShare,
  collectionView,
  createBinder,
  createShare,
  deleteItem,
  ensureAppShare,
  itemJson,
  itemsOfCard,
  openShare,
  revokePublicShares,
  revokeShare,
  shareJson,
  syncItems,
  syncShopPurchases,
  updateItem,
} from '../../src/collection.ts';

let sql: Sql;
let drop: () => Promise<void>;
let dir: string;
let a: Account;
const BASE = 'http://localhost:3000';

before(async () => {
  ({ sql, drop } = await freshDatabase());
  dir = mkdtempSync(join(tmpdir(), 'coll-test-'));
  makeCatalog(join(dir, 'catalog.sqlite'), 400);
  await importPack(sql, {
    manifest: { version: 'v1', files: { 'catalog.sqlite': { bytes: 1, sha256: 'a'.repeat(64) } } },
    catalogPath: join(dir, 'catalog.sqlite'),
  });
  await requestLoginLink(sql, { email: 'ash@example.com', locale: 'de', baseUrl: BASE });
  const [m] = await sql<
    { payload: { url: string } }[]
  >`SELECT payload FROM outbox ORDER BY id DESC LIMIT 1`;
  const r = await redeemLoginLink(sql, new URL(m!.payload.url).searchParams.get('t')!);
  assert.ok(r.ok);
  a = r.account;
});
after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await drop();
});

const charizard = { card_id: 'base1-4', language: 'DE', finish: 'holo', condition: 'NM' };

test('adding: validation, unknown cards, merging plain lines, client_ref', async () => {
  const bad = await addItem(
    sql,
    a.id,
    { ...charizard, condition: 'XX', quantity: 0 },
    { source: 'portal' },
  );
  assert.deepEqual(bad, { ok: false, errors: { condition: 'invalid', quantity: 'invalid' } });
  assert.deepEqual(
    await addItem(sql, a.id, { ...charizard, card_id: 'nope-1' }, { source: 'portal' }),
    {
      ok: false,
      errors: { card_id: 'unknown' },
    },
  );
  const one = await addItem(sql, a.id, charizard, {
    source: 'app',
    clientRef: 'ref-aaaa-0001',
    locale: 'de',
  });
  assert.ok(one.ok && one.created);
  assert.equal(one.item.card?.name, 'Glurak');
  assert.equal(one.item.valueCents, 40000);
  // the same client_ref again: same item, nothing added
  const again = await addItem(sql, a.id, charizard, { source: 'app', clientRef: 'ref-aaaa-0001' });
  assert.ok(
    again.ok && !again.created && again.item.id === one.item.id && again.item.quantity === 1,
  );
  // a new tap: merged into the plain line
  const merged = await addItem(
    sql,
    a.id,
    { ...charizard, quantity: 2 },
    { source: 'app', clientRef: 'ref-aaaa-0002' },
  );
  assert.ok(merged.ok && merged.item.id === one.item.id && merged.item.quantity === 3);
  // EX condition, with a price: its own line, valued at 85 %
  const ex = await addItem(
    sql,
    a.id,
    { ...charizard, condition: 'EX', purchase_price_cents: 25000 },
    { source: 'portal' },
  );
  assert.ok(ex.ok && ex.created && ex.item.valueCents === 34000);
  assert.equal((await itemsOfCard(sql, a.id, 'base1-4', 'de')).length, 2);
});

test('view, update, delete and the app’s sync with deletions', async () => {
  const t0 = new Date(Date.now() - 1000);
  const b = await createBinder(sql, a.id, 'Tauschordner');
  assert.ok(b);
  const pika = await addItem(
    sql,
    a.id,
    { card_id: 'base1-58', language: 'EN', finish: 'normal', condition: 'GD', binder_id: b.id },
    { source: 'portal' },
  );
  assert.ok(pika.ok);
  const view = await collectionView(sql, a.id, { locale: 'en' });
  assert.equal(view.total.cards, 5);
  assert.equal(view.total.valueCents, 3 * 40000 + 34000);
  assert.equal(view.total.withoutPrice, 1); // Pikachu has no price in the fixture
  assert.equal(view.total.purchaseCents, 25000);
  assert.equal(view.items[0]!.cardId, 'base1-4');
  const filtered = await collectionView(sql, a.id, { locale: 'en', q: 'pika' });
  assert.deepEqual(
    filtered.items.map((i) => i.cardId),
    ['base1-58'],
  );
  const inBinder = await collectionView(sql, a.id, { locale: 'en', binderId: b.id });
  assert.equal(inBinder.items.length, 1);

  const up = await updateItem(sql, a.id, pika.item.id, {
    quantity: 4,
    note: 'Promo-Stempel',
    binder_id: null,
  });
  assert.ok(
    up &&
      up.ok &&
      up.item.quantity === 4 &&
      up.item.note === 'Promo-Stempel' &&
      up.item.binderId === null,
  );
  assert.deepEqual(await updateItem(sql, a.id, pika.item.id, { quantity: 1000 }), {
    ok: false,
    errors: { quantity: 'too_large' },
  });
  assert.equal(await updateItem(sql, a.id, 999999, { quantity: 2 }), null);

  await deleteItem(sql, a.id, pika.item.id);
  const sync = await syncItems(sql, a.id, { updatedSince: t0 });
  const gone = sync.items.find((i) => i.id === pika.item.id);
  assert.ok(gone && 'deleted' in gone);
  // a first sync (no time) lists only what is there, page by page
  const p1 = await syncItems(sql, a.id, { limit: 1 });
  assert.equal(p1.items.length, 1);
  assert.ok(p1.nextCursor);
  const p2 = await syncItems(sql, a.id, { limit: 1, cursor: p1.nextCursor });
  assert.equal(p2.items.length, 1);
  assert.notEqual(p2.items[0]!.id, p1.items[0]!.id);
  assert.equal(p2.nextCursor, null);
});

test('shares: a personal link is mailed and expires after 7 days, a public one until revoked', async () => {
  const account = { id: a.id, name: 'Ash', email: a.email, locale: 'de' as const };
  assert.deepEqual(await createShare(sql, account, { kind: 'personal' }, { baseUrl: BASE }), {
    ok: false,
    errors: { recipientEmail: 'required' },
  });
  const p = await createShare(
    sql,
    account,
    { kind: 'personal', recipientEmail: 'Misty@Example.com', message: 'Schau mal' },
    { baseUrl: BASE },
  );
  assert.ok(p.ok);
  const [mail] = await sql<{ to_address: string; reply_to: string; payload: { url: string } }[]>`
    SELECT to_address, reply_to, payload FROM outbox WHERE template = 'collection_shared'`;
  assert.equal(mail!.to_address, 'misty@example.com');
  assert.equal(mail!.reply_to, a.email);
  assert.equal(mail!.payload.url, `${BASE}/de/c/${p.share.token}`);
  const opened = await openShare(sql, p.share.token);
  assert.ok(opened.ok && opened.owner.id === a.id);
  const later = new Date(Date.now() + 8 * 86400_000);
  assert.deepEqual(await openShare(sql, p.share.token, later), { ok: false, problem: 'expired' });

  const pub = await createShare(
    sql,
    account,
    { kind: 'public', title: 'Alles', showPrices: false },
    { baseUrl: BASE },
  );
  assert.ok(pub.ok && pub.share.expiresAt === null);
  assert.ok((await openShare(sql, pub.share.token, later)).ok);
  await revokeShare(sql, a.id, pub.share.id);
  assert.deepEqual(await openShare(sql, pub.share.token), { ok: false, problem: 'unknown' });
});

async function newAccount(email: string): Promise<Account> {
  await requestLoginLink(sql, { email, locale: 'de', baseUrl: BASE });
  const [m] = await sql<{ payload: { url: string } }[]>`
    SELECT payload FROM outbox WHERE to_address = ${email} ORDER BY id DESC LIMIT 1`;
  const r = await redeemLoginLink(sql, new URL(m!.payload.url).searchParams.get('t')!);
  assert.ok(r.ok);
  return r.account;
}

test('the app’s link: made once, found again, counted next to other public links', async () => {
  const bo = await newAccount('bo@example.com');
  const owner = { id: bo.id, name: null, email: bo.email, locale: 'de' as const };
  // never shared
  assert.deepEqual(await appShare(sql, bo.id), { share: null, otherPublic: 0 });
  // made now (no binders, with prices), then the same one again
  const made = await ensureAppShare(sql, bo.id);
  assert.equal(made.created, true);
  assert.deepEqual(made.share.binderIds, []);
  assert.equal(made.share.showPrices, true);
  assert.equal(made.share.kind, 'public');
  assert.equal(made.share.title, null);
  const again = await ensureAppShare(sql, bo.id);
  assert.equal(again.created, false);
  assert.equal(again.share.id, made.share.id);
  assert.equal((await appShare(sql, bo.id)).share?.id, made.share.id);
  // as the app gets it: the address in the account's language
  assert.deepEqual(shareJson(made.share, BASE, 'de'), {
    id: made.share.id,
    url: `${BASE}/de/c/${made.share.token}`,
    show_prices: true,
    views: 0,
    created_at: made.share.createdAt.toISOString(),
  });

  // two quick taps at once still make one link
  const cy = await newAccount('cy@example.com');
  const both = await Promise.all([ensureAppShare(sql, cy.id), ensureAppShare(sql, cy.id)]);
  assert.equal(both[0].share.id, both[1].share.id);
  assert.deepEqual(both.map((x) => x.created).sort(), [false, true]);
  const [{ n }] = await sql<[{ n: number }]>`
    SELECT count(*)::int AS n FROM collection_shares WHERE account_id = ${cy.id}`;
  assert.equal(n, 1);

  // a portal link of one binder is another public link, not the app's
  const dee = await newAccount('dee@example.com');
  const deeOwner = { id: dee.id, name: null, email: dee.email, locale: 'de' as const };
  const binder = await createBinder(sql, dee.id, 'Tausch');
  assert.ok(binder);
  const one = await createShare(
    sql,
    deeOwner,
    { kind: 'public', binderIds: [binder.id] },
    { baseUrl: BASE },
  );
  assert.ok(one.ok);
  assert.deepEqual(await appShare(sql, dee.id), { share: null, otherPublic: 1 });
  const deeApp = await ensureAppShare(sql, dee.id);
  assert.equal(deeApp.created, true);
  assert.equal(deeApp.otherPublic, 1);
  assert.equal((await appShare(sql, dee.id)).otherPublic, 1);
  // …and so is one without prices
  assert.ok(
    (await createShare(sql, deeOwner, { kind: 'public', showPrices: false }, { baseUrl: BASE })).ok,
  );
  assert.equal((await appShare(sql, dee.id)).otherPublic, 2);

  // a portal link of the whole collection with prices is the app's link
  const eli = await newAccount('eli@example.com');
  const eliOwner = { id: eli.id, name: null, email: eli.email, locale: 'de' as const };
  const portal = await createShare(sql, eliOwner, { kind: 'public' }, { baseUrl: BASE });
  assert.ok(portal.ok);
  const eliApp = await ensureAppShare(sql, eli.id);
  assert.equal(eliApp.created, false);
  assert.equal(eliApp.share.id, portal.share.id);
  // revoked in the portal: the app sees the collection as private
  await revokeShare(sql, eli.id, portal.share.id);
  assert.equal((await appShare(sql, eli.id)).share, null);

  // Make private: every public link stops, personal ones keep running
  const personal = await createShare(
    sql,
    owner,
    { kind: 'personal', recipientEmail: 'friend@example.com' },
    { baseUrl: BASE },
  );
  assert.ok(personal.ok);
  const binders = await createShare(
    sql,
    owner,
    { kind: 'public', showPrices: false },
    { baseUrl: BASE },
  );
  assert.ok(binders.ok);
  assert.equal((await appShare(sql, bo.id)).otherPublic, 1);
  assert.equal(await revokePublicShares(sql, bo.id), 2);
  assert.deepEqual(await appShare(sql, bo.id), { share: null, otherPublic: 0 });
  assert.deepEqual(await openShare(sql, made.share.token), { ok: false, problem: 'unknown' });
  assert.deepEqual(await openShare(sql, binders.share.token), { ok: false, problem: 'unknown' });
  assert.ok((await openShare(sql, personal.share.token)).ok);
  // nothing public any more: still fine
  assert.equal(await revokePublicShares(sql, bo.id), 0);
  // sharing again makes a new link
  const fresh = await ensureAppShare(sql, bo.id);
  assert.equal(fresh.created, true);
  assert.notEqual(fresh.share.token, made.share.token);
});

test('an edited item comes back whole, as the app shows it', async () => {
  const added = await addItem(sql, a.id, { ...charizard, merge: false }, { source: 'app' });
  assert.ok(added.ok);
  const up = await updateItem(sql, a.id, added.item.id, { quantity: 2 }, 'de');
  assert.ok(up && up.ok);
  const j = itemJson(up.item);
  assert.equal(j.quantity, 2);
  assert.equal(j.card_id, 'base1-4');
  for (const k of ['name', 'set_name', 'number', 'image_url', 'value_cents'] as const) {
    assert.ok(j[k] !== null && j[k] !== undefined, `${k} is there`);
  }
});

test('cards bought in the shop join the collection once and leave it after a refund', async () => {
  await sql`INSERT INTO card_sets (set_code, name_de, name_en, card_count) VALUES ('base1', 'Grundset', 'Base Set', 102)`;
  await sql`INSERT INTO card_master (card_ref, set_code, local_id, name_de, name_en) VALUES ('base1-4', 'base1', '4', 'Glurak', 'Charizard')`;
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (sku, slug, card_ref, set_code, card_number, name_de, name_en, card_language, finish, condition, price_cents, status)
    VALUES ('BASE1-4-DE-EX-H', 'base1-4-de-ex-h', 'base1-4', 'base1', '4/102', 'Glurak', 'Charizard', 'DE', 'holo', 'EX', 30000, 'active')
    RETURNING id`;
  const [o] = await sql<{ id: number }[]>`
    INSERT INTO orders (number, lookup_token, status, locale, country, email, goods_cents, shipping_cents, total_cents,
                        shipping_method, vat_regime, vat_rate_bp, vat_cents, account_id)
    VALUES ('PK-COLL-1', ${'t'.repeat(30)}, 'paid', 'de', 'AT', ${a.email}, 30000, 0, 30000, 'insured', 'small_business', 0, 0, ${a.id})
    RETURNING id`;
  await sql`
    INSERT INTO order_items (order_id, product_id, sku, name_de, name_en, set_code, card_number, card_language, condition, finish,
                             unit_price_cents, quantity)
    VALUES (${o!.id}, ${p!.id}, 'BASE1-4-DE-EX-H', 'Glurak', 'Charizard', 'base1', '4/102', 'DE', 'EX', 'holo', 30000, 1)`;
  assert.deepEqual(await syncShopPurchases(sql), { added: 1, removed: 0 });
  assert.deepEqual(await syncShopPurchases(sql), { added: 0, removed: 0 });
  const shop = (await itemsOfCard(sql, a.id, 'base1-4', 'de')).find((i) => i.source === 'shop');
  assert.equal(shop?.purchasePriceCents, 30000);
  assert.equal(shop?.condition, 'EX');
  await sql`UPDATE orders SET status = 'refunded' WHERE id = ${o!.id}`;
  assert.deepEqual(await syncShopPurchases(sql), { added: 0, removed: 1 });
  assert.equal(
    (await itemsOfCard(sql, a.id, 'base1-4', 'de')).some((i) => i.source === 'shop'),
    false,
  );
});

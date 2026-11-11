import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import {
  parse,
  IntakeRequest,
  ProductPatch,
  StockChange,
  ProductInput,
} from '../../src/api-schemas.ts';
import {
  changeStock,
  getProduct,
  intake,
  listProducts,
  patchProduct,
  replaceProduct,
  searchMaster,
  type Actor,
} from '../../src/products.ts';
import {
  claimIdempotencyKey,
  createApiClient,
  ipAllowed,
  loadApiClient,
  storeIdempotentResponse,
  requestHash,
} from '../../src/api-clients.ts';
import { ApiError } from '../../src/errors.ts';
import { syncCardDetails, type TcgdexClient } from '../../src/tcgdex.ts';

let sql: Sql;
let drop: () => Promise<void>;
const actor: Actor = { source: 'api', id: 'kid_test', reference: 'req-1' };

const tcgdex: TcgdexClient = {
  sets: async () => [],
  set: async () => null,
  card: async (lang, id) =>
    id === 'sv03.5-199'
      ? {
          id,
          localId: '199',
          name: lang === 'de' ? 'Glurak-ex' : 'Charizard ex',
          category: 'Pokemon',
          rarity: lang === 'de' ? 'Selten, besondere Illustration' : 'Special illustration rare',
          types: ['Fire'],
          image: `https://assets.tcgdex.net/${lang}/sv/sv03.5/199`,
          set: { id: 'sv03.5' },
        }
      : null,
};

before(async () => {
  ({ sql, drop } = await freshDatabase());
  await sql`INSERT INTO card_sets (set_code, name_de, name_en, card_count, release_date)
            VALUES ('sv03.5', '151', '151', 165, '2023-09-22')`;
});
after(async () => drop());

const glurak = (over: Record<string, unknown> = {}) =>
  parse(IntakeRequest, {
    card_ref: 'sv03.5-199',
    card_language: 'DE',
    condition: 'NM',
    finish: 'holo',
    delta: 1,
    storage_location: '014',
    price: { amount: 12900, currency: 'EUR' },
    ...over,
  });

test('validation names each bad field and rejects unknown ones', () => {
  try {
    parse(IntakeRequest, {
      card_language: 'XX',
      condition: 'NMM',
      finish: 'holo',
      delta: 0,
      storage_location: '14',
      storage_locaton: '014',
    });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 422);
    assert.ok(e.fields?.card_language);
    assert.ok(e.fields?.condition);
    assert.ok(e.fields?.storage_location);
    assert.ok(e.fields?._?.includes('storage_locaton'), JSON.stringify(e.fields));
  }
});

test('intake creates the product from master data and puts the copy into box 014', async () => {
  const r = await intake(sql, glurak(), actor, {
    tcgdex,
    baseUrl: 'https://overpricedcardboard.com',
  });
  assert.equal(r.created, true);
  assert.deepEqual(r.warnings, []);
  const p = r.product;
  assert.equal(p.sku, 'sv03.5-199-DE-NM-H');
  assert.equal(p.name_de, 'Glurak-ex');
  assert.equal(p.name_en, 'Charizard ex');
  assert.equal(p.card_number, '199/165');
  assert.equal(p.rarity, 'Special illustration rare');
  assert.equal(p.release_year, 2023);
  assert.equal(p.status, 'active', 'price + card image → active');
  assert.equal(p.high_value, true);
  assert.equal(p.url, 'https://overpricedcardboard.com/karten/glurak-ex-sv03-5-199-de-nm-h');
  assert.deepEqual(p.stock, {
    quantity: 1,
    reserved: 0,
    available: 1,
    boxes: [{ storage_location: '014', quantity: 1, reserved: 0 }],
  });
});

test('a second copy in another box becomes a second box entry, not an overwrite', async () => {
  const r = await intake(
    sql,
    glurak({ storage_location: '003', price: { amount: 11900, currency: 'EUR' } }),
    actor,
    { tcgdex },
  );
  assert.equal(r.created, false);
  assert.equal(r.product.price?.amount, 11900, 'latest scanned price wins');
  assert.deepEqual(
    r.product.stock.boxes.map((b) => `${b.storage_location}:${b.quantity}`),
    ['003:1', '014:1'],
  );
});

test('set_code + card_number finds the same product as card_ref', async () => {
  const r = await intake(
    sql,
    glurak({ card_ref: undefined, set_code: 'sv03.5', card_number: '199/165' }),
    actor,
    {},
  );
  assert.equal(r.created, false);
  assert.equal(r.product.stock.quantity, 3);
});

test('unknown card without names is refused; with names it is created as draft without price', async () => {
  await assert.rejects(
    intake(sql, glurak({ card_ref: 'zz1-7', price: undefined }), actor, { tcgdex }),
    (e: ApiError) => e.code === 'unknown_card',
  );
  const r = await intake(
    sql,
    glurak({
      card_ref: 'zz1-7',
      name_de: 'Testkarte',
      name_en: 'Test card',
      price: undefined,
    }),
    actor,
    { tcgdex },
  );
  assert.equal(r.product.status, 'draft');
  assert.equal(r.product.sku, 'zz1-7-DE-NM-H');
  assert.equal(r.product.card_ref, null, 'not in the master data');
});

test('asking for active without price stays draft with a warning', async () => {
  const r = await intake(
    sql,
    glurak({ card_ref: 'zz1-8', name_de: 'A', name_en: 'A', price: undefined, status: 'active' }),
    actor,
    {},
  );
  assert.equal(r.product.status, 'draft');
  assert.ok(r.warnings.includes('not_activated_no_price'));
  assert.ok(r.warnings.includes('not_activated_no_image'));
});

test('external_id must be unique', async () => {
  await intake(sql, glurak({ external_id: 'scan-1' }), actor, {});
  await assert.rejects(
    intake(
      sql,
      glurak({ card_ref: 'zz1-7', name_de: 'T', name_en: 'T', external_id: 'scan-1' }),
      actor,
      {},
    ),
    (e: ApiError) => e.status === 409 && e.code === 'external_id_taken',
  );
});

test('high value follows the price: more than € 50, whatever the app sends', async () => {
  const at = (amount: number, over: Record<string, unknown> = {}) =>
    intake(
      sql,
      glurak({ condition: 'EX', price: { amount, currency: 'EUR' }, ...over }),
      actor,
      {},
    );
  assert.equal((await at(5000)).product.high_value, false, '€ 50.00 is not more than € 50');
  assert.equal((await at(5001)).product.high_value, true);
  const r = await at(500, { high_value: true });
  assert.equal(r.product.high_value, false, 'the app cannot override the price rule');
  assert.ok(r.warnings.includes('high_value_ignored_set_by_price'));
  // changing the threshold re-evaluates existing products
  await sql`UPDATE settings SET value = '400' WHERE key = 'high_value_threshold_cents'`;
  const [p] = await sql<{ high_value: boolean }[]>`
    SELECT high_value FROM products WHERE sku = 'sv03.5-199-DE-EX-H'`;
  assert.equal(p!.high_value, true);
  await sql`UPDATE settings SET value = '5000' WHERE key = 'high_value_threshold_cents'`;
});

test('stock: remove, set, move, and refuse taking more than a box holds', async () => {
  const sku = 'sv03.5-199-DE-NM-H';
  let s = await changeStock(
    sql,
    sku,
    parse(StockChange, { delta: -1, storage_location: '003', reason: 'damaged' }),
    actor,
  );
  assert.deepEqual(
    s.boxes.map((b) => `${b.storage_location}:${b.quantity}`),
    ['014:3'],
  );
  s = await changeStock(sql, sku, parse(StockChange, { set: 5, storage_location: '014' }), actor);
  assert.equal(s.quantity, 5);
  s = await changeStock(sql, sku, parse(StockChange, { move: 2, from: '014', to: '020' }), actor);
  assert.deepEqual(
    s.boxes.map((b) => `${b.storage_location}:${b.quantity}`),
    ['014:3', '020:2'],
  );
  await assert.rejects(
    changeStock(sql, sku, parse(StockChange, { delta: -9, storage_location: '020' }), actor),
    (e: ApiError) => e.status === 409 && e.code === 'insufficient_stock',
  );
  await assert.rejects(
    changeStock(sql, 'nope', parse(StockChange, { delta: 1, storage_location: '001' }), actor),
    (e: ApiError) => e.status === 404,
  );
  const [ledger] = await sql`SELECT count(*)::int AS n FROM stock_ledger WHERE actor = 'kid_test'`;
  assert.ok((ledger?.n as number) >= 6);
});

test('patch moves all free copies into one box', async () => {
  const r = await patchProduct(
    sql,
    'sv03.5-199-DE-NM-H',
    parse(ProductPatch, { storage_location: '099', description_de: 'Leicht dezentriert' }),
    actor,
    {},
  );
  assert.deepEqual(
    r.product.stock.boxes.map((b) => `${b.storage_location}:${b.quantity}`),
    ['099:5'],
  );
  const [row] = await sql`SELECT description_de FROM products WHERE sku = 'sv03.5-199-DE-NM-H'`;
  assert.equal(row?.description_de, 'Leicht dezentriert');
});

test('PUT refuses a body that describes another card', async () => {
  await assert.rejects(
    replaceProduct(
      sql,
      'sv03.5-199-DE-NM-H',
      parse(ProductInput, {
        card_ref: 'sv03.5-199',
        card_language: 'EN',
        condition: 'NM',
        finish: 'holo',
      }),
      actor,
      {},
    ),
    (e: ApiError) => e.code === 'identity_mismatch',
  );
  const r = await replaceProduct(
    sql,
    'sv03.5-199-EN-NM-H',
    parse(ProductInput, {
      card_ref: 'sv03.5-199',
      card_language: 'EN',
      condition: 'NM',
      finish: 'holo',
      price: { amount: 9900, currency: 'EUR' },
    }),
    actor,
    {},
  );
  assert.equal(r.created, true);
  assert.equal(r.product.stock.quantity, 0);
});

test('PUT replaces URL images but keeps uploaded photos', async () => {
  const sku = 'sv03.5-199-DE-EX-H';
  const created = await intake(
    sql,
    glurak({
      condition: 'EX',
      images: [{ role: 'front', url: 'https://example.com/old-front.jpg' }],
    }),
    actor,
    {},
  );
  assert.equal(created.product.sku, sku);
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products WHERE sku = ${sku}`;
  await sql`INSERT INTO product_images (product_id, role, position, source_url)
            VALUES (${p!.id}, 'back', 5, 'upload:incoming/scan-back.jpg')`;

  await replaceProduct(
    sql,
    sku,
    parse(ProductInput, {
      card_ref: 'sv03.5-199',
      card_language: 'DE',
      condition: 'EX',
      finish: 'holo',
      price: { amount: 9900, currency: 'EUR' },
      images: [{ role: 'front', url: 'https://example.com/new-front.jpg' }],
    }),
    actor,
    {},
  );
  const sources = await sql<{ source_url: string }[]>`
    SELECT source_url FROM product_images WHERE product_id = ${p!.id} ORDER BY source_url`;
  assert.deepEqual(
    sources.map((r) => r.source_url),
    ['https://example.com/new-front.jpg', 'upload:incoming/scan-back.jpg'],
  );
});

test('list with filters and cursor', async () => {
  const page1 = await listProducts(sql, { limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.ok(page1.next_cursor);
  const page2 = await listProducts(sql, { limit: 2, cursor: page1.next_cursor! });
  assert.notEqual(page2.items[0]?.sku, page1.items[0]?.sku);
  const inBox = await listProducts(sql, { storage_location: '099' });
  assert.deepEqual(
    inBox.items.map((p) => p.sku),
    ['sv03.5-199-DE-NM-H'],
  );
  assert.equal(await getProduct(sql, 'missing'), null);
});

test('master search by set and number, and by name with a typo', async () => {
  await syncCardDetails(sql, tcgdex, 'sv03.5-199');
  assert.equal(
    (await searchMaster(sql, { set: 'sv03.5', number: '199/165' }))[0]?.name,
    'Glurak-ex',
  );
  assert.equal((await searchMaster(sql, { q: 'glurk', lang: 'de' }))[0]?.card_ref, 'sv03.5-199');
  assert.equal((await searchMaster(sql, { q: 'charizard', lang: 'en' }))[0]?.name, 'Charizard ex');
});

test('API clients: encrypted secret, IP allow-list, idempotency', async () => {
  const key = randomBytes(32);
  const { client, secret } = await createApiClient(
    sql,
    { name: 'Scanner', createdBy: 'test', ipAllowlist: ['10.0.0.0/24'] },
    key,
  );
  const [raw] = await sql`SELECT secret_enc FROM api_clients WHERE id = ${client.id}`;
  assert.ok(!String(raw?.secret_enc).includes(secret), 'secret not stored in plain text');
  assert.equal((await loadApiClient(sql, client.key_id, key))?.secret, secret);
  assert.equal(await ipAllowed(sql, client.id, '10.0.0.7'), true);
  assert.equal(await ipAllowed(sql, client.id, '192.168.1.1'), false);

  const h = requestHash('POST', '/api/v1/stock/intake', '{"a":1}');
  assert.deepEqual(await claimIdempotencyKey(sql, client.id, 'k1', h), { state: 'new' });
  assert.deepEqual(await claimIdempotencyKey(sql, client.id, 'k1', h), { state: 'in_progress' });
  await storeIdempotentResponse(sql, client.id, 'k1', 201, { ok: true });
  assert.deepEqual(await claimIdempotencyKey(sql, client.id, 'k1', h), {
    state: 'replay',
    status: 201,
    body: { ok: true },
  });
  assert.deepEqual(await claimIdempotencyKey(sql, client.id, 'k1', 'other'), { state: 'conflict' });
});

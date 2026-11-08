import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import { ApiError } from '../../src/errors.ts';
import { parse, IntakeRequest, ProductInput, ProductPatch } from '../../src/api-schemas.ts';
import {
  changeStock,
  getProduct,
  intake,
  listProducts,
  patchProduct,
  replaceProduct,
  type Actor,
} from '../../src/products.ts';
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from '../../src/categories.ts';
import { listCatalog, productBySlug, setsForSale } from '../../src/storefront.ts';
import type { TcgdexClient } from '../../src/tcgdex.ts';

let sql: Sql;
let drop: () => Promise<void>;
const actor: Actor = { source: 'api', id: 'kid_test', reference: 'req-variants' };

const NAMES: Record<string, { de: string; en: string }> = {
  'sv03.5-199': { de: 'Glurak-ex', en: 'Charizard ex' },
  'sv03.5-025': { de: 'Pikachu', en: 'Pikachu' },
};
const tcgdex: TcgdexClient = {
  sets: async () => [],
  set: async () => null,
  card: async (lang, id) => {
    const n = NAMES[id];
    if (!n || (lang !== 'de' && lang !== 'en')) return null;
    return {
      id,
      localId: id.split('-')[1]!,
      name: n[lang],
      category: 'Pokemon',
      rarity: 'Common',
      types: ['Fire'],
      image: `https://assets.tcgdex.net/${lang}/sv/sv03.5/${id.split('-')[1]}`,
      set: { id: 'sv03.5' },
    };
  },
};

const add = async (cardRef: string, language: string, condition: string, cents: number) =>
  (
    await intake(
      sql,
      parse(IntakeRequest, {
        card_ref: cardRef,
        card_language: language,
        condition,
        finish: 'holo',
        delta: 2,
        storage_location: '014',
        price: { amount: cents, currency: 'EUR' },
      }),
      actor,
      { tcgdex },
    )
  ).product;

let skus: Record<string, string> = {};
let slugs: Record<string, string> = {};

before(async () => {
  ({ sql, drop } = await freshDatabase());
  await sql`INSERT INTO card_sets (set_code, name_de, name_en, card_count, release_date)
            VALUES ('sv03.5', '151', '151', 165, '2023-09-22')`;
  const made = {
    deNM: await add('sv03.5-199', 'DE', 'NM', 12900),
    deEX: await add('sv03.5-199', 'DE', 'EX', 9900),
    deLP: await add('sv03.5-199', 'DE', 'LP', 5900),
    enNM: await add('sv03.5-199', 'EN', 'NM', 15000),
    pika: await add('sv03.5-025', 'DE', 'NM', 300),
  };
  for (const [k, p] of Object.entries(made)) {
    assert.equal(p.status, 'active', k);
    skus[k] = p.sku;
  }
  // the Light Played copy is sold out
  await changeStock(sql, made.deLP.sku, { set: 0, storage_location: '014' }, actor);
  const rows = await sql<{ sku: string; slug: string }[]>`SELECT sku, slug FROM products`;
  slugs = Object.fromEntries(
    Object.entries(skus).map(([k, sku]) => [k, rows.find((r) => r.sku === sku)!.slug]),
  );
});
after(async () => drop());

const conditionsOf = (t: { variants: { condition: string }[] }) =>
  t.variants.map((v) => v.condition);

test('the conditions of one card share a tile; language makes a different card', async () => {
  const r = await listCatalog(sql, { sort: 'price_asc' }, 'de');
  assert.equal(r.total, 3);
  assert.deepEqual(
    r.items.map((t) => t.sku),
    [skus.pika, skus.deEX, skus.enNM],
    'price_asc: by the cheapest condition; the tile leads with it',
  );
  const glurak = r.items[1]!;
  assert.deepEqual(conditionsOf(glurak), ['NM', 'EX'], 'sold out LP left out, best first');
  assert.equal(glurak.priceCents, 9900);
  assert.deepEqual(
    glurak.variants.map((v) => [v.sku, v.priceCents, v.available]),
    [
      [skus.deNM, 12900, 2],
      [skus.deEX, 9900, 2],
    ],
  );
  assert.equal(r.items[2]!.variants.length, 1);

  const desc = await listCatalog(sql, { sort: 'price_desc' }, 'de');
  assert.deepEqual(
    desc.items.map((t) => t.sku),
    [skus.enNM, skus.deEX, skus.pika],
    'price_desc: by the dearest condition',
  );
});

test('filters pick conditions; the tile shows only the matching ones', async () => {
  const nm = await listCatalog(sql, { conditions: ['NM'] }, 'de');
  assert.equal(nm.total, 3);
  const glurak = nm.items.find((t) => t.variants.some((v) => v.sku === skus.deNM))!;
  assert.deepEqual(conditionsOf(glurak), ['NM']);
  assert.equal(glurak.sku, skus.deNM);

  const cheap = await listCatalog(
    sql,
    { priceMax: 10000, languages: ['DE'], sort: 'price_desc' },
    'de',
  );
  assert.deepEqual(
    cheap.items.map((t) => conditionsOf(t)),
    [['EX'], ['NM']],
  );

  const all = await listCatalog(sql, { inStockOnly: false, sort: 'price_asc' }, 'de');
  const withLp = all.items.find((t) => t.variants.some((v) => v.sku === skus.deLP))!;
  assert.deepEqual(conditionsOf(withLp), ['NM', 'EX', 'LP']);
  assert.equal(withLp.sku, skus.deEX, 'leads with a copy in stock, not the cheaper sold-out one');
});

test('pages and counts are cards, not products', async () => {
  const p1 = await listCatalog(sql, { pageSize: 2, sort: 'price_asc' }, 'de');
  assert.equal(p1.pages, 2);
  assert.equal(p1.items.length, 2);
  const p2 = await listCatalog(sql, { pageSize: 2, page: 2, sort: 'price_asc' }, 'de');
  assert.deepEqual(
    p2.items.map((t) => t.sku),
    [skus.enNM],
  );
  const f = p1.facets;
  assert.equal(f.languages.find((x) => x.value === 'DE')?.count, 2);
  assert.equal(f.conditions.find((x) => x.value === 'NM')?.count, 3);
  assert.equal(f.conditions.find((x) => x.value === 'EX')?.count, 1);
  assert.equal(f.sets.find((x) => x.value === 'sv03.5')?.count, 3);
  assert.equal((await setsForSale(sql, 'de'))[0]?.forSale, 3);
});

test('a product page lists the other conditions of the card, sold out included', async () => {
  const page = await productBySlug(sql, slugs.deNM!, 'de');
  assert.ok(page);
  assert.equal(page.sku, skus.deNM);
  assert.deepEqual(
    page.variants.map((v) => [v.condition, v.slug, v.available]),
    [
      ['NM', slugs.deNM, 2],
      ['EX', slugs.deEX, 2],
      ['LP', slugs.deLP, 0],
    ],
  );
  const single = await productBySlug(sql, slugs.enNM!, 'de');
  assert.deepEqual(conditionsOf(single!), ['NM']);
});

test('categories: create, label through the API fields, filter the shop', async () => {
  const cute = await createCategory(sql, { nameDe: 'Süße Karten', nameEn: 'Cute cards' });
  assert.equal(cute.slug, 'suesse-karten');
  await createCategory(sql, { nameDe: 'Cute', position: -1 });
  await assert.rejects(
    createCategory(sql, { nameDe: 'Cute' }),
    (e) => e instanceof ApiError && e.status === 409,
  );
  await assert.rejects(
    createCategory(sql, { nameDe: '   ' }),
    (e) => e instanceof ApiError && e.status === 422,
  );
  assert.deepEqual(
    (await listCategories(sql)).map((c) => c.slug),
    ['cute', 'suesse-karten'],
    'position first',
  );

  // PATCH with categories (as the app sends it)
  const before = (await getProduct(sql, skus.pika!))!;
  assert.deepEqual(before.categories, []);
  await new Promise((r) => setTimeout(r, 20));
  const r = await patchProduct(
    sql,
    skus.pika!,
    parse(ProductPatch, { categories: ['suesse-karten', 'cute', 'cute'] }),
    actor,
  );
  assert.deepEqual(r.product.categories, ['cute', 'suesse-karten']);
  assert.ok(r.product.updated_at > before.updated_at, 'apps syncing by updated_since see it');
  const since = await listProducts(sql, { updated_since: new Date(before.updated_at) });
  assert.ok(since.items.some((p) => p.sku === skus.pika));

  // a PATCH without the field leaves them alone
  const r2 = await patchProduct(
    sql,
    skus.pika!,
    parse(ProductPatch, { name_de: 'Pikachu' }),
    actor,
  );
  assert.deepEqual(r2.product.categories, ['cute', 'suesse-karten']);

  // unknown slug: 422 and nothing changes
  await assert.rejects(
    patchProduct(sql, skus.pika!, parse(ProductPatch, { categories: ['cute', 'nope'] }), actor),
    (e) => e instanceof ApiError && e.status === 422 && /nope/.test(String(e.fields?.categories)),
  );
  assert.deepEqual((await getProduct(sql, skus.pika!))!.categories, ['cute', 'suesse-karten']);
  assert.throws(
    () => parse(ProductPatch, { categories: ['Not A Slug'] }),
    (e) => e instanceof ApiError && 'categories.0' in (e.fields ?? {}),
  );

  // intake labels too; one condition labelled puts the whole card in the category
  await intake(
    sql,
    parse(IntakeRequest, {
      card_ref: 'sv03.5-199',
      card_language: 'DE',
      condition: 'EX',
      finish: 'holo',
      delta: 1,
      storage_location: '015',
      categories: ['cute'],
    }),
    actor,
    { tcgdex },
  );
  const shop = await listCatalog(sql, { categories: ['cute'], sort: 'price_asc' }, 'de');
  assert.deepEqual(
    shop.items.map((t) => [t.sku, conditionsOf(t)]),
    [
      [skus.pika, ['NM']],
      [skus.deEX, ['NM', 'EX']],
    ],
  );
  assert.equal(shop.total, 2);
  assert.deepEqual(
    shop.facets.categories.map((f) => [f.value, f.label, f.count]),
    [
      ['cute', 'Cute', 2],
      ['suesse-karten', 'Süße Karten', 1],
    ],
  );
  const en = await listCatalog(sql, {}, 'en');
  assert.equal(en.facets.categories.find((f) => f.value === 'suesse-karten')?.label, 'Cute cards');
  const page = await productBySlug(sql, slugs.deNM!, 'de');
  assert.deepEqual(page!.categories, [{ slug: 'cute', name: 'Cute' }], 'from the EX copy');

  // PUT replaces the product: no categories field means none
  const current = (await getProduct(sql, skus.deEX!))!;
  const put = await replaceProduct(
    sql,
    skus.deEX!,
    parse(ProductInput, {
      card_ref: 'sv03.5-199',
      card_language: 'DE',
      condition: 'EX',
      finish: 'holo',
      price: current.price,
    }),
    actor,
    { tcgdex },
  );
  assert.deepEqual(put.product.categories, []);

  // renaming keeps the slug; deleting takes it off the products
  const cuteId = (await listCategories(sql)).find((c) => c.slug === 'cute')!.id;
  await updateCategory(sql, cuteId, { nameDe: 'Niedlich', nameEn: 'Cute', position: 5 });
  assert.deepEqual(
    (await listCategories(sql)).map((c) => [c.slug, c.nameDe, c.products]),
    [
      ['suesse-karten', 'Süße Karten', 1],
      ['cute', 'Niedlich', 1],
    ],
  );
  await deleteCategory(sql, cuteId);
  assert.deepEqual((await getProduct(sql, skus.pika!))!.categories, ['suesse-karten']);
});

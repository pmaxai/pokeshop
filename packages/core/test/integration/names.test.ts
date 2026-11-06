import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import { parse, IntakeRequest, ProductPatch } from '../../src/api-schemas.ts';
import { getProduct, intake, patchProduct, type Actor } from '../../src/products.ts';
import { documentItemName } from '../../src/fulfilment.ts';
import {
  fillLocalNames,
  missingLocalNames,
  syncLocalName,
  type TcgdexClient,
} from '../../src/tcgdex.ts';
import { listCatalog, productBySlug } from '../../src/storefront.ts';
import { addToCart, createCart, loadCart } from '../../src/cart.ts';
import { syncLegalTexts } from '../../src/legal-sync.ts';
import { createCheckoutOrder, orderById, startPayment } from '../../src/orders.ts';
import { fakeProvider } from '../../src/payments.ts';

let sql: Sql;
let drop: () => Promise<void>;
const actor: Actor = { source: 'api', id: 'kid_test', reference: 'req-names' };
const NAMES: Record<string, string> = {
  de: 'Glurak-ex',
  en: 'Charizard ex',
  fr: 'Dracaufeu-ex',
  it: 'Charizard-ex',
};
const asked: string[] = [];
const tcgdex: TcgdexClient = {
  sets: async () => [],
  set: async () => null,
  card: async (lang, id) => {
    asked.push(`${lang}:${id}`);
    if (id !== 'sv03.5-199' || !NAMES[lang]) return null; // e.g. no Dutch name at TCGdex
    return {
      id,
      localId: '199',
      name: NAMES[lang]!,
      category: 'Pokemon',
      rarity: 'Special illustration rare',
      types: ['Fire'],
      image: `https://assets.tcgdex.net/${lang}/sv/sv03.5/199`,
      set: { id: 'sv03.5' },
    };
  },
};

const card = (over: Record<string, unknown>) =>
  parse(IntakeRequest, {
    card_ref: 'sv03.5-199',
    condition: 'NM',
    finish: 'holo',
    delta: 1,
    storage_location: '014',
    price: { amount: 12900, currency: 'EUR' },
    ...over,
  });

before(async () => {
  ({ sql, drop } = await freshDatabase());
  await syncLegalTexts(sql);
  await sql`INSERT INTO card_sets (set_code, name_de, name_en, card_count, release_date)
            VALUES ('sv03.5', '151', '151', 165, '2023-09-22')`;
});
after(async () => drop());

test('a French card gets its printed name from TCGdex at intake', async () => {
  const r = await intake(sql, card({ card_language: 'FR' }), actor, { tcgdex });
  assert.equal(r.product.name_local, 'Dracaufeu-ex');
  assert.equal(r.product.name_original, 'Dracaufeu-ex');
  assert.equal(r.product.name_de, 'Glurak-ex');
  assert.ok(asked.includes('fr:sv03.5-199'));
  // asked once: the answer is kept in the master data
  const before = asked.length;
  await intake(sql, card({ card_language: 'FR', condition: 'EX' }), actor, { tcgdex });
  assert.equal(asked.filter((a) => a.startsWith('fr:')).length, 1);
  assert.ok(asked.length >= before);
});

test('a Japanese card keeps the name the app sends; DE/EN cards ignore it', async () => {
  const ja = await intake(sql, card({ card_language: 'JA', name_local: ' リザードンex ' }), actor, {
    tcgdex,
  });
  assert.equal(ja.product.sku, 'sv03.5-199-JA-NM-H');
  assert.equal(ja.product.name_local, 'リザードンex');
  assert.equal(ja.product.name_original, 'リザードンex');

  const de = await intake(sql, card({ card_language: 'DE', name_local: 'Dracaufeu-ex' }), actor, {
    tcgdex,
  });
  assert.equal(de.product.name_local, null, 'the database drops it for German cards');
  assert.equal(de.product.name_original, 'Glurak-ex');

  // a Korean card nobody named yet shows the English name until the admin adds it
  const ko = await intake(sql, card({ card_language: 'KO' }), actor, { tcgdex });
  assert.equal(ko.product.name_local, null);
  assert.equal(ko.product.name_original, 'Charizard ex');
  const patched = await patchProduct(
    sql,
    ko.product.sku,
    parse(ProductPatch, { name_local: '리자몽ex' }),
    actor,
  );
  assert.equal(patched.product.name_original, '리자몽ex');
});

test('the shop shows the printed name with English and German below', async () => {
  const de = await listCatalog(sql, { languages: ['JA', 'EN', 'DE'], sort: 'name' }, 'de');
  const byLang = Object.fromEntries(de.items.map((t) => [t.cardLanguage, t]));
  assert.equal(byLang.JA!.name, 'リザードンex');
  assert.equal(byLang.JA!.nameLang, 'ja');
  assert.deepEqual(
    byLang.JA!.nameTranslations.map((t) => t.text),
    ['Charizard ex', 'Glurak-ex'],
  );
  assert.equal(byLang.DE!.name, 'Glurak-ex');
  assert.deepEqual(
    byLang.DE!.nameTranslations.map((t) => t.text),
    ['Charizard ex'],
  );

  const en = await listCatalog(sql, { languages: ['JA', 'DE'] }, 'en');
  const ja = en.items.find((t) => t.cardLanguage === 'JA')!;
  assert.equal(ja.name, 'リザードンex', 'the English shop shows the Japanese name too');
  assert.deepEqual(
    ja.nameTranslations.map((t) => t.text),
    ['Charizard ex'],
  );

  // search finds the printed name
  const found = await listCatalog(sql, { q: 'リザードン' }, 'de');
  assert.deepEqual(
    found.items.map((t) => t.cardLanguage),
    ['JA'],
  );
  const fr = await listCatalog(sql, { q: 'dracaufeu' }, 'de');
  assert.ok(fr.items.length >= 1 && fr.items.every((t) => t.cardLanguage === 'FR'));

  const page = await productBySlug(sql, ja.slug, 'de');
  assert.equal(page!.name, 'リザードンex');
});

test('orders keep the printed name for the payment page, mails and invoices', async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products WHERE sku = 'sv03.5-199-JA-NM-H'`;
  const cart = await createCart(sql, 'de');
  await addToCart(sql, cart, p!.id, 1);
  assert.equal((await loadCart(sql, cart, 'de')).lines[0]!.name, 'リザードンex');
  const order = await createCheckoutOrder(sql, {
    cartId: cart,
    locale: 'de',
    details: {
      email: 'ash@example.com',
      shipping: {
        name: 'Ash',
        street: 'Hauptstraße 1',
        postcode: '1010',
        city: 'Wien',
        country: 'AT',
      },
      acceptTerms: true,
    },
    reservationMinutes: 10,
    ossEnabled: false,
  });
  // the admin renames the product later; the order keeps what was bought
  await sql`UPDATE products SET name_local = 'リザードンex（改）' WHERE id = ${p!.id}`;
  const o = await orderById(sql, order.id);
  assert.equal(o!.items[0]!.nameLocal, 'リザードンex');

  const pay = fakeProvider('http://localhost:3000');
  await startPayment(sql, pay, order, {
    email: 'ash@example.com',
    locale: 'de',
    successUrl: 'http://localhost:3000/bestellung/x',
    cancelUrl: 'http://localhost:3000/warenkorb',
  });
  const session = [...pay.sessions.values()].find((s) => s.orderId === order.id)!;
  assert.equal(session.input.lines[0]!.name, 'リザードンex 199/165');
  assert.match(session.input.lines[0]!.description ?? '', /^Charizard ex · Glurak-ex · 151/);

  // invoices: the PDF font cannot print Japanese, so English and German stand in
  const row = {
    card_language: 'JA',
    name_de: 'Glurak-ex',
    name_en: 'Charizard ex',
    name_local: 'リザードンex',
  };
  assert.equal(documentItemName(row, 'de'), 'Charizard ex (Glurak-ex)');
  assert.equal(documentItemName(row, 'en'), 'Charizard ex');
  assert.equal(
    documentItemName({ ...row, card_language: 'FR', name_local: 'Dracaufeu-ex' }, 'de'),
    'Dracaufeu-ex (Charizard ex, Glurak-ex)',
  );
  assert.equal(
    documentItemName({ ...row, card_language: 'RU', name_local: 'Чаризард-ex' }, 'de'),
    'Charizard ex (Glurak-ex)',
  );
});

test('older French products get their name in the background', async () => {
  // created while TCGdex was unreachable
  const r = await intake(sql, card({ card_language: 'IT', condition: 'GD' }), actor, {});
  assert.equal(r.product.name_local, null);
  const nl = await intake(sql, card({ card_language: 'NL', condition: 'GD' }), actor, {});
  assert.equal(nl.product.name_local, null);
  const missing = await missingLocalNames(sql);
  assert.deepEqual(missing.map((m) => m.lang).sort(), ['it', 'nl']);
  assert.equal(await syncLocalName(sql, tcgdex, 'sv03.5-199', 'it'), 'Charizard-ex');
  assert.equal(
    await syncLocalName(sql, tcgdex, 'sv03.5-199', 'nl'),
    null,
    'TCGdex has no Dutch name',
  );
  assert.equal((await getProduct(sql, r.product.sku))!.name_local, 'Charizard-ex');
  assert.equal((await getProduct(sql, nl.product.sku))!.name_local, null);
  assert.equal((await missingLocalNames(sql)).length, 0, 'Dutch was asked: no endless retries');
  assert.equal(await fillLocalNames(sql), 0);
});

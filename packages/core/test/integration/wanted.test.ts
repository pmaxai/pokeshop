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
import { grantComplimentary } from '../../src/subscriptions.ts';
import { addToCart, createCart, loadCart } from '../../src/cart.ts';
import { syncLegalTexts } from '../../src/legal-sync.ts';
import { CheckoutRejected, createCheckoutOrder } from '../../src/orders.ts';
import { renderAccountMail } from '../../src/mail-account.ts';
import type { OutboxMail } from '../../src/outbox.ts';
import {
  addWanted,
  createOffer,
  declineOffer,
  listWanted,
  offerToCart,
  removeWanted,
  sendWantedAlerts,
  syncWantedPurchases,
  wantedDemand,
  wantedJson,
} from '../../src/wanted.ts';

let sql: Sql;
let drop: () => Promise<void>;
let dir: string;
let ash: Account;
let misty: Account;
const BASE = 'http://localhost:3000';

async function login(email: string): Promise<Account> {
  await requestLoginLink(sql, { email, locale: 'de', baseUrl: BASE });
  const [m] = await sql<{ payload: { url: string } }[]>`
    SELECT payload FROM outbox WHERE to_address = ${email} ORDER BY id DESC LIMIT 1`;
  const r = await redeemLoginLink(sql, new URL(m!.payload.url).searchParams.get('t')!);
  assert.ok(r.ok);
  return r.account;
}

async function product(p: {
  sku: string;
  language?: string;
  condition?: string;
  price: number | null;
  status?: string;
  stock?: number;
}): Promise<number> {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO products (sku, slug, card_ref, set_code, set_name_de, set_name_en, card_number, name_de, name_en,
                          card_language, finish, condition, price_cents, status)
    VALUES (${p.sku}, ${p.sku.toLowerCase()}, 'base1-4', 'base1', 'Grundset', 'Base Set', '4/102', 'Glurak',
            'Charizard', ${p.language ?? 'DE'}, 'holo', ${p.condition ?? 'NM'}, ${p.price}, ${p.status ?? 'active'})
    RETURNING id`;
  if ((p.stock ?? 1) > 0) {
    await sql`SELECT stock_change(${r!.id}, '001', ${p.stock ?? 1}, 'import', 'test', NULL, 'intake')`;
  }
  return Number(r!.id);
}

const outbox = (template: string) => sql<OutboxMail[]>`
  SELECT id, template, to_address, reply_to, locale, payload, attachments, attempts
    FROM outbox WHERE template = ${template} ORDER BY id`;

const ctx = () => ({
  baseUrl: 'https://overpricedcardboard.com',
  mediaDir: dir,
  replyTo: 'order@overpricedcardboard.com',
  company: { name: 'Overpriced Cardboard', public_name: 'Overpriced Cardboard' },
});

before(async () => {
  ({ sql, drop } = await freshDatabase());
  await syncLegalTexts(sql);
  dir = mkdtempSync(join(tmpdir(), 'wanted-test-'));
  makeCatalog(join(dir, 'catalog.sqlite'), 400);
  await importPack(sql, {
    manifest: { version: 'v1', files: { 'catalog.sqlite': { bytes: 1, sha256: 'a'.repeat(64) } } },
    catalogPath: join(dir, 'catalog.sqlite'),
  });
  await sql`INSERT INTO card_sets (set_code, name_de, name_en, card_count) VALUES ('base1', 'Grundset', 'Base Set', 102)`;
  await sql`INSERT INTO card_master (card_ref, set_code, local_id, name_de, name_en) VALUES ('base1-4', 'base1', '4', 'Glurak', 'Charizard')`;
  ash = await login('ash@example.com');
  misty = await login('misty@example.com');
});
after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await drop();
});

test('the list: validation, the same wish once, client_ref, removing', async () => {
  assert.deepEqual(
    await addWanted(sql, ash.id, { card_id: 'base1-4', language: 'XX', max_price_cents: 0 }),
    { ok: false, errors: { language: 'invalid', max_price_cents: 'invalid' } },
  );
  assert.deepEqual(await addWanted(sql, ash.id, { card_id: 'nope-1' }), {
    ok: false,
    errors: { card_id: 'unknown' },
  });
  const one = await addWanted(
    sql,
    ash.id,
    { card_id: 'base1-4', language: 'de', min_condition: 'ex', max_price_cents: 35000 },
    { clientRef: 'want-0001', locale: 'de' },
  );
  assert.ok(one.ok && one.created);
  assert.equal(one.wanted.card?.name, 'Glurak');
  assert.equal(one.wanted.state, 'searching');
  // value of an EX copy (holo € 400 × 0.85)
  assert.equal(one.wanted.valueCents, 34000);
  const same = await addWanted(sql, ash.id, {
    card_id: 'base1-4',
    language: 'DE',
    min_condition: 'EX',
    max_price_cents: 35000,
  });
  assert.ok(same.ok && !same.created && same.wanted.id === one.wanted.id);
  const ref = await addWanted(sql, ash.id, { card_id: 'base1-58' }, { clientRef: 'want-0001' });
  assert.ok(ref.ok && !ref.created && ref.wanted.id === one.wanted.id, 'client_ref wins');
  const pika = await addWanted(sql, ash.id, { card_id: 'base1-58' });
  assert.ok(pika.ok && pika.created);
  assert.equal((await listWanted(sql, ash.id, 'de')).length, 2);
  assert.ok(await removeWanted(sql, ash.id, pika.wanted.id));
  assert.equal(await removeWanted(sql, misty.id, one.wanted.id), false, 'not her card');
  const json = wantedJson((await listWanted(sql, ash.id, 'en'))[0]!);
  assert.equal(json.card_id, 'base1-4');
  assert.equal(json.language, 'DE');
  assert.equal(json.state, 'searching');
  assert.equal(json.image_url, 'https://assets.tcgdex.net/en/base/base1/4');
});

test('"now in the shop": once per card and product, matching wishes, subscribers only', async () => {
  // too expensive, too worn, wrong language: no match
  await product({ sku: 'W-EXP', price: 40000 });
  await product({ sku: 'W-LP', condition: 'LP', price: 10000 });
  await product({ sku: 'W-EN', language: 'EN', price: 10000 });
  const good = await product({ sku: 'W-GOOD', condition: 'EX', price: 30000 });
  // no subscription yet: nothing is sent, nothing is remembered
  assert.equal(await sendWantedAlerts(sql), 0);
  await grantComplimentary(
    sql,
    ash.id,
    { plan: 'collector', extraDevices: 0, until: '', note: 'test' },
    'test',
  );
  assert.equal(await sendWantedAlerts(sql), 1);
  assert.equal(await sendWantedAlerts(sql), 0, 'only once');
  const [mail] = await outbox('wanted_available');
  assert.deepEqual(mail!.payload, {
    items: [{ wanted_id: (await listWanted(sql, ash.id, 'de'))[0]!.id, product_id: good }],
  });
  const r = await renderAccountMail(sql, mail!, ctx());
  assert.equal(r.subject, 'Eine gesuchte Karte ist jetzt im Shop');
  assert.match(r.html, /Glurak/);
  assert.match(r.html, /https:\/\/overpricedcardboard\.com\/de\/karten\/w-good/);
  assert.match(r.html, /https:\/\/overpricedcardboard\.com\/de\/konto\/fehlend/);
  const [w] = await listWanted(sql, ash.id, 'de');
  assert.equal(w!.state, 'available');
  assert.deepEqual(
    w!.inShop.map((m) => m.productId),
    [good],
  );
  // a card put on the list while it is already in the shop: shown at once, no e-mail
  const now = await addWanted(sql, ash.id, { card_id: 'base1-4', language: 'EN' });
  assert.ok(now.ok && now.wanted.state === 'available');
  assert.equal(await sendWantedAlerts(sql), 0);
});

test('offers: draft card for one customer, offer price in cart and order, bought → off the list', async () => {
  const [w] = (await listWanted(sql, ash.id, 'de')).filter((x) => x.language === 'DE');
  const draft = await product({ sku: 'W-DRAFT', condition: 'NM', price: 45000, status: 'draft' });
  assert.deepEqual(
    await createOffer(
      sql,
      { wantedId: w!.id, productId: draft, priceCents: 33000, days: 0 },
      { by: 'admin@example.com' },
    ),
    { ok: false, errors: { days: 'invalid' } },
  );
  const made = await createOffer(
    sql,
    {
      wantedId: w!.id,
      productId: draft,
      priceCents: 33000,
      days: 7,
      message: 'Für dich zurückgelegt',
    },
    { by: 'admin@example.com' },
  );
  assert.ok(made.ok);
  const [offerMail] = await outbox('wanted_offer');
  const rendered = await renderAccountMail(sql, offerMail!, ctx());
  assert.equal(rendered.subject, 'Ein Angebot für deine gesuchte Karte');
  assert.match(rendered.html, /Dein Preis: <strong>€\s330,00<\/strong>/);
  assert.match(rendered.html, /Für dich zurückgelegt/);
  assert.match(rendered.html, /halten wir die Karte für dich zurück/);
  assert.equal((await listWanted(sql, ash.id, 'de')).find((x) => x.id === w!.id)!.state, 'offer');

  // only Ash can take it
  const cart = await createCart(sql, 'de');
  assert.equal(await offerToCart(sql, misty.id, made.offerId, cart), 'unknown');
  assert.equal(await offerToCart(sql, ash.id, made.offerId, cart), 'ok');
  // the line stays one copy
  assert.equal((await addToCart(sql, cart, draft, 3)).quantity, 1);
  const mine = await loadCart(sql, cart, 'de', { accountId: ash.id });
  assert.equal(mine.lines[0]!.priceCents, 33000);
  assert.equal(mine.lines[0]!.offer?.id, made.offerId);
  assert.ok(mine.check.ok);
  const stranger = await loadCart(sql, cart, 'de', { accountId: misty.id });
  assert.equal(stranger.lines[0]!.offer, null);
  assert.equal(stranger.check.ok, false, 'a draft card without the offer cannot be bought');

  const details = {
    email: ash.email,
    shipping: {
      name: 'Ash',
      street: 'Hauptstraße 1',
      postcode: '1010',
      city: 'Wien',
      country: 'AT',
    },
    acceptTerms: true as const,
  };
  await assert.rejects(
    createCheckoutOrder(sql, {
      cartId: cart,
      locale: 'de',
      details,
      reservationMinutes: 10,
      ossEnabled: false,
      smallBusiness: true,
      accountId: misty.id,
    }),
    CheckoutRejected,
  );
  const order = await createCheckoutOrder(sql, {
    cartId: cart,
    locale: 'de',
    details,
    reservationMinutes: 10,
    ossEnabled: false,
    smallBusiness: true,
    accountId: ash.id,
  });
  const [line] = await sql<{ unit_price_cents: number; quantity: number; offer_id: number }[]>`
    SELECT unit_price_cents, quantity, offer_id FROM order_items WHERE order_id = ${order.id}`;
  assert.deepEqual(
    { ...line, offer_id: Number(line!.offer_id) },
    {
      unit_price_cents: 33000,
      quantity: 1,
      offer_id: made.offerId,
    },
  );
  const [held] = await sql<{ reserved: number }[]>`
    SELECT reserved FROM product_stock WHERE product_id = ${draft}`;
  assert.equal(held!.reserved, 1, 'the draft card is held for the payment');

  // paid: offer accepted, card found
  await sql`UPDATE orders SET status = 'paid', kind = 'cards' WHERE id = ${order.id}`;
  assert.deepEqual(await syncWantedPurchases(sql), { offers: 1, found: 1 });
  assert.deepEqual(await syncWantedPurchases(sql), { offers: 0, found: 0 });
  const left = await listWanted(sql, ash.id, 'de');
  assert.equal(
    left.some((x) => x.id === w!.id),
    false,
  );
  const [o] = await sql<{ status: string; order_id: number }[]>`
    SELECT status, order_id FROM wanted_offers WHERE id = ${made.offerId}`;
  assert.equal(o!.status, 'accepted');
  assert.equal(Number(o!.order_id), order.id);
});

test('declining, and the admin view of the demand', async () => {
  const w = await addWanted(sql, misty.id, { card_id: 'base1-4' });
  assert.ok(w.ok);
  const p = await product({ sku: 'W-MISTY', condition: 'GD', price: 20000, status: 'draft' });
  const made = await createOffer(
    sql,
    { wantedId: w.wanted.id, productId: p, priceCents: 15000, days: 3 },
    { by: 'admin@example.com' },
  );
  assert.ok(made.ok);
  assert.equal(await declineOffer(sql, ash.id, made.offerId), false, 'not his offer');
  assert.ok(await declineOffer(sql, misty.id, made.offerId));
  const cart = await createCart(sql, 'de');
  assert.equal(await offerToCart(sql, misty.id, made.offerId, cart), 'unknown');
  const [d] = await wantedDemand(sql);
  assert.equal(d!.cardId, 'base1-4');
  assert.equal(d!.customers, 2);
  assert.deepEqual(d!.languages.sort(), ['*', 'EN']);
  assert.equal(d!.maxPriceCents, null);
});

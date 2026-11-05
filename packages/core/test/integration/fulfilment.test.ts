import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import { addToCart, createCart } from '../../src/cart.ts';
import { syncLegalTexts } from '../../src/legal-sync.ts';
import { createCheckoutOrder, handlePaymentEvent, startPayment } from '../../src/orders.ts';
import { fakeProvider } from '../../src/payments.ts';
import {
  FulfilmentError,
  issueInvoice,
  listOrders,
  markShipped,
  orderAdmin,
  pickList,
  refundOrder,
  startPacking,
} from '../../src/fulfilment.ts';
import { documentPdf, sendDueMails, type Mail, type MailTransport } from '../../src/mail.ts';
import {
  EventInput,
  eventBySlug,
  pastEvents,
  saveEvent,
  upcomingEvents,
} from '../../src/events.ts';
import {
  generalSettings,
  saveGeneralSettings,
  SettingsError,
  updateCountries,
  countrySettings,
} from '../../src/shop-settings.ts';

let sql: Sql;
let drop: () => Promise<void>;
let mediaDir: string;
const pay = fakeProvider('http://localhost:3000');
const company = {
  name: 'Antalyse GmbH',
  street: 'Wienerstraße 1',
  postcode: '2440',
  city: 'Moosbrunn',
  country: 'AT',
  email: 'bestellung@pokemonkarten.at',
  vat_id: 'ATU79907228',
  register_number: 'FN 614039z',
  register_court: 'Landesgericht Korneuburg',
};
const ctx = () => ({
  baseUrl: 'https://pokemonkarten.at',
  mediaDir,
  company,
  replyTo: 'bestellung@pokemonkarten.at',
});

class Memory implements MailTransport {
  readonly name = 'memory';
  sent: Mail[] = [];
  async send(m: Mail) {
    this.sent.push(m);
  }
}

async function product(sku: string, price: number, boxes: Record<string, number>): Promise<number> {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (sku, slug, set_code, set_name_de, set_name_en, card_number, name_de, name_en,
                          card_language, finish, condition, price_cents, status)
    VALUES (${sku}, ${sku.toLowerCase()}, 'sv03.5', '151', '151', '006/165', ${'Karte ' + sku},
            ${'Card ' + sku}, 'DE', 'holo', 'NM', ${price}, 'active') RETURNING id`;
  for (const [box, n] of Object.entries(boxes)) {
    await sql`SELECT stock_change(${p!.id}, ${box}, ${n}, 'import', 'test', NULL, 'intake')`;
  }
  return p!.id;
}

async function paidOrder(lines: [number, number][], email = 'ash@example.com') {
  const cart = await createCart(sql, 'de');
  for (const [id, q] of lines) await addToCart(sql, cart, id, q);
  const order = await createCheckoutOrder(sql, {
    cartId: cart,
    locale: 'de',
    reservationMinutes: 10,
    ossEnabled: false,
    details: {
      email,
      shipping: { name: 'Ash', street: 'Weg 1', postcode: '1010', city: 'Wien', country: 'AT' },
      acceptTerms: true,
    },
  });
  await startPayment(sql, pay, order, { email, locale: 'de', successUrl: 'x', cancelUrl: 'y' });
  const [o] = await sql<
    { stripe_session_id: string }[]
  >`SELECT stripe_session_id FROM orders WHERE id = ${order.id}`;
  assert.equal(await handlePaymentEvent(sql, pay, pay.pay(o!.stripe_session_id)), 'paid');
  return order.id;
}

const boxes = async (id: number) =>
  Object.fromEntries(
    (
      await sql<{ storage_location: string; quantity: number }[]>`
      SELECT storage_location, quantity FROM stock_locations WHERE product_id = ${id} ORDER BY storage_location`
    ).map((r) => [r.storage_location, r.quantity]),
  );

before(async () => {
  ({ sql, drop } = await freshDatabase());
  await syncLegalTexts(sql);
  mediaDir = await mkdtemp(join(tmpdir(), 'pokeshop-ful-'));
});
after(async () => drop());

test('pick list: every copy with its box, sorted by box number', async () => {
  const a = await product('PICK-A', 1500, { '010': 1, '002': 1 });
  const b = await product('PICK-B', 300, { '001': 3 });
  const id = await paidOrder([
    [a, 2],
    [b, 2],
  ]);
  const { lines, slips } = await pickList(sql, [id]);
  assert.deepEqual(
    lines.map((l) => `${l.box}:${l.sku}:${l.quantity}`),
    ['001:PICK-B:2', '002:PICK-A:1', '010:PICK-A:1'],
  );
  assert.equal(slips.length, 1);
  assert.equal(slips[0]!.lines.length, 3);
  assert.deepEqual(await startPacking(sql, [id], 'staff@x'), [id]);
  assert.deepEqual(
    await startPacking(sql, [id], 'staff@x'),
    [],
    'only paid orders move to packing',
  );
  assert.equal(
    (await listOrders(sql, { view: 'packing' })).rows.some((r) => r.id === id),
    true,
  );
});

test('shipping: insured needs a tracking number, then invoice and mail', async () => {
  const p = await product('SHIP-1', 4900, { '005': 1 });
  const id = await paidOrder([[p, 1]]);
  await assert.rejects(
    markShipped(sql, id, { actor: 'staff@x' }),
    (e: FulfilmentError) => e.code === 'tracking_required',
  );
  const r = await markShipped(sql, id, {
    trackingNumber: 'rr 1234 5678 9at',
    actor: 'staff@x',
    at: new Date('2026-11-06T09:00:00Z'),
  });
  assert.match(r.invoice!, /^RE-2026-\d{6}$/);
  const a = await orderAdmin(sql, id);
  assert.equal(a!.order.status, 'shipped');
  assert.equal(a!.order.tracking_number, 'RR12345678 9AT'.replace(' ', ''));
  const [inv] = await sql<{ gross_cents: number; vat_cents: number; lines: unknown[] }[]>`
    SELECT gross_cents, vat_cents, lines FROM documents WHERE order_id = ${id} AND kind = 'invoice'`;
  assert.equal(inv!.gross_cents, 4900 + 500, 'card + € 5 minimum insurance');
  assert.equal(inv!.vat_cents, 900);
  assert.equal(inv!.lines.length, 2);
  await assert.rejects(
    markShipped(sql, id, { trackingNumber: 'RR1', actor: 'x' }),
    FulfilmentError,
  );

  const t = new Memory();
  await sendDueMails(sql, t, ctx(), 50);
  const shipped = t.sent.find((m) => m.subject.startsWith('Deine Karten sind unterwegs'))!;
  assert.ok(shipped, 'shipping mail sent');
  assert.match(shipped.html, /sendungsdetails\?snr=RR123456789AT/);
  assert.equal(shipped.attachments[0]!.name, `Rechnung-${r.invoice}.pdf`);
});

test('refund after shipping: card back into its box, credit note, mail; then the rest', async () => {
  const a = await product('REF-A', 2500, { '007': 1 });
  const b = await product('REF-B', 800, { '003': 2 });
  const id = await paidOrder([
    [a, 1],
    [b, 2],
  ]);
  await markShipped(sql, id, { trackingNumber: 'RR000111222AT', actor: 'x' });
  const items = (await orderAdmin(sql, id))!.items;
  const itemB = items.find((i) => i.sku === 'REF-B')!;
  const before = pay.refunds.length;

  const r1 = await refundOrder(sql, pay, {
    orderId: id,
    items: [{ orderItemId: itemB.id, quantity: 1, restock: true }],
    shipping: false,
    reason: 'Widerruf',
    actor: 'owner@x',
  });
  assert.equal(r1.amount, 800);
  assert.equal(pay.refunds.length, before + 1);
  assert.equal(pay.refunds.at(-1)!.idempotencyKey, `refund-${r1.refundId}`);
  assert.match(r1.creditNote!, /^GS-2026-\d{6}$/);
  assert.deepEqual(await boxes(b), { '003': 1 }, 'one copy back in box 003');
  let o = (await orderAdmin(sql, id))!.order;
  assert.equal(o.refunded_cents, 800);
  assert.equal(o.status, 'shipped');

  await assert.rejects(
    refundOrder(sql, pay, {
      orderId: id,
      items: [{ orderItemId: itemB.id, quantity: 2, restock: false }],
      shipping: false,
      reason: '',
      actor: 'x',
    }),
    (e: FulfilmentError) => e.code === 'bad_quantity',
  );
  const itemA = items.find((i) => i.sku === 'REF-A')!;
  const r2 = await refundOrder(sql, pay, {
    orderId: id,
    items: [
      { orderItemId: itemA.id, quantity: 1, restock: false },
      { orderItemId: itemB.id, quantity: 1, restock: false },
    ],
    shipping: true,
    reason: '',
    actor: 'x',
  });
  o = (await orderAdmin(sql, id))!.order;
  assert.equal(r2.amount, 2500 + 800 + 500);
  assert.equal(o.refunded_cents, o.total_cents);
  assert.equal(o.status, 'refunded');
  assert.deepEqual(await boxes(a), { '007': 0 }, 'not restocked when not asked');

  const [credit] = await sql<{ id: number; refers_to: string; gross_cents: number }[]>`
    SELECT id, refers_to, gross_cents FROM documents WHERE refund_id = ${r1.refundId}`;
  assert.match(credit!.refers_to, /^RE-/);
  const pdf = await documentPdf(sql, credit!.id, ctx());
  assert.match(pdf.name, /^Rechnungskorrektur-GS-/);
  assert.equal(pdf.content.subarray(0, 5).toString(), '%PDF-');

  const t = new Memory();
  await sendDueMails(sql, t, ctx(), 50);
  const refundMails = t.sent.filter((m) => m.subject.startsWith('Erstattung zu deiner Bestellung'));
  assert.equal(refundMails.length, 2);
  assert.match(refundMails[0]!.html, /1 × Karte REF-B/);
  assert.equal(refundMails[0]!.attachments.length, 1, 'credit note attached');

  // Stripe then reports the same total – nothing new to record.
  const [pi] = await sql<
    { pi: string }[]
  >`SELECT stripe_payment_intent_id AS pi FROM orders WHERE id = ${id}`;
  assert.equal(
    await handlePaymentEvent(sql, pay, {
      id: 'evt_r',
      type: 'charge.refunded',
      paymentIntentId: pi!.pi,
      amountRefunded: o.total_cents,
    }),
    'known',
  );
});

test('cancelling before shipping: full refund, cards back, no invoice, shipping refused', async () => {
  const p = await product('CANCEL-1', 3000, { '004': 1 });
  const id = await paidOrder([[p, 1]]);
  const item = (await orderAdmin(sql, id))!.items[0]!;
  const r = await refundOrder(sql, pay, {
    orderId: id,
    items: [{ orderItemId: item.id, quantity: 1, restock: true }],
    shipping: true,
    reason: 'Storno',
    actor: 'x',
  });
  assert.equal(r.creditNote, null, 'no invoice yet, so no credit note');
  assert.equal((await orderAdmin(sql, id))!.order.status, 'refunded');
  assert.deepEqual(await boxes(p), { '004': 1 });
  await assert.rejects(
    markShipped(sql, id, { trackingNumber: 'RR999888777AT', actor: 'x' }),
    (e: FulfilmentError) => e.code === 'wrong_status',
  );
});

test('partly refunded before shipping: the invoice bills only what ships', async () => {
  const a = await product('PART-A', 1200, { '008': 1 });
  const b = await product('PART-B', 600, { '009': 1 });
  const id = await paidOrder([
    [a, 1],
    [b, 1],
  ]);
  const itemB = (await orderAdmin(sql, id))!.items.find((i) => i.sku === 'PART-B')!;
  await refundOrder(sql, pay, {
    orderId: id,
    items: [{ orderItemId: itemB.id, quantity: 1, restock: true }],
    shipping: false,
    reason: 'beschädigt',
    actor: 'x',
  });
  const inv = await sql.begin((tx) => issueInvoice(tx, id, new Date()));
  const [d] = await sql<
    { gross_cents: number; lines: { de: string }[] }[]
  >`SELECT gross_cents, lines FROM documents WHERE id = ${inv!.id}`;
  assert.equal(d!.gross_cents, 1200);
  assert.deepEqual(
    d!.lines.map((l) => l.de.split(' ')[1]),
    ['PART-A'],
  );
});

test('a refund made in the Stripe Dashboard is recorded and reported', async () => {
  const p = await product('EXT-1', 2000, { '011': 1 });
  const id = await paidOrder([[p, 1]]);
  const [pi] = await sql<
    { pi: string }[]
  >`SELECT stripe_payment_intent_id AS pi FROM orders WHERE id = ${id}`;
  assert.equal(
    await handlePaymentEvent(sql, pay, {
      id: 'evt_ext',
      type: 'charge.refunded',
      paymentIntentId: pi!.pi,
      amountRefunded: 500,
    }),
    'recorded',
  );
  const o = (await orderAdmin(sql, id))!;
  assert.equal(o.order.refunded_cents, 500);
  assert.equal(o.refunds[0]!.created_by, 'stripe');
  const [alert] =
    await sql`SELECT 1 FROM outbox WHERE template = 'admin_alert' AND payload->>'subject' LIKE 'Erstattung in Stripe%'`;
  assert.ok(alert);
});

test('events: create with address-friendly slug, upcoming vs past, validation', async () => {
  const input = (over: Record<string, unknown>) =>
    EventInput.parse({
      title_de: 'Pokémon-Börse Wien',
      title_en: '',
      starts_at: '2099-12-12T10:00',
      ends_at: '2099-12-12T17:00',
      venue: 'Messe',
      street: '',
      postcode: '',
      city: 'Wien',
      country: 'at',
      description_de: 'Tauschen und kaufen',
      description_en: '',
      entry_fee: '5 €',
      table_info: '',
      website_url: '',
      status: 'published',
      ...over,
    });
  const id = await saveEvent(sql, null, input({}));
  const id2 = await saveEvent(sql, null, input({}));
  await saveEvent(
    sql,
    null,
    input({ title_de: 'Alte Börse', starts_at: '2020-01-01T10:00', ends_at: '' }),
  );
  await saveEvent(sql, null, input({ title_de: 'Entwurf', status: 'draft' }));
  const up = await upcomingEvents(sql);
  assert.deepEqual(
    up.map((e) => e.slug),
    ['pokemon-boerse-wien-wien-2099-12-12', 'pokemon-boerse-wien-wien-2099-12-12-2'],
  );
  assert.equal(
    up[0]!.starts_at.toISOString(),
    '2099-12-12T09:00:00.000Z',
    'Vienna time stored as UTC',
  );
  assert.deepEqual(
    (await pastEvents(sql)).map((e) => e.title_de),
    ['Alte Börse'],
  );
  assert.equal(await eventBySlug(sql, 'entwurf-wien-2099-12-12'), null, 'drafts are not public');
  await saveEvent(sql, id, input({ title_de: 'Pokémon-Börse Wien (neu)' }));
  assert.equal(
    (await eventBySlug(sql, 'pokemon-boerse-wien-wien-2099-12-12'))!.title_de,
    'Pokémon-Börse Wien (neu)',
    'slug stays',
  );
  assert.ok(id2 > id);
  assert.equal(
    EventInput.safeParse({
      ...input({}),
      starts_at: '2099-12-12T10:00',
      ends_at: '2099-12-11T10:00',
    }).success,
    false,
  );
  assert.equal(
    EventInput.safeParse({ ...input({}), website_url: 'javascript:alert(1)' }).success,
    false,
  );
});

test('settings: countries, threshold re-evaluates cards, tracking link checked', async () => {
  const rows = await countrySettings(sql);
  await assert.rejects(
    updateCountries(
      sql,
      rows.map((r) => ({
        code: r.code,
        deliveryEnabled: false,
        minOrderCents: 0,
        insuredRateBp: 1000,
        insuredMinimumCents: 500,
        insuredMaxOrderCents: 50000,
        deliveryTimeDe: null,
        deliveryTimeEn: null,
      })),
    ),
    SettingsError,
  );
  await updateCountries(sql, [
    {
      code: 'CH',
      deliveryEnabled: true,
      minOrderCents: 5000,
      insuredRateBp: 1000,
      insuredMinimumCents: 500,
      insuredMaxOrderCents: 50000,
      deliveryTimeDe: '5–8 Werktage',
      deliveryTimeEn: null,
    },
  ]);
  assert.equal((await countrySettings(sql)).find((c) => c.code === 'CH')!.delivery_enabled, true);

  const g = await generalSettings(sql);
  assert.equal(g.high_value_threshold_cents, 2000);
  assert.match(g.tracking_url, /\{number\}/);
  await assert.rejects(
    saveGeneralSettings(sql, { ...g, tracking_url: 'https://example.com/track' }),
    SettingsError,
  );
  const p = await product('THR-1', 1500, { '012': 1 });
  await saveGeneralSettings(sql, { ...g, high_value_threshold_cents: 1000 });
  const [hv] = await sql<
    { high_value: boolean }[]
  >`SELECT high_value FROM products WHERE id = ${p}`;
  assert.equal(hv!.high_value, true, '€ 15 is high value once the limit is € 10');
  await saveGeneralSettings(sql, g);
});

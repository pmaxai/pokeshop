import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import { addToCart, createCart, loadCart, setCartCountry } from '../../src/cart.ts';
import { syncLegalTexts } from '../../src/legal-sync.ts';
import {
  createCheckoutOrder,
  expireHolds,
  handlePaymentEvent,
  issueInvoice,
  orderById,
  releaseOrder,
  startPayment,
  validateCheckout,
  CheckoutRejected,
  type CheckoutDetails,
} from '../../src/orders.ts';
import { fakeProvider } from '../../src/payments.ts';
import {
  graphMessage,
  invoicePdf,
  sendDueMails,
  type Mail,
  type MailTransport,
} from '../../src/mail.ts';
import { recordWithdrawal } from '../../src/withdrawals.ts';

let sql: Sql;
let drop: () => Promise<void>;
const pay = fakeProvider('http://localhost:3000');

async function product(sku: string, priceCents: number, copies: number): Promise<number> {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (sku, slug, set_code, set_name_de, set_name_en, card_number, name_de, name_en,
                          card_language, finish, condition, price_cents, status)
    VALUES (${sku}, ${sku.toLowerCase()}, 'sv03.5', '151', '151', '006/165', ${'Glurak ' + sku},
            ${'Charizard ' + sku}, 'DE', 'holo', 'NM', ${priceCents}, 'active')
    RETURNING id`;
  await sql`SELECT stock_change(${p!.id}, '001', ${copies}, 'import', 'test', NULL, 'intake')`;
  return p!.id;
}

const stock = async (id: number) =>
  (
    await sql<{ quantity: number; reserved: number; available: number }[]>`
    SELECT quantity, reserved, available FROM product_stock WHERE product_id = ${id}`
  )[0]!;

const details = (over: Partial<CheckoutDetails> = {}): CheckoutDetails => ({
  email: 'ash@example.com',
  shipping: {
    name: 'Ash Ketchum',
    street: 'Hauptstraße 1',
    postcode: '1010',
    city: 'Wien',
    country: 'AT',
  },
  acceptTerms: true,
  ...over,
});

async function checkout(cartId: string, d = details()) {
  const order = await createCheckoutOrder(sql, {
    cartId,
    locale: 'de',
    details: d,
    reservationMinutes: 10,
    ossEnabled: false,
  });
  const url = await startPayment(sql, pay, order, {
    email: d.email,
    locale: 'de',
    successUrl: 'http://localhost:3000/bestellung/x',
    cancelUrl: 'http://localhost:3000/warenkorb',
  });
  const [o] = await sql<{ stripe_session_id: string }[]>`
    SELECT stripe_session_id FROM orders WHERE id = ${order.id}`;
  return { order, url, session: o!.stripe_session_id };
}

class MemoryTransport implements MailTransport {
  readonly name = 'memory';
  sent: Mail[] = [];
  async send(m: Mail) {
    this.sent.push(m);
  }
}
let mediaDir: string;
const mailCtx = () => ({
  baseUrl: 'https://pokemonkarten.at',
  mediaDir,
  replyTo: 'bestellung@pokemonkarten.at',
  company: {
    name: 'Antalyse GmbH',
    street: 'Wienerstraße 1',
    postcode: '2440',
    city: 'Moosbrunn',
    country: 'AT',
    email: 'bestellung@pokemonkarten.at',
    vat_id: 'ATU79907228',
    register_number: 'FN 614039z',
    register_court: 'Landesgericht Korneuburg',
  },
});

before(async () => {
  ({ sql, drop } = await freshDatabase());
  await syncLegalTexts(sql);
  mediaDir = await mkdtemp(join(tmpdir(), 'pokeshop-media-'));
});
after(async () => drop());

test('legal texts load once per change', async () => {
  assert.equal(await syncLegalTexts(sql), 0, 'unchanged files add no version');
  const rows = await sql`SELECT kind, locale, version FROM legal_texts ORDER BY kind, locale`;
  assert.equal(rows.length, 6);
});

test('checkout form: postcode by country, e-mail, terms', () => {
  const bad = validateCheckout({
    email: 'nope',
    shipping: { name: '', street: 'x', postcode: '123', city: 'Wien', country: 'AT' },
    acceptTerms: false,
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.errors.email, 'invalid_email');
    assert.equal(bad.errors['shipping.name'], 'required');
    assert.equal(bad.errors['shipping.postcode'], 'invalid_postcode');
    assert.equal(bad.errors.acceptTerms, 'terms');
  }
  const de = validateCheckout({
    ...details(),
    shipping: { ...details().shipping, postcode: '10115', country: 'DE' },
  });
  assert.equal(de.ok, true);
});

test('cart: no reservation, capped at free copies, minimum order per country', async () => {
  const id = await product('CART-1', 900, 2);
  const cart = await createCart(sql, 'de');
  const r = await addToCart(sql, cart, id, 5);
  assert.deepEqual(r, { quantity: 2, limited: true, unavailable: false });
  assert.equal((await stock(id)).reserved, 0, 'the cart reserves nothing');
  let view = await loadCart(sql, cart, 'de');
  assert.equal(view.check.ok, true, 'AT minimum € 10 reached with € 18');
  assert.equal(await setCartCountry(sql, cart, 'DE'), true);
  view = await loadCart(sql, cart, 'de');
  assert.equal(view.check.ok, false);
  assert.deepEqual(view.check.problems, [{ code: 'below_minimum', minimum: 2000, missing: 200 }]);
  assert.equal(await setCartCountry(sql, cart, 'FR'), false, 'France is not a delivery country');
});

test('paying: cards held for 10 minutes, committed on payment, mails queued, replay harmless', async () => {
  const id = await product('PAY-1', 12900, 1);
  const cart = await createCart(sql, 'de');
  await addToCart(sql, cart, id, 1);
  const { order, url, session } = await checkout(cart);
  assert.match(url, /\/dev\/zahlung\/cs_fake_/);
  assert.equal(order.totalCents, 12900 + 1290, 'card over € 20: 10 % insured shipping');
  assert.equal((await stock(id)).reserved, 1);
  const until = order.reservedUntil.getTime() - Date.now();
  assert.ok(until > 9 * 60_000 && until <= 10 * 60_000, 'hold of 10 minutes');

  // Somebody else cannot put the held copy into their cart.
  const other = await createCart(sql, 'de');
  assert.equal((await addToCart(sql, other, id, 1)).unavailable, true);

  const event = pay.pay(session, 'eps');
  assert.equal(await handlePaymentEvent(sql, pay, event), 'paid');
  assert.deepEqual(await stock(id), { quantity: 0, reserved: 0, available: 0 });
  const o = await orderById(sql, order.id);
  assert.equal(o!.status, 'paid');
  assert.equal(o!.shippingMethod, 'insured');
  assert.equal(o!.vatCents, 2365, '20 % VAT contained in € 141,90');
  assert.equal((await loadCart(sql, cart, 'de')).lines.length, 0, 'cart emptied');

  assert.equal(await handlePaymentEvent(sql, pay, event), 'already', 'webhook replay');
  const mails = await sql<{ template: string; to_address: string }[]>`
    SELECT template, to_address FROM outbox ORDER BY id`;
  assert.deepEqual(
    mails.map((m) => m.template),
    ['order_confirmation', 'order_notification'],
  );
  const [ledger] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_ledger WHERE product_id = ${id} AND reason = 'sold'`;
  assert.equal(ledger!.n, 1);
});

test('the hold runs out: session closed, cards back on sale', async () => {
  const id = await product('HOLD-1', 1500, 1);
  const cart = await createCart(sql, 'de');
  await addToCart(sql, cart, id, 1);
  const { order, session } = await checkout(cart);
  await sql`UPDATE orders SET reserved_until = now() - interval '5 minutes' WHERE id = ${order.id}`;
  assert.equal(await expireHolds(sql, pay), 1);
  assert.equal((await orderById(sql, order.id))!.status, 'expired');
  assert.equal((await stock(id)).available, 1);
  assert.equal(pay.sessions.get(session)!.status, 'expired');
});

test('payment after the hold: accepted while the cards are there, refunded when sold out', async () => {
  // Still there: the late payment takes the card again.
  const a = await product('LATE-1', 1500, 1);
  const cart1 = await createCart(sql, 'de');
  await addToCart(sql, cart1, a, 1);
  const first = await checkout(cart1);
  await releaseOrder(sql, { id: first.order.id }, 'expired', 'test');
  assert.equal(await handlePaymentEvent(sql, pay, pay.pay(first.session)), 'paid');
  assert.equal((await stock(a)).quantity, 0);

  // Sold out: someone else bought the card meanwhile → full refund and a mail.
  const b = await product('LATE-2', 3000, 1);
  const slow = await createCart(sql, 'de');
  await addToCart(sql, slow, b, 1);
  const late = await checkout(slow);
  await releaseOrder(sql, { id: late.order.id }, 'expired', 'test');
  const fast = await createCart(sql, 'de');
  await addToCart(sql, fast, b, 1);
  const winner = await checkout(fast, details({ email: 'misty@example.com' }));
  await handlePaymentEvent(sql, pay, pay.pay(winner.session));

  const refundsBefore = pay.refunds.length;
  assert.equal(await handlePaymentEvent(sql, pay, pay.pay(late.session)), 'refunded');
  assert.equal(pay.refunds.length, refundsBefore + 1);
  assert.equal(pay.refunds.at(-1)!.amount, 3000 + 500, 'goods + € 5 minimum insurance');
  const o = await orderById(sql, late.order.id);
  assert.equal(o!.status, 'refunded');
  const [m] = await sql`SELECT 1 FROM outbox WHERE template = 'order_unavailable'
                        AND payload->>'order_id' = ${String(late.order.id)}`;
  assert.ok(m, 'buyer is told');
});

test('a new checkout from the same cart replaces the open one', async () => {
  const id = await product('AGAIN-1', 1200, 1);
  const cart = await createCart(sql, 'de');
  await addToCart(sql, cart, id, 1);
  const one = await checkout(cart);
  const two = await checkout(cart);
  assert.equal((await orderById(sql, one.order.id))!.status, 'cancelled');
  assert.equal((await orderById(sql, two.order.id))!.status, 'checkout');
  assert.equal((await stock(id)).reserved, 1, 'held once, not twice');
  assert.equal(pay.sessions.get(one.session)!.status, 'expired');
});

test('checkout refuses an empty cart and a country we do not ship to', async () => {
  const cart = await createCart(sql, 'de');
  await assert.rejects(
    createCheckoutOrder(sql, {
      cartId: cart,
      locale: 'de',
      details: details(),
      reservationMinutes: 10,
      ossEnabled: false,
    }),
    (e: CheckoutRejected) =>
      e instanceof CheckoutRejected && e.problems.some((p) => p.code === 'empty_cart'),
  );
  const id = await product('FR-1', 5000, 1);
  await addToCart(sql, cart, id, 1);
  await assert.rejects(
    createCheckoutOrder(sql, {
      cartId: cart,
      locale: 'de',
      details: details({ shipping: { ...details().shipping, country: 'FR', postcode: '75001' } }),
      reservationMinutes: 10,
      ossEnabled: false,
    }),
    (e: CheckoutRejected) => e.problems[0]?.code === 'country_not_delivered',
  );
  assert.equal((await stock(id)).reserved, 0);
});

test('mails: confirmation with terms PDF, shop notice with boxes, invoice PDF', async () => {
  const t = new MemoryTransport();
  const sent = await sendDueMails(sql, t, mailCtx());
  assert.ok(sent >= 2);
  const confirm = t.sent.find((m) => m.subject.startsWith('Bestellbestätigung'))!;
  assert.ok(confirm, 'confirmation sent');
  assert.equal(confirm.to, 'ash@example.com');
  assert.match(confirm.html, /Versicherter Versand/);
  assert.match(confirm.html, /vertrag-widerrufen/);
  assert.equal(confirm.attachments[0]!.name, 'AGB-und-Widerrufsbelehrung.pdf');
  assert.equal(confirm.attachments[0]!.content.subarray(0, 5).toString(), '%PDF-');
  const notice = t.sent.find((m) => m.subject.startsWith('Neue Bestellung'))!;
  assert.match(notice.html, /Box 001/);
  assert.match(notice.subject, /versichert/);

  const [paid] = await sql<
    { id: number }[]
  >`SELECT id FROM orders WHERE status = 'paid' ORDER BY id LIMIT 1`;
  const inv = await sql.begin((tx) => issueInvoice(tx, paid!.id, new Date('2026-11-06T10:00:00Z')));
  assert.equal(inv.number, 'RE-2026-000001');
  const again = await sql.begin((tx) => issueInvoice(tx, paid!.id, new Date()));
  assert.equal(again.number, inv.number, 'one invoice per order');
  const pdf = await invoicePdf(sql, inv.id, mailCtx());
  assert.equal(pdf.name, 'Rechnung-RE-2026-000001.pdf');
  assert.equal(pdf.content.subarray(0, 5).toString(), '%PDF-');
});

test('withdrawal: stored with time of receipt, acknowledgement repeats the content', async () => {
  const w = await recordWithdrawal(
    sql,
    {
      name: 'Ash Ketchum',
      email: 'ash@example.com',
      order_number: 'PK-2611-ABCDE',
      items: 'Glurak',
    },
    'de',
  );
  const t = new MemoryTransport();
  await sendDueMails(sql, t, mailCtx());
  const ack = t.sent.find((m) => m.subject === 'Eingangsbestätigung deines Widerrufs')!;
  assert.ok(ack);
  assert.match(ack.html, /PK-2611-ABCDE/);
  assert.match(ack.html, /Glurak/);
  assert.match(ack.html, /\d{2}:\d{2}:\d{2}/, 'time of receipt with seconds');
  const [row] = await sql<{ acknowledged_at: Date | null }[]>`
    SELECT acknowledged_at FROM withdrawals WHERE id = ${w.id}`;
  assert.ok(row!.acknowledged_at);
  assert.ok(t.sent.some((m) => m.subject.startsWith('Widerruf eingegangen')));
});

test('Graph sendMail body', () => {
  const body = graphMessage({
    to: 'a@example.com',
    replyTo: 'bestellung@pokemonkarten.at',
    subject: 'S',
    html: '<p>x</p>',
    attachments: [{ name: 'a.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF') }],
  });
  assert.deepEqual(body.message.toRecipients, [{ emailAddress: { address: 'a@example.com' } }]);
  assert.equal(body.message.attachments[0]!['@odata.type'], '#microsoft.graph.fileAttachment');
  assert.equal(body.message.attachments[0]!.contentBytes, Buffer.from('%PDF').toString('base64'));
  assert.equal(body.saveToSentItems, true);
});

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import { addToCart, createCart, loadCart } from '../../src/cart.ts';
import { syncLegalTexts } from '../../src/legal-sync.ts';
import {
  completeWithoutPayment,
  createCheckoutOrder,
  expireHolds,
  handlePaymentEvent,
  startPayment,
  CheckoutRejected,
  type CheckoutDetails,
} from '../../src/orders.ts';
import { fakeProvider } from '../../src/payments.ts';
import { issueInvoice, markShipped, refundOrder } from '../../src/fulfilment.ts';
import {
  cancelGiftVoucher,
  createGiftVoucherOrder,
  validateGiftVoucher,
} from '../../src/gift-vouchers.ts';
import {
  addCartCode,
  cartCodes,
  createDiscountCodes,
  createPromoVouchers,
  listVouchers,
  priceCartCodes,
  voucherLedger,
  voucherTotals,
} from '../../src/vouchers.ts';
import {
  checkLicenseBuyer,
  createLicenseOrder,
  issueOrderLicenses,
  licenseSeller,
  startLicensePayment,
  validateLicenseCheckout,
  LicenseCheckoutRejected,
} from '../../src/licenses.ts';
import { memoryLicenseClient } from '../../src/license-client.ts';
import { fakeVies } from '../../src/tax-id.ts';
import { documentData, sendDueMails, type Mail, type MailTransport } from '../../src/mail.ts';

let sql: Sql;
let drop: () => Promise<void>;
let mediaDir: string;
const shop = fakeProvider('http://localhost:3000');
const gmbh = fakeProvider('http://localhost:3000', 'gmbh');
const licenses = memoryLicenseClient();
let seller: Record<string, string>;

class MemoryTransport implements MailTransport {
  readonly name = 'memory';
  sent: Mail[] = [];
  async send(m: Mail) {
    this.sent.push(m);
  }
}
const mailCtx = () => ({
  baseUrl: 'https://overpricedcardboard.com',
  mediaDir,
  replyTo: 'order@overpricedcardboard.com',
  company: {
    name: 'Maximilian Pinter',
    street: 'Wienerstraße 1',
    postcode: '2440',
    city: 'Moosbrunn',
    country: 'AT',
  },
  licenses,
  licenseSeller: seller,
  gmbhPayments: gmbh,
});

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

const details = (email = 'ash@example.com'): CheckoutDetails => ({
  email,
  shipping: {
    name: 'Ash Ketchum',
    street: 'Hauptstraße 1',
    postcode: '1010',
    city: 'Wien',
    country: 'AT',
  },
  acceptTerms: true,
});

async function order(cartId: string, email = 'ash@example.com') {
  return createCheckoutOrder(sql, {
    cartId,
    locale: 'de',
    details: details(email),
    reservationMinutes: 10,
    ossEnabled: false,
    smallBusiness: true,
  });
}

async function pay(orderId: number, number: string) {
  await startPayment(
    sql,
    shop,
    {
      id: orderId,
      number,
      token: 'x',
      totalCents: 0,
      dueCents: 0,
      reservedUntil: new Date(),
      replacedSessions: [],
    },
    { email: 'ash@example.com', locale: 'de', successUrl: 'x', cancelUrl: 'y' },
  );
  const [o] = await sql<{ stripe_session_id: string }[]>`
    SELECT stripe_session_id FROM orders WHERE id = ${orderId}`;
  return { session: shop.sessions.get(o!.stripe_session_id)!, id: o!.stripe_session_id };
}

/** Buys a gift voucher the way a customer does and returns its code. */
async function buyVoucher(cents: number, email = 'misty@example.com') {
  const v = validateGiftVoucher({
    amountCents: String(cents),
    recipientName: 'Rocko',
    message: 'Alles Gute! 🎉',
    name: 'Misty',
    email,
    acceptTerms: true,
  });
  assert.ok(v.ok, JSON.stringify(!v.ok && v.errors));
  const o = await createGiftVoucherOrder(sql, { locale: 'de', details: v.data });
  const { id, session } = await pay(o.id, o.number);
  assert.equal(session.amountTotal, cents);
  assert.equal(await handlePaymentEvent(sql, shop, shop.pay(id)), 'paid');
  const [row] = await sql<{ id: number; code: string; balance_cents: number; origin: string }[]>`
    SELECT v.id, v.code, v.balance_cents, v.origin FROM vouchers v WHERE v.order_id = ${o.id}`;
  return { orderId: o.id, ...row! };
}

const balance = async (code: string) =>
  (await sql<{ b: number }[]>`SELECT balance_cents AS b FROM vouchers WHERE code = ${code}`)[0]!.b;

before(async () => {
  ({ sql, drop } = await freshDatabase());
  await syncLegalTexts(sql);
  mediaDir = await mkdtemp(join(tmpdir(), 'pokeshop-media-'));
  seller = (await licenseSeller(sql)) as unknown as Record<string, string>;
  // Shipping that costs something, so vouchers can be seen paying it.
  await sql`UPDATE countries SET standard_shipping_cents = 250 WHERE code = 'AT'`;
});
after(async () => drop());

let sold: Awaited<ReturnType<typeof buyVoucher>>;

test('a bought gift voucher: paid through the shop, created on payment, PDF to the buyer', async () => {
  assert.equal(
    validateGiftVoucher({ amountCents: '999', name: 'x', email: 'a@b.at', acceptTerms: true }).ok,
    false,
  );
  assert.equal(
    validateGiftVoucher({ amountCents: '30100', name: 'x', email: 'a@b.at', acceptTerms: true }).ok,
    false,
  );
  assert.equal(
    validateGiftVoucher({ amountCents: '2550', name: 'x', email: 'a@b.at', acceptTerms: true }).ok,
    false,
    'whole euros',
  );
  sold = await buyVoucher(1500);
  assert.match(sold.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(sold.origin, 'sold');
  assert.equal(sold.balance_cents, 1500);
  const [o] = await sql<{ status: string; vat_regime: string; vat_cents: number }[]>`
    SELECT status, vat_regime, vat_cents FROM orders WHERE id = ${sold.orderId}`;
  assert.deepEqual(o, { status: 'completed', vat_regime: 'voucher', vat_cents: 0 });
  const [docs] = await sql<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM documents WHERE order_id = ${sold.orderId}`;
  assert.equal(docs!.n, 0, 'a voucher sale is no supply: no invoice');
  const t = new MemoryTransport();
  await sendDueMails(sql, t, mailCtx(), 20);
  const m = t.sent.find((x) => x.to === 'misty@example.com')!;
  assert.equal(m.subject, 'Dein Geschenkgutschein von Overpriced Cardboard');
  assert.ok(m.html.includes(sold.code));
  assert.deepEqual(
    m.attachments.map((a) => a.name),
    [`Gutschein-${sold.code}.pdf`, 'AGB-und-Widerrufsbelehrung.pdf'],
  );
  assert.equal(m.attachments[0]!.content.subarray(0, 5).toString(), '%PDF-');
  assert.ok(t.sent.some((x) => /Gutschein verkauft/.test(x.subject)));
});

test('cart: code + promotional voucher + bought voucher, in that order', async () => {
  const a = await product('A1', 1000, 5);
  const b = await product('B1', 500, 5);
  await createDiscountCodes(
    sql,
    {
      code: 'Christmas',
      kind: 'percent',
      percentBp: 2000,
      appliesTo: 'both',
      oncePerCustomer: true,
      minGoodsCents: 1000,
    },
    'owner@example.com',
  );
  await createDiscountCodes(
    sql,
    { code: 'APPONLY', kind: 'percent', percentBp: 5000, appliesTo: 'licenses' },
    'owner',
  );
  const [promo] = await createPromoVouchers(
    sql,
    { valueCents: 500, count: 1, expiresAt: null, note: 'für Brock' },
    'owner@example.com',
  );
  const cart = await createCart(sql, 'de');
  await addToCart(sql, cart, a, 2);
  await addToCart(sql, cart, b, 1);
  const view = await loadCart(sql, cart, 'de');
  const goods = view.check.goodsSubtotal;
  const ship = view.check.shipping!.price;
  assert.equal(goods, 2500);

  assert.deepEqual(await addCartCode(sql, cart, 'nonsense', goods), {
    ok: false,
    problem: 'unknown',
  });
  assert.deepEqual(await addCartCode(sql, cart, 'apponly', goods), {
    ok: false,
    problem: 'not_for_cards',
  });
  assert.equal((await addCartCode(sql, cart, ' christmas ', goods)).ok, true, 'any case, spaces');
  assert.equal(
    (await addCartCode(sql, cart, promo!.code.toLowerCase().replace(/-/g, ''), goods)).ok,
    true,
  );
  assert.equal((await addCartCode(sql, cart, sold.code, goods)).ok, true);
  assert.deepEqual(await cartCodes(sql, cart), ['Christmas', promo!.code, sold.code]);

  const priced = await priceCartCodes(sql, {
    codes: await cartCodes(sql, cart),
    lines: view.lines.map((l) => l.lineTotal),
    shipping: ship,
  });
  const p = priced.pricing;
  assert.equal(p.code!.amount, 500, '20 % of € 25 cards');
  assert.deepEqual(
    p.promo.map((v) => v.amount),
    [500],
  );
  assert.equal(p.discount, 1000);
  assert.equal(p.total, goods + ship - 1000);
  assert.deepEqual(
    p.paid.map((v) => v.amount),
    [Math.min(1500, p.total)],
  );
  assert.equal(p.due, p.total - p.paid[0]!.amount);
  assert.deepEqual(p.lineDiscounts, [800, 200], 'spread over the lines by value');

  const created = await order(cart);
  assert.equal(created.totalCents, p.total);
  assert.equal(created.dueCents, p.due);
  const [o] = await sql<
    {
      goods_cents: number;
      discount_cents: number;
      voucher_cents: number;
      total_cents: number;
      vat_regime: string;
    }[]
  >`SELECT goods_cents, discount_cents, voucher_cents, total_cents, vat_regime FROM orders WHERE id = ${created.id}`;
  assert.deepEqual(o, {
    goods_cents: 2500,
    discount_cents: 1000,
    voucher_cents: p.paid[0]!.amount,
    total_cents: p.total,
    vat_regime: 'small_business',
  });
  assert.equal(await balance(sold.code), 1500 - p.paid[0]!.amount, 'held at once');
  assert.equal(await balance(promo!.code), 0);

  const { id: sid, session } = await pay(created.id, created.number);
  assert.equal(session.input.discount!.amount, 1000 + p.paid[0]!.amount);
  assert.match(session.input.discount!.label, /^Rabatt und Gutschein CHRISTMAS/);
  assert.equal(session.amountTotal, p.due, 'Stripe collects only the rest');
  assert.equal(await handlePaymentEvent(sql, shop, shop.pay(sid)), 'paid');
  const uses = await sql<
    { status: string }[]
  >`SELECT status FROM voucher_redemptions WHERE order_id = ${created.id}`;
  assert.deepEqual(
    uses.map((u) => u.status),
    ['used', 'used'],
  );

  // The same code again for the same customer: once per customer.
  const cart2 = await createCart(sql, 'de');
  await addToCart(sql, cart2, a, 2);
  assert.equal((await addCartCode(sql, cart2, 'CHRISTMAS', 2000)).ok, true, 'e-mail not known yet');
  await assert.rejects(
    order(cart2),
    (e) =>
      e instanceof CheckoutRejected &&
      e.problems.some((x) => x.code === 'code_problem' && x.problem === 'already_used'),
  );
  const ok = await order(cart2, 'brock@example.com');
  assert.equal(ok.totalCents, 2000 - 400 + ship);

  // Invoice: the discount as lines, the bought voucher as a payment below the total.
  await sql`UPDATE orders SET status = 'packing' WHERE id = ${created.id}`;
  await markShipped(sql, created.id, { actor: 'owner' });
  const [doc] = await sql<
    { id: number }[]
  >`SELECT id FROM documents WHERE order_id = ${created.id} AND kind = 'invoice'`;
  const inv = await documentData(sql, doc!.id, mailCtx().company);
  assert.deepEqual(
    inv.items.map((i) => [i.description.split(' ')[0], i.unitCents * i.quantity]),
    [
      ['Glurak', 2000],
      ['Glurak', 500],
      ['Versand', ship],
      ['Rabatt', -500],
      ['Aktionsgutschein', -500],
    ],
  );
  assert.equal(inv.totalCents, p.total);
  assert.deepEqual(inv.voucherPayments, [{ code: sold.code, cents: p.paid[0]!.amount }]);

  // Refund one copy of A: € 10 less its share of the discount (€ 4), split like the payment.
  const [itemA] = await sql<{ id: number }[]>`
    SELECT id FROM order_items WHERE order_id = ${created.id} AND product_id = ${a}`;
  const before = await balance(sold.code);
  const r = await refundOrder(sql, shop, {
    orderId: created.id,
    items: [{ orderItemId: itemA!.id, quantity: 1, restock: true }],
    shipping: false,
    reason: 'test',
    actor: 'owner',
  });
  assert.equal(r.amount, 600);
  const [ref] = await sql<
    { voucher_cents: number }[]
  >`SELECT voucher_cents FROM refunds WHERE id = ${r.refundId}`;
  const toVoucher = Math.floor((600 * p.paid[0]!.amount) / p.total);
  assert.equal(ref!.voucher_cents, toVoucher);
  assert.equal(await balance(sold.code), before + toVoucher, 'part back onto the voucher');
  assert.equal(shop.refunds.at(-1)!.amount, 600 - toVoucher, 'the rest to the card');
});

test('a voucher that covers everything: no payment page', async () => {
  const c = await product('C1', 400, 3);
  const [big] = await createPromoVouchers(
    sql,
    { valueCents: 5000, count: 1, expiresAt: null },
    'owner',
  );
  const cart = await createCart(sql, 'de');
  await addToCart(sql, cart, c, 4);
  assert.equal((await addCartCode(sql, cart, big!.code, 1200)).ok, true);
  await sql`UPDATE cart_items SET quantity = 3 WHERE cart_id = ${cart}`;
  const created = await order(cart, 'gift@example.com');
  assert.equal(created.dueCents, 0);
  assert.equal(created.totalCents, 0, 'a promotional voucher is a discount: nothing is owed');
  assert.equal(await completeWithoutPayment(sql, created.id), 'paid');
  const [o] = await sql<
    {
      status: string;
      payment_method_type: string;
      discount_cents: number;
      shipping_discount_cents: number;
    }[]
  >`
    SELECT status, payment_method_type, discount_cents, shipping_discount_cents FROM orders WHERE id = ${created.id}`;
  assert.equal(o!.status, 'paid');
  assert.equal(o!.payment_method_type, 'discount');
  assert.ok(o!.shipping_discount_cents > 0, 'the voucher paid the shipping too');
  assert.equal(await balance(big!.code), 5000 - o!.discount_cents, 'the rest stays on it');
});

test('an order that is not paid gives code and vouchers back; Stripe minimum', async () => {
  const d = await product('D1', 2000, 2);
  await createDiscountCodes(
    sql,
    {
      code: 'ONCE',
      kind: 'amount',
      amountCents: 500,
      appliesTo: 'cards',
      maxUses: 1,
      oncePerCustomer: false,
    },
    'owner',
  );
  const v = await buyVoucher(2000, 'buyer2@example.com');
  const cart = await createCart(sql, 'de');
  await addToCart(sql, cart, d, 1);
  await addCartCode(sql, cart, 'ONCE', 2000);
  await addCartCode(sql, cart, v.code, 2000);
  const view = await loadCart(sql, cart, 'de');
  const ship = view.check.shipping!.price;
  const created = await order(cart, 'late@example.com');
  // € 20 − € 5 + shipping: the voucher pays all but € 0.50 (Stripe's minimum) … unless it covers it all.
  const total = 2000 - 500 + ship;
  assert.equal(created.totalCents, total);
  assert.equal(created.dueCents, Math.max(0, total - 2000) || 0);
  await pay(created.id, created.number);
  await sql`UPDATE orders SET reserved_until = now() - interval '1 hour' WHERE id = ${created.id}`;
  assert.equal(await expireHolds(sql, shop), 1);
  assert.equal(await balance(v.code), 2000, 'voucher back in full');
  const [u] = await sql<
    { status: string }[]
  >`SELECT status FROM discount_code_uses WHERE order_id = ${created.id}`;
  assert.equal(u!.status, 'released', 'the single use is free again');
  const cart2 = await createCart(sql, 'de');
  await addToCart(sql, cart2, d, 1);
  assert.equal((await addCartCode(sql, cart2, 'ONCE', 2000)).ok, true);

  // A voucher that leaves less than € 0.50: it pays € 0.50 less.
  const e = await product('E1', 1530, 1);
  const w = await buyVoucher(2000, 'buyer3@example.com');
  const cart3 = await createCart(sql, 'de');
  await addToCart(sql, cart3, e, 1);
  const shipE = (await loadCart(sql, cart3, 'de')).check.shipping!.price;
  const priced = await priceCartCodes(sql, { codes: [w.code], lines: [1530], shipping: shipE });
  const due = 1530 + shipE - Math.min(2000, 1530 + shipE);
  assert.equal(priced.pricing.due, due === 0 ? 0 : Math.max(due, 50));
});

test('promotional vouchers are a discount, bought ones money: totals and ledger', async () => {
  const totals = await voucherTotals(sql);
  assert.ok(totals.sold_count >= 3);
  assert.ok(totals.sold_open > 0);
  const list = await listVouchers(sql, { origin: 'promo' });
  assert.ok(list.rows.every((r) => r.origin === 'promo'));
  assert.ok(list.rows.some((r) => r.note === 'für Brock'));
  const ledger = await voucherLedger(
    sql,
    new Date(Date.now() - 3600_000),
    new Date(Date.now() + 3600_000),
  );
  const kinds = new Set(ledger.map((l) => l.kind));
  for (const k of ['issued', 'redeemed', 'released', 'restored']) assert.ok(kinds.has(k), k);
  assert.ok(ledger.every((l) => l.balance_after >= 0));
});

test('a bought voucher taken back: refund of what is left', async () => {
  const v = await buyVoucher(2500, 'regret@example.com');
  const r = await cancelGiftVoucher(sql, shop, {
    voucherId: v.id,
    actor: 'owner',
    reason: 'Widerruf',
  });
  assert.equal(r.amount, 2500);
  const [row] = await sql<{ status: string; balance_cents: number }[]>`
    SELECT status, balance_cents FROM vouchers WHERE id = ${v.id}`;
  assert.deepEqual(row, { status: 'cancelled', balance_cents: 0 });
  assert.equal(shop.refunds.at(-1)!.amount, 2500);
  const cart = await createCart(sql, 'de');
  assert.deepEqual(await addCartCode(sql, cart, v.code, 1000), { ok: false, problem: 'blocked' });
  await assert.rejects(
    cancelGiftVoucher(sql, shop, { voucherId: v.id, actor: 'owner', reason: '' }),
    /schon storniert/,
  );
});

test('licences: a 20 % campaign through Stripe, a free licence for a friend without', async () => {
  await addReleaseOnce();
  await createDiscountCodes(
    sql,
    { code: 'APP20', kind: 'percent', percentBp: 2000, appliesTo: 'licenses' },
    'owner',
  );
  await createDiscountCodes(
    sql,
    {
      count: 2,
      prefix: 'FREUND',
      campaign: 'Freunde 2026',
      kind: 'percent',
      percentBp: 10_000,
      appliesTo: 'licenses',
      maxLicenses: 1,
    },
    'owner',
  );
  const [friend] = await sql<
    { code: string }[]
  >`SELECT code FROM discount_codes WHERE campaign = 'Freunde 2026' ORDER BY id LIMIT 1`;
  assert.match(friend!.code, /^FREUND-[A-Z0-9]{6}$/);

  const buy = async (over: Record<string, unknown>) => {
    const v = validateLicenseCheckout({
      buyer: 'consumer',
      name: 'Misty',
      email: 'misty@example.com',
      street: 'Arenaweg 2',
      postcode: '1010',
      city: 'Wien',
      country: 'AT',
      quantity: '1',
      acceptTerms: true,
      immediateDelivery: true,
      ...over,
    });
    assert.ok(v.ok, JSON.stringify(!v.ok && v.errors));
    const c = await checkLicenseBuyer(sql, v.data, { grossCents: 13900, vies: fakeVies });
    assert.ok(c.ok);
    const o = await createLicenseOrder(sql, { locale: 'de', details: v.data, buyer: c.buyer });
    return { o, v, c };
  };
  // 20 % off two licences, through the GmbH's Stripe with a coupon.
  const { o, v, c } = await buy({ code: 'app20', quantity: '2' });
  assert.equal(o.totalCents, 27800 - 5560);
  await startLicensePayment(sql, gmbh, o, {
    details: v.data,
    buyer: c.buyer,
    locale: 'de',
    successUrl: 'x',
    cancelUrl: 'y',
  });
  const [row] = await sql<
    { stripe_session_id: string }[]
  >`SELECT stripe_session_id FROM orders WHERE id = ${o.id}`;
  const s = gmbh.sessions.get(row!.stripe_session_id)!;
  assert.equal(s.input.discount!.amount, 5560);
  assert.equal(s.amountTotal, 22240);
  assert.equal(s.amountTax, 22240 - Math.round(22240 / 1.2), 'Stripe Tax on the reduced price');
  assert.equal(await handlePaymentEvent(sql, gmbh, gmbh.pay(row!.stripe_session_id)), 'paid');
  const [paid] = await sql<{ goods_cents: number; discount_cents: number; total_cents: number }[]>`
    SELECT goods_cents, discount_cents, total_cents FROM orders WHERE id = ${o.id}`;
  assert.deepEqual(paid, { goods_cents: 27800, discount_cents: 5560, total_cents: 22240 });

  // Cards-only codes and vouchers do not work for licences.
  await assert.rejects(
    buy({ code: 'ONCE' }),
    (e) => e instanceof LicenseCheckoutRejected && e.problem === 'not_for_licenses',
  );
  await assert.rejects(
    buy({ code: sold.code }),
    (e) => e instanceof LicenseCheckoutRejected && e.problem === 'voucher_for_licenses',
  );

  // A friend's code: one licence free, the second at full price.
  const two = await buy({ code: friend!.code, quantity: '2', email: 'brock@example.com' });
  assert.equal(two.o.totalCents, 13900);
  await assert.rejects(
    buy({ code: friend!.code, email: 'other@example.com' }),
    (e) => e instanceof LicenseCheckoutRejected && e.problem === 'used_up',
  );
  const [second] = await sql<
    { code: string }[]
  >`SELECT code FROM discount_codes WHERE campaign = 'Freunde 2026' ORDER BY id DESC LIMIT 1`;
  const free = await buy({ code: second!.code, email: 'tracey@example.com' });
  assert.equal(free.o.totalCents, 0);
  assert.equal(await completeWithoutPayment(sql, free.o.id), 'paid');
  assert.equal(
    await issueOrderLicenses(sql, licenses, free.o.id, new Date(), null),
    'issued',
    'no Stripe needed',
  );
  const [fo] = await sql<
    { invoice_number: string | null }[]
  >`SELECT invoice_number FROM order_licenses WHERE order_id = ${free.o.id}`;
  assert.equal(fo!.invoice_number, null, 'free: no invoice');
  const t = new MemoryTransport();
  await sendDueMails(sql, t, mailCtx(), 30);
  const m = t.sent.find((x) => x.to === 'tracey@example.com')!;
  assert.match(m.html, /Die Lizenz ist ein Geschenk/);
  assert.deepEqual(
    m.attachments.filter((a) => !a.contentId).map((a) => a.name),
    ['Lizenzbedingungen.pdf'],
  );
});

let released = false;
async function addReleaseOnce() {
  if (released) return;
  released = true;
  await sql`INSERT INTO app_releases (version, storage_key, size_bytes, sha256, uploaded_by)
            VALUES ('1.0.0', 'app/x.apk', 1000, ${'a'.repeat(64)}, 'owner')`;
}

test('sold out after payment: vouchers back, the card part refunded', async () => {
  const f = await product('F1', 1000, 1);
  const v = await buyVoucher(1000, 'f@example.com');
  const cart = await createCart(sql, 'de');
  await addToCart(sql, cart, f, 1);
  await addCartCode(sql, cart, v.code, 1000);
  const created = await order(cart, 'f@example.com');
  const { id } = await pay(created.id, created.number);
  // The hold runs out and somebody else takes the card.
  await sql`UPDATE orders SET reserved_until = now() - interval '1 hour' WHERE id = ${created.id}`;
  await sql`SELECT order_release_stock(${created.id})`;
  await sql`UPDATE orders SET status = 'expired' WHERE id = ${created.id}`;
  assert.equal(await balance(v.code), 1000);
  await sql`SELECT stock_change(${f}, '001', -1, 'admin', 'other', NULL, 'sold elsewhere')`;
  const outcome = await handlePaymentEvent(sql, shop, shop.pay(id));
  assert.ok(['refunded', 'refund_pending'].includes(outcome), outcome);
  assert.equal(await balance(v.code), 1000, 'the voucher keeps its value');
  assert.equal(shop.refunds.at(-1)!.amount, created.dueCents, 'only what went through Stripe');
});

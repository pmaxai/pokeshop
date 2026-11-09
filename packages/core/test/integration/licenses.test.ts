import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import { syncLegalTexts } from '../../src/legal-sync.ts';
import { claimJob, finishJob } from '../../src/jobs.ts';
import { memoryLicenseClient } from '../../src/license-client.ts';
import {
  addRelease,
  appSales,
  checkLicenseBuyer,
  createLicenseOrder,
  issueOrderLicenses,
  licenseOrderByToken,
  licenseSeller,
  refundLicenseOrder,
  requestLicenseResend,
  resendLicensesByEmail,
  revokeOrderLicenses,
  saveAppSettings,
  startLicensePayment,
  validateLicenseCheckout,
  LicenseCheckoutRejected,
  type LicenseBuyer,
} from '../../src/licenses.ts';
import {
  expireHolds,
  handlePaymentEvent,
  processPaidSession,
  recordExternalRefund,
  startPayment,
} from '../../src/orders.ts';
import { CustomerRejected, fakeProvider } from '../../src/payments.ts';
import { fakeVies } from '../../src/tax-id.ts';
import {
  graphMessage,
  sendDueMails,
  type Mail,
  type MailContext,
  type MailTransport,
} from '../../src/mail.ts';
import { listOrders } from '../../src/fulfilment.ts';

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
const mailCtx = (): MailContext => ({
  baseUrl: 'https://pokemonkarten.at',
  mediaDir,
  replyTo: 'bestellung@pokemonkarten.at',
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

const form = (over: Record<string, unknown> = {}) => ({
  buyer: 'consumer',
  name: 'Misty Waterflower',
  email: 'Misty@Example.com',
  street: 'Arenaweg 2',
  postcode: '80331',
  city: 'München',
  country: 'de',
  quantity: '2',
  acceptTerms: true,
  immediateDelivery: true,
  ...over,
});

/** Form → VIES → order → Stripe customer and page, as the server action does it. */
async function buy(over: Record<string, unknown> = {}, locale: 'de' | 'en' = 'de') {
  const v = validateLicenseCheckout(form(over));
  assert.ok(v.ok, JSON.stringify(!v.ok && v.errors));
  const c = await checkLicenseBuyer(sql, v.data, { grossCents: 13900, vies: fakeVies });
  assert.ok(c.ok, JSON.stringify(!c.ok && c.errors));
  const order = await createLicenseOrder(sql, { locale, details: v.data, buyer: c.buyer });
  await startLicensePayment(sql, gmbh, order, {
    details: v.data,
    buyer: c.buyer,
    locale,
    successUrl: 'https://pokemonkarten.at/app/lizenz/x',
    cancelUrl: 'https://pokemonkarten.at/app',
  });
  const [row] = await sql<{ stripe_session_id: string; stripe_customer_id: string }[]>`
    SELECT stripe_session_id, stripe_customer_id FROM orders WHERE id = ${order.id}`;
  return {
    order,
    buyer: c.buyer as LicenseBuyer,
    sessionId: row!.stripe_session_id,
    session: gmbh.sessions.get(row!.stripe_session_id)!,
    customer: gmbh.customers.get(row!.stripe_customer_id)!,
  };
}

before(async () => {
  ({ sql, drop } = await freshDatabase());
  await syncLegalTexts(sql);
  mediaDir = await mkdtemp(join(tmpdir(), 'pokeshop-media-'));
  seller = (await licenseSeller(sql)) as unknown as Record<string, string>;
});
after(async () => drop());

test('the GmbH is the seller of the licences (setting from the migration)', () => {
  assert.equal(seller.name, 'Antalyse GmbH');
  assert.equal(seller.email, 'info@abc-it.at');
  assert.equal(seller.register_number, 'FN 614039z');
  assert.equal(seller.vat_id, 'ATU79907228');
});

test('the form: consent, address, company and tax id where the buyer type needs them', () => {
  const ok = validateLicenseCheckout(form());
  assert.ok(ok.ok);
  assert.equal(ok.data.email, 'misty@example.com');
  assert.equal(ok.data.country, 'DE');
  assert.equal(ok.data.quantity, 2);
  const bad = validateLicenseCheckout(
    form({ immediateDelivery: false, quantity: '51', postcode: '1010', street: '' }),
  );
  assert.ok(!bad.ok);
  assert.equal(bad.errors.immediateDelivery, 'consent');
  assert.equal(bad.errors.quantity, 'too_many', 'the licence service issues at most 50');
  assert.equal(bad.errors.postcode, 'invalid_postcode', 'German postcodes have five digits');
  assert.equal(bad.errors.street, 'required', 'invoices above € 400 need the address');
  assert.ok(validateLicenseCheckout(form({ quantity: '50' })).ok);

  const errs = (over: Record<string, unknown>) => {
    const r = validateLicenseCheckout(form(over));
    return r.ok ? {} : r.errors;
  };
  assert.equal(errs({ country: 'CH', postcode: '8001' }).country, 'consumer_eu_only');
  assert.equal(errs({ country: 'JP', postcode: '1000001' }).country, 'country');
  assert.equal(errs({ buyer: 'business' }).company, 'required');
  assert.equal(
    errs({ buyer: 'business', company: 'Arena GmbH', country: 'CH', postcode: '8001' }).vatId,
    'required',
    'businesses outside the EU name their tax number',
  );
  assert.equal(
    errs({
      buyer: 'business',
      company: 'Arena Inc',
      country: 'US',
      postcode: '10001',
      vatId: 'abc',
    }).vatId,
    'invalid_tax_id',
  );
  assert.ok(
    validateLicenseCheckout(
      form({
        buyer: 'business',
        company: 'Arena Inc',
        country: 'US',
        postcode: '10001',
        vatId: '12-3456789',
      }),
    ).ok,
  );
  assert.ok(
    validateLicenseCheckout(form({ buyer: 'business', company: 'Arena GmbH' })).ok,
    'an EU business may buy without a VAT id (and pays VAT)',
  );
});

test('VIES decides about reverse charge; price and VAT follow the buyer', async () => {
  const check = async (over: Record<string, unknown>) => {
    const v = validateLicenseCheckout(form(over));
    assert.ok(v.ok, JSON.stringify(!v.ok && v.errors));
    return checkLicenseBuyer(sql, v.data, { grossCents: 13900, vies: fakeVies });
  };
  const pricing = async (over: Record<string, unknown>) => {
    const r = await check(over);
    assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
    const p = r.buyer.pricing;
    return [p.unitCents, p.behavior, p.regime, p.rateBp, p.taxExempt, p.taxCode];
  };
  assert.deepEqual(await pricing({}), [13900, 'inclusive', 'oss', 1900, 'none', 'txcd_10202000']);
  assert.deepEqual(await pricing({ country: 'AT', postcode: '1010' }), [
    13900,
    'inclusive',
    'domestic',
    2000,
    'none',
    'txcd_10202000',
  ]);
  const biz = { buyer: 'business', company: 'Arena GmbH' };
  assert.deepEqual(
    await pricing({ ...biz, country: 'AT', postcode: '1010', vatId: 'ATU12345678' }),
    [13900, 'inclusive', 'domestic', 2000, 'none', 'txcd_10202003'],
  );
  assert.deepEqual(await pricing({ ...biz, vatId: 'DE 123 456 789' }), [
    11583,
    'exclusive',
    'reverse_charge',
    0,
    'reverse',
    'txcd_10202003',
  ]);
  assert.deepEqual(await pricing(biz), [13900, 'inclusive', 'oss', 1900, 'none', 'txcd_10202003']);
  assert.deepEqual(
    await pricing({ ...biz, country: 'US', postcode: '10001', vatId: '123456789' }),
    [11583, 'exclusive', 'export', 0, 'reverse', 'txcd_10202003'],
  );
  const de = await check({ ...biz, vatId: '123456789' });
  assert.ok(de.ok);
  assert.deepEqual(de.buyer.taxId, { type: 'eu_vat', value: 'DE123456789' });
  assert.equal(de.buyer.viesName, 'Testfirma (VIES-Ersatz)');
  assert.deepEqual(await check({ ...biz, vatId: 'DE123456000' }), {
    ok: false,
    errors: { vatId: 'vat_id_invalid' },
  });
  assert.deepEqual(await check({ ...biz, vatId: 'DE123456999' }), {
    ok: false,
    errors: { vatId: 'vies_unavailable' },
  });
});

test('sales open only with the licence service and something to install', async () => {
  assert.equal((await appSales(sql, true)).open, false, 'no APK yet');
  await addRelease(sql, {
    version: '1.2.30',
    storageKey: 'app/abc.apk',
    sizeBytes: 90_000_000,
    sha256: 'a'.repeat(64),
    uploadedBy: 'owner@example.com',
  });
  const s = await appSales(sql, true);
  assert.equal(s.open, true);
  assert.equal(s.priceCents, 13900);
  assert.equal(s.release?.version, '1.2.30');
  assert.equal((await appSales(sql, false)).open, false, 'no licence service');
  await saveAppSettings(sql, {
    priceCents: 13900,
    playStoreUrl: 'https://play.google.com/store/apps/details?id=io.github.pmaxai.cardscanner',
    senderEmail: 'Lizenzen@ABC-it.at',
  });
  assert.match((await appSales(sql, true)).playStoreUrl!, /play\.google\.com/);
  assert.equal((await licenseSeller(sql)).email, 'lizenzen@abc-it.at');
  await saveAppSettings(sql, {
    priceCents: 13900,
    playStoreUrl: '',
    senderEmail: 'info@abc-it.at',
  });
  assert.equal((await appSales(sql, true)).playStoreUrl, null);
});

let orderId = 0;
let token = '';

test('a consumer buys: GmbH Stripe with Stripe Tax and invoice, keys, e-mail', async () => {
  const { order, session, sessionId, customer } = await buy();
  orderId = order.id;
  token = order.token;
  assert.equal(order.totalCents, 27800);
  assert.deepEqual(
    session.input.lines.map((l) => [l.name, l.unitAmount, l.quantity]),
    [['ScanPM-Lizenz (Beta)', 13900, 2]],
  );
  // Stripe Tax works from the customer's address; prices include the VAT.
  assert.deepEqual(session.input.tax, { behavior: 'inclusive', code: 'txcd_10202000' });
  assert.equal(customer.address.country, 'DE');
  assert.equal(customer.taxExempt, 'none');
  assert.equal(customer.taxId, null);
  assert.equal(session.input.customerId, customer.id);
  assert.match(session.input.invoice!.footer, /Antalyse GmbH · Wienerstraße 1, 2440 Moosbrunn/);
  assert.match(session.input.invoice!.footer, /FN 614039z, Landesgericht Korneuburg/);
  assert.match(session.input.invoice!.footer, /UID ATU79907228/);
  assert.doesNotMatch(session.input.invoice!.footer, /Reverse/);
  assert.deepEqual(session.input.invoice!.fields, [{ name: 'Bestellnummer', value: order.number }]);

  const [o] = await sql<
    {
      seller: string;
      vat_regime: string;
      tax_country: string;
      vat_cents: number;
      agb_version: number | null;
    }[]
  >`SELECT seller, vat_regime, tax_country, vat_cents, agb_version FROM orders WHERE id = ${order.id}`;
  assert.deepEqual(o, {
    seller: 'gmbh',
    vat_regime: 'oss',
    tax_country: 'DE',
    vat_cents: 4439,
    agb_version: null,
  });
  const [terms] = await sql<{ terms_version: number }[]>`
    SELECT terms_version FROM order_licenses WHERE order_id = ${order.id}`;
  assert.equal(terms!.terms_version, 1, 'the GmbH licence terms the buyer accepted');

  assert.equal((await licenseOrderByToken(sql, token))?.canDownload, false, 'not paid yet');

  // The shop's account (and webhook) cannot complete a GmbH order.
  assert.deepEqual(
    await processPaidSession(sql, shop, {
      ...(await gmbh.getSession(sessionId)),
      paymentStatus: 'paid',
    }),
    { kind: 'unknown_order' },
  );
  assert.equal(await handlePaymentEvent(sql, gmbh, gmbh.pay(sessionId)), 'paid');
  const [paid] = await sql<
    { status: string; vat_cents: number; vat_rate_bp: number; total_cents: number; inv: string }[]
  >`SELECT o.status, o.vat_cents, o.vat_rate_bp, o.total_cents, l.stripe_invoice_id AS inv
      FROM orders o JOIN order_licenses l ON l.order_id = o.id WHERE o.id = ${order.id}`;
  assert.equal(paid!.status, 'paid');
  assert.equal(paid!.vat_cents, 4439, 'Stripe Tax: 19 % German VAT in € 278');
  assert.equal(paid!.vat_rate_bp, 1900);
  assert.equal(paid!.total_cents, 27800);
  assert.match(paid!.inv, /^in_fake_/);

  const job = await claimJob(sql, ['license.issue']);
  assert.equal(job?.payload.order_id, order.id);
  await assert.rejects(
    issueOrderLicenses(sql, licenses, order.id),
    /GmbH Stripe account not configured/,
  );
  assert.equal(await issueOrderLicenses(sql, licenses, order.id, new Date(), gmbh), 'issued');
  await finishJob(sql, job!.id);
  assert.equal(await issueOrderLicenses(sql, licenses, order.id, new Date(), gmbh), 'already');
  assert.equal(licenses.all().length, 2);

  const view = await licenseOrderByToken(sql, token);
  assert.equal(view?.status, 'completed');
  assert.equal(view?.canDownload, true);
  const [inv] = await sql<{ invoice_number: string }[]>`
    SELECT invoice_number FROM order_licenses WHERE order_id = ${order.id}`;
  assert.match(inv!.invoice_number, /^TEST-/);
  const [docs] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM documents WHERE order_id = ${order.id}`;
  assert.equal(docs!.n, 0, 'no invoice of the shop: Stripe issues the GmbH’s');

  const listed = await listOrders(sql, { view: 'licenses' });
  assert.deepEqual(
    listed.rows.map((r) => [r.number, r.kind, r.copies]),
    [[order.number, 'license', 2]],
  );
  assert.equal((await listOrders(sql, { view: 'open' })).total, 0, 'nothing to pack');
});

test('the licence e-mail comes from the GmbH, with Stripe’s invoice and the licence terms', async () => {
  const t = new MemoryTransport();
  await sendDueMails(sql, t, mailCtx(), 20);
  const m = t.sent.find((x) => x.to === 'misty@example.com')!;
  assert.ok(m, 'sent to the buyer');
  assert.equal(m.from, 'info@abc-it.at');
  assert.equal(m.replyTo, 'info@abc-it.at');
  assert.equal(m.subject, 'Deine 2 ScanPM-Lizenzen');
  for (const l of licenses.all()) assert.ok(m.html.includes(l.key), 'key in the mail');
  assert.ok(m.html.includes(`https://pokemonkarten.at/api/app/download/${token}`));
  assert.match(m.html, /Version 1\.2\.30/);
  assert.match(m.html, /§ 18 Abs\. 1 Z 11 FAGG/);
  assert.match(m.html, /Vertragspartner für die Lizenz ist die Antalyse GmbH/);
  assert.match(m.html, /Antalyse GmbH · Wienerstraße 1, 2440 Moosbrunn · FN 614039z/);
  assert.doesNotMatch(m.html, /Maximilian Pinter/, 'the GmbH’s mail does not name the sole trader');
  const qr = m.attachments.filter((a) => a.contentId);
  assert.equal(qr.length, 2);
  assert.equal(qr[0]!.content.subarray(1, 4).toString(), 'PNG');
  const files = m.attachments.filter((a) => !a.contentId);
  const [inv] = await sql<{ invoice_number: string }[]>`
    SELECT invoice_number FROM order_licenses WHERE order_id = ${orderId}`;
  assert.deepEqual(
    files.map((a) => a.name),
    [`Rechnung-${inv!.invoice_number}.pdf`, 'Lizenzbedingungen.pdf'],
  );
  for (const f of files) assert.equal(f.content.subarray(0, 5).toString(), '%PDF-');
  assert.equal(
    graphMessage(m).message.attachments.filter((a) => (a as { isInline?: boolean }).isInline)
      .length,
    2,
    'QR codes go out as inline images',
  );
  const alert = t.sent.find((x) => /ScanPM-Lizenz verkauft/.test(x.subject));
  assert.ok(alert, 'the shop hears about the sale');
  assert.equal(alert.from ?? null, null, 'alerts still come from the shop');
  assert.match(alert.html, /an die GmbH/);
  assert.ok(
    !t.sent.some((x) => /Umsatzsteuer prüfen/.test(x.subject)),
    'Stripe Tax charged what the buyer was shown',
  );
});

test('a business in another EU country pays net with reverse charge', async () => {
  const { order, session, sessionId, customer } = await buy(
    {
      buyer: 'business',
      company: 'Arena Pokéball GmbH',
      vatId: 'DE123456789',
      quantity: '3',
      email: 'buero@arena.example',
    },
    'en',
  );
  assert.equal(order.totalCents, 3 * 11583);
  assert.deepEqual(session.input.tax, { behavior: 'exclusive', code: 'txcd_10202003' });
  assert.equal(customer.taxExempt, 'reverse');
  assert.deepEqual(customer.taxId, { type: 'eu_vat', value: 'DE123456789' });
  assert.equal(customer.company, 'Arena Pokéball GmbH');
  assert.equal(customer.locale, 'en');
  assert.match(session.input.invoice!.footer, /Reverse charge/);
  assert.deepEqual(session.input.invoice!.fields, [{ name: 'Order number', value: order.number }]);
  await handlePaymentEvent(sql, gmbh, gmbh.pay(sessionId));
  const [o] = await sql<
    {
      vat_regime: string;
      vat_cents: number;
      tax_country: string | null;
      total_cents: number;
      buyer_business: boolean;
      buyer_tax_id: string;
    }[]
  >`SELECT vat_regime, vat_cents, tax_country, total_cents, buyer_business, buyer_tax_id
      FROM orders WHERE id = ${order.id}`;
  assert.deepEqual(o, {
    vat_regime: 'reverse_charge',
    vat_cents: 0,
    tax_country: null,
    total_cents: 34749,
    buyer_business: true,
    buyer_tax_id: 'DE123456789',
  });
  assert.equal(await issueOrderLicenses(sql, licenses, order.id, new Date(), gmbh), 'issued');
  const t = new MemoryTransport();
  await sendDueMails(sql, t, mailCtx(), 20);
  const m = t.sent.find((x) => x.to === 'buero@arena.example')!;
  assert.match(m.html, /bought as a business/);
  assert.doesNotMatch(m.html, /FAGG/);
});

test('a business outside the EU pays net, not taxable in Austria', async () => {
  const { order, session, customer } = await buy({
    buyer: 'business',
    company: 'Arena Inc',
    country: 'US',
    postcode: '10001',
    city: 'New York',
    vatId: '123456789',
    quantity: '1',
  });
  assert.equal(order.totalCents, 11583);
  assert.deepEqual(customer.taxId, { type: 'us_ein', value: '12-3456789' });
  assert.equal(customer.taxExempt, 'reverse');
  assert.match(session.input.invoice!.footer, /Nicht in Österreich steuerbar.*§ 3a Abs\. 6 UStG/);
  const [o] = await sql<
    { vat_regime: string }[]
  >`SELECT vat_regime FROM orders WHERE id = ${order.id}`;
  assert.equal(o!.vat_regime, 'export');
});

test('Stripe refuses the tax id: the order is cancelled and the form says which field', async () => {
  const v = validateLicenseCheckout(
    form({
      buyer: 'business',
      company: 'Arena Ltd',
      country: 'GB',
      postcode: 'SW1A 1AA',
      vatId: 'GB123456789',
    }),
  );
  assert.ok(v.ok);
  const c = await checkLicenseBuyer(sql, v.data, { grossCents: 13900, vies: fakeVies });
  assert.ok(c.ok);
  const buyer = { ...c.buyer, taxId: { type: 'gb_vat', value: 'GB-INVALID' } };
  const order = await createLicenseOrder(sql, { locale: 'de', details: v.data, buyer });
  await assert.rejects(
    startLicensePayment(sql, gmbh, order, {
      details: v.data,
      buyer,
      locale: 'de',
      successUrl: 'x',
      cancelUrl: 'y',
    }),
    (e) => e instanceof CustomerRejected && e.field === 'tax_id',
  );
  const [o] = await sql<{ status: string }[]>`SELECT status FROM orders WHERE id = ${order.id}`;
  assert.equal(o!.status, 'cancelled');
  await assert.rejects(
    startLicensePayment(sql, shop, order, {
      details: v.data,
      buyer,
      locale: 'de',
      successUrl: 'x',
      cancelUrl: 'y',
    }),
    /GmbH account/,
  );
  await assert.rejects(
    createLicenseOrder(sql, {
      locale: 'de',
      details: { ...v.data, country: 'CH' },
      buyer: { ...buyer, business: false, country: 'CH' },
    }),
    (e) => e instanceof LicenseCheckoutRejected && e.code === 'country',
  );
});

test('holds: each account closes only its own unpaid orders', async () => {
  const { order } = await buy({ quantity: '1', email: 'late@example.com' });
  await sql`UPDATE orders SET reserved_until = now() - interval '1 hour' WHERE id = ${order.id}`;
  assert.equal(await expireHolds(sql, shop), 0, 'not the shop’s order');
  assert.equal(await expireHolds(sql, gmbh), 1);
  const [o] = await sql<{ status: string }[]>`SELECT status FROM orders WHERE id = ${order.id}`;
  assert.equal(o!.status, 'expired');
});

test('licence e-mail lost: one look-up per address and hour, sent by the GmbH', async () => {
  await requestLicenseResend(sql, 'MISTY@example.com', 'en', new Date('2026-11-09T10:05:00Z'));
  await requestLicenseResend(sql, 'misty@example.com', 'en', new Date('2026-11-09T10:40:00Z'));
  await requestLicenseResend(sql, 'not an address', 'en');
  const jobs = await sql<{ payload: { email: string } }[]>`
    SELECT payload FROM jobs WHERE kind = 'license.resend'`;
  assert.deepEqual(
    jobs.map((j) => j.payload.email),
    ['misty@example.com'],
  );
  assert.equal(await resendLicensesByEmail(sql, licenses, 'brock@example.com', 'en'), 0);
  assert.equal(await resendLicensesByEmail(sql, licenses, 'misty@example.com', 'en'), 2);
  const t = new MemoryTransport();
  await sendDueMails(sql, t, mailCtx(), 20);
  const m = t.sent.find((x) => x.subject === 'Your ScanPM licence (sent again)')!;
  assert.ok(m);
  assert.equal(m.from, 'info@abc-it.at');
  assert.ok(m.html.includes(`/api/app/download/${token}`));
  assert.doesNotMatch(m.html, /FAGG/, 'no purchase details in a resend');
});

test('refund: Stripe credit note of the GmbH, money back, keys revoked', async () => {
  await assert.rejects(
    refundLicenseOrder(sql, shop, { orderId, actor: 'owner@example.com', reason: '' }),
    /anderen Stripe-Konto/,
  );
  const r = await refundLicenseOrder(sql, gmbh, {
    orderId,
    actor: 'owner@example.com',
    reason: 'customer could not install',
  });
  assert.equal(r.amount, 27800);
  assert.match(r.creditNote!, /^TESTGS-/);
  const cn = gmbh.creditNotes.at(-1)!;
  assert.match(cn.invoiceId, /^in_fake_/);
  assert.match(cn.memo, /^Erstattung zur Bestellung PK-/, 'the internal reason stays internal');
  assert.equal(cn.total, 27800);
  const [refund] = await sql<{ stripe_refund_id: string; credit_note_number: string }[]>`
    SELECT stripe_refund_id, credit_note_number FROM refunds WHERE order_id = ${orderId}`;
  assert.match(refund!.stripe_refund_id, /^re_fake_cn_/);
  assert.equal(refund!.credit_note_number, r.creditNote);
  const [docs] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM documents WHERE order_id = ${orderId}`;
  assert.equal(docs!.n, 0, 'no correction document of the shop');

  const job = await claimJob(sql, ['license.revoke']);
  assert.equal(job?.payload.order_id, orderId);
  assert.equal(await revokeOrderLicenses(sql, licenses, orderId, 'refund'), 2);
  const view = await licenseOrderByToken(sql, token);
  assert.equal(view?.status, 'refunded');
  assert.equal(view?.canDownload, false);

  // Stripe reports the refund the credit note made: already known.
  const [pi] = await sql<{ stripe_payment_intent_id: string }[]>`
    SELECT stripe_payment_intent_id FROM orders WHERE id = ${orderId}`;
  assert.equal(
    await recordExternalRefund(sql, pi!.stripe_payment_intent_id, 27800, 'evt_cn_refund'),
    'known',
  );

  const t = new MemoryTransport();
  await sendDueMails(sql, t, mailCtx(), 20);
  const m = t.sent.find((x) => x.subject.startsWith('Erstattung'))!;
  assert.equal(m.from, 'info@abc-it.at');
  assert.match(m.html, /2 × ScanPM-Lizenz/);
  assert.match(m.html, /Rechnungskorrektur findest du im Anhang/);
  assert.deepEqual(
    m.attachments.map((a) => a.name),
    [`Gutschrift-${r.creditNote}.pdf`],
  );
  await assert.rejects(
    refundLicenseOrder(sql, gmbh, { orderId, actor: 'owner@example.com', reason: '' }),
    /nicht erstattet/,
  );
});

test('a full refund in the Stripe dashboard revokes the keys too', async () => {
  const { order, sessionId } = await buy({ quantity: '1', email: 'brock@example.com' }, 'en');
  await handlePaymentEvent(sql, gmbh, gmbh.pay(sessionId));
  const [pi] = await sql<{ stripe_payment_intent_id: string }[]>`
    SELECT stripe_payment_intent_id FROM orders WHERE id = ${order.id}`;
  assert.equal(
    await recordExternalRefund(sql, pi!.stripe_payment_intent_id, 13900, 'evt_test_refund'),
    'recorded',
  );
  const [job] = await sql<{ payload: { order_id: number } }[]>`
    SELECT payload FROM jobs WHERE kind = 'license.revoke' AND dedupe_key = ${`license.revoke:${order.id}`}`;
  assert.equal(job?.payload.order_id, order.id);
  const [o] = await sql<{ status: string }[]>`SELECT status FROM orders WHERE id = ${order.id}`;
  assert.equal(o!.status, 'refunded');
  assert.equal(
    await issueOrderLicenses(sql, licenses, order.id, new Date(), gmbh),
    'skipped',
    'no keys after a refund',
  );
  const [alert] = await sql<{ payload: { text: string } }[]>`
    SELECT payload FROM outbox WHERE dedupe_key LIKE 'stripe_refund:evt_test_refund:%'`;
  assert.match(alert!.payload.text, /Stripe-Dashboard der GmbH eine Gutschrift/);
});

test('an older licence order of the shop keeps the shop’s own invoice', async () => {
  const v = validateLicenseCheckout(form({ quantity: '1', email: 'old@example.com' }));
  assert.ok(v.ok);
  const c = await checkLicenseBuyer(sql, v.data, { grossCents: 13900, vies: fakeVies });
  assert.ok(c.ok);
  const order = await createLicenseOrder(sql, { locale: 'de', details: v.data, buyer: c.buyer });
  await sql`UPDATE orders SET seller = 'shop', vat_regime = 'small_business', vat_cents = 0,
                              vat_rate_bp = 0 WHERE id = ${order.id}`;
  await startPayment(sql, shop, order, {
    email: v.data.email,
    locale: 'de',
    successUrl: 'x',
    cancelUrl: 'y',
  });
  const [row] = await sql<{ stripe_session_id: string }[]>`
    SELECT stripe_session_id FROM orders WHERE id = ${order.id}`;
  assert.equal(await handlePaymentEvent(sql, shop, shop.pay(row!.stripe_session_id)), 'paid');
  assert.equal(await issueOrderLicenses(sql, licenses, order.id), 'issued');
  const [doc] = await sql<{ number: string }[]>`
    SELECT number FROM documents WHERE order_id = ${order.id} AND kind = 'invoice'`;
  assert.match(doc!.number, /^RE-\d{4}-000001$/);
  const t = new MemoryTransport();
  await sendDueMails(sql, t, mailCtx(), 20);
  const m = t.sent.find((x) => x.to === 'old@example.com')!;
  assert.equal(m.from ?? null, null, 'from the shop');
  assert.deepEqual(
    m.attachments.filter((a) => !a.contentId).map((a) => a.name),
    [`Rechnung-${doc!.number}.pdf`, 'AGB-und-Widerrufsbelehrung.pdf'],
  );
  // Its keys sent again: from the shop, which sold them.
  assert.equal(await resendLicensesByEmail(sql, licenses, 'old@example.com', 'de'), 1);
  const t2 = new MemoryTransport();
  await sendDueMails(sql, t2, mailCtx(), 20);
  const again = t2.sent.find((x) => x.to === 'old@example.com')!;
  assert.equal(again.from ?? null, null);
  assert.doesNotMatch(again.html, /Antalyse/);
});

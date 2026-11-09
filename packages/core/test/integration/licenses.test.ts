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
  createLicenseOrder,
  issueOrderLicenses,
  licenseOrderByToken,
  refundLicenseOrder,
  requestLicenseResend,
  resendLicensesByEmail,
  revokeOrderLicenses,
  saveAppSettings,
  validateLicenseCheckout,
  LicenseCheckoutRejected,
} from '../../src/licenses.ts';
import { handlePaymentEvent, recordExternalRefund, startPayment } from '../../src/orders.ts';
import { fakeProvider } from '../../src/payments.ts';
import { graphMessage, sendDueMails, type Mail, type MailTransport } from '../../src/mail.ts';
import { listOrders } from '../../src/fulfilment.ts';

let sql: Sql;
let drop: () => Promise<void>;
let mediaDir: string;
const pay = fakeProvider('http://localhost:3000');
const licenses = memoryLicenseClient();

class MemoryTransport implements MailTransport {
  readonly name = 'memory';
  sent: Mail[] = [];
  async send(m: Mail) {
    this.sent.push(m);
  }
}
const mailCtx = () => ({
  baseUrl: 'https://pokemonkarten.at',
  mediaDir,
  replyTo: 'bestellung@pokemonkarten.at',
  company: {
    name: 'Maximilian Pinter Sammelkartenverkauf',
    street: 'Wienerstraße 1',
    postcode: '2440',
    city: 'Moosbrunn',
    country: 'AT',
  },
  licenses,
});

const form = (over: Record<string, unknown> = {}) => ({
  name: 'Misty Waterflower',
  email: 'Misty@Example.com',
  country: 'de',
  quantity: '2',
  acceptTerms: true,
  immediateDelivery: true,
  ...over,
});

before(async () => {
  ({ sql, drop } = await freshDatabase());
  await syncLegalTexts(sql);
  mediaDir = await mkdtemp(join(tmpdir(), 'pokeshop-media-'));
});
after(async () => drop());

test('the form needs the consent to immediate delivery and an EU country', async () => {
  const ok = validateLicenseCheckout(form());
  assert.ok(ok.ok);
  assert.equal(ok.data.email, 'misty@example.com');
  assert.equal(ok.data.country, 'DE');
  assert.equal(ok.data.quantity, 2);
  const bad = validateLicenseCheckout(form({ immediateDelivery: false, quantity: '6' }));
  assert.ok(!bad.ok);
  assert.equal(bad.errors.immediateDelivery, 'consent');
  assert.equal(bad.errors.quantity, 'too_many');
  await assert.rejects(
    createLicenseOrder(sql, {
      locale: 'de',
      details: { ...ok.data, country: 'CH' },
      priceCents: 8000,
      ossEnabled: false,
      smallBusiness: true,
    }),
    (e) => e instanceof LicenseCheckoutRejected && e.code === 'country',
  );
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
  assert.equal(s.priceCents, 8000);
  assert.equal(s.release?.version, '1.2.30');
  assert.equal((await appSales(sql, false)).open, false, 'no licence service');
  await saveAppSettings(sql, {
    priceCents: 8000,
    playStoreUrl: 'https://play.google.com/store/apps/details?id=io.github.pmaxai.cardscanner',
  });
  assert.match((await appSales(sql, true)).playStoreUrl!, /play\.google\.com/);
  await saveAppSettings(sql, { priceCents: 8000, playStoreUrl: '' });
  assert.equal((await appSales(sql, true)).playStoreUrl, null);
});

let orderId = 0;
let token = '';

test('buying: Stripe page, payment, keys from the licence service, invoice and e-mail', async () => {
  const v = validateLicenseCheckout(form());
  assert.ok(v.ok);
  const order = await createLicenseOrder(sql, {
    locale: 'de',
    details: v.data,
    priceCents: 8000,
    ossEnabled: false,
    smallBusiness: true,
  });
  orderId = order.id;
  token = order.token;
  assert.equal(order.totalCents, 16000);
  const url = await startPayment(sql, pay, order, {
    email: v.data.email,
    locale: 'de',
    successUrl: 'https://pokemonkarten.at/app/lizenz/x',
    cancelUrl: 'https://pokemonkarten.at/app',
  });
  assert.match(url, /\/dev\/zahlung\//);
  const [row] = await sql<{ stripe_session_id: string; vat_regime: string; vat_cents: number }[]>`
    SELECT stripe_session_id, vat_regime, vat_cents FROM orders WHERE id = ${order.id}`;
  assert.equal(row!.vat_regime, 'small_business');
  assert.equal(row!.vat_cents, 0);
  const session = pay.sessions.get(row!.stripe_session_id)!;
  assert.deepEqual(
    session.input.lines.map((l) => [l.name, l.unitAmount, l.quantity]),
    [['ScanPM-Lizenz (Beta)', 8000, 2]],
  );

  const before = await licenseOrderByToken(sql, token);
  assert.equal(before?.canDownload, false, 'not paid yet');

  assert.equal(await handlePaymentEvent(sql, pay, pay.pay(row!.stripe_session_id)), 'paid');
  const [paid] = await sql<{ status: string; kind: string }[]>`
    SELECT status, kind FROM orders WHERE id = ${order.id}`;
  assert.deepEqual(paid, { status: 'paid', kind: 'license' });
  const [stock] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM order_item_allocations a JOIN order_items i ON i.id = a.order_item_id
     WHERE i.order_id = ${order.id}`;
  assert.equal(stock!.n, 0, 'no cards involved');

  // The worker picks up the delivery job.
  const job = await claimJob(sql, ['license.issue']);
  assert.equal(job?.payload.order_id, order.id);
  assert.equal(await issueOrderLicenses(sql, licenses, order.id), 'issued');
  await finishJob(sql, job!.id);
  assert.equal(await issueOrderLicenses(sql, licenses, order.id), 'already', 'safe to repeat');
  assert.equal(licenses.all().length, 2);

  const view = await licenseOrderByToken(sql, token);
  assert.equal(view?.status, 'completed');
  assert.equal(view?.canDownload, true);
  assert.equal(view?.quantity, 2);

  const [doc] = await sql<{ number: string; lines: { de: string; quantity: number }[] }[]>`
    SELECT number, lines FROM documents WHERE order_id = ${order.id} AND kind = 'invoice'`;
  assert.match(doc!.number, /^RE-\d{4}-000001$/);
  assert.equal(doc!.lines[0]!.quantity, 2);
  assert.match(doc!.lines[0]!.de, /ScanPM/);

  const listed = await listOrders(sql, { view: 'licenses' });
  assert.deepEqual(
    listed.rows.map((r) => [r.number, r.kind, r.copies]),
    [[order.number, 'license', 2]],
  );
  assert.equal((await listOrders(sql, { view: 'open' })).total, 0, 'nothing to pack');
});

test('the licence e-mail: keys, QR codes inline, download link, invoice, withdrawal note', async () => {
  const t = new MemoryTransport();
  await sendDueMails(sql, t, mailCtx(), 20);
  const m = t.sent.find((x) => x.to === 'misty@example.com')!;
  assert.ok(m, 'sent to the buyer');
  assert.equal(m.subject, 'Deine 2 ScanPM-Lizenzen');
  for (const l of licenses.all()) assert.ok(m.html.includes(l.key), 'key in the mail');
  assert.ok(m.html.includes(`https://pokemonkarten.at/api/app/download/${token}`));
  assert.match(m.html, /Version 1\.2\.30/);
  assert.match(m.html, /§ 18 Abs\. 1 Z 11 FAGG/);
  const qr = m.attachments.filter((a) => a.contentId);
  assert.equal(qr.length, 2);
  assert.equal(qr[0]!.content.subarray(1, 4).toString(), 'PNG');
  assert.ok(m.html.includes(`cid:${qr[0]!.contentId}`));
  const names = m.attachments.filter((a) => !a.contentId).map((a) => a.name);
  assert.deepEqual(names, [
    `Rechnung-${(await sql`SELECT number FROM documents WHERE order_id = ${orderId}`)[0]!.number}.pdf`,
    'AGB-und-Widerrufsbelehrung.pdf',
  ]);
  const graph = graphMessage(m).message.attachments;
  assert.equal(
    graph.filter((a) => (a as { isInline?: boolean }).isInline).length,
    2,
    'QR codes go out as inline images',
  );
  const shop = t.sent.find((x) => /ScanPM-Lizenz verkauft/.test(x.subject));
  assert.ok(shop, 'the shop hears about the sale');
});

test('licence e-mail lost: one look-up per address and hour, silent for unknown addresses', async () => {
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
  assert.ok(m.html.includes(`/api/app/download/${token}`));
  assert.doesNotMatch(m.html, /FAGG/, 'no purchase details in a resend');
});

test('refund: money back, correction document, keys revoked', async () => {
  const r = await refundLicenseOrder(sql, pay, {
    orderId,
    actor: 'owner@example.com',
    reason: 'customer could not install',
  });
  assert.equal(r.amount, 16000);
  assert.match(r.creditNote!, /^GS-/);
  assert.equal(pay.refunds.at(-1)?.amount, 16000);
  const job = await claimJob(sql, ['license.revoke']);
  assert.equal(job?.payload.order_id, orderId);
  assert.equal(await revokeOrderLicenses(sql, licenses, orderId, 'refund'), 2);
  assert.ok(licenses.all().every((l) => l.revoked_at));
  const view = await licenseOrderByToken(sql, token);
  assert.equal(view?.status, 'refunded');
  assert.equal(view?.canDownload, false);
  const t = new MemoryTransport();
  await sendDueMails(sql, t, mailCtx(), 20);
  const m = t.sent.find((x) => x.subject.startsWith('Erstattung'))!;
  assert.match(m.html, /2 × ScanPM-Lizenz/);
  await assert.rejects(
    refundLicenseOrder(sql, pay, { orderId, actor: 'owner@example.com', reason: '' }),
    /nicht erstattet/,
  );
});

test('a full refund in the Stripe dashboard revokes the keys too', async () => {
  const v = validateLicenseCheckout(form({ quantity: '1', email: 'brock@example.com' }));
  assert.ok(v.ok);
  const order = await createLicenseOrder(sql, {
    locale: 'en',
    details: v.data,
    priceCents: 8000,
    ossEnabled: false,
    smallBusiness: true,
  });
  await startPayment(sql, pay, order, {
    email: v.data.email,
    locale: 'en',
    successUrl: 'https://pokemonkarten.at/en/app/license/x',
    cancelUrl: 'https://pokemonkarten.at/en/app',
  });
  const [row] = await sql<{ stripe_session_id: string }[]>`
    SELECT stripe_session_id FROM orders WHERE id = ${order.id}`;
  await handlePaymentEvent(sql, pay, pay.pay(row!.stripe_session_id));
  const [pi] = await sql<{ stripe_payment_intent_id: string }[]>`
    SELECT stripe_payment_intent_id FROM orders WHERE id = ${order.id}`;
  await recordExternalRefund(sql, pi!.stripe_payment_intent_id, 8000, 'evt_test_refund');
  const [job] = await sql<{ payload: { order_id: number } }[]>`
    SELECT payload FROM jobs WHERE kind = 'license.revoke' AND dedupe_key = ${`license.revoke:${order.id}`}`;
  assert.equal(job?.payload.order_id, order.id);
  const [o] = await sql<{ status: string }[]>`SELECT status FROM orders WHERE id = ${order.id}`;
  assert.equal(o!.status, 'refunded');
  assert.equal(
    await issueOrderLicenses(sql, licenses, order.id),
    'skipped',
    'no keys after a refund',
  );
});

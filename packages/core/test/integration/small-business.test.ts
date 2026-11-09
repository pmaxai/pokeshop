import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import { addToCart, createCart } from '../../src/cart.ts';
import { syncLegalTexts } from '../../src/legal-sync.ts';
import { legalHtml } from '../../src/legal.ts';
import {
  createCheckoutOrder,
  handlePaymentEvent,
  orderById,
  startPayment,
} from '../../src/orders.ts';
import { fakeProvider } from '../../src/payments.ts';
import { documentPdf, sendDueMails, type Mail, type MailTransport } from '../../src/mail.ts';
import { issueInvoice } from '../../src/fulfilment.ts';

let sql: Sql;
let drop: () => Promise<void>;
let mediaDir: string;
let company: Record<string, string | null>;
const pay = fakeProvider('http://localhost:3000');

before(async () => {
  ({ sql, drop } = await freshDatabase());
  await syncLegalTexts(sql);
  mediaDir = await mkdtemp(join(tmpdir(), 'pokeshop-ku-'));
  const [c] = await sql<{ value: Record<string, string | null> }[]>`
    SELECT value FROM settings WHERE key = 'company'`;
  company = c!.value;
});
after(async () => drop());

test('the shop runs as sole trader under the small business scheme', async () => {
  const settings = Object.fromEntries(
    (await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM settings`).map((r) => [
      r.key,
      r.value,
    ]),
  );
  assert.equal(settings.small_business, true);
  assert.equal(settings.high_value_threshold_cents, 5000, 'high value above € 50');
  assert.equal(company.name, 'Maximilian Pinter');
  assert.equal(company.public_name, 'pokemonkarten.at');
  assert.equal(company.trade, 'Handel mit Waren aller Art');
  assert.equal(company.vat_id, '');
  assert.equal(company.register_number, '');
  const [at] = await sql<{ insured_rate_bp: number; insured_minimum_cents: number }[]>`
    SELECT insured_rate_bp, insured_minimum_cents FROM countries WHERE code = 'AT'`;
  assert.deepEqual({ ...at }, { insured_rate_bp: 500, insured_minimum_cents: 500 });
});

test('legal texts name the shop and point to the legal notice, not to the owner', async () => {
  for (const file of ['agb.de.md', 'agb.en.md', 'privacy.de.md', 'withdrawal.de.md']) {
    const md = await readFile(new URL(`../../legal/${file}`, import.meta.url), 'utf8');
    const html = legalHtml(md, { company, baseUrl: 'https://pokemonkarten.at', locale: 'de' });
    assert.ok(!html.includes('Pinter'), `${file} does not name the owner`);
    assert.ok(!html.includes('{{'), `${file} has no unfilled placeholder`);
    assert.match(html, /pokemonkarten\.at, Wienerstraße 1, 2440 Moosbrunn/);
  }
  const agb = await readFile(new URL('../../legal/agb.de.md', import.meta.url), 'utf8');
  const html = legalHtml(agb, { company, baseUrl: 'https://pokemonkarten.at', locale: 'de' });
  assert.match(html, /https:\/\/pokemonkarten\.at\/impressum/);
  assert.match(html, /§ 6 Abs\. 1 Z 27 UStG/);
  assert.match(html, /Bestellung retournieren \(Vertrag widerrufen\)/);
  assert.match(
    html,
    /mehr als 50 €, versenden wir versichert und berechnen dafür 5 % des Warenwerts/,
  );
  assert.match(html, /In andere Länder liefern wir derzeit nur auf Anfrage/);
});

class MemoryTransport implements MailTransport {
  readonly name = 'memory';
  sent: Mail[] = [];
  async send(m: Mail) {
    this.sent.push(m);
  }
}

test('no VAT at checkout, in mails and on the invoice', async () => {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (sku, slug, set_code, set_name_de, set_name_en, card_number, name_de, name_en,
                          card_language, finish, condition, price_cents, status)
    VALUES ('KU-1', 'ku-1', 'sv03.5', '151', '151', '006/165', 'Glurak', 'Charizard', 'DE', 'holo',
            'NM', 6000, 'active')
    RETURNING id`;
  await sql`SELECT stock_change(${p!.id}, '001', 1, 'import', 'test', NULL, 'intake')`;
  const cart = await createCart(sql, 'de');
  await addToCart(sql, cart, p!.id, 1);
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
    smallBusiness: true,
  });
  // € 60 is over € 50: insured, 5 % of € 60 = € 3, at least € 5
  assert.equal(order.totalCents, 6000 + 500);
  await startPayment(sql, pay, order, {
    email: 'ash@example.com',
    locale: 'de',
    successUrl: 'http://localhost:3000/bestellung/x',
    cancelUrl: 'http://localhost:3000/warenkorb',
  });
  const [s] = await sql<{ stripe_session_id: string }[]>`
    SELECT stripe_session_id FROM orders WHERE id = ${order.id}`;
  assert.equal(await handlePaymentEvent(sql, pay, pay.pay(s!.stripe_session_id, 'card')), 'paid');
  const o = await orderById(sql, order.id);
  assert.equal(o!.vatRegime, 'small_business');
  assert.equal(o!.vatCents, 0);
  assert.equal(o!.vatRateBp, 0);

  const ctx = {
    baseUrl: 'https://pokemonkarten.at',
    mediaDir,
    replyTo: 'bestellung@pokemonkarten.at',
    company,
  };
  const t = new MemoryTransport();
  await sendDueMails(sql, t, ctx);
  const confirm = t.sent.find((m) => m.subject.startsWith('Bestellbestätigung'))!;
  assert.match(confirm.html, /Umsatzsteuerbefreit, Kleinunternehmer gemäß § 6 Abs\. 1 Z 27 UStG/);
  assert.doesNotMatch(confirm.html, /USt\. \(/);
  assert.match(confirm.html, /Bestellung retournieren \(Vertrag widerrufen\)/);
  assert.match(
    confirm.html,
    /Maximilian Pinter · Wienerstraße 1, 2440 Moosbrunn<\/p>/,
    'the mail footer identifies the seller (contract confirmation), without register or UID',
  );

  const inv = await sql.begin((tx) => issueInvoice(tx, order.id, new Date('2026-11-07T10:00:00Z')));
  const [doc] = await sql<{ net_cents: number; vat_cents: number; gross_cents: number }[]>`
    SELECT net_cents, vat_cents, gross_cents FROM documents WHERE id = ${inv!.id}`;
  assert.deepEqual({ ...doc }, { net_cents: 6500, vat_cents: 0, gross_cents: 6500 });
  const pdf = await documentPdf(sql, inv!.id, ctx);
  assert.equal(pdf.content.subarray(0, 5).toString(), '%PDF-');
});

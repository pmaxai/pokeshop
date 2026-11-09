// E-mail: templates, attachments and sending through Microsoft Graph as bestellung@ – licence
// mails as Antalyse GmbH from its own address (setting license_seller.email).
// The worker takes due mails from the outbox (outbox.ts) and sends them here.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ConfidentialClientApplication } from '@azure/msal-node';
import QRCode from 'qrcode';
import type { Db, Sql } from './db.ts';
import { cardNames, cardNameText } from './catalog.ts';
import { formatEuro, formatRate } from './money.ts';
import { SMALL_BUSINESS_NOTE, type VatRegime } from './vat.ts';
import { currentLegal, type LegalKind } from './legal.ts';
import type { License, LicenseClient } from './license-client.ts';
import type { PaymentProvider } from './payments.ts';
import { APP_NAME, downloadPath } from './licenses.ts';
import {
  claimMail,
  markMailFailed,
  markMailSent,
  type MailAttachment,
  type OutboxMail,
} from './outbox.ts';
import { orderById, type CustomerOrder } from './orders.ts';
import {
  PAYMENT_METHOD_LABELS,
  renderInvoicePdf,
  renderLegalPdf,
  type InvoiceData,
} from './pdf.ts';

export type Attachment = {
  name: string;
  contentType: string;
  content: Buffer;
  /** Shown inside the mail (<img src="cid:…">) instead of as a file to download. */
  contentId?: string;
};
export type Mail = {
  to: string;
  /** Sender mailbox when it is not the default one (the GmbH's licence mails). */
  from?: string | null;
  replyTo?: string | null;
  subject: string;
  html: string;
  attachments: Attachment[];
};

export interface MailTransport {
  readonly name: string;
  send(mail: Mail): Promise<void>;
}

export type MailContext = {
  baseUrl: string;
  mediaDir: string;
  company: Record<string, string | null | undefined>;
  replyTo: string;
  /** Licence service: the licence mails ask it for the keys (they are not kept in the shop). */
  licenses?: LicenseClient | null;
  /** Antalyse GmbH (setting license_seller): sender, footer and terms of the licence mails. */
  licenseSeller?: Record<string, string | null | undefined> | null;
  /** The GmbH's Stripe account: its invoices and credit notes are attached from there. */
  gmbhPayments?: PaymentProvider | null;
};

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

export type GraphOptions = {
  tenantId: string;
  clientId: string;
  /** PEM file with the private key and the certificate (preferred). */
  certPath?: string;
  clientSecret?: string;
  sender: string;
  fetch?: typeof fetch;
};

/** Builds the sendMail request body (exported for tests). */
export function graphMessage(mail: Mail) {
  return {
    message: {
      subject: mail.subject,
      body: { contentType: 'HTML', content: mail.html },
      toRecipients: [{ emailAddress: { address: mail.to } }],
      ...(mail.replyTo ? { replyTo: [{ emailAddress: { address: mail.replyTo } }] } : {}),
      attachments: mail.attachments.map((a) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.name,
        contentType: a.contentType,
        contentBytes: a.content.toString('base64'),
        ...(a.contentId ? { isInline: true, contentId: a.contentId } : {}),
      })),
    },
    saveToSentItems: true,
  };
}

function certificateCredential(pem: string) {
  const key = /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/.exec(
    pem,
  )?.[0];
  const cert = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem)?.[0];
  if (!key || !cert)
    throw new Error('GRAPH_CLIENT_CERT_PATH must contain the private key and the certificate');
  const x509 = new X509Certificate(cert);
  return {
    privateKey: key,
    thumbprintSha256: createHash('sha256').update(x509.raw).digest('hex'),
    x5c: cert,
  };
}

export function graphTransport(opts: GraphOptions): MailTransport {
  const auth: ConstructorParameters<typeof ConfidentialClientApplication>[0]['auth'] = {
    clientId: opts.clientId,
    authority: `https://login.microsoftonline.com/${opts.tenantId}`,
    ...(opts.certPath
      ? { clientCertificate: certificateCredential(readFileSync(opts.certPath, 'utf8')) }
      : { clientSecret: opts.clientSecret }),
  };
  const app = new ConfidentialClientApplication({ auth });
  const doFetch = opts.fetch ?? fetch;
  return {
    name: 'graph',
    async send(mail) {
      const token = await app.acquireTokenByClientCredential({
        scopes: ['https://graph.microsoft.com/.default'],
      });
      if (!token?.accessToken) throw new Error('no Graph access token');
      // Mail.Send (application) lets the app send as any mailbox of the tenant.
      const sender = mail.from || opts.sender;
      const res = await doFetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(graphMessage(mail)),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (res.status !== 202) {
        throw new Error(`Graph sendMail ${res.status}: ${(await res.text()).slice(0, 500)}`);
      }
    },
  };
}

/** Development: writes each mail as an HTML file (and its attachments) into a folder. */
export function fileTransport(dir: string): MailTransport {
  return {
    name: 'file',
    async send(mail) {
      await mkdir(dir, { recursive: true });
      const base = `${new Date().toISOString().replace(/[:.]/g, '-')}-${mail.to.replace(/[^a-z0-9@.-]/gi, '_')}`;
      // Inline images point at the saved files, so the HTML can be opened in a browser.
      let html = mail.html;
      for (const a of mail.attachments) {
        if (a.contentId) html = html.split(`cid:${a.contentId}`).join(`${base}-${a.name}`);
      }
      await writeFile(
        join(dir, `${base}.html`),
        `<!-- From: ${mail.from ?? 'default'} | To: ${mail.to} | Subject: ${mail.subject} | Attachments: ${mail.attachments.map((a) => a.name).join(', ')} -->\n${html}`,
      );
      for (const a of mail.attachments) await writeFile(join(dir, `${base}-${a.name}`), a.content);
    },
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const C = {
  ink: '#161c33',
  muted: '#586079',
  line: '#dce0e8',
  accent: '#c2470a',
  paper: '#f5f6f8',
};

/**
 * The shop's mails carry its name; the GmbH's licence mails the app's name and the GmbH's
 * details in the footer (pass a context whose company is the GmbH).
 */
function layout(
  locale: 'de' | 'en',
  ctx: MailContext,
  preheader: string,
  body: string,
  brand: 'shop' | 'app' = 'shop',
): string {
  const co = ctx.company;
  const foot = [
    co.name,
    `${co.street ?? ''}, ${co.postcode ?? ''} ${co.city ?? ''}`,
    co.register_number ? `${co.register_number}, ${co.register_court ?? ''}` : '',
    co.vat_id ? `UID ${co.vat_id}` : '',
  ]
    .filter(Boolean)
    .map(esc)
    .join(' · ');
  return `<!doctype html><html lang="${locale === 'de' ? 'de-AT' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${brand === 'app' ? esc(APP_NAME) : 'pokemonkarten.at'}</title></head>
<body style="margin:0;padding:0;background:${C.paper};color:${C.ink};font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5">
<span style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${C.line};border-radius:6px">
<tr><td style="padding:22px 28px 8px;font-size:20px;font-weight:bold;letter-spacing:-0.01em">${brand === 'app' ? `${esc(APP_NAME)}<span style="color:${C.muted};font-size:13px;font-weight:normal;letter-spacing:0"> · ${esc(co.name ?? '')}</span>` : `pokemonkarten<span style="color:${C.accent}">.at</span>`}</td></tr>
<tr><td style="padding:8px 28px 28px">${body}</td></tr></table>
<p style="max-width:600px;margin:16px auto 0;color:${C.muted};font-size:12px;line-height:1.5">${foot}</p>
</td></tr></table></body></html>`;
}

const p = (html: string) => `<p style="margin:0 0 14px">${html}</p>`;
const h2 = (text: string) => `<h2 style="margin:22px 0 8px;font-size:16px">${esc(text)}</h2>`;
const button = (href: string, label: string) =>
  `<p style="margin:18px 0"><a href="${esc(href)}" style="display:inline-block;background:#ef5b0c;color:#ffffff;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:6px">${esc(label)}</a></p>`;

const dateTime = (d: Date, locale: 'de' | 'en', seconds = false) =>
  new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
    dateStyle: 'long',
    timeStyle: seconds ? 'medium' : 'short',
    timeZone: 'Europe/Vienna',
  }).format(d);

function address(a: CustomerOrder['shippingAddress'] | null, locale: 'de' | 'en'): string {
  if (!a) return '';
  const country =
    new Intl.DisplayNames([locale === 'de' ? 'de-AT' : 'en'], { type: 'region' }).of(a.country) ??
    a.country;
  return [a.company, a.name, a.street, `${a.postcode} ${a.city}`, country]
    .filter(Boolean)
    .map(esc)
    .join('<br>');
}

function itemsTable(o: CustomerOrder, locale: 'de' | 'en', boxes?: Map<number, string>): string {
  const rows = o.items
    .map((i) => {
      const names = cardNames(i, locale);
      const set = locale === 'en' ? (i.setNameEn ?? i.setNameDe) : (i.setNameDe ?? i.setNameEn);
      const box = boxes?.get(i.productId);
      return `<tr><td style="padding:8px 0;border-bottom:1px solid ${C.line};vertical-align:top">
<strong lang="${names.lang}">${esc(names.original)}</strong> <span style="color:${C.muted}">${esc(i.cardNumber)}</span><br>
${names.translations.length ? `<span style="color:${C.muted};font-size:13px">${names.translations.map((t) => `<span lang="${t.lang}">${esc(t.text)}</span> (${t.lang.toUpperCase()})`).join(' · ')}</span><br>` : ''}<span style="color:${C.muted};font-size:13px">${esc([set, i.cardLanguage, i.condition].filter(Boolean).join(' · '))}${box ? ` · Box ${esc(box)}` : ''}</span></td>
<td style="padding:8px 0 8px 12px;border-bottom:1px solid ${C.line};text-align:right;vertical-align:top;white-space:nowrap">${i.quantity} × ${esc(formatEuro(i.unitPriceCents, locale))}</td></tr>`;
    })
    .join('');
  const t = TEXT[locale];
  const line = (label: string, value: string, bold = false) =>
    `<tr><td style="padding:6px 0;${bold ? 'font-weight:bold' : ''}">${esc(label)}</td><td style="padding:6px 0 6px 12px;text-align:right;white-space:nowrap;${bold ? 'font-weight:bold' : ''}">${esc(value)}</td></tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">${rows}
${line(t.goods, formatEuro(o.goodsCents, locale))}
${line(t.shippingLabel(o.shippingMethod), o.shippingCents ? formatEuro(o.shippingCents, locale) : t.free)}
${line(t.total, formatEuro(o.totalCents, locale), true)}
<tr><td colspan="2" style="color:${C.muted};font-size:13px">${esc(o.vatRegime === 'small_business' ? SMALL_BUSINESS_NOTE[locale] : t.vatIncluded(formatRate(o.vatRateBp, locale), formatEuro(o.vatCents, locale)))}</td></tr></table>`;
}

const TEXT = {
  de: {
    hello: (n: string) => `Hallo ${n},`,
    goods: 'Warenwert',
    total: 'Gesamt',
    free: 'kostenlos',
    shippingLabel: (m: string) =>
      m === 'insured'
        ? 'Versicherter Versand'
        : m === 'tracked'
          ? 'Versand mit Sendungsverfolgung'
          : 'Versand',
    vatIncluded: (rate: string, amount: string) => `inkl. ${rate} USt. (${amount})`,
    confirmSubject: (n: string) => `Bestellbestätigung ${n}`,
    confirmIntro:
      'danke für deine Bestellung! Deine Zahlung ist angekommen. Wir packen deine Karten sorgfältig ein und schicken sie mit der Österreichischen Post. Sobald das Paket unterwegs ist, bekommst du eine E-Mail mit der Rechnung.',
    orderFacts: (n: string, d: string) => `Bestellnummer <strong>${esc(n)}</strong> vom ${esc(d)}`,
    yourOrder: 'Deine Bestellung',
    deliverTo: 'Lieferadresse',
    viewOrder: 'Bestellung ansehen',
    withdrawalTitle: 'Widerrufsrecht',
    withdrawal: (url: string) =>
      `Du kannst den Vertrag innerhalb von 14 Tagen ab Erhalt der Karten ohne Angabe von Gründen widerrufen, auch online unter <a href="${esc(url)}" style="color:${C.accent}">Bestellung retournieren (Vertrag widerrufen)</a>. Unsere AGB und die Widerrufsbelehrung mit dem Muster-Widerrufsformular findest du im Anhang.`,
    questions: 'Fragen zu deiner Bestellung? Antworte einfach auf diese E-Mail.',
    unavailableSubject: (n: string) => `Deine Bestellung ${n}: Karten leider vergriffen`,
    unavailable: (amount: string) =>
      `deine Zahlung ist erst angekommen, nachdem die Reservierung deiner Karten abgelaufen war – und in der Zwischenzeit hat jemand anderer sie gekauft. Es tut uns leid! Wir haben dir den vollen Betrag von <strong>${esc(amount)}</strong> auf dein Zahlungsmittel zurückerstattet. Je nach Bank dauert die Gutschrift einige Tage.`,
    ackSubject: 'Eingangsbestätigung deines Widerrufs',
    ackIntro: (at: string) =>
      `wir haben deinen Widerruf am <strong>${esc(at)}</strong> erhalten. Das hast du uns geschickt:`,
    ackNext:
      'Wir melden uns mit den nächsten Schritten. Bitte schick die Karten innerhalb von 14 Tagen an unsere Adresse zurück; den Kaufpreis erstatten wir, sobald die Karten bei uns sind oder du uns die Rücksendung nachweist.',
    fields: {
      name: 'Name',
      email: 'E-Mail',
      order_number: 'Bestellnummer',
      order_date: 'Bestellt am',
      items: 'Widerrufene Karten',
      message: 'Nachricht',
    } as Record<string, string>,
    all: 'alle',
    legalPdf: 'AGB-und-Widerrufsbelehrung.pdf',
    licenseTermsPdf: 'Lizenzbedingungen.pdf',
    stripeCreditPdf: (n: string) => `Gutschrift-${n}.pdf`,
    invoicePdf: (n: string) => `Rechnung-${n}.pdf`,
    creditPdf: (n: string) => `Rechnungskorrektur-${n}.pdf`,
    shippedSubject: (n: string) => `Deine Karten sind unterwegs (${n})`,
    shippedIntro:
      'deine Karten sind gut verpackt und auf dem Weg zu dir. Die Rechnung findest du im Anhang.',
    tracking: (num: string) => `Sendungsnummer: <strong>${esc(num)}</strong>`,
    track: 'Sendung verfolgen',
    refundSubject: (n: string) => `Erstattung zu deiner Bestellung ${n}`,
    refundIntro: (amount: string) =>
      `wir haben dir <strong>${esc(amount)}</strong> auf dein Zahlungsmittel zurückerstattet. Je nach Bank dauert die Gutschrift einige Tage.`,
    refundCredit: 'Die Rechnungskorrektur findest du im Anhang.',
    refundedItems: 'Erstattet',
  },
  en: {
    hello: (n: string) => `Hello ${n},`,
    goods: 'Goods',
    total: 'Total',
    free: 'free',
    shippingLabel: (m: string) =>
      m === 'insured' ? 'Insured shipping' : m === 'tracked' ? 'Tracked shipping' : 'Shipping',
    vatIncluded: (rate: string, amount: string) => `incl. ${rate} VAT (${amount})`,
    confirmSubject: (n: string) => `Order confirmation ${n}`,
    confirmIntro:
      'thank you for your order! Your payment has arrived. We will pack your cards carefully and send them with Austrian Post. As soon as the parcel is on its way you will receive an e-mail with the invoice.',
    orderFacts: (n: string, d: string) => `Order number <strong>${esc(n)}</strong> of ${esc(d)}`,
    yourOrder: 'Your order',
    deliverTo: 'Delivery address',
    viewOrder: 'View order',
    withdrawalTitle: 'Right of withdrawal',
    withdrawal: (url: string) =>
      `You may withdraw from the contract within 14 days of receiving the cards without giving any reason, also online at <a href="${esc(url)}" style="color:${C.accent}">Return an order (withdraw from contract)</a>. Our terms and the withdrawal instructions with the model withdrawal form are attached.`,
    questions: 'Questions about your order? Just reply to this e-mail.',
    unavailableSubject: (n: string) => `Your order ${n}: cards sold out`,
    unavailable: (amount: string) =>
      `your payment arrived only after the reservation of your cards had run out – and in the meantime someone else bought them. We are sorry! We have refunded the full amount of <strong>${esc(amount)}</strong> to your payment method. Depending on your bank it may take a few days to show.`,
    ackSubject: 'Acknowledgement of your withdrawal',
    ackIntro: (at: string) =>
      `we received your withdrawal on <strong>${esc(at)}</strong>. This is what you sent us:`,
    ackNext:
      'We will be in touch with the next steps. Please send the cards back to our address within 14 days; we refund the price once the cards are back with us or you show us proof of return.',
    fields: {
      name: 'Name',
      email: 'E-mail',
      order_number: 'Order number',
      order_date: 'Ordered on',
      items: 'Cards withdrawn',
      message: 'Message',
    } as Record<string, string>,
    all: 'all',
    legalPdf: 'Terms-and-withdrawal.pdf',
    licenseTermsPdf: 'Licence-terms.pdf',
    stripeCreditPdf: (n: string) => `Credit-note-${n}.pdf`,
    invoicePdf: (n: string) => `Invoice-${n}.pdf`,
    creditPdf: (n: string) => `Credit-note-${n}.pdf`,
    shippedSubject: (n: string) => `Your cards are on their way (${n})`,
    shippedIntro: 'your cards are packed safely and on their way to you. The invoice is attached.',
    tracking: (num: string) => `Tracking number: <strong>${esc(num)}</strong>`,
    track: 'Track parcel',
    refundSubject: (n: string) => `Refund for your order ${n}`,
    refundIntro: (amount: string) =>
      `we have refunded <strong>${esc(amount)}</strong> to your payment method. Depending on your bank it may take a few days to show.`,
    refundCredit: 'The credit note is attached.',
    refundedItems: 'Refunded',
  },
};

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

async function orderToken(db: Db, id: number): Promise<string | null> {
  const [r] = await db<
    { lookup_token: string }[]
  >`SELECT lookup_token FROM orders WHERE id = ${id}`;
  return r?.lookup_token ?? null;
}

const orderUrl = (ctx: MailContext, locale: 'de' | 'en', token: string) =>
  `${ctx.baseUrl}${locale === 'de' ? '/bestellung' : '/en/order'}/${token}`;
const withdrawUrl = (ctx: MailContext, locale: 'de' | 'en') =>
  `${ctx.baseUrl}${locale === 'de' ? '/vertrag-widerrufen' : '/en/withdraw'}`;

type Rendered = {
  subject: string;
  html: string;
  inline?: Attachment[];
  /** Licence mails of the GmbH: its own sender and reply address. */
  from?: string | null;
  replyTo?: string | null;
};

/** Context for a mail the GmbH sends: its details in the footer and the legal PDFs. */
function gmbhContext(ctx: MailContext): MailContext & { sender: string | null } {
  const seller = ctx.licenseSeller;
  if (!seller?.name) throw new Error('setting license_seller is missing – run migrate');
  return { ...ctx, company: seller, sender: seller.email || null };
}

async function orderSeller(db: Db, orderId: number): Promise<'shop' | 'gmbh'> {
  const [o] = await db<
    { seller: 'shop' | 'gmbh' }[]
  >`SELECT seller FROM orders WHERE id = ${orderId}`;
  return o?.seller ?? 'shop';
}

export async function renderTemplate(
  db: Db,
  mail: OutboxMail,
  ctx: MailContext,
): Promise<Rendered> {
  const L = mail.locale;
  const t = TEXT[L];
  const payload = mail.payload as Record<string, unknown>;
  switch (mail.template) {
    case 'order_confirmation': {
      const o = await orderById(db, Number(payload.order_id));
      if (!o) throw new Error('order not found');
      const token = await orderToken(db, o.id);
      const body = [
        p(esc(t.hello(o.shippingAddress.name))),
        p(t.confirmIntro),
        p(t.orderFacts(o.number, dateTime(o.paidAt ?? o.createdAt, L))),
        h2(t.yourOrder),
        itemsTable(o, L),
        h2(t.deliverTo),
        p(address(o.shippingAddress, L)),
        token ? button(orderUrl(ctx, L, token), t.viewOrder) : '',
        h2(t.withdrawalTitle),
        p(t.withdrawal(withdrawUrl(ctx, L))),
        p(esc(t.questions)),
      ].join('\n');
      return {
        subject: t.confirmSubject(o.number),
        html: layout(L, ctx, t.confirmSubject(o.number), body),
      };
    }
    case 'order_shipped': {
      const o = await orderById(db, Number(payload.order_id));
      if (!o) throw new Error('order not found');
      const token = await orderToken(db, o.id);
      const [c] = await db<{ value: { tracking_url?: string } }[]>`
        SELECT value FROM settings WHERE key = 'carrier'`;
      const trackUrl =
        o.trackingNumber && c?.value?.tracking_url
          ? c.value.tracking_url.replace('{number}', encodeURIComponent(o.trackingNumber))
          : null;
      const body = [
        p(esc(t.hello(o.shippingAddress.name))),
        p(t.shippedIntro),
        o.trackingNumber ? p(t.tracking(o.trackingNumber)) : '',
        trackUrl ? button(trackUrl, t.track) : '',
        h2(t.yourOrder),
        itemsTable(o, L),
        h2(t.deliverTo),
        p(address(o.shippingAddress, L)),
        token
          ? p(
              `<a href="${esc(orderUrl(ctx, L, token))}" style="color:${C.accent}">${esc(t.viewOrder)}</a>`,
            )
          : '',
        h2(t.withdrawalTitle),
        p(t.withdrawal(withdrawUrl(ctx, L))),
        p(esc(t.questions)),
      ].join('\n');
      return {
        subject: t.shippedSubject(o.number),
        html: layout(L, ctx, t.shippedSubject(o.number), body),
      };
    }
    case 'refund_issued': {
      const o = await orderById(db, Number(payload.order_id));
      if (!o) throw new Error('order not found');
      const [r] = await db<
        {
          amount_cents: number;
          shipping_cents: number;
          items: { orderItemId: number; quantity: number }[];
        }[]
      >`
        SELECT amount_cents, shipping_cents, items FROM refunds WHERE id = ${Number(payload.refund_id)}`;
      if (!r) throw new Error('refund not found');
      const [credit] = await db`
        SELECT 1 FROM documents WHERE refund_id = ${Number(payload.refund_id)}
        UNION ALL
        SELECT 1 FROM refunds WHERE id = ${Number(payload.refund_id)} AND stripe_credit_note_id IS NOT NULL`;
      const gmbh = (await orderSeller(db, o.id)) === 'gmbh' ? gmbhContext(ctx) : null;
      const [ids] = await db<{ ids: number[] }[]>`
        SELECT array_agg(id ORDER BY id) AS ids FROM order_items WHERE order_id = ${o.id}`;
      const rows = r.items
        .map((w) => {
          const idx = (ids?.ids ?? []).indexOf(w.orderItemId);
          const i = o.items[idx];
          if (!i) return '';
          return `<li>${w.quantity} × ${esc(cardNameText(cardNames(i, L)))} ${esc(i.cardNumber)}</li>`;
        })
        .join('');
      const shippingRow =
        r.shipping_cents > 0 ? `<li>${esc(t.shippingLabel(o.shippingMethod))}</li>` : '';
      const [lic] = await db<{ quantity: number }[]>`
        SELECT quantity FROM order_licenses WHERE order_id = ${o.id}`;
      const licenseRow = lic
        ? `<li>${lic.quantity} × ${esc(L === 'de' ? `${APP_NAME}-Lizenz (der Schlüssel ist damit gesperrt)` : `${APP_NAME} licence (the key no longer works)`)}</li>`
        : '';
      const body = [
        p(esc(t.hello((o.shippingAddress ?? o.billingAddress)?.name ?? ''))),
        p(t.refundIntro(formatEuro(r.amount_cents, L))),
        rows || shippingRow || licenseRow
          ? `${h2(t.refundedItems)}<ul style="margin:0 0 14px;padding-left:20px">${rows}${shippingRow}${licenseRow}</ul>`
          : '',
        credit ? p(esc(t.refundCredit)) : '',
        p(esc(t.questions)),
      ].join('\n');
      if (gmbh) {
        return {
          subject: t.refundSubject(o.number),
          html: layout(L, gmbh, t.refundSubject(o.number), body, 'app'),
          from: gmbh.sender,
          replyTo: gmbh.sender,
        };
      }
      return {
        subject: t.refundSubject(o.number),
        html: layout(L, ctx, t.refundSubject(o.number), body),
      };
    }
    case 'order_unavailable': {
      const o = await orderById(db, Number(payload.order_id));
      if (!o) throw new Error('order not found');
      const amount = formatEuro(Number(payload.amount_cents ?? o.totalCents), L);
      const body = [
        p(esc(t.hello(o.shippingAddress.name))),
        p(t.unavailable(amount)),
        itemsTable(o, L),
        p(esc(t.questions)),
      ].join('\n');
      return {
        subject: t.unavailableSubject(o.number),
        html: layout(L, ctx, t.unavailableSubject(o.number), body),
      };
    }
    case 'order_notification': {
      const o = await orderById(db, Number(payload.order_id));
      if (!o) throw new Error('order not found');
      const boxes = await db<{ product_id: number; boxes: string }[]>`
        SELECT i.product_id, string_agg(a.storage_location || CASE WHEN a.quantity > 1 THEN ' (' || a.quantity || '×)' ELSE '' END, ', ' ORDER BY a.storage_location) AS boxes
          FROM order_items i JOIN order_item_allocations a ON a.order_item_id = i.id AND a.status = 'committed'
         WHERE i.order_id = ${o.id} GROUP BY i.product_id`;
      const [m] = await db<
        { payment_method_type: string | null }[]
      >`SELECT payment_method_type FROM orders WHERE id = ${o.id}`;
      const method = m?.payment_method_type
        ? (PAYMENT_METHOD_LABELS[m.payment_method_type]?.de ?? m.payment_method_type)
        : 'Stripe';
      const shipping =
        o.shippingMethod === 'insured'
          ? '<strong>VERSICHERT verschicken</strong>'
          : o.shippingMethod === 'tracked'
            ? '<strong>Mit Sendungsverfolgung</strong> verschicken (über 500 €, ohne Versicherung)'
            : 'Standardversand';
      const body = [
        p(
          `Neue Bestellung <strong>${esc(o.number)}</strong> über <strong>${esc(formatEuro(o.totalCents, 'de'))}</strong>, bezahlt mit ${esc(method)}.`,
        ),
        p(shipping),
        itemsTable(o, 'de', new Map(boxes.map((b) => [b.product_id, b.boxes]))),
        h2('Lieferadresse'),
        p(address(o.shippingAddress, 'de')),
        p(`E-Mail: ${esc(o.email)}`),
        button(`${ctx.baseUrl}/admin`, 'Zum Admin'),
      ].join('\n');
      const subject = `Neue Bestellung ${o.number} – ${formatEuro(o.totalCents, 'de')}${o.shippingMethod === 'insured' ? ' – versichert' : ''}`;
      return { subject, html: layout('de', ctx, subject, body) };
    }
    case 'withdrawal_ack':
    case 'withdrawal_notification': {
      const [w] = await db<
        {
          id: number;
          name: string;
          email: string;
          order_number: string | null;
          order_date: string | null;
          items: string | null;
          message: string | null;
          received_at: Date;
        }[]
      >`SELECT id, name, email, order_number, order_date, items, message, received_at FROM withdrawals WHERE id = ${Number(payload.withdrawal_id)}`;
      if (!w) throw new Error('withdrawal not found');
      const lang = mail.template === 'withdrawal_ack' ? L : 'de';
      const tt = TEXT[lang];
      const rows = (['name', 'email', 'order_number', 'order_date', 'items', 'message'] as const)
        .map((k) => [k, k === 'items' ? w.items || tt.all : w[k]] as const)
        .filter(([, v]) => v)
        .map(
          ([k, v]) =>
            `<tr><td style="padding:4px 12px 4px 0;color:${C.muted};vertical-align:top">${esc(tt.fields[k])}</td><td style="padding:4px 0;white-space:pre-wrap">${esc(v)}</td></tr>`,
        )
        .join('');
      const at = dateTime(w.received_at, lang, true);
      if (mail.template === 'withdrawal_ack') {
        const body = [
          p(esc(tt.hello(w.name))),
          p(tt.ackIntro(at)),
          `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 16px">${rows}</table>`,
          p(esc(tt.ackNext)),
          p(esc(tt.questions)),
        ].join('\n');
        return { subject: tt.ackSubject, html: layout(lang, ctx, tt.ackSubject, body) };
      }
      const subject = `Widerruf eingegangen${w.order_number ? `: ${w.order_number}` : ''}`;
      const body = [
        p(
          `Eingang: <strong>${esc(at)}</strong>. Die Eingangsbestätigung an den Kunden ist unterwegs.`,
        ),
        `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px">${rows}</table>`,
      ].join('\n');
      return { subject, html: layout('de', ctx, subject, body) };
    }
    case 'admin_alert': {
      const subject = `[pokemonkarten.at] ${String(payload.subject ?? 'Hinweis')}`;
      return { subject, html: layout('de', ctx, subject, p(esc(payload.text ?? ''))) };
    }
    case 'license_delivery':
    case 'license_resend':
      return renderLicenseMail(db, mail, ctx);
  }
}

// ---------------------------------------------------------------------------
// App licences
// ---------------------------------------------------------------------------

const LICENSE_TEXT = {
  de: {
    subject: `Deine ${APP_NAME}-Lizenz`,
    subjectMany: (n: number) => `Deine ${n} ${APP_NAME}-Lizenzen`,
    subjectAgain: `Deine ${APP_NAME}-Lizenz (erneut gesendet)`,
    intro: (n: number) =>
      n === 1
        ? `danke für deinen Kauf! Hier ist dein Lizenzschlüssel für ${APP_NAME}.`
        : `danke für deinen Kauf! Hier sind deine ${n} Lizenzschlüssel für ${APP_NAME}. Jede Lizenz ist auf einem Gerät aktiv.`,
    introAgain: `du hast deine Lizenz neu angefordert. Hier sind die Lizenzschlüssel zu deiner E-Mail-Adresse.`,
    introResent: `hier ist deine Lizenz-E-Mail noch einmal.`,
    licence: (i: number, n: number) => (n === 1 ? 'Lizenzschlüssel' : `Lizenz ${i} von ${n}`),
    activeOn: (device: string) => `Derzeit aktiv auf: ${device}`,
    howTitle: "So geht's",
    stepDownload:
      'App herunterladen und öffnen. Android fragt einmal, ob dein Browser Apps installieren darf: erlauben.',
    stepStore: 'App aus dem Google Play Store installieren.',
    downloadButton: (v: string | null) =>
      v ? `${APP_NAME} herunterladen (Version ${v})` : `${APP_NAME} herunterladen`,
    storeButton: `${APP_NAME} im Play Store`,
    stepStart: `${APP_NAME} starten und die Kamera erlauben. Beim ersten Start entpackt die App ihre Kartendatenbank, das dauert ein paar Sekunden.`,
    stepActivate:
      'Den QR-Code oben scannen oder den Schlüssel eintippen (Groß- und Kleinschreibung, Leerzeichen und Bindestriche sind egal). Für die Aktivierung braucht die App einmal Internet.',
    goodTitle: 'Gut zu wissen',
    good: [
      'Eine Lizenz ist auf einem Gerät gleichzeitig aktiv. Für ein neues Handy öffnest du in der App ⚙ → Licence → „Show the licence QR code“ und scannst ihn mit dem neuen Gerät. Das alte hört dann auf.',
      'Updates sind in der Lizenz enthalten, solange wir die App anbieten. Die App meldet neue Versionen selbst (Leiste oben → Update), mit frischen Preisen.',
      `${APP_NAME} ist in der Beta: Die Erkennung ist nicht perfekt und Preise können fehlen oder abweichen. Prüf wertvolle Karten vor dem Kauf.`,
      'Heb diese E-Mail auf. Auf der App-Seite im Shop kannst du sie jederzeit neu anfordern.',
    ],
    facts: (n: string, total: string) => `Bestellnummer <strong>${esc(n)}</strong> · ${esc(total)}`,
    invoice: 'Die Rechnung findest du im Anhang.',
    seller: (name: string) =>
      `Verkäufer und dein Vertragspartner für die Lizenz ist die ${esc(name)}. Die Rechnung der ${esc(name)} findest du im Anhang.`,
    withdrawalTitle: 'Widerrufsrecht',
    withdrawal: (at: string) =>
      `Du hast beim Kauf am ${esc(at)} ausdrücklich verlangt, dass wir vor Ablauf der Widerrufsfrist liefern, und bestätigt, dass dein Widerrufsrecht damit erlischt (§ 18 Abs. 1 Z 11 FAGG). Mit dieser E-Mail ist die Lizenz geliefert. Unsere AGB und die Widerrufsbelehrung liegen als PDF bei.`,
    withdrawalGmbh: (at: string) =>
      `Du hast beim Kauf am ${esc(at)} ausdrücklich verlangt, dass wir vor Ablauf der Widerrufsfrist liefern, und bestätigt, dass dein Widerrufsrecht damit erlischt (§ 18 Abs. 1 Z 11 FAGG). Mit dieser E-Mail ist die Lizenz geliefert. Die Lizenzbedingungen mit der Widerrufsbelehrung liegen als PDF bei.`,
    withdrawalBusiness:
      'Du hast als Unternehmen gekauft: Das Widerrufsrecht für Verbraucher gilt dafür nicht. Die Lizenzbedingungen liegen als PDF bei.',
    questions: 'Fragen oder Probleme? Antworte einfach auf diese E-Mail.',
    qrAlt: 'QR-Code der Lizenz',
  },
  en: {
    subject: `Your ${APP_NAME} licence`,
    subjectMany: (n: number) => `Your ${n} ${APP_NAME} licences`,
    subjectAgain: `Your ${APP_NAME} licence (sent again)`,
    intro: (n: number) =>
      n === 1
        ? `thank you for your purchase! Here is your licence key for ${APP_NAME}.`
        : `thank you for your purchase! Here are your ${n} licence keys for ${APP_NAME}. Each licence is active on one device.`,
    introAgain: `you asked for your licence again. Here are the licence keys for your e-mail address.`,
    introResent: `here is your licence e-mail once more.`,
    licence: (i: number, n: number) => (n === 1 ? 'Licence key' : `Licence ${i} of ${n}`),
    activeOn: (device: string) => `Currently active on: ${device}`,
    howTitle: 'How it works',
    stepDownload:
      'Download the app and open the file. Android asks once whether your browser may install apps: allow it.',
    stepStore: 'Install the app from the Google Play Store.',
    downloadButton: (v: string | null) =>
      v ? `Download ${APP_NAME} (version ${v})` : `Download ${APP_NAME}`,
    storeButton: `${APP_NAME} on Google Play`,
    stepStart: `Start ${APP_NAME} and allow the camera. On the first start the app unpacks its card database, which takes a few seconds.`,
    stepActivate:
      'Scan the QR code above or type the key (case, spaces and dashes don’t matter). Activating needs the internet once.',
    goodTitle: 'Good to know',
    good: [
      'A licence is active on one device at a time. For a new phone, open ⚙ → Licence → “Show the licence QR code” in the app and scan it with the new device. The old one then stops.',
      'Updates are included for as long as we offer the app. The app announces new versions itself (bar at the top → Update), with fresh prices.',
      `${APP_NAME} is in beta: recognition isn’t perfect and prices can be missing or off. Check valuable cards before you buy.`,
      'Keep this e-mail. You can ask for it again any time on the app page in the shop.',
    ],
    facts: (n: string, total: string) => `Order number <strong>${esc(n)}</strong> · ${esc(total)}`,
    invoice: 'The invoice is attached.',
    seller: (name: string) =>
      `The licence is sold by ${esc(name)}, your contract partner for it. The invoice from ${esc(name)} is attached.`,
    withdrawalTitle: 'Right of withdrawal',
    withdrawal: (at: string) =>
      `When you bought on ${esc(at)} you expressly asked us to deliver before the withdrawal period ends and confirmed that your right of withdrawal ends with it (§ 18 (1) 11 FAGG). With this e-mail the licence is delivered. Our terms and the withdrawal information are attached as a PDF.`,
    withdrawalGmbh: (at: string) =>
      `When you bought on ${esc(at)} you expressly asked us to deliver before the withdrawal period ends and confirmed that your right of withdrawal ends with it (§ 18 (1) 11 FAGG). With this e-mail the licence is delivered. The licence terms with the withdrawal information are attached as a PDF.`,
    withdrawalBusiness:
      'You bought as a business: the consumer right of withdrawal does not apply. The licence terms are attached as a PDF.',
    questions: 'Questions or problems? Just reply to this e-mail.',
    qrAlt: 'Licence QR code',
  },
};

async function appDownload(
  db: Db,
): Promise<{ playStoreUrl: string | null; version: string | null }> {
  const [s] = await db<{ value: unknown }[]>`
    SELECT value FROM settings WHERE key = 'app_play_store_url'`;
  const [r] = await db<{ version: string }[]>`
    SELECT version FROM app_releases ORDER BY created_at DESC, id DESC LIMIT 1`;
  return {
    playStoreUrl: typeof s?.value === 'string' && s.value.startsWith('https://') ? s.value : null,
    version: r?.version ?? null,
  };
}

async function renderLicenseMail(db: Db, mail: OutboxMail, ctx: MailContext): Promise<Rendered> {
  const L = mail.locale;
  const t = LICENSE_TEXT[L];
  const payload = mail.payload as Record<string, unknown>;
  if (!ctx.licenses) throw new Error('licence service not configured (LICENSE_SERVICE_URL)');

  let ids: string[];
  type OrderFacts = {
    id: number;
    number: string;
    seller: 'shop' | 'gmbh';
    business: boolean;
    customer_name: string | null;
    lookup_token: string;
    total_cents: number;
    consent: Date;
  };
  let order: OrderFacts | null = null;
  if (mail.template === 'license_delivery') {
    const [o] = await db<(OrderFacts & { license_ids: string[] })[]>`
      SELECT o.id, o.number, o.seller, o.buyer_business AS business, o.customer_name,
             o.lookup_token, o.total_cents, l.immediate_delivery_consent_at AS consent,
             l.license_ids
        FROM orders o JOIN order_licenses l ON l.order_id = o.id
       WHERE o.id = ${Number(payload.order_id)}`;
    if (!o) throw new Error('licence order not found');
    order = o;
    ids = o.license_ids;
  } else {
    ids = Array.isArray(payload.license_ids) ? payload.license_ids.map(String) : [];
  }
  const licenses: License[] = [];
  for (const id of ids) {
    const l = await ctx.licenses.get(id);
    if (l && !l.revoked_at) licenses.push(l);
  }
  if (!licenses.length) throw new Error('no active licences to send');

  // Download link: the order's own link (its token is the credential).
  const refs = [...new Set(licenses.map((l) => l.order_ref).filter((r): r is string => !!r))];
  const tokens = refs.length
    ? await db<{ number: string; lookup_token: string }[]>`
        SELECT o.number, o.lookup_token FROM orders o JOIN order_licenses l ON l.order_id = o.id
         WHERE o.number = ANY(${refs}::text[]) AND o.status IN ('paid', 'completed')
           AND l.revoked_at IS NULL
         ORDER BY o.paid_at DESC`
    : [];
  const token = order?.lookup_token ?? tokens[0]?.lookup_token ?? null;
  const app = await appDownload(db);
  // Licences are the GmbH's: its sender and footer (older shop orders keep the shop's).
  const gmbh = (order ? order.seller === 'gmbh' : !!ctx.licenseSeller?.name)
    ? gmbhContext(ctx)
    : null;

  const inline: Attachment[] = [];
  const boxes: string[] = [];
  for (const [i, l] of licenses.entries()) {
    const png = await QRCode.toBuffer(l.qr, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
      color: { dark: '#161c33', light: '#ffffff' },
    });
    const cid = `licence-qr-${i + 1}`;
    inline.push({ name: `${cid}.png`, contentType: 'image/png', content: png, contentId: cid });
    boxes.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:6px;margin:0 0 14px"><tr>
<td style="padding:14px 16px;vertical-align:middle">
<div style="color:${C.muted};font-size:13px;margin-bottom:4px">${esc(t.licence(i + 1, licenses.length))}</div>
<div style="font-family:'Courier New',Courier,monospace;font-size:18px;font-weight:bold;letter-spacing:0.04em;word-break:break-all">${esc(l.key)}</div>
${l.active_device?.name ? `<div style="color:${C.muted};font-size:13px;margin-top:6px">${esc(t.activeOn(l.active_device.name))}</div>` : ''}
</td>
<td width="140" style="padding:10px;vertical-align:middle;text-align:right"><img src="cid:${cid}" width="130" height="130" alt="${esc(t.qrAlt)}" style="display:block;border:0"></td></tr></table>`);
  }

  const name = order?.customer_name ?? licenses[0]!.name ?? '';
  const intro =
    mail.template === 'license_resend'
      ? t.introAgain
      : payload.again
        ? t.introResent
        : t.intro(licenses.length);
  const first = app.playStoreUrl
    ? esc(t.stepStore) + button(app.playStoreUrl, t.storeButton)
    : esc(t.stepDownload) +
      (token ? button(`${ctx.baseUrl}${downloadPath(token)}`, t.downloadButton(app.version)) : '');
  const steps = [first, esc(t.stepStart), esc(t.stepActivate)];
  const body = [
    p(
      esc(
        name
          ? L === 'de'
            ? `Hallo ${name},`
            : `Hello ${name},`
          : L === 'de'
            ? 'Hallo,'
            : 'Hello,',
      ),
    ),
    p(esc(intro)),
    ...boxes,
    h2(t.howTitle),
    `<ol style="margin:0 0 14px;padding-left:20px">${steps.map((s) => `<li style="margin:0 0 8px">${s}</li>`).join('')}</ol>`,
    h2(t.goodTitle),
    `<ul style="margin:0 0 14px;padding-left:20px">${t.good.map((g) => `<li style="margin:0 0 6px">${esc(g)}</li>`).join('')}</ul>`,
    order && !payload.again
      ? [
          p(t.facts(order.number, formatEuro(order.total_cents, L))),
          p(gmbh ? t.seller(String(gmbh.company.name)) : esc(t.invoice)),
          h2(t.withdrawalTitle),
          p(
            !gmbh
              ? t.withdrawal(dateTime(order.consent, L))
              : order.business
                ? esc(t.withdrawalBusiness)
                : t.withdrawalGmbh(dateTime(order.consent, L)),
          ),
        ].join('\n')
      : '',
    p(esc(t.questions)),
  ].join('\n');
  const subject =
    mail.template === 'license_resend' || payload.again
      ? t.subjectAgain
      : licenses.length === 1
        ? t.subject
        : t.subjectMany(licenses.length);
  if (gmbh) {
    return {
      subject,
      html: layout(L, gmbh, subject, body, 'app'),
      inline,
      from: gmbh.sender,
      replyTo: gmbh.sender,
    };
  }
  return { subject, html: layout(L, ctx, subject, body), inline };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export async function documentData(
  db: Db,
  documentId: number,
  company: MailContext['company'],
): Promise<InvoiceData & { pdfKey: string | null }> {
  const [d] = await db<
    {
      order_id: number;
      kind: 'invoice' | 'credit_note';
      number: string;
      issued_at: Date;
      delivered_at: Date | null;
      refers_to: string | null;
      locale: 'de' | 'en';
      pdf_key: string | null;
      lines: { de: string; en: string; quantity: number; unit_cents: number }[];
      billing_address: InvoiceData['billing'] | null;
      gross_cents: number;
      vat_cents: number;
      vat_rate_bp: number;
    }[]
  >`
    SELECT order_id, kind, number, issued_at, delivered_at, refers_to, locale, pdf_key, lines,
           billing_address, gross_cents, vat_cents, vat_rate_bp
      FROM documents WHERE id = ${documentId}`;
  if (!d) throw new Error(`document ${documentId} not found`);
  const o = await orderById(db, d.order_id);
  const [x] = await db<
    {
      vat_regime: VatRegime;
      tax_country: string | null;
      payment_method_type: string | null;
    }[]
  >`SELECT vat_regime, tax_country, payment_method_type FROM orders WHERE id = ${d.order_id}`;
  if (!o || !x) throw new Error('order not found');
  const L = d.locale;
  return {
    pdfKey: d.pdf_key,
    kind: d.kind,
    number: d.number,
    issuedAt: d.issued_at,
    deliveredAt: d.kind === 'invoice' ? (d.delivered_at ?? d.issued_at) : null,
    refersTo: d.refers_to,
    orderNumber: o.number,
    locale: L,
    company,
    billing: d.billing_address ?? o.billingAddress ?? o.shippingAddress,
    items: d.lines.map((l) => ({
      description: L === 'en' ? l.en : l.de,
      quantity: l.quantity,
      unitCents: l.unit_cents,
    })),
    shipping: null,
    totalCents: d.gross_cents,
    vatCents: d.vat_cents,
    vatRateBp: d.vat_rate_bp,
    vatRegime: x.vat_regime,
    taxCountry: x.tax_country,
    paidWith: x.payment_method_type,
    paidAt: o.paidAt,
  };
}

/** Invoice or credit note PDF, rendered once and kept under MEDIA_DIR/documents. */
export async function documentPdf(
  db: Db,
  documentId: number,
  ctx: MailContext,
): Promise<{ name: string; content: Buffer; key: string }> {
  const data = await documentData(db, documentId, ctx.company);
  const name =
    data.kind === 'invoice'
      ? TEXT[data.locale].invoicePdf(data.number)
      : TEXT[data.locale].creditPdf(data.number);
  if (data.pdfKey) {
    const cached = await readFile(join(ctx.mediaDir, data.pdfKey)).catch(() => null);
    if (cached) return { name, content: cached, key: data.pdfKey };
  }
  const content = await renderInvoicePdf(data);
  const key = `documents/${data.issuedAt.getUTCFullYear()}/${data.number}.pdf`;
  await mkdir(dirname(join(ctx.mediaDir, key)), { recursive: true });
  await writeFile(join(ctx.mediaDir, key), content);
  await db`UPDATE documents SET pdf_key = ${key} WHERE id = ${documentId}`;
  return { name, content, key };
}

async function resolveAttachment(
  db: Db,
  a: MailAttachment,
  locale: 'de' | 'en',
  ctx: MailContext,
): Promise<Attachment> {
  if (a.kind === 'document') {
    const { key: _key, ...pdf } = await documentPdf(db, a.id, ctx);
    return { ...pdf, contentType: 'application/pdf' };
  }
  if (a.kind === 'stripe') {
    if (!ctx.gmbhPayments) throw new Error('GmbH Stripe account not configured');
    const content = await ctx.gmbhPayments.documentPdf({ kind: a.doc, id: a.id });
    const safe = a.number.replace(/[^A-Za-z0-9-]/g, '_');
    return {
      name:
        a.doc === 'invoice' ? TEXT[locale].invoicePdf(safe) : TEXT[locale].stripeCreditPdf(safe),
      contentType: 'application/pdf',
      content,
    };
  }
  const docs = [];
  for (const k of a.kinds as LegalKind[]) {
    const text = await currentLegal(db, k, locale);
    if (text) docs.push(text);
  }
  if (docs.length === 0) throw new Error('legal texts missing – run migrate');
  const terms = a.kinds.includes('license_terms');
  const content = await renderLegalPdf(docs, {
    company: ctx.company as Record<string, unknown>,
    seller: (ctx.licenseSeller ?? undefined) as Record<string, unknown> | undefined,
    baseUrl: ctx.baseUrl,
    locale,
    note:
      locale === 'en' ? 'Translation for convenience; the German version is binding.' : undefined,
  });
  return {
    name: terms ? TEXT[locale].licenseTermsPdf : TEXT[locale].legalPdf,
    contentType: 'application/pdf',
    content,
  };
}

export async function buildMail(db: Db, m: OutboxMail, ctx: MailContext): Promise<Mail> {
  const r = await renderTemplate(db, m, ctx);
  const attachments: Attachment[] = [...(r.inline ?? [])];
  for (const a of m.attachments ?? [])
    attachments.push(await resolveAttachment(db, a, m.locale, ctx));
  return {
    to: m.to_address,
    from: r.from ?? null,
    replyTo: m.reply_to ?? r.replyTo ?? ctx.replyTo,
    subject: r.subject,
    html: r.html,
    attachments,
  };
}

/** Worker: sends up to `max` due mails. Returns how many were sent. */
export async function sendDueMails(
  sql: Sql,
  transport: MailTransport,
  ctx: MailContext,
  max = 10,
  log: (msg: string) => void = () => {},
): Promise<number> {
  let sent = 0;
  for (let i = 0; i < max; i++) {
    const m = await claimMail(sql);
    if (!m) break;
    try {
      await transport.send(await buildMail(sql, m, ctx));
      await markMailSent(sql, m.id);
      if (m.template === 'withdrawal_ack') {
        await sql`UPDATE withdrawals SET acknowledged_at = now()
                   WHERE id = ${Number((m.payload as { withdrawal_id?: unknown }).withdrawal_id)}`;
      }
      sent++;
    } catch (e) {
      const final = await markMailFailed(sql, m, (e as Error).message);
      log(
        `[mail] ${m.template} #${m.id} to ${m.to_address} failed${final ? ' for good' : ''}: ${(e as Error).message}`,
      );
    }
  }
  return sent;
}

/** Graph when configured, a folder (MAIL_DIR) for local development, otherwise none. */
export function mailTransportFromEnv(env: NodeJS.ProcessEnv = process.env): MailTransport | null {
  if (
    env.GRAPH_TENANT_ID &&
    env.GRAPH_CLIENT_ID &&
    (env.GRAPH_CLIENT_CERT_PATH || env.GRAPH_CLIENT_SECRET)
  ) {
    return graphTransport({
      tenantId: env.GRAPH_TENANT_ID,
      clientId: env.GRAPH_CLIENT_ID,
      certPath: env.GRAPH_CLIENT_CERT_PATH || undefined,
      clientSecret: env.GRAPH_CLIENT_SECRET || undefined,
      sender: env.GRAPH_SENDER ?? 'bestellung@pokemonkarten.at',
    });
  }
  if (env.MAIL_DIR) return fileTransport(env.MAIL_DIR);
  return null;
}

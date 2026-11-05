// E-mail: templates, attachments and sending through Microsoft Graph as bestellung@.
// The worker takes due mails from the outbox (outbox.ts) and sends them here.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ConfidentialClientApplication } from '@azure/msal-node';
import type { Db, Sql } from './db.ts';
import { formatEuro, formatRate } from './money.ts';
import { currentLegal, type LegalKind } from './legal.ts';
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

export type Attachment = { name: string; contentType: string; content: Buffer };
export type Mail = {
  to: string;
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
      const res = await doFetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(opts.sender)}/sendMail`,
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
      await writeFile(
        join(dir, `${base}.html`),
        `<!-- To: ${mail.to} | Subject: ${mail.subject} | Attachments: ${mail.attachments.map((a) => a.name).join(', ')} -->\n${mail.html}`,
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

function layout(locale: 'de' | 'en', ctx: MailContext, preheader: string, body: string): string {
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
  return `<!doctype html><html lang="${locale === 'de' ? 'de-AT' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>pokemonkarten.at</title></head>
<body style="margin:0;padding:0;background:${C.paper};color:${C.ink};font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5">
<span style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${C.line};border-radius:6px">
<tr><td style="padding:22px 28px 8px;font-size:20px;font-weight:bold;letter-spacing:-0.01em">pokemonkarten<span style="color:${C.accent}">.at</span></td></tr>
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
      const name = locale === 'en' ? i.nameEn : i.nameDe;
      const set = locale === 'en' ? (i.setNameEn ?? i.setNameDe) : (i.setNameDe ?? i.setNameEn);
      const box = boxes?.get(i.productId);
      return `<tr><td style="padding:8px 0;border-bottom:1px solid ${C.line};vertical-align:top">
<strong>${esc(name)}</strong> <span style="color:${C.muted}">${esc(i.cardNumber)}</span><br>
<span style="color:${C.muted};font-size:13px">${esc([set, i.cardLanguage, i.condition].filter(Boolean).join(' · '))}${box ? ` · Box ${esc(box)}` : ''}</span></td>
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
<tr><td colspan="2" style="color:${C.muted};font-size:13px">${esc(t.vatIncluded(formatRate(o.vatRateBp, locale), formatEuro(o.vatCents, locale)))}</td></tr></table>`;
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
      `Du kannst den Vertrag innerhalb von 14 Tagen ab Erhalt der Karten ohne Angabe von Gründen widerrufen, auch online unter <a href="${esc(url)}" style="color:${C.accent}">Vertrag widerrufen</a>. Unsere AGB und die Widerrufsbelehrung mit dem Muster-Widerrufsformular findest du im Anhang.`,
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
    invoicePdf: (n: string) => `Rechnung-${n}.pdf`,
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
      `You may withdraw from the contract within 14 days of receiving the cards without giving any reason, also online at <a href="${esc(url)}" style="color:${C.accent}">Withdraw from contract</a>. Our terms and the withdrawal instructions with the model withdrawal form are attached.`,
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
    invoicePdf: (n: string) => `Invoice-${n}.pdf`,
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

type Rendered = { subject: string; html: string };

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
  }
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export async function invoiceData(
  db: Db,
  documentId: number,
  company: MailContext['company'],
): Promise<InvoiceData & { pdfKey: string | null }> {
  const [d] = await db<
    {
      order_id: number;
      number: string;
      issued_at: Date;
      locale: 'de' | 'en';
      pdf_key: string | null;
    }[]
  >`
    SELECT order_id, number, issued_at, locale, pdf_key FROM documents WHERE id = ${documentId} AND kind = 'invoice'`;
  if (!d) throw new Error(`invoice ${documentId} not found`);
  const o = await orderById(db, d.order_id);
  const [x] = await db<
    {
      vat_regime: 'domestic' | 'oss' | 'export';
      tax_country: string | null;
      payment_method_type: string | null;
      shipped_at: Date | null;
    }[]
  >`
    SELECT vat_regime, tax_country, payment_method_type, shipped_at FROM orders WHERE id = ${d.order_id}`;
  if (!o || !x) throw new Error('order not found');
  const L = d.locale;
  return {
    pdfKey: d.pdf_key,
    number: d.number,
    issuedAt: d.issued_at,
    deliveredAt: x.shipped_at ?? d.issued_at,
    orderNumber: o.number,
    locale: L,
    company,
    billing: o.billingAddress ?? o.shippingAddress,
    items: o.items.map((i) => ({
      description: [
        `${L === 'en' ? i.nameEn : i.nameDe} ${i.cardNumber}`,
        L === 'en' ? (i.setNameEn ?? i.setNameDe) : (i.setNameDe ?? i.setNameEn),
        i.cardLanguage,
        i.condition,
      ]
        .filter(Boolean)
        .join(', '),
      quantity: i.quantity,
      unitCents: i.unitPriceCents,
    })),
    shipping:
      o.shippingCents > 0
        ? { label: TEXT[L].shippingLabel(o.shippingMethod), cents: o.shippingCents }
        : null,
    totalCents: o.totalCents,
    vatCents: o.vatCents,
    vatRateBp: o.vatRateBp,
    vatRegime: x.vat_regime,
    taxCountry: x.tax_country,
    paidWith: x.payment_method_type,
    paidAt: o.paidAt,
  };
}

/** Invoice PDF, rendered once and kept under MEDIA_DIR/documents. */
export async function invoicePdf(
  db: Db,
  documentId: number,
  ctx: MailContext,
): Promise<{ name: string; content: Buffer }> {
  const data = await invoiceData(db, documentId, ctx.company);
  const name = TEXT[data.locale].invoicePdf(data.number);
  if (data.pdfKey) {
    const cached = await readFile(join(ctx.mediaDir, data.pdfKey)).catch(() => null);
    if (cached) return { name, content: cached };
  }
  const content = await renderInvoicePdf(data);
  const key = `documents/${data.issuedAt.getUTCFullYear()}/${data.number}.pdf`;
  await mkdir(dirname(join(ctx.mediaDir, key)), { recursive: true });
  await writeFile(join(ctx.mediaDir, key), content);
  await db`UPDATE documents SET pdf_key = ${key} WHERE id = ${documentId}`;
  return { name, content };
}

async function resolveAttachment(
  db: Db,
  a: MailAttachment,
  locale: 'de' | 'en',
  ctx: MailContext,
): Promise<Attachment> {
  if (a.kind === 'document') {
    const pdf = await invoicePdf(db, a.id, ctx);
    return { ...pdf, contentType: 'application/pdf' };
  }
  const docs = [];
  for (const k of a.kinds as LegalKind[]) {
    const text = await currentLegal(db, k, locale);
    if (text) docs.push(text);
  }
  if (docs.length === 0) throw new Error('legal texts missing – run migrate');
  const content = await renderLegalPdf(docs, {
    company: ctx.company as Record<string, unknown>,
    baseUrl: ctx.baseUrl,
    locale,
    note:
      locale === 'en' ? 'Translation for convenience; the German version is binding.' : undefined,
  });
  return { name: TEXT[locale].legalPdf, contentType: 'application/pdf', content };
}

export async function buildMail(db: Db, m: OutboxMail, ctx: MailContext): Promise<Mail> {
  const r = await renderTemplate(db, m, ctx);
  const attachments: Attachment[] = [];
  for (const a of m.attachments ?? [])
    attachments.push(await resolveAttachment(db, a, m.locale, ctx));
  return {
    to: m.to_address,
    replyTo: m.reply_to ?? ctx.replyTo,
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

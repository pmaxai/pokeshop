// PDFs: invoice (§ 11 UStG) and the legal texts as e-mail attachment.
// Used by the worker only (pdfkit reads its font metrics from node_modules at runtime).
import PDFDocument from 'pdfkit';
import { Lexer, type Token, type Tokens } from 'marked';
import { formatEuro, formatRate } from './money.ts';
import { SMALL_BUSINESS_NOTE, type VatRegime } from './vat.ts';
import { fillPlaceholders, type LegalContext } from './legal.ts';

type Company = Record<string, string | null | undefined>;

const INK = '#161c33';
const MUTED = '#586079';
const ACCENT = '#c2470a';
const LINE = '#dce0e8';

function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function newDoc(title: string, author: string) {
  return new PDFDocument({
    size: 'A4',
    margins: { top: 56, bottom: 64, left: 56, right: 56 },
    info: { Title: title, Author: author, Creator: 'pokemonkarten.at' },
    lang: 'de-AT',
    bufferPages: true,
  } as PDFKit.PDFDocumentOptions);
}

const dateFmt = (d: Date, locale: 'de' | 'en') =>
  new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Vienna',
  }).format(d);

function companyLines(c: Company, locale: 'de' | 'en'): string[] {
  return [
    c.name ?? '',
    `${c.street ?? ''}, ${c.postcode ?? ''} ${c.city ?? ''}, ${c.country === 'AT' ? (locale === 'de' ? 'Österreich' : 'Austria') : (c.country ?? '')}`,
    c.email ?? '',
    [
      c.vat_id ? `UID ${c.vat_id}` : '',
      c.register_number ? `${c.register_number}, ${c.register_court ?? ''}` : '',
    ]
      .filter(Boolean)
      .join('  ·  '),
  ].filter(Boolean);
}

function pageNumbers(doc: PDFKit.PDFDocument, label: (n: number, total: number) => string) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(label(i + 1, range.count), 56, doc.page.height - 40, {
        width: doc.page.width - 112,
        align: 'right',
      });
    doc.page.margins.bottom = bottom;
  }
}

// ---------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------

export type InvoiceData = {
  /** Invoice, or a correction (credit note) for a refund on an invoiced order. */
  kind: 'invoice' | 'credit_note';
  number: string;
  issuedAt: Date;
  deliveredAt: Date | null;
  /** Credit note: number of the invoice it corrects. */
  refersTo: string | null;
  orderNumber: string;
  locale: 'de' | 'en';
  company: Company;
  billing: {
    name: string;
    company?: string | undefined;
    /** App licences are billed with name and country only. */
    street?: string | undefined;
    postcode?: string | undefined;
    city?: string | undefined;
    country: string;
  };
  items: { description: string; quantity: number; unitCents: number }[];
  shipping: { label: string; cents: number } | null;
  totalCents: number;
  vatCents: number;
  vatRateBp: number;
  vatRegime: VatRegime;
  taxCountry: string | null;
  paidWith: string | null;
  paidAt: Date | null;
};

const INVOICE_TEXT = {
  de: {
    title: 'Rechnung',
    creditTitle: 'Rechnungskorrektur',
    creditDate: 'Datum',
    creditTotal: 'Erstattungsbetrag',
    refersTo: 'Zu Rechnung',
    refunded: (date: string) => `Der Betrag wurde am ${date} auf dein Zahlungsmittel erstattet.`,
    number: 'Rechnungsnummer',
    date: 'Rechnungsdatum',
    delivery: 'Lieferdatum',
    order: 'Bestellnummer',
    pos: 'Pos.',
    item: 'Artikel',
    qty: 'Menge',
    unit: 'Einzelpreis',
    total: 'Gesamt',
    net: 'Summe netto',
    vat: 'USt.',
    gross: 'Rechnungsbetrag',
    paid: (method: string, date: string) =>
      `Bezahlt am ${date} (${method}). Vielen Dank für deinen Einkauf!`,
    oss: (c: string) => `Umsatzsteuer des Bestimmungslandes ${c} (One-Stop-Shop).`,
    export: 'Steuerfreie Ausfuhrlieferung.',
    page: (n: number, t: number) => `Seite ${n} von ${t}`,
  },
  en: {
    title: 'Invoice',
    creditTitle: 'Credit note',
    creditDate: 'Date',
    creditTotal: 'Amount refunded',
    refersTo: 'Corrects invoice',
    refunded: (date: string) => `The amount was refunded to your payment method on ${date}.`,
    number: 'Invoice number',
    date: 'Invoice date',
    delivery: 'Delivery date',
    order: 'Order number',
    pos: 'No.',
    item: 'Item',
    qty: 'Qty',
    unit: 'Unit price',
    total: 'Total',
    net: 'Net total',
    vat: 'VAT',
    gross: 'Invoice total',
    paid: (method: string, date: string) =>
      `Paid on ${date} (${method}). Thank you for your order!`,
    oss: (c: string) => `VAT of the country of destination ${c} (One-Stop-Shop).`,
    export: 'Tax-free export delivery.',
    page: (n: number, t: number) => `Page ${n} of ${t}`,
  },
};

export const PAYMENT_METHOD_LABELS: Record<string, { de: string; en: string }> = {
  card: { de: 'Karte', en: 'card' },
  eps: { de: 'EPS-Überweisung', en: 'EPS bank transfer' },
  paypal: { de: 'PayPal', en: 'PayPal' },
  apple_pay: { de: 'Apple Pay', en: 'Apple Pay' },
  google_pay: { de: 'Google Pay', en: 'Google Pay' },
};

export async function renderInvoicePdf(inv: InvoiceData): Promise<Buffer> {
  const t = INVOICE_TEXT[inv.locale];
  const L = inv.locale;
  const credit = inv.kind === 'credit_note';
  const title = credit ? t.creditTitle : t.title;
  const doc = newDoc(`${title} ${inv.number}`, inv.company.name ?? '');
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;

  // Header: shop name left, seller right.
  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor(INK)
    .text('pokemonkarten', left, 56, { continued: true });
  doc.fillColor(ACCENT).text('.at');
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  const seller = companyLines(inv.company, L);
  doc.text(seller.join('\n'), left + width / 2, 58, {
    width: width / 2,
    align: 'right',
    lineGap: 1.5,
  });

  // Buyer
  const b = inv.billing;
  const countryName =
    new Intl.DisplayNames([L === 'de' ? 'de-AT' : 'en'], { type: 'region' }).of(b.country) ??
    b.country;
  doc
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor(MUTED)
    .text(seller.slice(0, 2).join(' · '), left, 150);
  doc
    .fontSize(10.5)
    .fillColor(INK)
    .text(
      [b.company, b.name, b.street, [b.postcode, b.city].filter(Boolean).join(' '), countryName]
        .filter(Boolean)
        .join('\n'),
      left,
      164,
      {
        lineGap: 2,
      },
    );

  // Title and facts
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(`${title} ${inv.number}`, left, 268);
  const facts: [string, string][] = [
    [credit ? t.creditDate : t.date, dateFmt(inv.issuedAt, L)],
    ...(inv.deliveredAt ? ([[t.delivery, dateFmt(inv.deliveredAt, L)]] as [string, string][]) : []),
    ...(inv.refersTo ? ([[t.refersTo, inv.refersTo]] as [string, string][]) : []),
    [t.order, inv.orderNumber],
  ];
  let y = 296;
  for (const [k, v] of facts) {
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(k, left, y, { width: 120 });
    doc.fillColor(INK).text(v, left + 120, y);
    y += 15;
  }

  // Items
  y += 18;
  const col = {
    pos: left,
    item: left + 34,
    qty: left + width - 190,
    unit: left + width - 140,
    total: left + width - 70,
  };
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED);
    doc.text(t.pos, col.pos, y);
    doc.text(t.item, col.item, y);
    doc.text(t.qty, col.qty, y, { width: 40, align: 'right' });
    doc.text(t.unit, col.unit, y, { width: 60, align: 'right' });
    doc.text(t.total, col.total, y, { width: 70, align: 'right' });
    y += 14;
    doc
      .moveTo(left, y)
      .lineTo(left + width, y)
      .strokeColor(LINE)
      .lineWidth(0.8)
      .stroke();
    y += 6;
  };
  header();
  const rows = [
    ...inv.items.map((i) => ({ text: i.description, qty: i.quantity, unit: i.unitCents })),
    ...(inv.shipping ? [{ text: inv.shipping.label, qty: 1, unit: inv.shipping.cents }] : []),
  ];
  rows.forEach((r, idx) => {
    doc.font('Helvetica').fontSize(9.5);
    const h = doc.heightOfString(r.text, { width: col.qty - col.item - 10 });
    if (y + h > doc.page.height - 140) {
      doc.addPage();
      y = 56;
      header();
    }
    doc.fillColor(MUTED).text(String(idx + 1), col.pos, y);
    doc.fillColor(INK).text(r.text, col.item, y, { width: col.qty - col.item - 10 });
    doc.text(String(r.qty), col.qty, y, { width: 40, align: 'right' });
    doc.text(formatEuro(r.unit, L), col.unit, y, { width: 60, align: 'right' });
    doc.text(formatEuro(r.unit * r.qty, L), col.total, y, { width: 70, align: 'right' });
    y += Math.max(h, 12) + 7;
  });
  doc
    .moveTo(left, y)
    .lineTo(left + width, y)
    .strokeColor(LINE)
    .lineWidth(0.8)
    .stroke();
  y += 10;

  // Totals
  const sumRow = (label: string, value: string, bold = false) => {
    doc
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(bold ? 11 : 9.5)
      .fillColor(INK);
    doc.text(label, col.qty - 120, y, { width: 220, align: 'right' });
    doc.text(value, col.total, y, { width: 70, align: 'right' });
    y += bold ? 18 : 15;
  };
  const smallBusiness = inv.vatRegime === 'small_business';
  if (!smallBusiness) {
    sumRow(t.net, formatEuro(inv.totalCents - inv.vatCents, L));
    sumRow(`${t.vat} ${formatRate(inv.vatRateBp, L)}`, formatEuro(inv.vatCents, L));
  }
  sumRow(credit ? t.creditTotal : t.gross, formatEuro(inv.totalCents, L), true);

  y += 16;
  doc.font('Helvetica').fontSize(9).fillColor(INK);
  const notes: string[] = [];
  if (inv.vatRegime === 'oss' && inv.taxCountry) notes.push(t.oss(inv.taxCountry));
  if (inv.vatRegime === 'export') notes.push(t.export);
  if (smallBusiness) notes.push(`${SMALL_BUSINESS_NOTE[L]}.`);
  if (credit) {
    notes.push(t.refunded(dateFmt(inv.issuedAt, L)));
  } else if (inv.paidAt) {
    const m = inv.paidWith ? (PAYMENT_METHOD_LABELS[inv.paidWith]?.[L] ?? inv.paidWith) : 'Stripe';
    notes.push(t.paid(m, dateFmt(inv.paidAt, L)));
  }
  doc.text(notes.join('\n'), left, y, { width, lineGap: 2 });

  pageNumbers(doc, (n, total) => `${inv.number} · ${t.page(n, total)}`);
  return toBuffer(doc);
}

// ---------------------------------------------------------------------------
// Legal texts
// ---------------------------------------------------------------------------

/** Inline Markdown → plain text runs (bold kept), links as "text (url)". */
function inlineRuns(tokens: Token[] | undefined): { text: string; bold: boolean }[] {
  const out: { text: string; bold: boolean }[] = [];
  const walk = (ts: Token[] | undefined, bold: boolean) => {
    for (const tk of ts ?? []) {
      if (tk.type === 'strong') walk((tk as Tokens.Strong).tokens, true);
      else if (tk.type === 'em') walk((tk as Tokens.Em).tokens, bold);
      else if (tk.type === 'link') {
        const l = tk as Tokens.Link;
        const label = l.text;
        out.push({
          text:
            label === l.href || label === l.href.replace(/^mailto:/, '')
              ? label
              : `${label} (${l.href.replace(/^mailto:/, '')})`,
          bold,
        });
      } else if (tk.type === 'br') out.push({ text: '\n', bold });
      else if ('tokens' in tk && Array.isArray((tk as { tokens?: Token[] }).tokens))
        walk((tk as { tokens: Token[] }).tokens, bold);
      else out.push({ text: decode((tk as { text?: string }).text ?? tk.raw), bold });
    }
  };
  walk(tokens, false);
  return out;
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

function writeRuns(
  doc: PDFKit.PDFDocument,
  runs: { text: string; bold: boolean }[],
  opts: PDFKit.Mixins.TextOptions = {},
) {
  runs.forEach((r, i) => {
    doc
      .font(r.bold ? 'Helvetica-Bold' : 'Helvetica')
      .text(r.text, { ...opts, continued: i < runs.length - 1 });
  });
  if (runs.length === 0) doc.text('');
}

export async function renderLegalPdf(
  docs: { title: string; body_md: string; version: number }[],
  ctx: LegalContext & {
    note?: string;
    /** Who issues the texts, if not the shop (the GmbH). */ issuer?: string;
  },
): Promise<Buffer> {
  const issuer = ctx.issuer ?? String(ctx.company.name ?? '');
  const doc = newDoc(docs.map((d) => d.title).join(' / '), issuer);
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  docs.forEach((d, idx) => {
    if (idx > 0) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(d.title, left, doc.y, { width });
    doc.moveDown(0.3);
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(MUTED)
      .text(`${issuer} · ${ctx.locale === 'de' ? 'Fassung' : 'Version'} ${d.version}`);
    if (ctx.note) doc.moveDown(0.3).text(ctx.note, { width });
    doc.moveDown(0.8);
    const tokens = new Lexer().lex(fillPlaceholders(d.body_md, ctx));
    for (const tk of tokens) {
      doc.fillColor(INK);
      switch (tk.type) {
        case 'heading': {
          const h = tk as Tokens.Heading;
          doc
            .moveDown(0.5)
            .font('Helvetica-Bold')
            .fontSize(h.depth <= 2 ? 12.5 : 10.5);
          doc.text(decode(h.text), { width });
          doc.moveDown(0.25);
          break;
        }
        case 'paragraph':
          doc.fontSize(9.5);
          writeRuns(doc, inlineRuns((tk as Tokens.Paragraph).tokens), { width, lineGap: 1.5 });
          doc.moveDown(0.5);
          break;
        case 'list': {
          const l = tk as Tokens.List;
          l.items.forEach((item, n) => {
            const bullet = l.ordered ? `${Number(l.start || 1) + n}.` : '–';
            const y = doc.y;
            doc
              .font('Helvetica')
              .fontSize(9.5)
              .text(bullet, left + 4, y, { width: 16 });
            doc.y = y;
            const runs = item.tokens.flatMap((t) =>
              inlineRuns('tokens' in t ? ((t as Tokens.Text).tokens ?? [t]) : [t]),
            );
            doc.x = left + 20;
            writeRuns(doc, runs, { width: width - 20, lineGap: 1.5 });
            doc.x = left;
            doc.moveDown(0.25);
          });
          doc.moveDown(0.3);
          break;
        }
        case 'blockquote':
          doc.fontSize(9.5).fillColor(MUTED);
          writeRuns(doc, inlineRuns((tk as Tokens.Blockquote).tokens), { width, lineGap: 1.5 });
          doc.moveDown(0.5);
          break;
        case 'hr':
          doc.moveDown(0.3);
          doc
            .moveTo(left, doc.y)
            .lineTo(left + width, doc.y)
            .strokeColor(LINE)
            .stroke();
          doc.moveDown(0.6);
          break;
        case 'space':
          break;
        default:
          if ('text' in tk) {
            doc
              .fontSize(9.5)
              .font('Helvetica')
              .text(decode(String((tk as { text: string }).text)), { width });
            doc.moveDown(0.5);
          }
      }
    }
  });
  pageNumbers(doc, (n, total) =>
    ctx.locale === 'de' ? `Seite ${n} von ${total}` : `Page ${n} of ${total}`,
  );
  return toBuffer(doc);
}

// Fulfilment: packing, pick list by storage box, shipping with invoice, refunds with optional
// restock and credit note, withdrawals. Used by the admin.
import type { Db, Sql, Tx } from './db.ts';
import { cardNameText, compareStorageLocations, rowNames, translationText } from './catalog.ts';
import { splitGross } from './money.ts';
import { formatDocumentNumber } from './numbering.ts';
import { licenseDocumentLine } from './licenses.ts';
import { enqueueMail } from './outbox.ts';
import { orderEvent } from './orders.ts';
import type { PaymentProvider } from './payments.ts';

export type DocumentLine = { de: string; en: string; quantity: number; unit_cents: number };

const vienna = (d: Date) =>
  Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Europe/Vienna' }).format(d));

type ItemRow = {
  id: number;
  product_id: number;
  sku: string;
  name_de: string;
  name_en: string;
  name_local: string | null;
  set_name_de: string | null;
  set_name_en: string | null;
  card_number: string;
  card_language: string;
  condition: string;
  finish: string;
  unit_price_cents: number;
  quantity: number;
  refunded_quantity: number;
  restocked_quantity: number;
  high_value: boolean;
};

const ITEM_COLUMNS = `id, product_id, sku, name_de, name_en, name_local, set_name_de, set_name_en, card_number,
  card_language, condition, finish, unit_price_cents, quantity, refunded_quantity, restocked_quantity, high_value`;

/** "リザードンex (Charizard ex, Glurak-ex)": printed name first, as in the shop. */
function itemName(
  i: Pick<ItemRow, 'card_language' | 'name_de' | 'name_en' | 'name_local'>,
  locale: 'de' | 'en',
): string {
  return cardNameText(rowNames(i, locale));
}

/** The PDF font (Helvetica, WinAnsi) only prints Western European characters. */
const PDF_PRINTABLE =
  /^[\x20-\x7e\u00a0-\u00ff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u2013\u2014\u2018\u2019\u201c\u201d\u201e\u2022\u2026\u20ac]*$/;

/**
 * Name on invoices and credit notes: as in the shop, except that a Japanese, Korean, Chinese,
 * Thai or Cyrillic printed name gives way to the English (and German) one – the card language
 * stays on the line.
 */
export function documentItemName(
  i: Pick<ItemRow, 'card_language' | 'name_de' | 'name_en' | 'name_local'>,
  locale: 'de' | 'en',
): string {
  const n = rowNames(i, locale);
  if (PDF_PRINTABLE.test(n.original)) return cardNameText(n);
  const printable = n.translations.filter((t) => PDF_PRINTABLE.test(t.text));
  return printable.length ? printable.map(translationText).join(' · ') : i.name_en;
}

function itemLine(i: ItemRow, quantity: number): DocumentLine {
  const tail = [i.card_language, i.condition].join(', ');
  return {
    de: `${documentItemName(i, 'de')} ${i.card_number}, ${i.set_name_de ?? i.set_name_en ?? ''}, ${tail}`,
    en: `${documentItemName(i, 'en')} ${i.card_number}, ${i.set_name_en ?? i.set_name_de ?? ''}, ${tail}`,
    quantity,
    unit_cents: i.unit_price_cents,
  };
}

function shippingLine(method: string, cents: number): DocumentLine {
  return {
    de: method === 'insured' ? 'Versicherter Versand' : 'Versand',
    en: method === 'insured' ? 'Insured shipping' : 'Shipping',
    quantity: 1,
    unit_cents: cents,
  };
}

type OrderForDocs = {
  id: number;
  number: string;
  status: string;
  locale: 'de' | 'en';
  email: string | null;
  vat_rate_bp: number;
  vat_regime: string;
  total_cents: number;
  refunded_cents: number;
  shipping_cents: number;
  shipping_method: string;
  billing_address: unknown;
  shipping_address: unknown;
  stripe_payment_intent_id: string | null;
};

async function lockOrder(tx: Tx, id: number): Promise<OrderForDocs> {
  const [o] = await tx<OrderForDocs[]>`
    SELECT id, number, status, locale, email, vat_rate_bp, vat_regime, total_cents, refunded_cents,
           shipping_cents, shipping_method, billing_address, shipping_address, stripe_payment_intent_id
      FROM orders WHERE id = ${id} FOR UPDATE`;
  if (!o) throw new FulfilmentError('not_found', 'Bestellung nicht gefunden');
  return o;
}

const vatOf = (gross: number, o: OrderForDocs) =>
  o.vat_regime === 'export' ? 0 : splitGross(gross, o.vat_rate_bp).vat;

async function refundedShipping(tx: Db, orderId: number): Promise<number> {
  const [r] = await tx<{ s: number }[]>`
    SELECT coalesce(sum(shipping_cents), 0)::int AS s FROM refunds
     WHERE order_id = ${orderId} AND status IN ('pending', 'succeeded')`;
  return r?.s ?? 0;
}

export class FulfilmentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** App licences of an order as a document line (licence orders only). */
async function licenseLines(tx: Db, orderId: number): Promise<DocumentLine[]> {
  const [l] = await tx<{ quantity: number; unit_price_cents: number }[]>`
    SELECT quantity, unit_price_cents FROM order_licenses WHERE order_id = ${orderId}`;
  return l ? [licenseDocumentLine(l.quantity, l.unit_price_cents)] : [];
}

/**
 * Issues the invoice when the order ships (the invoice states the delivery date, § 11 UStG);
 * for app licences when the keys are sent.
 * Lines already refunded before shipping are left out. Returns null if nothing is left to bill.
 */
export async function issueInvoice(
  tx: Tx,
  orderId: number,
  deliveredAt: Date,
): Promise<{ id: number; number: string } | null> {
  const o = await lockOrder(tx, orderId);
  const [existing] = await tx<{ id: number; number: string }[]>`
    SELECT id, number FROM documents WHERE order_id = ${orderId} AND kind = 'invoice'`;
  if (existing) return existing;
  const items = await tx<ItemRow[]>`
    SELECT ${tx.unsafe(ITEM_COLUMNS)} FROM order_items WHERE order_id = ${orderId} ORDER BY id`;
  const lines = items
    .filter((i) => i.quantity > i.refunded_quantity)
    .map((i) => itemLine(i, i.quantity - i.refunded_quantity));
  lines.push(...(await licenseLines(tx, orderId)));
  const shipping = o.shipping_cents - (await refundedShipping(tx, orderId));
  if (shipping > 0) lines.push(shippingLine(o.shipping_method, shipping));
  const gross = lines.reduce((a, l) => a + l.unit_cents * l.quantity, 0);
  if (gross === 0) return null;
  const vat = vatOf(gross, o);
  const year = vienna(deliveredAt);
  const [s] = await tx<{ seq: number }[]>`SELECT next_document_seq('invoice', ${year}) AS seq`;
  const number = formatDocumentNumber('invoice', year, s!.seq);
  const [doc] = await tx<{ id: number }[]>`
    INSERT INTO documents (order_id, kind, year, seq, number, issued_at, delivered_at, net_cents,
                           vat_cents, gross_cents, vat_rate_bp, locale, lines, billing_address)
    VALUES (${orderId}, 'invoice', ${year}, ${s!.seq}, ${number}, ${deliveredAt}, ${deliveredAt},
            ${gross - vat}, ${vat}, ${gross}, ${o.vat_rate_bp}, ${o.locale}, ${tx.json(lines as never)},
            ${tx.json((o.billing_address ?? o.shipping_address) as never)})
    RETURNING id`;
  return { id: doc!.id, number };
}

/** Credit note for a refund on an order that already has an invoice. */
async function issueCreditNote(
  tx: Tx,
  o: OrderForDocs,
  refundId: number,
  lines: DocumentLine[],
  at: Date,
): Promise<{ id: number; number: string } | null> {
  const [invoice] = await tx<{ number: string }[]>`
    SELECT number FROM documents WHERE order_id = ${o.id} AND kind = 'invoice'`;
  if (!invoice) return null;
  const gross = lines.reduce((a, l) => a + l.unit_cents * l.quantity, 0);
  const vat = vatOf(gross, o);
  const year = vienna(at);
  const [s] = await tx<{ seq: number }[]>`SELECT next_document_seq('credit_note', ${year}) AS seq`;
  const number = formatDocumentNumber('credit_note', year, s!.seq);
  const [doc] = await tx<{ id: number }[]>`
    INSERT INTO documents (order_id, refund_id, kind, year, seq, number, issued_at, net_cents,
                           vat_cents, gross_cents, vat_rate_bp, locale, lines, refers_to, billing_address)
    VALUES (${o.id}, ${refundId}, 'credit_note', ${year}, ${s!.seq}, ${number}, ${at}, ${gross - vat},
            ${vat}, ${gross}, ${o.vat_rate_bp}, ${o.locale}, ${tx.json(lines as never)},
            ${invoice.number}, ${tx.json((o.billing_address ?? o.shipping_address) as never)})
    RETURNING id`;
  return { id: doc!.id, number };
}

/** Credit note for a refunded licence order (all its licences). */
export async function issueCreditNoteForLicense(
  tx: Tx,
  orderId: number,
  refundId: number,
  at: Date,
): Promise<{ id: number; number: string } | null> {
  const o = await lockOrder(tx, orderId);
  return issueCreditNote(tx, o, refundId, await licenseLines(tx, orderId), at);
}

// ---------------------------------------------------------------------------
// Packing and shipping
// ---------------------------------------------------------------------------

/** Paid orders → "packing" (pick list printed). Returns the ids that changed. */
export async function startPacking(sql: Sql, ids: number[], actor: string): Promise<number[]> {
  if (ids.length === 0) return [];
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: number }[]>`
      UPDATE orders SET status = 'packing' WHERE id = ANY(${ids}::bigint[]) AND status = 'paid'
      RETURNING id`;
    for (const r of rows) await orderEvent(tx, r.id, 'packing', {}, actor);
    return rows.map((r) => r.id);
  });
}

/**
 * Marks the order as shipped, issues the invoice and queues the shipping mail with the
 * invoice and the tracking link.
 */
export async function markShipped(
  sql: Sql,
  orderId: number,
  input: { trackingNumber?: string | null; actor: string; at?: Date },
): Promise<{ invoice: string | null }> {
  const at = input.at ?? new Date();
  const tracking = input.trackingNumber?.trim().replace(/\s+/g, '').toUpperCase() || null;
  if (tracking && !/^[A-Z0-9-]{6,40}$/.test(tracking)) {
    throw new FulfilmentError('invalid_tracking', 'Die Sendungsnummer sieht nicht richtig aus.');
  }
  return sql.begin(async (tx) => {
    const o = await lockOrder(tx, orderId);
    if (!['paid', 'packing'].includes(o.status)) {
      throw new FulfilmentError(
        'wrong_status',
        'Nur bezahlte Bestellungen können versendet werden.',
      );
    }
    if (o.shipping_method !== 'standard' && !tracking) {
      throw new FulfilmentError(
        'tracking_required',
        'Versicherte und nachverfolgte Sendungen brauchen eine Sendungsnummer.',
      );
    }
    const [carrier] = await tx<{ value: { code?: string } }[]>`
      SELECT value FROM settings WHERE key = 'carrier'`;
    await tx`UPDATE orders SET status = 'shipped', shipped_at = ${at}, tracking_number = ${tracking},
                               carrier = ${carrier?.value?.code ?? 'post_at'}
              WHERE id = ${orderId}`;
    const invoice = await issueInvoice(tx, orderId, at);
    if (o.email) {
      await enqueueMail(tx, {
        template: 'order_shipped',
        to: o.email,
        locale: o.locale,
        payload: { order_id: orderId },
        attachments: invoice ? [{ kind: 'document', id: invoice.id }] : [],
        dedupeKey: `order_shipped:${orderId}`,
      });
    }
    await orderEvent(
      tx,
      orderId,
      'shipped',
      { tracking, invoice: invoice?.number ?? null },
      input.actor,
    );
    return { invoice: invoice?.number ?? null };
  });
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export type RefundInput = {
  orderId: number;
  items: { orderItemId: number; quantity: number; restock: boolean }[];
  /** Refund what is left of the shipping charge. */
  shipping: boolean;
  reason: string;
  actor: string;
};

export type RefundResult = { refundId: number; amount: number; creditNote: string | null };

/**
 * Refunds cards (and optionally the shipping charge) through Stripe, puts the chosen copies
 * back into their boxes, issues a credit note if the order was already invoiced and mails
 * the buyer. Nothing changes in the shop if Stripe refuses.
 */
export async function refundOrder(
  sql: Sql,
  provider: PaymentProvider,
  input: RefundInput,
  now = new Date(),
): Promise<RefundResult> {
  const wanted = input.items.filter((i) => i.quantity > 0);
  const prep = await sql.begin(async (tx) => {
    const o = await lockOrder(tx, input.orderId);
    if (!['paid', 'packing', 'shipped', 'completed'].includes(o.status)) {
      throw new FulfilmentError('wrong_status', 'Diese Bestellung kann nicht erstattet werden.');
    }
    if (!o.stripe_payment_intent_id) {
      throw new FulfilmentError('no_payment', 'Zu dieser Bestellung gibt es keine Zahlung.');
    }
    const items = await tx<ItemRow[]>`
      SELECT ${tx.unsafe(ITEM_COLUMNS)} FROM order_items WHERE order_id = ${o.id} FOR UPDATE`;
    let amount = 0;
    for (const w of wanted) {
      const it = items.find((i) => i.id === w.orderItemId);
      if (!it || !Number.isInteger(w.quantity) || w.quantity > it.quantity - it.refunded_quantity) {
        throw new FulfilmentError('bad_quantity', 'Mehr Exemplare als noch nicht erstattet.');
      }
      amount += it.unit_price_cents * w.quantity;
    }
    const shipping = input.shipping ? o.shipping_cents - (await refundedShipping(tx, o.id)) : 0;
    amount += shipping;
    if (amount <= 0)
      throw new FulfilmentError('nothing', 'Bitte Karten oder Versandkosten wählen.');
    if (amount > o.total_cents - o.refunded_cents) {
      throw new FulfilmentError('too_much', 'Der Betrag übersteigt das noch Erstattbare.');
    }
    const [r] = await tx<{ id: number }[]>`
      INSERT INTO refunds (order_id, amount_cents, shipping_cents, reason, items, status, created_by)
      VALUES (${o.id}, ${amount}, ${shipping}, ${input.reason.trim().slice(0, 500) || null},
              ${tx.json(wanted as never)}, 'pending', ${input.actor})
      RETURNING id`;
    return { refundId: r!.id, amount, shipping, pi: o.stripe_payment_intent_id };
  });

  let stripeId: string;
  try {
    const res = await provider.refund({
      paymentIntentId: prep.pi,
      amount: prep.amount,
      idempotencyKey: `refund-${prep.refundId}`,
    });
    stripeId = res.id;
  } catch (e) {
    await sql`UPDATE refunds SET status = 'failed', error = ${(e as Error).message.slice(0, 1000)}
               WHERE id = ${prep.refundId}`;
    await orderEvent(
      sql,
      input.orderId,
      'refund_failed',
      { error: (e as Error).message },
      input.actor,
    );
    throw new FulfilmentError(
      'stripe_failed',
      `Stripe hat die Erstattung abgelehnt: ${(e as Error).message}`,
    );
  }

  return sql.begin(async (tx) => {
    const o = await lockOrder(tx, input.orderId);
    await tx`UPDATE refunds SET status = 'succeeded', stripe_refund_id = ${stripeId} WHERE id = ${prep.refundId}`;
    const items = await tx<ItemRow[]>`
      SELECT ${tx.unsafe(ITEM_COLUMNS)} FROM order_items WHERE order_id = ${o.id}`;
    const lines: DocumentLine[] = [];
    for (const w of wanted) {
      const it = items.find((i) => i.id === w.orderItemId)!;
      await tx`UPDATE order_items SET refunded_quantity = refunded_quantity + ${w.quantity} WHERE id = ${it.id}`;
      if (w.restock) {
        await tx`SELECT order_item_restock(${it.id}, ${w.quantity}, ${input.actor}, ${`refund:${prep.refundId}`})`;
      }
      lines.push(itemLine(it, w.quantity));
    }
    if (prep.shipping > 0) lines.push(shippingLine(o.shipping_method, prep.shipping));
    const refunded = o.refunded_cents + prep.amount;
    await tx`UPDATE orders SET refunded_cents = ${refunded},
                    status = CASE WHEN ${refunded} >= total_cents THEN 'refunded' ELSE status END
              WHERE id = ${o.id}`;
    const credit = await issueCreditNote(tx, o, prep.refundId, lines, now);
    if (o.email) {
      await enqueueMail(tx, {
        template: 'refund_issued',
        to: o.email,
        locale: o.locale,
        payload: { order_id: o.id, refund_id: prep.refundId },
        attachments: credit ? [{ kind: 'document', id: credit.id }] : [],
        dedupeKey: `refund_issued:${prep.refundId}`,
      });
    }
    await orderEvent(
      tx,
      o.id,
      'refunded',
      { amount: prep.amount, refund: stripeId, credit_note: credit?.number ?? null, items: wanted },
      input.actor,
    );
    return { refundId: prep.refundId, amount: prep.amount, creditNote: credit?.number ?? null };
  });
}

// ---------------------------------------------------------------------------
// Pick list
// ---------------------------------------------------------------------------

export type PickLine = {
  box: string;
  quantity: number;
  orderId: number;
  orderNumber: string;
  sku: string;
  name: string;
  setName: string | null;
  cardNumber: string;
  cardLanguage: string;
  condition: string;
  finish: string;
};

export type PackingSlip = {
  id: number;
  number: string;
  shippingMethod: string;
  totalCents: number;
  paidAt: Date | null;
  address: Record<string, string | undefined>;
  email: string | null;
  lines: PickLine[];
};

/** Everything to pick for the given orders, sorted by box, plus one packing slip per order. */
export async function pickList(
  db: Db,
  orderIds: number[],
): Promise<{ lines: PickLine[]; slips: PackingSlip[] }> {
  if (orderIds.length === 0) return { lines: [], slips: [] };
  const rows = await db<
    (Omit<PickLine, 'orderId' | 'orderNumber' | 'name'> & {
      order_id: number;
      order_number: string;
      name_de: string;
      name_en: string;
      name_local: string | null;
    })[]
  >`
    SELECT a.storage_location AS box, a.quantity, i.order_id, o.number AS order_number, i.sku,
           i.name_de, i.name_en, i.name_local, i.set_name_de AS "setName", i.card_number AS "cardNumber",
           i.card_language AS "cardLanguage", i.condition, i.finish
      FROM order_item_allocations a
      JOIN order_items i ON i.id = a.order_item_id
      JOIN orders o ON o.id = i.order_id
     WHERE i.order_id = ANY(${orderIds}::bigint[]) AND a.status = 'committed'`;
  const lines: PickLine[] = rows
    .map(({ order_id, order_number, name_de, name_en, name_local, ...r }) => ({
      ...r,
      name: itemName({ card_language: r.cardLanguage, name_de, name_en, name_local }, 'de'),
      orderId: order_id,
      orderNumber: order_number,
    }))
    .sort(
      (a, b) =>
        compareStorageLocations(a.box, b.box) ||
        a.name.localeCompare(b.name, 'de') ||
        a.orderNumber.localeCompare(b.orderNumber),
    );
  const orders = await db<
    {
      id: number;
      number: string;
      shipping_method: string;
      total_cents: number;
      paid_at: Date | null;
      shipping_address: Record<string, string | undefined>;
      email: string | null;
    }[]
  >`SELECT id, number, shipping_method, total_cents, paid_at, shipping_address, email
      FROM orders WHERE id = ANY(${orderIds}::bigint[]) ORDER BY paid_at, id`;
  return {
    lines,
    slips: orders.map((o) => ({
      id: o.id,
      number: o.number,
      shippingMethod: o.shipping_method,
      totalCents: o.total_cents,
      paidAt: o.paid_at,
      address: o.shipping_address,
      email: o.email,
      lines: lines.filter((l) => l.orderId === o.id),
    })),
  };
}

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------

export const ORDER_VIEWS = {
  open: { label: 'Zu packen', statuses: ['paid'], kind: 'cards' },
  packing: { label: 'In Arbeit', statuses: ['packing'], kind: 'cards' },
  shipped: { label: 'Versendet', statuses: ['shipped', 'completed'], kind: 'cards' },
  licenses: {
    label: 'App-Lizenzen',
    statuses: ['paid', 'completed', 'refunded'],
    kind: 'license',
  },
  refunded: { label: 'Erstattet', statuses: ['refunded'], kind: null },
  unpaid: {
    label: 'Nicht bezahlt',
    statuses: ['checkout', 'awaiting_payment', 'expired', 'payment_failed', 'cancelled'],
    kind: null,
  },
  all: { label: 'Alle', statuses: [] as string[], kind: null },
} as const;
export type OrderView = keyof typeof ORDER_VIEWS;

export type OrderListRow = {
  id: number;
  number: string;
  status: string;
  created_at: Date;
  paid_at: Date | null;
  customer_name: string | null;
  email: string | null;
  country: string;
  total_cents: number;
  refunded_cents: number;
  shipping_method: string;
  copies: number;
  kind: 'cards' | 'license';
};

export async function listOrders(
  db: Db,
  input: { view: OrderView; q?: string; page?: number; pageSize?: number },
): Promise<{ rows: OrderListRow[]; total: number }> {
  const statuses = ORDER_VIEWS[input.view].statuses as readonly string[];
  const kind = ORDER_VIEWS[input.view].kind as string | null;
  const q = input.q?.trim().slice(0, 100);
  const size = input.pageSize ?? 50;
  const where = db`
    true
    ${statuses.length ? db`AND o.status = ANY(${statuses as string[]}::text[])` : db``}
    ${kind ? db`AND o.kind = ${kind}` : db``}
    ${
      q
        ? db`AND (o.number ILIKE ${'%' + q.replace(/[%_\\]/g, '\\$&') + '%'} OR lower(o.email) = ${q.toLowerCase()}
                OR o.customer_name ILIKE ${'%' + q.replace(/[%_\\]/g, '\\$&') + '%'})`
        : db``
    }`;
  const [rows, [count]] = await Promise.all([
    db<OrderListRow[]>`
      SELECT o.id, o.number, o.status, o.created_at, o.paid_at, o.customer_name, o.email, o.country,
             o.total_cents, o.refunded_cents, o.shipping_method, o.kind,
             (SELECT coalesce(sum(quantity), 0)::int FROM order_items i WHERE i.order_id = o.id)
             + (SELECT coalesce(sum(quantity), 0)::int FROM order_licenses l WHERE l.order_id = o.id) AS copies
        FROM orders o WHERE ${where}
       ORDER BY ${input.view === 'open' || input.view === 'packing' ? db`o.paid_at ASC NULLS LAST` : db`o.created_at DESC`}, o.id DESC
       LIMIT ${size} OFFSET ${((input.page ?? 1) - 1) * size}`,
    db<{ n: number }[]>`SELECT count(*)::int AS n FROM orders o WHERE ${where}`,
  ]);
  return { rows, total: count?.n ?? 0 };
}

/** Orders per status; licence orders count separately ("license:<status>"). */
export async function orderCounts(db: Db): Promise<Record<string, number>> {
  const rows = await db<{ status: string; kind: string; n: number }[]>`
    SELECT status, kind, count(*)::int AS n FROM orders GROUP BY status, kind`;
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = r.kind === 'license' ? `license:${r.status}` : r.status;
    out[k] = (out[k] ?? 0) + r.n;
  }
  return out;
}

export async function orderAdmin(db: Db, id: number) {
  const [order] = await db<
    (OrderForDocs & {
      created_at: Date;
      paid_at: Date | null;
      shipped_at: Date | null;
      cancelled_at: Date | null;
      reserved_until: Date | null;
      customer_name: string | null;
      phone: string | null;
      country: string;
      goods_cents: number;
      vat_cents: number;
      payment_method_type: string | null;
      stripe_session_id: string | null;
      tracking_number: string | null;
      carrier: string | null;
      internal_note: string | null;
      lookup_token: string;
      agb_version: number | null;
      kind: 'cards' | 'license';
      seller: 'shop' | 'gmbh';
      buyer_business: boolean;
      buyer_tax_id: string | null;
      buyer_tax_id_type: string | null;
      stripe_customer_id: string | null;
      tax_country: string | null;
    })[]
  >`SELECT * FROM orders WHERE id = ${id}`;
  if (!order) return null;
  const [items, allocations, events, documents, refunds, mails, withdrawals] = await Promise.all([
    db<
      ItemRow[]
    >`SELECT ${db.unsafe(ITEM_COLUMNS)} FROM order_items WHERE order_id = ${id} ORDER BY id`,
    db<{ order_item_id: number; storage_location: string; quantity: number; status: string }[]>`
      SELECT a.order_item_id, a.storage_location, a.quantity, a.status
        FROM order_item_allocations a JOIN order_items i ON i.id = a.order_item_id
       WHERE i.order_id = ${id} AND a.status <> 'released' ORDER BY a.id`,
    db<{ kind: string; detail: Record<string, unknown>; actor: string; created_at: Date }[]>`
      SELECT kind, detail, actor, created_at FROM order_events WHERE order_id = ${id} ORDER BY id`,
    db<
      {
        id: number;
        kind: string;
        number: string;
        issued_at: Date;
        gross_cents: number;
        pdf_key: string | null;
      }[]
    >`
      SELECT id, kind, number, issued_at, gross_cents, pdf_key FROM documents WHERE order_id = ${id} ORDER BY id`,
    db<
      {
        id: number;
        amount_cents: number;
        shipping_cents: number;
        reason: string | null;
        status: string;
        created_by: string | null;
        created_at: Date;
        error: string | null;
        credit_note_number: string | null;
        credit_note_pdf_url: string | null;
      }[]
    >`
      SELECT id, amount_cents, shipping_cents, reason, status, created_by, created_at, error,
             credit_note_number, credit_note_pdf_url
        FROM refunds WHERE order_id = ${id} ORDER BY id`,
    db<
      {
        template: string;
        to_address: string;
        status: string;
        sent_at: Date | null;
        last_error: string | null;
        created_at: Date;
      }[]
    >`
      SELECT template, to_address, status, sent_at, last_error, created_at FROM outbox
       WHERE payload->>'order_id' = ${String(id)} ORDER BY id`,
    db<{ id: number; received_at: Date; items: string | null; handled_at: Date | null }[]>`
      SELECT id, received_at, items, handled_at FROM withdrawals WHERE order_id = ${id} ORDER BY id`,
  ]);
  const [license] = await db<
    {
      quantity: number;
      unit_price_cents: number;
      immediate_delivery_consent_at: Date;
      license_ids: string[];
      issued_at: Date | null;
      revoked_at: Date | null;
      downloads: number;
      last_download_at: Date | null;
      stripe_invoice_id: string | null;
      invoice_number: string | null;
      invoice_url: string | null;
      invoice_pdf_url: string | null;
      terms_version: number | null;
    }[]
  >`SELECT quantity, unit_price_cents, immediate_delivery_consent_at, license_ids, issued_at,
           revoked_at, downloads, last_download_at, stripe_invoice_id, invoice_number,
           invoice_url, invoice_pdf_url, terms_version
      FROM order_licenses WHERE order_id = ${id}`;
  return {
    order,
    items,
    allocations,
    events,
    documents,
    refunds,
    mails,
    withdrawals,
    license: license ?? null,
  };
}

export async function saveInternalNote(sql: Sql, id: number, note: string, actor: string) {
  await sql`UPDATE orders SET internal_note = ${note.trim().slice(0, 4000) || null} WHERE id = ${id}`;
  await orderEvent(sql, id, 'note', {}, actor);
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

export async function listWithdrawals(db: Db, open: boolean) {
  return db<
    {
      id: number;
      order_id: number | null;
      order_number: string | null;
      name: string;
      email: string;
      items: string | null;
      order_date: string | null;
      message: string | null;
      received_at: Date;
      acknowledged_at: Date | null;
      handled_at: Date | null;
      handled_by: string | null;
      note: string | null;
      order_status: string | null;
    }[]
  >`SELECT w.*, o.status AS order_status FROM withdrawals w LEFT JOIN orders o ON o.id = w.order_id
     WHERE ${open ? db`w.handled_at IS NULL` : db`true`}
     ORDER BY w.received_at DESC LIMIT 200`;
}

export async function markWithdrawalHandled(sql: Sql, id: number, actor: string, note: string) {
  await sql`UPDATE withdrawals SET handled_at = now(), handled_by = ${actor},
                   note = ${note.trim().slice(0, 2000) || null} WHERE id = ${id}`;
}

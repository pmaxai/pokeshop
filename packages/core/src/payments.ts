// Payment provider: Stripe Checkout in production, a local stand-in for development and tests.
// The shop only talks to this interface, so order logic is tested without the network.
//
// Two sellers, two Stripe accounts: the shop (cards, sole trader) and Antalyse GmbH (app
// licences). The GmbH's account computes VAT with Stripe Tax and issues invoices and credit
// notes itself.
import { randomBytes } from 'node:crypto';
import PDFDocument from 'pdfkit';
import Stripe from 'stripe';

export type Seller = 'shop' | 'gmbh';
export const SELLERS: readonly Seller[] = ['shop', 'gmbh'];

/** Stripe customer for a GmbH sale: Stripe Tax works out the VAT from address and tax id. */
export type CustomerInput = {
  orderId: number;
  orderNumber: string;
  email: string;
  name: string;
  company?: string;
  locale: 'de' | 'en';
  address: { line1: string; postcode: string; city: string; country: string };
  /** Business buyer's tax id in Stripe's types (eu_vat, ch_vat, us_ein …). */
  taxId?: { type: string; value: string } | null;
  /** 'reverse': business abroad, the buyer accounts for the tax (reverse charge). */
  taxExempt: 'none' | 'reverse';
};

export type SessionTax = {
  /** Unit amounts include the tax ('inclusive') or Stripe adds it ('exclusive'). */
  behavior: 'inclusive' | 'exclusive';
  /** Stripe product tax code, e.g. txcd_10202000 (downloadable software, personal use). */
  code: string;
};

export type SessionInput = {
  orderId: number;
  orderNumber: string;
  email: string;
  locale: 'de' | 'en';
  lines: { name: string; description?: string; unitAmount: number; quantity: number }[];
  successUrl: string;
  cancelUrl: string;
  /** Unix seconds; Stripe needs at least 30 minutes, the shop expires the session itself. */
  expiresAt: number;
  /** Existing Stripe customer (GmbH): replaces the e-mail field on the payment page. */
  customerId?: string;
  /** Stripe Tax computes the VAT (GmbH). */
  tax?: SessionTax;
  /** Stripe issues the invoice (GmbH): footer and extra fields printed on it. */
  invoice?: { footer: string; fields: { name: string; value: string }[] };
  /** Discount code and vouchers, taken off the lines' sum (a one-time Stripe coupon). */
  discount?: { amount: number; label: string };
};

export type SessionTaxLine = {
  amount: number;
  /** Rate in basis points (2000 = 20 %); null if Stripe gave none. */
  rateBp: number | null;
  country: string | null;
  /** Stripe's taxability reason: standard_rated, reverse_charge, not_collecting … */
  reason: string | null;
};

export type SessionInfo = {
  id: string;
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
  paymentIntentId: string | null;
  paymentMethodType: string | null;
  amountTotal: number | null;
  orderId: number | null;
  /** Tax in the total (Stripe Tax); null when the session computed none. */
  amountTax?: number | null;
  taxes?: SessionTaxLine[];
  /** The invoice Stripe created for the payment (invoice_creation). */
  invoiceId?: string | null;
};

export type InvoiceInfo = {
  id: string;
  /** Set once Stripe has finalised the invoice. */
  number: string | null;
  status: string | null;
  pdfUrl: string | null;
  hostedUrl: string | null;
};

export type CreditNoteInfo = {
  id: string;
  number: string;
  total: number;
  pdfUrl: string | null;
  /** The refund Stripe made with the credit note. */
  refundId: string | null;
};

/** Stripe events reduced to what the shop acts on. */
export type PaymentEvent =
  | {
      id: string;
      type:
        | 'checkout.session.completed'
        | 'checkout.session.async_payment_succeeded'
        | 'checkout.session.async_payment_failed'
        | 'checkout.session.expired';
      sessionId: string;
    }
  | { id: string; type: 'charge.refunded'; paymentIntentId: string; amountRefunded: number }
  | { id: string; type: 'charge.dispute.created'; paymentIntentId: string; amount: number }
  | { id: string; type: 'other'; stripeType: string };

export interface PaymentProvider {
  readonly name: 'stripe' | 'fake';
  /** Whose Stripe account this is. */
  readonly seller: Seller;
  createSession(input: SessionInput): Promise<{ id: string; url: string }>;
  getSession(id: string): Promise<SessionInfo>;
  /** Closes an open session. 'complete' means it was paid before it could be closed. */
  expireSession(id: string): Promise<'expired' | 'complete'>;
  refund(input: {
    paymentIntentId: string;
    amount: number;
    idempotencyKey: string;
  }): Promise<{ id: string; status: string }>;
  createCustomer(input: CustomerInput): Promise<string>;
  getInvoice(id: string): Promise<InvoiceInfo>;
  /**
   * Credits a paid invoice in full – every line, so Stripe Tax reverses the VAT – and refunds
   * the payment with it.
   */
  creditInvoice(input: {
    invoiceId: string;
    memo: string;
    idempotencyKey: string;
  }): Promise<CreditNoteInfo>;
  /** PDF of a Stripe invoice or credit note, for the e-mail. */
  documentPdf(doc: { kind: 'invoice' | 'credit_note'; id: string }): Promise<Buffer>;
}

/** Stripe refused the buyer's details: the tax id's format, or an address it cannot place. */
export class CustomerRejected extends Error {
  readonly field: 'tax_id' | 'address';
  constructor(field: 'tax_id' | 'address', message: string) {
    super(message);
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

export type StripeOptions = {
  secretKey: string;
  webhookSecret?: string;
  /** Allowed payment methods; card covers Apple Pay and Google Pay. */
  paymentMethods?: string[];
  seller?: Seller;
  /** The account's own tax ids (txi_…) printed on its invoices; else the dashboard default. */
  accountTaxIds?: string[];
  client?: Stripe;
  fetch?: typeof fetch;
};

export const DEFAULT_PAYMENT_METHODS = ['card', 'eps', 'paypal'];

function toSessionInfo(s: Stripe.Checkout.Session): SessionInfo {
  const pi = s.payment_intent;
  const piId = typeof pi === 'string' ? pi : (pi?.id ?? null);
  let method: string | null = null;
  if (pi && typeof pi !== 'string') {
    const pm = pi.payment_method;
    method = pm && typeof pm !== 'string' ? pm.type : null;
  }
  const orderId = Number(s.metadata?.order_id ?? NaN);
  const taxes = (s.total_details?.breakdown?.taxes ?? []).map((t) => ({
    amount: t.amount,
    rateBp: typeof t.rate?.percentage === 'number' ? Math.round(t.rate.percentage * 100) : null,
    country: t.rate?.country ?? null,
    reason: t.taxability_reason ?? null,
  }));
  return {
    id: s.id,
    status: (s.status ?? 'open') as SessionInfo['status'],
    paymentStatus: s.payment_status as SessionInfo['paymentStatus'],
    paymentIntentId: piId,
    paymentMethodType: method,
    amountTotal: s.amount_total ?? null,
    orderId: Number.isSafeInteger(orderId) ? orderId : null,
    amountTax: s.automatic_tax?.enabled ? (s.total_details?.amount_tax ?? 0) : null,
    taxes,
    invoiceId: typeof s.invoice === 'string' ? s.invoice : (s.invoice?.id ?? null),
  };
}

/**
 * Stripe's PDF links are public but unguessable. The link must be Stripe's; Stripe may redirect
 * to wherever it stores the file, so the answer is checked for being a PDF instead.
 */
const STRIPE_FILE_HOST = /^https:\/\/([a-z0-9-]+\.)*stripe\.com\//;
const MAX_PDF_BYTES = 10 * 1024 * 1024;

async function fetchStripePdf(url: string, doFetch: typeof fetch): Promise<Buffer> {
  if (!STRIPE_FILE_HOST.test(url)) throw new Error('not a Stripe document link');
  const res = await doFetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Stripe PDF ${res.status}`);
  if (!(res.url || url).startsWith('https://')) throw new Error('Stripe PDF left HTTPS');
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_PDF_BYTES || body.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('Stripe did not return a PDF');
  }
  return body;
}

export function stripeProvider(opts: StripeOptions): PaymentProvider & {
  parseWebhook(raw: string, signature: string): PaymentEvent;
} {
  const stripe =
    opts.client ?? new Stripe(opts.secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
  const methods = opts.paymentMethods?.length ? opts.paymentMethods : DEFAULT_PAYMENT_METHODS;
  const doFetch = opts.fetch ?? fetch;
  const meta = (input: { orderId: number; orderNumber: string }) => ({
    order_id: String(input.orderId),
    order_number: input.orderNumber,
  });
  return {
    name: 'stripe',
    seller: opts.seller ?? 'shop',
    async createSession(input) {
      // One coupon per order, for exactly its reduction; Stripe Tax and the GmbH's invoice
      // then work from the reduced price.
      const coupon = input.discount
        ? await stripe.coupons.create(
            {
              amount_off: input.discount.amount,
              currency: 'eur',
              duration: 'once',
              max_redemptions: 1,
              name: input.discount.label.slice(0, 40),
              metadata: meta(input),
            },
            { idempotencyKey: `order-${input.orderId}-coupon-${input.discount.amount}` },
          )
        : null;
      const s = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          locale: input.locale,
          ...(input.customerId ? { customer: input.customerId } : { customer_email: input.email }),
          client_reference_id: input.orderNumber,
          allowed_payment_method_types: methods,
          line_items: input.lines.map((l) => ({
            quantity: l.quantity,
            price_data: {
              currency: 'eur',
              unit_amount: l.unitAmount,
              ...(input.tax ? { tax_behavior: input.tax.behavior } : {}),
              product_data: {
                name: l.name,
                ...(l.description ? { description: l.description } : {}),
                ...(input.tax ? { tax_code: input.tax.code } : {}),
              },
            },
          })),
          ...(input.tax ? { automatic_tax: { enabled: true } } : {}),
          ...(coupon ? { discounts: [{ coupon: coupon.id }] } : {}),
          ...(input.invoice
            ? {
                invoice_creation: {
                  enabled: true,
                  invoice_data: {
                    footer: input.invoice.footer.slice(0, 5000),
                    custom_fields: input.invoice.fields.slice(0, 4).map((f) => ({
                      name: f.name.slice(0, 40),
                      value: f.value.slice(0, 140),
                    })),
                    metadata: meta(input),
                    ...(opts.accountTaxIds?.length ? { account_tax_ids: opts.accountTaxIds } : {}),
                    rendering_options: {
                      amount_tax_display:
                        input.tax?.behavior === 'exclusive'
                          ? 'exclude_tax'
                          : 'include_inclusive_tax',
                    },
                  },
                },
              }
            : {}),
          metadata: meta(input),
          payment_intent_data: {
            description: input.orderNumber,
            metadata: { order_id: String(input.orderId), order_number: input.orderNumber },
          },
          expires_at: input.expiresAt,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
        },
        { idempotencyKey: `order-${input.orderId}-session` },
      );
      if (!s.url) throw new Error('Stripe returned a session without URL');
      return { id: s.id, url: s.url };
    },
    async getSession(id) {
      return toSessionInfo(
        await stripe.checkout.sessions.retrieve(id, {
          // The tax breakdown (rate, country, reverse charge) is only sent when asked for.
          expand: ['payment_intent.payment_method', 'total_details.breakdown'],
        }),
      );
    },
    async expireSession(id) {
      try {
        await stripe.checkout.sessions.expire(id);
        return 'expired';
      } catch (e) {
        // Only open sessions can be expired: find out what happened instead.
        const s = await stripe.checkout.sessions.retrieve(id);
        if (s.status === 'complete') return 'complete';
        if (s.status === 'expired') return 'expired';
        throw e;
      }
    },
    async refund(input) {
      const r = await stripe.refunds.create(
        { payment_intent: input.paymentIntentId, amount: input.amount },
        { idempotencyKey: input.idempotencyKey },
      );
      return { id: r.id, status: r.status ?? 'pending' };
    },
    async createCustomer(input) {
      try {
        const c = await stripe.customers.create(
          {
            email: input.email,
            // The invoice shows the company with the buyer's name below it.
            name: input.company || input.name,
            ...(input.company ? { individual_name: input.name } : {}),
            address: {
              line1: input.address.line1,
              postal_code: input.address.postcode,
              city: input.address.city,
              country: input.address.country,
            },
            preferred_locales: [input.locale],
            tax_exempt: input.taxExempt,
            // Fail here, with a clear field, rather than on the payment page.
            tax: { validate_location: 'immediately' },
            ...(input.taxId
              ? {
                  tax_id_data: [
                    {
                      type: input.taxId.type as Stripe.CustomerCreateParams.TaxIdDatum.Type,
                      value: input.taxId.value,
                    },
                  ],
                }
              : {}),
            metadata: meta(input),
          },
          { idempotencyKey: `order-${input.orderId}-customer` },
        );
        return c.id;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'tax_id_invalid') throw new CustomerRejected('tax_id', (e as Error).message);
        if (code === 'customer_tax_location_invalid')
          throw new CustomerRejected('address', (e as Error).message);
        throw e;
      }
    },
    async getInvoice(id) {
      const i = await stripe.invoices.retrieve(id);
      return {
        id: i.id ?? id,
        number: i.number ?? null,
        status: i.status ?? null,
        pdfUrl: i.invoice_pdf ?? null,
        hostedUrl: i.hosted_invoice_url ?? null,
      };
    },
    async creditInvoice(input) {
      const inv = await stripe.invoices.retrieve(input.invoiceId);
      const lines: Stripe.CreditNoteCreateParams.Line[] = [];
      for await (const l of stripe.invoices.listLineItems(input.invoiceId, { limit: 100 })) {
        lines.push({
          type: 'invoice_line_item',
          invoice_line_item: l.id,
          quantity: l.quantity ?? 1,
        });
      }
      const cn = await stripe.creditNotes.create(
        {
          invoice: input.invoiceId,
          lines,
          refund_amount: inv.amount_paid,
          reason: 'order_change',
          memo: input.memo.slice(0, 500) || undefined,
          email_type: 'none',
          expand: ['refunds.refund'],
        },
        { idempotencyKey: input.idempotencyKey },
      );
      const first = cn.refunds?.[0]?.refund;
      return {
        id: cn.id,
        number: cn.number,
        total: cn.total,
        pdfUrl: cn.pdf ?? null,
        refundId: typeof first === 'string' ? first : (first?.id ?? null),
      };
    },
    async documentPdf(doc) {
      const url =
        doc.kind === 'invoice'
          ? (await stripe.invoices.retrieve(doc.id)).invoice_pdf
          : (await stripe.creditNotes.retrieve(doc.id)).pdf;
      if (!url) throw new Error(`Stripe ${doc.kind} ${doc.id} has no PDF yet`);
      return fetchStripePdf(url, doFetch);
    },
    parseWebhook(raw, signature) {
      if (!opts.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
      const e = stripe.webhooks.constructEvent(raw, signature, opts.webhookSecret);
      return normaliseStripeEvent(e);
    },
  };
}

export function normaliseStripeEvent(e: Stripe.Event): PaymentEvent {
  switch (e.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      return { id: e.id, type: e.type, sessionId: e.data.object.id };
    case 'charge.refunded': {
      const c = e.data.object;
      const pi = typeof c.payment_intent === 'string' ? c.payment_intent : c.payment_intent?.id;
      return {
        id: e.id,
        type: 'charge.refunded',
        paymentIntentId: pi ?? '',
        amountRefunded: c.amount_refunded,
      };
    }
    case 'charge.dispute.created': {
      const d = e.data.object;
      const pi = typeof d.payment_intent === 'string' ? d.payment_intent : d.payment_intent?.id;
      return {
        id: e.id,
        type: 'charge.dispute.created',
        paymentIntentId: pi ?? '',
        amount: d.amount,
      };
    }
    default:
      return { id: e.id, type: 'other', stripeType: e.type };
  }
}

// ---------------------------------------------------------------------------
// Local stand-in: sessions live in memory; /dev/zahlung/<id> plays the Stripe page.
// For the GmbH it also plays Stripe Tax (standard rates) and Stripe's invoices.
// ---------------------------------------------------------------------------

type FakeSession = SessionInfo & { input: SessionInput };
type FakeCustomer = CustomerInput & { id: string };
type FakeRefund = { paymentIntentId: string; amount: number; idempotencyKey: string };

/** Stripe Tax as the stand-in sees it: standard rate of an EU country, nothing elsewhere. */
function fakeTax(
  input: SessionInput,
  customer: FakeCustomer | undefined,
): Pick<SessionInfo, 'amountTotal' | 'amountTax' | 'taxes'> {
  const sum =
    input.lines.reduce((a, l) => a + l.unitAmount * l.quantity, 0) - (input.discount?.amount ?? 0);
  if (!input.tax) return { amountTotal: sum, amountTax: null, taxes: [] };
  const country = customer?.address.country ?? 'AT';
  const rate = (FAKE_EU_RATES as Record<string, number>)[country];
  if (customer?.taxExempt === 'reverse' || rate === undefined) {
    const reason = customer?.taxExempt === 'reverse' ? 'reverse_charge' : 'not_collecting';
    return {
      amountTotal: sum,
      amountTax: 0,
      taxes: [{ amount: 0, rateBp: 0, country, reason }],
    };
  }
  const tax =
    input.tax.behavior === 'inclusive'
      ? sum - Math.round((sum * 10_000) / (10_000 + rate))
      : Math.round((sum * rate) / 10_000);
  return {
    amountTotal: input.tax.behavior === 'inclusive' ? sum : sum + tax,
    amountTax: tax,
    taxes: [{ amount: tax, rateBp: rate, country, reason: 'standard_rated' }],
  };
}

/** Same seed rates as vat.ts (kept here so the stand-in has no other dependency). */
const FAKE_EU_RATES = {
  AT: 2000,
  BE: 2100,
  BG: 2000,
  CY: 1900,
  CZ: 2100,
  DE: 1900,
  DK: 2500,
  EE: 2400,
  ES: 2100,
  FI: 2550,
  FR: 2000,
  GR: 2400,
  HR: 2500,
  HU: 2700,
  IE: 2300,
  IT: 2200,
  LT: 2100,
  LU: 1700,
  LV: 2100,
  MT: 1800,
  NL: 2100,
  PL: 2300,
  PT: 2300,
  RO: 2100,
  SE: 2500,
  SI: 2200,
  SK: 2300,
} as const;

/** Invoice and credit-note numbers derive from the id, so any process can show them. */
const fakeNumber = (prefix: string, id: string) => `${prefix}-${id.slice(-8).toUpperCase()}`;

async function fakePdf(title: string, lines: string[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: title } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) =>
    doc.on('end', () => resolve(Buffer.concat(chunks))),
  );
  doc.fontSize(18).text(title);
  doc.moveDown().fontSize(11);
  for (const l of lines) doc.text(l);
  doc.end();
  return done;
}

export function fakeProvider(
  baseUrl: string,
  seller: Seller = 'shop',
): PaymentProvider & {
  sessions: Map<string, FakeSession>;
  customers: Map<string, FakeCustomer>;
  /** What the Stripe page does when the buyer pays: returns the webhook event to process. */
  pay(id: string, method?: string): PaymentEvent;
  refunds: FakeRefund[];
  creditNotes: (CreditNoteInfo & { invoiceId: string; memo: string })[];
} {
  // One store per process and seller, so the web app's server actions and pages share it.
  const g = globalThis as unknown as Record<string, unknown>;
  const key = seller === 'shop' ? '__pokeshopFakeSessions' : `__pokeshopFakeSessions_${seller}`;
  const store = (g[key] ??= new Map<string, FakeSession>()) as Map<string, FakeSession>;
  const customers = (g[`${key}_customers`] ??= new Map<string, FakeCustomer>()) as Map<
    string,
    FakeCustomer
  >;
  const invoices = (g[`${key}_invoices`] ??= new Map<string, { total: number }>()) as Map<
    string,
    { total: number }
  >;
  const refunds: FakeRefund[] = [];
  const creditNotes: (CreditNoteInfo & { invoiceId: string; memo: string })[] = [];
  const prefix = seller === 'shop' ? 'cs_fake_' : `cs_fake${seller}_`;
  return {
    name: 'fake',
    seller,
    sessions: store,
    customers,
    refunds,
    creditNotes,
    async createSession(input) {
      const id = `${prefix}${randomBytes(12).toString('hex')}`;
      const customer = input.customerId ? customers.get(input.customerId) : undefined;
      if (input.customerId && !customer) throw new Error(`unknown customer ${input.customerId}`);
      store.set(id, {
        id,
        status: 'open',
        paymentStatus: 'unpaid',
        paymentIntentId: null,
        paymentMethodType: null,
        ...fakeTax(input, customer),
        orderId: input.orderId,
        invoiceId: null,
        input,
      });
      return { id, url: `${baseUrl}/dev/zahlung/${id}` };
    },
    async getSession(id) {
      const s = store.get(id);
      if (!s) throw new Error(`unknown session ${id}`);
      const { input: _input, ...info } = s;
      return info;
    },
    async expireSession(id) {
      const s = store.get(id);
      if (!s) return 'expired';
      if (s.status === 'complete') return 'complete';
      s.status = 'expired';
      return 'expired';
    },
    async refund(input) {
      refunds.push(input);
      return { id: `re_fake_${refunds.length}`, status: 'succeeded' };
    },
    async createCustomer(input) {
      if (input.taxId && /INVALID/i.test(input.taxId.value)) {
        throw new CustomerRejected('tax_id', 'Invalid value for eu_vat.');
      }
      const id = `cus_fake_${randomBytes(8).toString('hex')}`;
      customers.set(id, { ...input, id });
      return id;
    },
    async getInvoice(id) {
      return {
        id,
        number: fakeNumber('TEST', id),
        status: 'paid',
        pdfUrl: null,
        hostedUrl: null,
      };
    },
    async creditInvoice(input) {
      const id = `cn_fake_${randomBytes(8).toString('hex')}`;
      const total = invoices.get(input.invoiceId)?.total ?? 0;
      refunds.push({
        paymentIntentId: `invoice:${input.invoiceId}`,
        amount: total,
        idempotencyKey: input.idempotencyKey,
      });
      const cn = {
        id,
        number: fakeNumber('TESTGS', id),
        total,
        pdfUrl: null,
        refundId: `re_fake_cn_${refunds.length}`,
        invoiceId: input.invoiceId,
        memo: input.memo,
      };
      creditNotes.push(cn);
      const { invoiceId: _i, memo: _m, ...info } = cn;
      return info;
    },
    async documentPdf(doc) {
      const number = fakeNumber(doc.kind === 'invoice' ? 'TEST' : 'TESTGS', doc.id);
      return fakePdf(
        doc.kind === 'invoice' ? `Testrechnung ${number}` : `Test-Gutschrift ${number}`,
        [
          'Lokaler Stripe-Ersatz: kein echter Beleg.',
          `Verkäufer-Konto: ${seller}`,
          `Stripe-ID: ${doc.id}`,
        ],
      );
    },
    pay(id, method = 'card') {
      const s = store.get(id);
      if (!s || s.status !== 'open') throw new Error('session is not open');
      s.status = 'complete';
      s.paymentStatus = 'paid';
      s.paymentIntentId = `pi_fake_${randomBytes(8).toString('hex')}`;
      s.paymentMethodType = method;
      if (s.input.invoice) {
        s.invoiceId = `in_fake_${randomBytes(8).toString('hex')}`;
        invoices.set(s.invoiceId, { total: s.amountTotal ?? 0 });
      }
      return {
        id: `evt_fake_${randomBytes(8).toString('hex')}`,
        type: 'checkout.session.completed',
        sessionId: id,
      };
    },
  };
}

const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const list = (v: string | undefined) =>
  v
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Provider of one seller from the environment: Stripe when its secret key is set
 * (STRIPE_SECRET_KEY for the shop, STRIPE_LICENSE_SECRET_KEY for the GmbH), otherwise the
 * local stand-in – but only while PUBLIC_BASE_URL points to localhost, so a real shop can
 * never take orders without Stripe.
 */
export function paymentsFromEnv(env: NodeJS.ProcessEnv = process.env, seller: Seller = 'shop') {
  const base = env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
  const v = (name: string) => env[seller === 'shop' ? `STRIPE_${name}` : `STRIPE_LICENSE_${name}`];
  const secretKey = v('SECRET_KEY');
  if (secretKey) {
    return stripeProvider({
      secretKey,
      webhookSecret: v('WEBHOOK_SECRET'),
      paymentMethods: list(v('PAYMENT_METHODS')),
      accountTaxIds: list(v('ACCOUNT_TAX_IDS')),
      seller,
    });
  }
  if (LOCALHOST.test(base)) return fakeProvider(base, seller);
  return null;
}

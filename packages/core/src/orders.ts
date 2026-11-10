// Orders: checkout with the 10-minute hold, payment results from Stripe, late payments,
// invoices. Stock always moves through the SQL functions of migration 0003.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Db, Sql, Tx } from './db.ts';
import { isPgError, SQLSTATE } from './db.ts';
import { emptyCart, loadCart, saveCheckoutDraft } from './cart.ts';
import { cardNames, translationText } from './catalog.ts';
import type { CheckoutProblem } from './checkout.ts';
import { currentLegalVersions } from './legal.ts';
import { licenseOrderPaid, licensePaymentLine, queueLicenseRevoke } from './licenses.ts';
import { newOrderNumber } from './numbering.ts';
import { alertShop, enqueueMail, enqueueShopMail } from './outbox.ts';
import type { PaymentEvent, PaymentProvider, SessionInfo, SessionInput } from './payments.ts';
import { reservedUntil, stripeSessionExpiresAt } from './reservation.ts';
import { orderVat, type VatRegime } from './vat.ts';
import {
  cartCodes,
  holdRedemptions,
  orderRedemptions,
  priceCartCodes,
  reholdRedemptions,
} from './vouchers.ts';
import { giftVoucherOrderPaid, giftVoucherPaymentLine } from './gift-vouchers.ts';

// ---------------------------------------------------------------------------
// Checkout form
// ---------------------------------------------------------------------------

const POSTCODE: Record<string, RegExp> = { AT: /^\d{4}$/, DE: /^\d{5}$/ };

/** Postcode format by country (exact for AT and DE, loose elsewhere). */
export function validPostcode(country: string, postcode: string): boolean {
  return (POSTCODE[country] ?? /^[A-Z0-9][A-Z0-9 -]{1,9}$/i).test(postcode);
}

const required = (max: number) => z.string().trim().min(1, 'required').max(max, 'too_long');
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'too_long')
    .transform((v) => v || undefined)
    .optional();

export const Address = z
  .object({
    name: required(100),
    company: optional(100),
    street: required(120),
    postcode: z.string().trim().min(1, 'required').max(10, 'too_long'),
    city: required(80),
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'required'),
  })
  .superRefine((a, ctx) => {
    if (a.postcode && !validPostcode(a.country, a.postcode))
      ctx.addIssue({ code: 'custom', path: ['postcode'], message: 'invalid_postcode' });
  });
export type Address = z.infer<typeof Address>;

export const CheckoutDetails = z.object({
  email: z.email('invalid_email').trim().toLowerCase().max(200, 'too_long'),
  phone: optional(40),
  shipping: Address,
  billing: Address.optional(),
  acceptTerms: z.literal(true, 'terms'),
});
export type CheckoutDetails = z.infer<typeof CheckoutDetails>;

/** Validates the form; errors are keyed by field path, e.g. "shipping.postcode". */
export function validateCheckout(
  input: unknown,
): { ok: true; data: CheckoutDetails } | { ok: false; errors: Record<string, string> } {
  const r = CheckoutDetails.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  const errors: Record<string, string> = {};
  for (const i of r.error.issues) {
    const k = i.path.join('.') || '_';
    errors[k] ??= i.message.startsWith('Invalid') ? 'invalid' : i.message;
  }
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------
// Creating the order and the hold
// ---------------------------------------------------------------------------

export class CheckoutRejected extends Error {
  readonly problems: CheckoutProblem[];
  constructor(problems: CheckoutProblem[]) {
    super(`checkout rejected: ${problems.map((p) => p.code).join(', ')}`);
    this.problems = problems;
  }
}

export type CreatedOrder = {
  id: number;
  number: string;
  token: string;
  totalCents: number;
  /** What Stripe collects: the total less bought vouchers. 0 = no payment page. */
  dueCents: number;
  reservedUntil: Date;
  /** Stripe sessions of earlier attempts from the same cart, to be closed. */
  replacedSessions: string[];
};

export async function orderEvent(
  db: Db,
  orderId: number,
  kind: string,
  detail: Record<string, unknown> = {},
  actor = 'system',
): Promise<void> {
  await db`INSERT INTO order_events (order_id, kind, detail, actor)
           VALUES (${orderId}, ${kind}, ${db.json(detail as never)}, ${actor})`;
}

/**
 * Turns the cart into an order and reserves the cards for `reservationMinutes`.
 * All-or-nothing: if a card is gone, nothing is created and the problems are returned.
 */
export async function createCheckoutOrder(
  sql: Sql,
  input: {
    cartId: string;
    locale: 'de' | 'en';
    details: CheckoutDetails;
    reservationMinutes: number;
    ossEnabled: boolean;
    /** Setting `small_business`: no VAT (Kleinunternehmerregelung). */
    smallBusiness?: boolean;
    now?: Date;
  },
): Promise<CreatedOrder> {
  const now = input.now ?? new Date();
  const d = input.details;
  try {
    return await sql.begin(async (tx) => {
      const [cart] = await tx`SELECT id FROM carts WHERE id = ${input.cartId} FOR UPDATE`;
      if (!cart) throw new CheckoutRejected([{ code: 'empty_cart' }]);

      // A new attempt from the same cart replaces the previous one.
      const previous = await tx<{ id: number; stripe_session_id: string | null }[]>`
        SELECT id, stripe_session_id FROM orders
         WHERE cart_id = ${input.cartId} AND status = 'checkout' FOR UPDATE`;
      for (const p of previous) {
        await tx`SELECT order_release_stock(${p.id})`;
        await tx`UPDATE orders SET status = 'cancelled', cancelled_at = now(), reserved_until = NULL
                  WHERE id = ${p.id}`;
        await orderEvent(tx, p.id, 'replaced_by_new_checkout');
      }

      await tx`UPDATE carts SET country = ${d.shipping.country}, locale = ${input.locale}
                WHERE id = ${input.cartId}
                  AND EXISTS (SELECT 1 FROM countries WHERE code = ${d.shipping.country} AND delivery_enabled)`;
      const view = await loadCart(tx, input.cartId, input.locale);
      if (view.country !== d.shipping.country) {
        throw new CheckoutRejected([
          { code: 'country_not_delivered', country: d.shipping.country },
        ]);
      }
      if (!view.check.ok || !view.check.shipping || view.check.total === null) {
        throw new CheckoutRejected(view.check.problems);
      }
      const country = view.countries.find((c) => c.code === view.country)!;
      // Code and vouchers, checked again under lock and with the buyer's e-mail.
      const codes = await priceCartCodes(tx, {
        codes: await cartCodes(tx, input.cartId),
        lines: view.lines.map((l) => l.lineTotal),
        shipping: view.check.shipping.price,
        email: d.email,
        lock: true,
        now,
      });
      const bad = codes.entries.filter((e) => e.kind === 'invalid');
      if (bad.length) {
        throw new CheckoutRejected(
          bad.map((e) => ({ code: 'code_problem' as const, entry: e.code, problem: e.problem! })),
        );
      }
      const price = codes.pricing;
      const vat = orderVat([{ gross: price.total }], {
        country: view.country,
        ossEnabled: input.ossEnabled,
        smallBusiness: input.smallBusiness ?? false,
        rates: { [view.country]: country.vat_rate_bp },
      });
      const legal = await currentLegalVersions(tx);

      let number = '';
      for (let i = 0; i < 6 && !number; i++) {
        const candidate = newOrderNumber(now);
        const [taken] = await tx`SELECT 1 FROM orders WHERE number = ${candidate}`;
        if (!taken) number = candidate;
      }
      if (!number) throw new Error('could not allocate an order number');
      const token = randomBytes(24).toString('base64url');
      const until = reservedUntil(now, input.reservationMinutes);

      const [o] = await tx<{ id: number }[]>`
        INSERT INTO orders (number, lookup_token, status, locale, country, email, customer_name, phone,
                            billing_address, shipping_address, goods_cents, shipping_cents, total_cents,
                            discount_cents, shipping_discount_cents, voucher_cents,
                            shipping_method, vat_regime, tax_country, vat_rate_bp, vat_cents,
                            reserved_until, agb_version, privacy_version, withdrawal_version,
                            terms_accepted_at, cart_id, created_at)
        VALUES (${number}, ${token}, 'checkout', ${input.locale}, ${view.country}, ${d.email},
                ${d.shipping.name}, ${d.phone ?? null}, ${tx.json((d.billing ?? d.shipping) as never)},
                ${tx.json(d.shipping as never)}, ${view.check.goodsSubtotal},
                ${view.check.shipping.price}, ${price.total}, ${price.discount},
                ${price.shippingDiscount}, ${price.voucher}, ${view.check.shipping.method},
                ${vat.regime}, ${vat.taxCountry}, ${vat.rate}, ${vat.vat}, ${until},
                ${legal.agb}, ${legal.privacy}, ${legal.withdrawal}, ${now}, ${input.cartId}, ${now})
        RETURNING id`;
      const orderId = o!.id;

      await tx`
        INSERT INTO order_items (order_id, product_id, sku, name_de, name_en, name_local, set_code, set_name_de,
                                 set_name_en, card_number, card_language, condition, finish,
                                 unit_price_cents, quantity, high_value)
        SELECT ${orderId}, p.id, p.sku, p.name_de, p.name_en, p.name_local, p.set_code, p.set_name_de, p.set_name_en,
               p.card_number, p.card_language, p.condition, p.finish, p.price_cents, ci.quantity,
               p.high_value
          FROM cart_items ci JOIN products p ON p.id = ci.product_id
         WHERE ci.cart_id = ${input.cartId}
         ORDER BY ci.added_at`;
      const [sum] = await tx<{ goods: number }[]>`
        SELECT coalesce(sum(unit_price_cents * quantity), 0)::int AS goods
          FROM order_items WHERE order_id = ${orderId}`;
      if (sum!.goods !== view.check.goodsSubtotal) {
        throw new Error('cart changed while the order was created');
      }
      // Each line's share of the discount, so refunds pay back what was really paid.
      for (const [i, l] of view.lines.entries()) {
        const share = price.lineDiscounts[i] ?? 0;
        if (share > 0) {
          await tx`UPDATE order_items SET discount_cents = ${share}
                    WHERE order_id = ${orderId} AND product_id = ${l.id}`;
        }
      }
      await holdRedemptions(tx, orderId, d.email, price);

      try {
        await tx.savepoint((sp) => sp`SELECT order_reserve(${orderId})`);
      } catch (e) {
        if (isPgError(e, SQLSTATE.insufficientStock)) {
          throw new CheckoutRejected(
            view.lines.map((l) => ({
              code: 'unavailable' as const,
              productId: l.id,
              requested: l.quantity,
              available: 0,
            })),
          );
        }
        throw e;
      }
      const { acceptTerms: _terms, ...draft } = d;
      await saveCheckoutDraft(tx, input.cartId, draft);
      await orderEvent(tx, orderId, 'created', {
        reserved_until: until.toISOString(),
        ...(price.code ? { code: price.code.code, discount: price.code.amount } : {}),
        ...(price.promo.length || price.paid.length
          ? { vouchers: [...price.promo, ...price.paid].map((v) => [v.code, v.amount]) }
          : {}),
      });
      return {
        id: orderId,
        number,
        token,
        totalCents: price.total,
        dueCents: price.due,
        reservedUntil: until,
        replacedSessions: previous.map((p) => p.stripe_session_id).filter((s): s is string => !!s),
      };
    });
  } catch (e) {
    if (e instanceof CheckoutRejected) {
      // The cart page shows exactly which card is gone.
      if (e.problems.some((p) => p.code === 'unavailable' && p.available === 0)) {
        const view = await loadCart(sql, input.cartId, input.locale);
        if (view.check.problems.length) throw new CheckoutRejected(view.check.problems);
      }
    }
    throw e;
  }
}

/** Line items for the payment page, in the buyer's language. */
async function paymentLines(db: Db, orderId: number, locale: 'de' | 'en') {
  const items = await db<
    {
      name_de: string;
      name_en: string;
      name_local: string | null;
      set_name_de: string | null;
      set_name_en: string | null;
      card_number: string;
      card_language: string;
      condition: string;
      unit_price_cents: number;
      quantity: number;
    }[]
  >`SELECT name_de, name_en, name_local, set_name_de, set_name_en, card_number, card_language,
           condition, unit_price_cents, quantity FROM order_items WHERE order_id = ${orderId} ORDER BY id`;
  const [o] = await db<{ shipping_cents: number; shipping_method: string }[]>`
    SELECT shipping_cents, shipping_method FROM orders WHERE id = ${orderId}`;
  const lines = items.map((i) => {
    const names = cardNames(
      {
        cardLanguage: i.card_language,
        nameDe: i.name_de,
        nameEn: i.name_en,
        nameLocal: i.name_local,
      },
      locale,
    );
    return {
      name: `${names.original} ${i.card_number}`,
      description: [
        ...names.translations.map(translationText),
        locale === 'en' ? (i.set_name_en ?? i.set_name_de) : (i.set_name_de ?? i.set_name_en),
        i.card_language,
        i.condition,
      ]
        .filter(Boolean)
        .join(' · '),
      unitAmount: i.unit_price_cents,
      quantity: i.quantity,
    };
  });
  const license = await licensePaymentLine(db, orderId, locale);
  if (license) lines.push(license);
  const gift = await giftVoucherPaymentLine(db, orderId, locale);
  if (gift) lines.push(gift);
  if (o && o.shipping_cents > 0) {
    lines.push({
      name: locale === 'en' ? 'Insured shipping' : 'Versicherter Versand',
      description: '',
      unitAmount: o.shipping_cents,
      quantity: 1,
    });
  }
  return lines;
}

/**
 * Opens the payment page for a fresh order. If that fails the hold is released at once,
 * so no card stays blocked by an order that cannot be paid.
 */
export async function startPayment(
  sql: Sql,
  provider: PaymentProvider,
  order: CreatedOrder,
  input: {
    email: string;
    locale: 'de' | 'en';
    successUrl: string;
    cancelUrl: string;
    now?: Date;
  } & Pick<SessionInput, 'customerId' | 'tax' | 'invoice'>,
): Promise<string> {
  for (const s of order.replacedSessions) {
    const r = await provider.expireSession(s).catch(() => null);
    if (r === 'complete') await syncSession(sql, provider, s);
  }
  try {
    const session = await provider.createSession({
      orderId: order.id,
      orderNumber: order.number,
      email: input.email,
      locale: input.locale,
      lines: await paymentLines(sql, order.id, input.locale),
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      expiresAt: stripeSessionExpiresAt(input.now ?? new Date()),
      customerId: input.customerId,
      tax: input.tax,
      invoice: input.invoice,
      discount: await paymentDiscount(sql, order.id, input.locale),
    });
    await sql`UPDATE orders SET stripe_session_id = ${session.id}, payment_url = ${session.url}
               WHERE id = ${order.id}`;
    await orderEvent(sql, order.id, 'payment_started', { session: session.id });
    return session.url;
  } catch (e) {
    await releaseOrder(sql, { id: order.id }, 'cancelled', 'payment_page_failed');
    throw e;
  }
}

/**
 * Code, promotional and bought vouchers as one reduction on the payment page (the shop's own
 * invoice shows them apart).
 */
async function paymentDiscount(
  db: Db,
  orderId: number,
  locale: 'de' | 'en',
): Promise<SessionInput['discount']> {
  const [o] = await db<{ discount_cents: number; voucher_cents: number }[]>`
    SELECT discount_cents, voucher_cents FROM orders WHERE id = ${orderId}`;
  const amount = (o?.discount_cents ?? 0) + (o?.voucher_cents ?? 0);
  if (amount <= 0) return undefined;
  const r = await orderRedemptions(db, orderId);
  const parts = [
    r.code ? r.code.code.toUpperCase() : null,
    ...[...r.promo, ...r.paid].map((v) => v.code),
  ].filter(Boolean);
  const vouchers = r.promo.length + r.paid.length > 0;
  const label =
    locale === 'en'
      ? `${r.code && vouchers ? 'Discount and voucher' : vouchers ? 'Voucher' : 'Discount'}`
      : `${r.code && vouchers ? 'Rabatt und Gutschein' : vouchers ? 'Gutschein' : 'Rabatt'}`;
  return { amount, label: `${label} ${parts.join(', ')}`.slice(0, 40) };
}

// ---------------------------------------------------------------------------
// Payment results
// ---------------------------------------------------------------------------

const DONE = ['paid', 'packing', 'shipped', 'completed', 'refunded'];

type OrderRow = {
  id: number;
  number: string;
  kind: 'cards' | 'license' | 'voucher';
  seller: 'shop' | 'gmbh';
  status: string;
  locale: 'de' | 'en';
  email: string | null;
  total_cents: number;
  voucher_cents: number;
  vat_cents: number;
  vat_rate_bp: number;
  cart_id: string | null;
  stripe_session_id: string | null;
};

export type PaidOutcome =
  | { kind: 'paid'; orderId: number }
  | { kind: 'already'; orderId: number }
  | { kind: 'refunded'; orderId: number }
  | { kind: 'refund_pending'; orderId: number }
  | { kind: 'not_paid'; orderId: number | null }
  | { kind: 'unknown_order' };

/**
 * The buyer paid. Commits the held cards (taking them again if the hold had run out),
 * issues the invoice and queues the mails. If the cards are gone by now, the payment is
 * refunded in full and the buyer is told.
 */
export async function processPaidSession(
  sql: Sql,
  provider: PaymentProvider,
  session: SessionInfo,
  now = new Date(),
): Promise<PaidOutcome> {
  if (session.paymentStatus === 'unpaid') return { kind: 'not_paid', orderId: session.orderId };
  const outcome = await sql.begin(async (tx) => {
    const [o] = await tx<OrderRow[]>`
      SELECT id, number, kind, seller, status, locale, email, total_cents, voucher_cents, vat_cents,
             vat_rate_bp, cart_id, stripe_session_id
        FROM orders
       WHERE stripe_session_id = ${session.id}
          OR (${session.orderId}::bigint IS NOT NULL AND id = ${session.orderId}::bigint
              AND stripe_session_id IS NULL)
       FOR UPDATE`;
    // Each seller's sessions come from its own Stripe account (and webhook).
    if (!o || o.seller !== provider.seller) return { kind: 'unknown_order' as const };
    if (DONE.includes(o.status)) return { kind: 'already' as const, orderId: o.id };
    const [pending] =
      await tx`SELECT 1 FROM refunds WHERE order_id = ${o.id} AND status = 'pending'`;
    if (pending) return { kind: 'refund_pending' as const, orderId: o.id };

    await tx`UPDATE orders SET stripe_payment_intent_id = ${session.paymentIntentId},
                               payment_method_type = ${session.paymentMethodType}
              WHERE id = ${o.id}`;
    const due = o.total_cents - o.voucher_cents;
    if (session.amountTotal !== null && session.amountTotal !== due) {
      // GmbH: Stripe Tax decides; a difference means the VAT came out other than expected.
      await alertShop(
        tx,
        `Betrag stimmt nicht: ${o.number}`,
        `Stripe meldet ${session.amountTotal} Cent, offen waren ${due} Cent.`,
        `amount_mismatch:${o.id}`,
      );
    }
    // Paid after the order had been given up: its vouchers were released and must be taken
    // again – if they no longer cover their part, the payment goes back.
    if (['expired', 'payment_failed', 'cancelled'].includes(o.status)) {
      if (!(await reholdRedemptions(tx, o.id))) {
        await tx`UPDATE orders SET status = 'cancelled', cancelled_at = now(), reserved_until = NULL
                  WHERE id = ${o.id}`;
        await tx`INSERT INTO refunds (order_id, amount_cents, reason, status, created_by)
                 VALUES (${o.id}, ${due}, 'cards_sold_out_after_payment', 'pending', 'system')`;
        await orderEvent(tx, o.id, 'vouchers_gone_after_payment', { session: session.id });
        return { kind: 'refund_pending' as const, orderId: o.id };
      }
    }

    if (o.kind === 'voucher') {
      await giftVoucherOrderPaid(tx, o, now);
      await orderEvent(tx, o.id, 'paid', {
        session: session.id,
        method: session.paymentMethodType,
      });
      return { kind: 'paid' as const, orderId: o.id };
    }

    if (o.kind === 'license') {
      // Nothing to take from stock: the worker fetches the keys and mails them.
      await licenseOrderPaid(tx, o, session, now);
      await orderEvent(tx, o.id, 'paid', {
        session: session.id,
        method: session.paymentMethodType,
      });
      return { kind: 'paid' as const, orderId: o.id };
    }

    const r = await cardOrderPaid(tx, o, now, {
      session: session.id,
      method: session.paymentMethodType,
    });
    if (r === 'unavailable') {
      // Vouchers go back with the cancellation (database trigger), the card payment here.
      await tx`INSERT INTO refunds (order_id, amount_cents, reason, status, created_by)
               VALUES (${o.id}, ${due}, 'cards_sold_out_after_payment', 'pending', 'system')`;
      return { kind: 'refund_pending' as const, orderId: o.id };
    }
    return { kind: 'paid' as const, orderId: o.id };
  });
  if (outcome.kind === 'refund_pending') {
    return (await runPendingRefunds(sql, provider, outcome.orderId))
      ? { kind: 'refunded', orderId: outcome.orderId }
      : outcome;
  }
  return outcome;
}

/**
 * Commits the held cards of a paid card order (taking them again if the hold had run out),
 * and queues the mails. 'unavailable': the cards are gone, the order is cancelled.
 */
async function cardOrderPaid(
  tx: Tx,
  o: Pick<OrderRow, 'id' | 'number' | 'locale' | 'email' | 'cart_id'>,
  now: Date,
  detail: { session: string | null; method: string | null },
): Promise<'paid' | 'unavailable'> {
  const [c] = await tx<{ result: string }[]>`
      SELECT order_commit_stock(${o.id}, ${o.number}) AS result`;
  if (c!.result === 'unavailable') {
    await tx`UPDATE orders SET status = 'cancelled', cancelled_at = now(), reserved_until = NULL
                WHERE id = ${o.id}`;
    await orderEvent(tx, o.id, 'sold_out_after_payment', detail);
    return 'unavailable';
  }

  await tx`UPDATE orders SET status = 'paid', paid_at = ${now}, reserved_until = NULL
              WHERE id = ${o.id}`;
  if (o.email) {
    // Terms and withdrawal instructions on a durable medium (§ 7 Abs. 3 FAGG).
    await enqueueMail(tx, {
      template: 'order_confirmation',
      to: o.email,
      locale: o.locale,
      payload: { order_id: o.id },
      attachments: [{ kind: 'legal', kinds: ['agb', 'withdrawal'] }],
      dedupeKey: `order_confirmation:${o.id}`,
    });
  }
  await enqueueShopMail(tx, 'order_notification', { order_id: o.id }, `order_notification:${o.id}`);
  if (o.cart_id) await emptyCart(tx, o.cart_id);
  await orderEvent(tx, o.id, 'paid', { ...detail, stock: c!.result });
  return 'paid';
}

/**
 * An order that code and vouchers cover in full: no payment page, paid at once.
 * 'unavailable' if the cards were sold in the meantime (the vouchers go back).
 */
export async function completeWithoutPayment(
  sql: Sql,
  orderId: number,
  now = new Date(),
): Promise<'paid' | 'unavailable' | 'not_free'> {
  return sql.begin(async (tx) => {
    const [o] = await tx<OrderRow[]>`
      SELECT id, number, kind, seller, status, locale, email, total_cents, voucher_cents, vat_cents,
             vat_rate_bp, cart_id, stripe_session_id
        FROM orders WHERE id = ${orderId} FOR UPDATE`;
    if (!o || o.status !== 'checkout' || o.total_cents - o.voucher_cents !== 0) {
      return 'not_free' as const;
    }
    const method = o.voucher_cents > 0 ? 'voucher' : 'discount';
    await tx`UPDATE orders SET payment_method_type = ${method} WHERE id = ${o.id}`;
    if (o.kind === 'license') {
      await licenseOrderPaid(tx, o, null, now);
      await orderEvent(tx, o.id, 'paid', { method });
      return 'paid' as const;
    }
    if (o.kind !== 'cards') return 'not_free' as const;
    return cardOrderPaid(tx, o, now, { session: null, method });
  });
}

/**
 * Refunds the shop owes (cards sold out after payment). Idempotent: Stripe gets the refund
 * row's id as idempotency key, so a retry never pays out twice.
 */
export async function runPendingRefunds(
  sql: Sql,
  provider: PaymentProvider,
  orderId?: number,
): Promise<boolean> {
  const rows = await sql<
    {
      id: number;
      order_id: number;
      amount_cents: number;
      pi: string | null;
      email: string | null;
      locale: 'de' | 'en';
      number: string;
    }[]
  >`
    SELECT r.id, r.order_id, r.amount_cents, o.stripe_payment_intent_id AS pi, o.email, o.locale, o.number
      FROM refunds r JOIN orders o ON o.id = r.order_id
     WHERE r.status = 'pending' AND r.reason = 'cards_sold_out_after_payment'
       AND o.seller = ${provider.seller}
       AND (${orderId ?? null}::bigint IS NULL OR r.order_id = ${orderId ?? null}::bigint)
     ORDER BY r.id LIMIT 20`;
  let allDone = rows.length > 0;
  for (const r of rows) {
    if (!r.pi && r.amount_cents > 0) {
      allDone = false;
      continue;
    }
    try {
      // Nothing went through Stripe when vouchers paid it all (they are back already).
      const res =
        r.amount_cents > 0
          ? await provider.refund({
              paymentIntentId: r.pi!,
              amount: r.amount_cents,
              idempotencyKey: `refund-${r.id}`,
            })
          : { id: null };
      await sql.begin(async (tx) => {
        await tx`UPDATE refunds SET status = 'succeeded', stripe_refund_id = ${res.id} WHERE id = ${r.id}`;
        await tx`UPDATE orders SET status = 'refunded', refunded_cents = refunded_cents + ${r.amount_cents}
                  WHERE id = ${r.order_id}`;
        await orderEvent(tx, r.order_id, 'refunded', { amount: r.amount_cents, refund: res.id });
        if (r.email) {
          await enqueueMail(tx, {
            template: 'order_unavailable',
            to: r.email,
            locale: r.locale,
            payload: { order_id: r.order_id, amount_cents: r.amount_cents },
            dedupeKey: `order_unavailable:${r.order_id}`,
          });
        }
        await alertShop(
          tx,
          `Automatisch erstattet: ${r.number}`,
          `Die Zahlung kam an, nachdem die Karten schon verkauft waren. ${(r.amount_cents / 100).toFixed(2)} € wurden erstattet.`,
          `auto_refund:${r.order_id}`,
        );
      });
    } catch (e) {
      allDone = false;
      await orderEvent(sql, r.order_id, 'refund_failed', { error: (e as Error).message });
    }
  }
  return allDone;
}

/** Gives the cards of an unpaid order back. Only open orders are touched. */
export async function releaseOrder(
  sql: Sql,
  where: { id: number } | { sessionId: string },
  status: 'expired' | 'payment_failed' | 'cancelled',
  reason: string,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [o] =
      'id' in where
        ? await tx<{ id: number; status: string }[]>`
            SELECT id, status FROM orders WHERE id = ${where.id} FOR UPDATE`
        : await tx<{ id: number; status: string }[]>`
            SELECT id, status FROM orders WHERE stripe_session_id = ${where.sessionId} FOR UPDATE`;
    if (!o || !['checkout', 'awaiting_payment'].includes(o.status)) return false;
    const [r] = await tx<{ n: number }[]>`SELECT order_release_stock(${o.id}) AS n`;
    await tx`UPDATE orders SET status = ${status}, reserved_until = NULL,
                    cancelled_at = CASE WHEN ${status} = 'cancelled' THEN now() END
              WHERE id = ${o.id}`;
    await orderEvent(tx, o.id, status, { reason, released: r!.n });
    return true;
  });
}

/** Re-reads a session from the provider and acts on its current state. */
export async function syncSession(
  sql: Sql,
  provider: PaymentProvider,
  sessionId: string,
): Promise<PaidOutcome | 'released' | 'open'> {
  const s = await provider.getSession(sessionId);
  if (s.status === 'complete' && s.paymentStatus !== 'unpaid') {
    return processPaidSession(sql, provider, s);
  }
  if (s.status === 'expired') {
    await releaseOrder(sql, { sessionId }, 'expired', 'session_expired');
    return 'released';
  }
  return 'open';
}

/**
 * Acts on one webhook event. The state is always re-read from Stripe, so events arriving
 * out of order or twice do no harm.
 */
export async function handlePaymentEvent(
  sql: Sql,
  provider: PaymentProvider,
  event: PaymentEvent,
): Promise<string> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const s = await provider.getSession(event.sessionId);
      if (s.paymentStatus === 'unpaid') {
        // Payment method that confirms later: keep the hold until Stripe reports the result.
        const r = await sql`UPDATE orders SET status = 'awaiting_payment'
                             WHERE stripe_session_id = ${s.id} AND status = 'checkout'`;
        return r.count ? 'awaiting_payment' : 'ignored';
      }
      return (await processPaidSession(sql, provider, s)).kind;
    }
    case 'checkout.session.async_payment_failed':
      return (await releaseOrder(
        sql,
        { sessionId: event.sessionId },
        'payment_failed',
        'async_failed',
      ))
        ? 'payment_failed'
        : 'ignored';
    case 'checkout.session.expired':
      return (await releaseOrder(sql, { sessionId: event.sessionId }, 'expired', 'session_expired'))
        ? 'expired'
        : 'ignored';
    case 'charge.refunded':
      return recordExternalRefund(sql, event.paymentIntentId, event.amountRefunded, event.id);
    case 'charge.dispute.created': {
      const [o] = await sql<{ id: number; number: string }[]>`
        SELECT id, number FROM orders WHERE stripe_payment_intent_id = ${event.paymentIntentId}`;
      if (o) await orderEvent(sql, o.id, 'dispute_opened', { amount: event.amount });
      await alertShop(
        sql,
        `Zahlung angefochten${o ? `: ${o.number}` : ''}`,
        `Ein Kunde hat eine Zahlung über ${(event.amount / 100).toFixed(2)} € angefochten. Bitte im Stripe-Dashboard antworten.`,
        `dispute:${event.id}`,
      );
      return 'alerted';
    }
    default:
      return 'ignored';
  }
}

/**
 * Stripe reports the total refunded on a charge. Refunds the shop made itself are already
 * recorded; anything beyond that was done in the Stripe Dashboard and is recorded here.
 */
export async function recordExternalRefund(
  sql: Sql,
  paymentIntentId: string,
  amountRefunded: number,
  eventId: string,
): Promise<'recorded' | 'known' | 'ignored'> {
  return sql.begin(async (tx) => {
    const [o] = await tx<
      { id: number; number: string; kind: string; seller: string; total_cents: number }[]
    >`
      SELECT id, number, kind, seller, total_cents FROM orders
       WHERE stripe_payment_intent_id = ${paymentIntentId} FOR UPDATE`;
    if (!o) return 'ignored';
    const [k] = await tx<{ s: number }[]>`
      SELECT coalesce(sum(amount_cents), 0)::int AS s FROM refunds
       WHERE order_id = ${o.id} AND status IN ('pending', 'succeeded')`;
    const diff = amountRefunded - (k?.s ?? 0);
    if (diff <= 0) return 'known';
    await tx`INSERT INTO refunds (order_id, amount_cents, reason, status, created_by)
             VALUES (${o.id}, ${diff}, 'refunded_in_stripe_dashboard', 'succeeded', 'stripe')`;
    await tx`UPDATE orders SET refunded_cents = refunded_cents + ${diff},
                    status = CASE WHEN refunded_cents + ${diff} >= total_cents THEN 'refunded' ELSE status END
              WHERE id = ${o.id}`;
    await orderEvent(tx, o.id, 'refunded_in_stripe', { amount: diff });
    if (o.kind === 'license' && amountRefunded >= o.total_cents) {
      // Refunded in full: the licence keys stop working.
      await queueLicenseRevoke(tx, o.id, `refunded in Stripe (${eventId})`);
    }
    await alertShop(
      tx,
      `Erstattung in Stripe: ${o.number}`,
      o.kind === 'license'
        ? `Im Stripe-Dashboard wurden ${(diff / 100).toFixed(2)} € erstattet.${amountRefunded >= o.total_cents ? ' Die Lizenzschlüssel werden gesperrt.' : ' Teilerstattung: die Lizenzen bleiben aktiv.'}${o.seller === 'gmbh' ? ' Bitte im Stripe-Dashboard der GmbH eine Gutschrift zur Rechnung erstellen, falls das nicht schon mit der Erstattung geschehen ist.' : ' Eine Rechnungskorrektur bitte im Admin prüfen.'}`
        : `Im Stripe-Dashboard wurden ${(diff / 100).toFixed(2)} € erstattet. Bestand und Gutschrift bitte im Admin prüfen – der Shop hat keine Karten zurückgebucht.`,
      `stripe_refund:${eventId}`,
    );
    return 'recorded';
  });
}

/** Stores a webhook event once. Returns false when it was already processed. */
export async function claimStripeEvent(
  sql: Sql,
  event: { id: string; type: string; payload: unknown },
): Promise<boolean> {
  await sql`INSERT INTO stripe_events (id, type, payload)
            VALUES (${event.id}, ${event.type}, ${sql.json(event.payload as never)})
            ON CONFLICT (id) DO NOTHING`;
  const [e] = await sql<{ processed_at: Date | null }[]>`
    SELECT processed_at FROM stripe_events WHERE id = ${event.id}`;
  return !e?.processed_at;
}

export async function finishStripeEvent(sql: Sql, id: string, error?: string): Promise<void> {
  if (error) await sql`UPDATE stripe_events SET error = ${error.slice(0, 2000)} WHERE id = ${id}`;
  else await sql`UPDATE stripe_events SET processed_at = now(), error = NULL WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// The 10-minute hold
// ---------------------------------------------------------------------------

/**
 * Worker: closes payments whose hold ran out and gives the cards back. A short grace keeps
 * a payment that is being confirmed right at the deadline from being cut off.
 */
export async function expireHolds(
  sql: Sql,
  provider: PaymentProvider,
  graceSeconds = 60,
): Promise<number> {
  const due = await sql<{ id: number; stripe_session_id: string | null }[]>`
    SELECT id, stripe_session_id FROM orders
     WHERE status = 'checkout' AND seller = ${provider.seller}
       AND reserved_until < now() - make_interval(secs => ${graceSeconds})
     ORDER BY reserved_until LIMIT 25`;
  let released = 0;
  for (const o of due) {
    if (o.stripe_session_id) {
      const r = await provider.expireSession(o.stripe_session_id);
      if (r === 'complete') {
        await syncSession(sql, provider, o.stripe_session_id);
        continue;
      }
    }
    if (await releaseOrder(sql, { id: o.id }, 'expired', 'hold_ran_out')) released++;
  }
  return released;
}

// ---------------------------------------------------------------------------
// Order page for the buyer
// ---------------------------------------------------------------------------

export type CustomerOrder = {
  id: number;
  number: string;
  status: string;
  locale: 'de' | 'en';
  email: string | null;
  createdAt: Date;
  paidAt: Date | null;
  shippedAt: Date | null;
  reservedUntil: Date | null;
  paymentUrl: string | null;
  shippingMethod: string;
  goodsCents: number;
  shippingCents: number;
  totalCents: number;
  /** Discount code and promotional vouchers (lower the total). */
  discountCents: number;
  /** Paid with bought vouchers (part of the total). */
  voucherCents: number;
  redemptions: Awaited<ReturnType<typeof orderRedemptions>>;
  vatCents: number;
  vatRateBp: number;
  vatRegime: VatRegime;
  shippingAddress: Address;
  billingAddress: Address | null;
  trackingNumber: string | null;
  items: {
    productId: number;
    nameDe: string;
    nameEn: string;
    nameLocal: string | null;
    setNameDe: string | null;
    setNameEn: string | null;
    cardNumber: string;
    cardLanguage: string;
    condition: string;
    finish: string;
    unitPriceCents: number;
    quantity: number;
  }[];
};

export async function orderByToken(db: Db, token: string): Promise<CustomerOrder | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [o] = await db<{ id: number }[]>`SELECT id FROM orders WHERE lookup_token = ${token}`;
  return o ? orderById(db, o.id) : null;
}

export async function orderById(db: Db, id: number): Promise<CustomerOrder | null> {
  const [o] = await db<
    {
      id: number;
      number: string;
      status: string;
      locale: 'de' | 'en';
      email: string | null;
      created_at: Date;
      paid_at: Date | null;
      shipped_at: Date | null;
      reserved_until: Date | null;
      payment_url: string | null;
      shipping_method: string;
      goods_cents: number;
      shipping_cents: number;
      total_cents: number;
      discount_cents: number;
      voucher_cents: number;
      vat_cents: number;
      vat_rate_bp: number;
      vat_regime: VatRegime;
      shipping_address: Address;
      billing_address: Address | null;
      tracking_number: string | null;
    }[]
  >`SELECT id, number, status, locale, email, created_at, paid_at, shipped_at, reserved_until, payment_url,
           shipping_method, goods_cents, shipping_cents, total_cents, discount_cents, voucher_cents,
           vat_cents, vat_rate_bp, vat_regime, shipping_address, billing_address, tracking_number
      FROM orders WHERE id = ${id}`;
  if (!o) return null;
  const items = await db<
    {
      product_id: number;
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
    }[]
  >`SELECT product_id, name_de, name_en, name_local, set_name_de, set_name_en, card_number,
           card_language, condition, finish, unit_price_cents, quantity
      FROM order_items WHERE order_id = ${id} ORDER BY id`;
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    locale: o.locale,
    email: o.email,
    createdAt: o.created_at,
    paidAt: o.paid_at,
    shippedAt: o.shipped_at,
    reservedUntil: o.reserved_until,
    paymentUrl: o.status === 'checkout' ? o.payment_url : null,
    shippingMethod: o.shipping_method,
    goodsCents: o.goods_cents,
    shippingCents: o.shipping_cents,
    discountCents: o.discount_cents,
    voucherCents: o.voucher_cents,
    redemptions:
      o.discount_cents + o.voucher_cents > 0
        ? await orderRedemptions(db, o.id)
        : { code: null, promo: [], paid: [] },
    totalCents: o.total_cents,
    vatCents: o.vat_cents,
    vatRateBp: o.vat_rate_bp,
    vatRegime: o.vat_regime,
    shippingAddress: o.shipping_address,
    billingAddress: o.billing_address,
    trackingNumber: o.tracking_number,
    items: items.map((i) => ({
      productId: i.product_id,
      nameDe: i.name_de,
      nameEn: i.name_en,
      nameLocal: i.name_local,
      setNameDe: i.set_name_de,
      setNameEn: i.set_name_en,
      cardNumber: i.card_number,
      cardLanguage: i.card_language,
      condition: i.condition,
      finish: i.finish,
      unitPriceCents: i.unit_price_cents,
      quantity: i.quantity,
    })),
  };
}

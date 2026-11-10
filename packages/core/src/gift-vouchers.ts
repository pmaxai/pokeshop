/**
 * Gift vouchers customers buy (kind 'voucher' orders, sold by the shop): the buyer pays through
 * the shop's Stripe, the voucher is created with its code once the payment is in, and its PDF
 * goes to the buyer to print or forward. The voucher is a multi-purpose voucher: the sale is
 * no supply and carries no VAT; the invoice comes when it is redeemed for cards.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Db, Sql, Tx } from './db.ts';
import { currentLegalVersions } from './legal.ts';
import { formatEuro } from './money.ts';
import { newOrderNumber } from './numbering.ts';
import { orderEvent, type CreatedOrder } from './orders.ts';
import { alertShop, enqueueMail } from './outbox.ts';
import type { PaymentProvider } from './payments.ts';
import { STRIPE_MIN_SESSION_MINUTES } from './reservation.ts';
import { GIFT_VOUCHER_MAX_CENTS, GIFT_VOUCHER_MIN_CENTS, newVoucherCode } from './vouchers.ts';

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'too_long')
    .transform((v) => v || undefined)
    .optional();

export const GiftVoucherCheckout = z.object({
  /** Whole euros from € 10 to € 300. */
  amountCents: z.coerce
    .number('amount')
    .int('amount')
    .min(GIFT_VOUCHER_MIN_CENTS, 'amount')
    .max(GIFT_VOUCHER_MAX_CENTS, 'amount')
    .refine((v) => v % 100 === 0, 'amount'),
  recipientName: optional(80),
  message: optional(300),
  name: z.string().trim().min(1, 'required').max(100, 'too_long'),
  email: z.email('invalid_email').trim().toLowerCase().max(200, 'too_long'),
  acceptTerms: z.literal(true, 'terms'),
});
export type GiftVoucherCheckout = z.infer<typeof GiftVoucherCheckout>;

export function validateGiftVoucher(
  input: unknown,
): { ok: true; data: GiftVoucherCheckout } | { ok: false; errors: Record<string, string> } {
  const r = GiftVoucherCheckout.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  const errors: Record<string, string> = {};
  for (const i of r.error.issues) {
    const k = i.path.join('.') || '_';
    errors[k] ??= i.message.startsWith('Invalid') ? 'invalid' : i.message;
  }
  return { ok: false, errors };
}

/** The unpaid purchase order; startPayment opens the shop's Stripe page for it. */
export async function createGiftVoucherOrder(
  sql: Sql,
  input: { locale: 'de' | 'en'; details: GiftVoucherCheckout; now?: Date },
): Promise<CreatedOrder> {
  const now = input.now ?? new Date();
  const d = input.details;
  return sql.begin(async (tx) => {
    const legal = await currentLegalVersions(tx);
    let number = '';
    for (let i = 0; i < 6 && !number; i++) {
      const candidate = newOrderNumber(now);
      const [taken] = await tx`SELECT 1 FROM orders WHERE number = ${candidate}`;
      if (!taken) number = candidate;
    }
    if (!number) throw new Error('could not allocate an order number');
    const token = randomBytes(24).toString('base64url');
    const until = new Date(now.getTime() + (STRIPE_MIN_SESSION_MINUTES + 5) * 60_000);
    // Nothing is delivered anywhere: the seller's country stands in for the buyer's.
    const [o] = await tx<{ id: number }[]>`
      INSERT INTO orders (number, lookup_token, kind, seller, status, locale, country, email,
                          customer_name, billing_address, goods_cents, shipping_cents, total_cents,
                          shipping_method, vat_regime, tax_country, vat_rate_bp, vat_cents,
                          reserved_until, agb_version, privacy_version, withdrawal_version,
                          terms_accepted_at, created_at)
      VALUES (${number}, ${token}, 'voucher', 'shop', 'checkout', ${input.locale}, 'AT', ${d.email},
              ${d.name}, ${tx.json({ name: d.name, country: 'AT' } as never)}, ${d.amountCents}, 0,
              ${d.amountCents}, 'none', 'voucher', NULL, 0, 0, ${until}, ${legal.agb},
              ${legal.privacy}, ${legal.withdrawal}, ${now}, ${now})
      RETURNING id`;
    await tx`
      INSERT INTO order_gift_vouchers (order_id, value_cents, recipient_name, message)
      VALUES (${o!.id}, ${d.amountCents}, ${d.recipientName ?? null}, ${d.message ?? null})`;
    await orderEvent(tx, o!.id, 'created', { kind: 'voucher', value: d.amountCents });
    return {
      id: o!.id,
      number,
      token,
      totalCents: d.amountCents,
      dueCents: d.amountCents,
      reservedUntil: until,
      replacedSessions: [],
    };
  });
}

/** Payment page line of a voucher purchase. */
export async function giftVoucherPaymentLine(db: Db, orderId: number, locale: 'de' | 'en') {
  const [g] = await db<{ value_cents: number; recipient_name: string | null }[]>`
    SELECT value_cents, recipient_name FROM order_gift_vouchers WHERE order_id = ${orderId}`;
  if (!g) return null;
  return {
    name:
      locale === 'en'
        ? `Gift voucher ${formatEuro(g.value_cents, 'en')}`
        : `Geschenkgutschein über ${formatEuro(g.value_cents, 'de')}`,
    description: [
      g.recipient_name
        ? locale === 'en'
          ? `for ${g.recipient_name}`
          : `für ${g.recipient_name}`
        : '',
      locale === 'en' ? 'for cards on pokemonkarten.at' : 'für Karten auf pokemonkarten.at',
    ]
      .filter(Boolean)
      .join(' · '),
    unitAmount: g.value_cents,
    quantity: 1,
  };
}

/** The purchase is paid: the voucher comes into being and its PDF goes to the buyer. */
export async function giftVoucherOrderPaid(
  tx: Tx,
  o: { id: number; number: string; email: string | null; locale: 'de' | 'en' },
  now: Date,
): Promise<void> {
  const [g] = await tx<
    {
      value_cents: number;
      recipient_name: string | null;
      message: string | null;
      voucher_id: number | null;
    }[]
  >`SELECT value_cents, recipient_name, message, voucher_id FROM order_gift_vouchers
     WHERE order_id = ${o.id} FOR UPDATE`;
  if (!g) throw new Error(`voucher order ${o.number} has no voucher`);
  let voucherId = g.voucher_id;
  let code = '';
  for (let attempt = 0; !voucherId && attempt < 5; attempt++) {
    code = newVoucherCode();
    const [v] = await tx<{ id: number }[]>`
      INSERT INTO vouchers (code, origin, value_cents, balance_cents, order_id, recipient_name,
                            message, created_by)
      VALUES (${code}, 'sold', ${g.value_cents}, ${g.value_cents}, ${o.id}, ${g.recipient_name},
              ${g.message}, 'system')
      ON CONFLICT (code) DO NOTHING RETURNING id`;
    if (v) voucherId = v.id;
  }
  if (!voucherId) throw new Error('could not allocate a voucher code');
  await tx`UPDATE order_gift_vouchers SET voucher_id = ${voucherId} WHERE order_id = ${o.id}`;
  await tx`INSERT INTO voucher_movements (voucher_id, order_id, kind, amount_cents)
           VALUES (${voucherId}, ${o.id}, 'issued', ${g.value_cents})`;
  // Paid means delivered: the code is in the e-mail.
  await tx`UPDATE orders SET status = 'paid', paid_at = ${now}, reserved_until = NULL
            WHERE id = ${o.id}`;
  await tx`UPDATE orders SET status = 'completed' WHERE id = ${o.id}`;
  if (o.email) {
    await enqueueMail(tx, {
      template: 'voucher_purchase',
      to: o.email,
      locale: o.locale,
      payload: { order_id: o.id, voucher_id: voucherId },
      attachments: [
        { kind: 'voucher', id: voucherId },
        { kind: 'legal', kinds: ['agb', 'withdrawal'] },
      ],
      dedupeKey: `voucher_purchase:${o.id}`,
    });
  }
  await alertShop(
    tx,
    `Gutschein verkauft: ${o.number}`,
    `Ein Geschenkgutschein über ${(g.value_cents / 100).toFixed(2).replace('.', ',')} € wurde bezahlt. Er ist noch kein Umsatz: Erst beim Einlösen gibt es eine Rechnung.`,
    `voucher_sold:${o.id}`,
  );
}

/**
 * Admin: takes back a bought voucher that was not used (withdrawal within 14 days, or kindness)
 * and refunds its price. A partly used one gives back what is left.
 */
export async function cancelGiftVoucher(
  sql: Sql,
  provider: PaymentProvider,
  input: { voucherId: number; actor: string; reason: string },
): Promise<{ amount: number }> {
  const prep = await sql.begin(async (tx) => {
    const [v] = await tx<
      {
        id: number;
        code: string;
        origin: string;
        status: string;
        balance_cents: number;
        order_id: number | null;
        pi: string | null;
        refunded_cents: number;
        total_cents: number;
      }[]
    >`SELECT v.id, v.code, v.origin, v.status, v.balance_cents, v.order_id,
             o.stripe_payment_intent_id AS pi, o.refunded_cents, o.total_cents
        FROM vouchers v LEFT JOIN orders o ON o.id = v.order_id
       WHERE v.id = ${input.voucherId} FOR UPDATE OF v`;
    if (!v || v.origin !== 'sold' || !v.order_id) {
      throw new Error('Nur gekaufte Gutscheine können erstattet werden.');
    }
    if (v.status === 'cancelled') throw new Error('Der Gutschein ist schon storniert.');
    const [held] = await tx`
      SELECT 1 FROM voucher_redemptions WHERE voucher_id = ${v.id} AND status = 'held'`;
    if (held) throw new Error('Der Gutschein steckt gerade in einer offenen Bestellung.');
    const amount = Math.min(v.balance_cents, v.total_cents - v.refunded_cents);
    if (amount <= 0)
      throw new Error('Auf dem Gutschein ist nichts mehr, das erstattet werden kann.');
    if (!v.pi) throw new Error('Zu diesem Gutschein gibt es keine Zahlung.');
    await tx`UPDATE vouchers SET status = 'cancelled', balance_cents = balance_cents - ${amount}
              WHERE id = ${v.id}`;
    await tx`INSERT INTO voucher_movements (voucher_id, order_id, kind, amount_cents, actor)
             VALUES (${v.id}, ${v.order_id}, 'cancelled', ${-amount}, ${input.actor})`;
    const [r] = await tx<{ id: number }[]>`
      INSERT INTO refunds (order_id, amount_cents, shipping_cents, reason, status, created_by)
      VALUES (${v.order_id}, ${amount}, 0, ${input.reason.trim().slice(0, 500) || 'voucher_cancelled'},
              'pending', ${input.actor})
      RETURNING id`;
    return { refundId: r!.id, amount, pi: v.pi, orderId: v.order_id, voucherId: v.id };
  });
  let stripeId: string;
  try {
    stripeId = (
      await provider.refund({
        paymentIntentId: prep.pi,
        amount: prep.amount,
        idempotencyKey: `refund-${prep.refundId}`,
      })
    ).id;
  } catch (e) {
    // Stripe said no: the voucher keeps its value.
    await sql.begin(async (tx) => {
      await tx`UPDATE refunds SET status = 'failed', error = ${(e as Error).message.slice(0, 1000)}
                WHERE id = ${prep.refundId}`;
      await tx`UPDATE vouchers SET status = 'active', balance_cents = balance_cents + ${prep.amount}
                WHERE id = ${prep.voucherId}`;
      await tx`INSERT INTO voucher_movements (voucher_id, order_id, kind, amount_cents, actor)
               VALUES (${prep.voucherId}, ${prep.orderId}, 'restored', ${prep.amount}, ${input.actor})`;
    });
    throw new Error(`Stripe hat die Erstattung abgelehnt: ${(e as Error).message}`);
  }
  await sql.begin(async (tx) => {
    await tx`UPDATE refunds SET status = 'succeeded', stripe_refund_id = ${stripeId}
              WHERE id = ${prep.refundId}`;
    const [o] = await tx<{ email: string | null; locale: 'de' | 'en' }[]>`
      UPDATE orders SET refunded_cents = refunded_cents + ${prep.amount},
             status = CASE WHEN refunded_cents + ${prep.amount} >= total_cents THEN 'refunded' ELSE status END
       WHERE id = ${prep.orderId} RETURNING email, locale`;
    if (o?.email) {
      await enqueueMail(tx, {
        template: 'refund_issued',
        to: o.email,
        locale: o.locale,
        payload: { order_id: prep.orderId, refund_id: prep.refundId },
        dedupeKey: `refund_issued:${prep.refundId}`,
      });
    }
    await orderEvent(
      tx,
      prep.orderId,
      'refunded',
      { amount: prep.amount, refund: stripeId, voucher_cancelled: prep.voucherId },
      input.actor,
    );
  });
  return { amount: prep.amount };
}

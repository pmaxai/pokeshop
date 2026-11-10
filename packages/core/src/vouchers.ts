/**
 * Gift vouchers and discount codes.
 *
 * - Vouchers (XXXX-XXXX-XXXX) are worth an amount and can be used for cards only (the shop's
 *   sale, not the GmbH's licences). A bought voucher ('sold') is a means of payment: it pays part
 *   of the invoice total. A voucher the shop gave away ('promo') was never paid for: it lowers
 *   the price, like a discount. What is left stays on the voucher.
 * - Discount codes (CHRISTMAS, FREUND-7KQ4M …) take a percentage or an amount off cards, licences
 *   or both. One per order; any number of vouchers can be added.
 *
 * Order of application on a card order: the code on the cards' value, promotional vouchers on
 * what is left including shipping, then bought vouchers pay the rest. Stripe collects what
 * remains – nothing at all when it is € 0.
 */
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { Db, Sql, Tx } from './db.ts';

/** Without 0/O, 1/I/L: readable from paper. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const VOUCHER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const DISCOUNT_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/;

/** Stripe cannot take less than € 0.50: a payment is either € 0 or at least that. */
export const STRIPE_MINIMUM_CENTS = 50;
export const MAX_VOUCHERS_PER_ORDER = 5;
export const GIFT_VOUCHER_MIN_CENTS = 1000;
export const GIFT_VOUCHER_MAX_CENTS = 30000;
export const GIFT_VOUCHER_PRESETS = [1000, 2500, 5000, 10000] as const;

export function newVoucherCode(): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** A random code for a friend or a flyer: PREFIX-XXXXX. */
export function newDiscountCode(prefix = 'CODE'): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix.toUpperCase()}-${s}`;
}

/** What was typed without spaces. */
export const tidyCode = (raw: string) => raw.trim().replace(/\s+/g, '');

/** The typed text as a voucher code (XXXX-XXXX-XXXX), if it can be one. */
export function asVoucherCode(raw: string): string | null {
  const compact = tidyCode(raw).toUpperCase().replace(/[-–]/g, '');
  if (!/^[A-Z0-9]{12}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8)}`;
}

export const formatPercent = (bp: number, locale: 'de' | 'en') =>
  `${(bp / 100).toLocaleString(locale === 'de' ? 'de-AT' : 'en', { maximumFractionDigits: 2 })} %`;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type VoucherRow = {
  id: number;
  code: string;
  origin: 'sold' | 'promo';
  value_cents: number;
  balance_cents: number;
  status: 'active' | 'blocked' | 'cancelled';
  expires_at: Date | null;
};

export type DiscountCodeRow = {
  id: number;
  code: string;
  campaign: string | null;
  kind: 'percent' | 'amount';
  percent_bp: number | null;
  amount_cents: number | null;
  applies_to: 'cards' | 'licenses' | 'both';
  min_goods_cents: number;
  max_licenses: number | null;
  max_uses: number | null;
  once_per_customer: boolean;
  valid_from: Date | null;
  valid_until: Date | null;
  active: boolean;
};

const VOUCHER_COLS = 'id, code, origin, value_cents, balance_cents, status, expires_at';
const CODE_COLS = `id, code, campaign, kind, percent_bp, amount_cents, applies_to, min_goods_cents,
  max_licenses, max_uses, once_per_customer, valid_from, valid_until, active`;

export type CodeProblem =
  | 'unknown'
  | 'inactive'
  | 'expired'
  | 'not_yet'
  | 'used_up'
  | 'already_used'
  | 'not_for_cards'
  | 'not_for_licenses'
  | 'min_goods'
  | 'empty'
  | 'blocked'
  | 'too_many'
  | 'voucher_for_licenses';

export type FoundCode =
  | { kind: 'voucher'; voucher: VoucherRow }
  | { kind: 'discount'; code: DiscountCodeRow }
  | { kind: 'invalid'; problem: CodeProblem; minGoodsCents?: number };

/**
 * What a typed code is and whether it can be used now. `email` checks "once per customer"
 * (only known at checkout), `goodsCents` the minimum order of a code.
 */
export async function findCode(
  db: Db,
  raw: string,
  input: {
    scope: 'cards' | 'licenses';
    email?: string | null;
    goodsCents?: number;
    now?: Date;
    /** Lock the row (checkout). */
    lock?: boolean;
    /** This order's own use does not count against the limits. */
    exceptOrderId?: number;
  },
): Promise<FoundCode> {
  const now = input.now ?? new Date();
  const code = tidyCode(raw);
  const voucherCode = asVoucherCode(code);
  if (voucherCode) {
    const [v] = input.lock
      ? await db<
          VoucherRow[]
        >`SELECT ${db.unsafe(VOUCHER_COLS)} FROM vouchers WHERE code = ${voucherCode} FOR UPDATE`
      : await db<
          VoucherRow[]
        >`SELECT ${db.unsafe(VOUCHER_COLS)} FROM vouchers WHERE code = ${voucherCode}`;
    if (v) {
      if (input.scope === 'licenses') return { kind: 'invalid', problem: 'voucher_for_licenses' };
      if (v.status !== 'active') return { kind: 'invalid', problem: 'blocked' };
      if (v.expires_at && v.expires_at <= now) return { kind: 'invalid', problem: 'expired' };
      if (v.balance_cents <= 0) return { kind: 'invalid', problem: 'empty' };
      return { kind: 'voucher', voucher: v };
    }
  }
  if (!DISCOUNT_CODE.test(code)) return { kind: 'invalid', problem: 'unknown' };
  const [c] = input.lock
    ? await db<DiscountCodeRow[]>`
        SELECT ${db.unsafe(CODE_COLS)} FROM discount_codes WHERE upper(code) = upper(${code}) FOR UPDATE`
    : await db<DiscountCodeRow[]>`
        SELECT ${db.unsafe(CODE_COLS)} FROM discount_codes WHERE upper(code) = upper(${code})`;
  if (!c) return { kind: 'invalid', problem: 'unknown' };
  if (!c.active) return { kind: 'invalid', problem: 'inactive' };
  if (c.valid_from && c.valid_from > now) return { kind: 'invalid', problem: 'not_yet' };
  if (c.valid_until && c.valid_until <= now) return { kind: 'invalid', problem: 'expired' };
  if (input.scope === 'cards' && c.applies_to === 'licenses') {
    return { kind: 'invalid', problem: 'not_for_cards' };
  }
  if (input.scope === 'licenses' && c.applies_to === 'cards') {
    return { kind: 'invalid', problem: 'not_for_licenses' };
  }
  const except = input.exceptOrderId ?? null;
  if (c.max_uses !== null) {
    const [u] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM discount_code_uses
       WHERE code_id = ${c.id} AND status IN ('held', 'used')
         AND (${except}::bigint IS NULL OR order_id <> ${except}::bigint)`;
    if (u!.n >= c.max_uses) return { kind: 'invalid', problem: 'used_up' };
  }
  if (c.once_per_customer && input.email) {
    const [u] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM discount_code_uses
       WHERE code_id = ${c.id} AND status IN ('held', 'used') AND lower(email) = lower(${input.email})
         AND (${except}::bigint IS NULL OR order_id <> ${except}::bigint)`;
    if (u!.n > 0) return { kind: 'invalid', problem: 'already_used' };
  }
  if (
    input.scope === 'cards' &&
    input.goodsCents !== undefined &&
    input.goodsCents < c.min_goods_cents
  ) {
    return { kind: 'invalid', problem: 'min_goods', minGoodsCents: c.min_goods_cents };
  }
  return { kind: 'discount', code: c };
}

// ---------------------------------------------------------------------------
// Pricing (pure)
// ---------------------------------------------------------------------------

export type AppliedVoucher = { voucherId: number; code: string; amount: number };

export type CardPricing = {
  goods: number;
  shipping: number;
  code: { id: number; code: string; label: { de: string; en: string }; amount: number } | null;
  /** Promotional vouchers: part of the discount. */
  promo: AppliedVoucher[];
  /** Bought vouchers: part of the payment. */
  paid: AppliedVoucher[];
  /** Code + promotional vouchers. */
  discount: number;
  /** Part of the discount on the shipping charge. */
  shippingDiscount: number;
  /** goods + shipping − discount: the invoice total. */
  total: number;
  /** Paid with bought vouchers. */
  voucher: number;
  /** Left for Stripe: 0 or at least € 0.50. */
  due: number;
  /** Discount on each line (all copies), in the lines' order. */
  lineDiscounts: number[];
};

export function codeLabel(c: DiscountCodeRow): { de: string; en: string } {
  const v =
    c.kind === 'percent'
      ? { de: formatPercent(c.percent_bp!, 'de'), en: formatPercent(c.percent_bp!, 'en') }
      : { de: '', en: '' };
  return {
    de: `Rabatt ${c.code.toUpperCase()}${v.de ? ` (${v.de})` : ''}`,
    en: `Discount ${c.code.toUpperCase()}${v.en ? ` (${v.en})` : ''}`,
  };
}

/** Splits `amount` over `weights` in proportion, in whole cents (largest remainder). */
export function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((a, w) => a + w, 0);
  if (total <= 0 || amount <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const out = raw.map(Math.floor);
  let rest = amount - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, f: r - Math.floor(r) }))
    .sort((a, b) => b.f - a.f || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    if (out[i]! < weights[i]!) {
      out[i]!++;
      rest--;
    }
  }
  return out;
}

/**
 * Price of a card order with a code and vouchers (in the order they were entered). Vouchers
 * not needed for this order are left out (amount 0 is never returned).
 */
export function priceCards(input: {
  lines: number[];
  shipping: number;
  code: DiscountCodeRow | null;
  vouchers: VoucherRow[];
}): CardPricing {
  const goods = input.lines.reduce((a, l) => a + l, 0);
  const shipping = input.shipping;
  let codeAmount = 0;
  if (input.code) {
    codeAmount =
      input.code.kind === 'percent'
        ? Math.round((goods * input.code.percent_bp!) / 10_000)
        : Math.min(input.code.amount_cents!, goods);
  }
  let goodsLeft = goods - codeAmount;
  let shippingLeft = shipping;
  const promo: AppliedVoucher[] = [];
  const paid: AppliedVoucher[] = [];
  let promoGoods = 0;
  let promoShipping = 0;
  for (const v of input.vouchers.filter((x) => x.origin === 'promo')) {
    const left = goodsLeft + shippingLeft;
    const amount = Math.min(v.balance_cents, left);
    if (amount <= 0) continue;
    const g = Math.min(amount, goodsLeft);
    goodsLeft -= g;
    promoGoods += g;
    shippingLeft -= amount - g;
    promoShipping += amount - g;
    promo.push({ voucherId: v.id, code: v.code, amount });
  }
  let due = goodsLeft + shippingLeft;
  for (const v of input.vouchers.filter((x) => x.origin === 'sold')) {
    const amount = Math.min(v.balance_cents, due);
    if (amount <= 0) continue;
    due -= amount;
    paid.push({ voucherId: v.id, code: v.code, amount });
  }
  // Stripe's minimum: give back from the last reduction until € 0.50 are due.
  let missing = due > 0 && due < STRIPE_MINIMUM_CENTS ? STRIPE_MINIMUM_CENTS - due : 0;
  const giveBack = (list: AppliedVoucher[], onPromo: boolean) => {
    for (let i = list.length - 1; i >= 0 && missing > 0; i--) {
      const take = Math.min(missing, list[i]!.amount);
      list[i]!.amount -= take;
      missing -= take;
      due += take;
      if (onPromo) {
        // Taken back from shipping first (it was applied last).
        const s = Math.min(take, promoShipping);
        promoShipping -= s;
        promoGoods -= take - s;
      }
    }
  };
  giveBack(paid, false);
  giveBack(promo, true);
  if (missing > 0 && codeAmount > 0) {
    const take = Math.min(missing, codeAmount);
    codeAmount -= take;
    missing -= take;
    due += take;
  }
  const discount = codeAmount + promoGoods + promoShipping;
  const total = goods + shipping - discount;
  const voucher = paid.reduce((a, p) => a + p.amount, 0);
  return {
    goods,
    shipping,
    code:
      input.code && codeAmount > 0
        ? {
            id: input.code.id,
            code: input.code.code,
            label: codeLabel(input.code),
            amount: codeAmount,
          }
        : null,
    promo: promo.filter((p) => p.amount > 0),
    paid: paid.filter((p) => p.amount > 0),
    discount,
    shippingDiscount: promoShipping,
    total,
    voucher,
    due: total - voucher,
    lineDiscounts: allocate(codeAmount + promoGoods, input.lines),
  };
}

/** Discount of a code on a licence order (net or gross unit price, as on the payment page). */
export function licenseDiscount(
  code: DiscountCodeRow,
  unitCents: number,
  quantity: number,
): number {
  const total = unitCents * quantity;
  const n = Math.min(quantity, code.max_licenses ?? quantity);
  let d =
    code.kind === 'percent'
      ? Math.round((unitCents * n * code.percent_bp!) / 10_000)
      : Math.min(code.amount_cents!, unitCents * n);
  d = Math.min(d, total);
  const due = total - d;
  if (due > 0 && due < STRIPE_MINIMUM_CENTS) d = total - STRIPE_MINIMUM_CENTS;
  return Math.max(0, d);
}

// ---------------------------------------------------------------------------
// Codes in the cart
// ---------------------------------------------------------------------------

export type CartCode = {
  code: string;
  found: FoundCode;
};

export async function cartCodes(db: Db, cartId: string): Promise<string[]> {
  const rows = await db<{ code: string }[]>`
    SELECT code FROM cart_codes WHERE cart_id = ${cartId} ORDER BY added_at, code`;
  return rows.map((r) => r.code);
}

/**
 * Adds a code to the cart if it can be used for cards. A second discount code replaces the
 * first (one per order). Returns what it was, or why not.
 */
export async function addCartCode(
  db: Db,
  cartId: string,
  raw: string,
  goodsCents: number,
): Promise<
  | { ok: true; kind: 'voucher' | 'discount'; code: string; replaced: string | null }
  | { ok: false; problem: CodeProblem; minGoodsCents?: number }
> {
  if (!raw.trim()) return { ok: false, problem: 'unknown' };
  const found = await findCode(db, raw, { scope: 'cards', goodsCents });
  if (found.kind === 'invalid') {
    return found.minGoodsCents === undefined
      ? { ok: false, problem: found.problem }
      : { ok: false, problem: found.problem, minGoodsCents: found.minGoodsCents };
  }
  const code = found.kind === 'voucher' ? found.voucher.code : found.code.code;
  const existing = await cartCodes(db, cartId);
  if (existing.some((c) => c.toUpperCase() === code.toUpperCase())) {
    return { ok: true, kind: found.kind, code, replaced: null };
  }
  let replaced: string | null = null;
  if (found.kind === 'discount') {
    for (const c of existing) {
      if (!VOUCHER_CODE.test(c)) {
        await db`DELETE FROM cart_codes WHERE cart_id = ${cartId} AND code = ${c}`;
        replaced = c;
      }
    }
  } else if (existing.filter((c) => VOUCHER_CODE.test(c)).length >= MAX_VOUCHERS_PER_ORDER) {
    return { ok: false, problem: 'too_many' };
  }
  await db`INSERT INTO cart_codes (cart_id, code) VALUES (${cartId}, ${code})
           ON CONFLICT DO NOTHING`;
  return { ok: true, kind: found.kind, code, replaced };
}

export async function removeCartCode(db: Db, cartId: string, code: string): Promise<void> {
  await db`DELETE FROM cart_codes WHERE cart_id = ${cartId} AND code = ${code}`;
}

export type CartCodesView = {
  pricing: CardPricing;
  /** Every entered code with what it does here, or why it does nothing. */
  entries: {
    code: string;
    kind: 'voucher' | 'discount' | 'invalid';
    origin?: 'sold' | 'promo';
    amount: number;
    balance?: number;
    problem?: CodeProblem;
    minGoodsCents?: number;
  }[];
};

/**
 * The cart's codes priced against its lines and shipping (cart and checkout pages, and the
 * order itself, with `lock` and the buyer's e-mail).
 */
export async function priceCartCodes(
  db: Db,
  input: {
    codes: string[];
    lines: number[];
    shipping: number;
    email?: string | null;
    lock?: boolean;
    now?: Date;
  },
): Promise<CartCodesView> {
  const goods = input.lines.reduce((a, l) => a + l, 0);
  let code: DiscountCodeRow | null = null;
  const vouchers: VoucherRow[] = [];
  const found: { code: string; f: FoundCode }[] = [];
  for (const c of input.codes) {
    const f = await findCode(db, c, {
      scope: 'cards',
      email: input.email,
      goodsCents: goods,
      lock: input.lock,
      now: input.now,
    });
    found.push({ code: c, f });
    if (f.kind === 'discount' && !code) code = f.code;
    if (f.kind === 'voucher' && vouchers.length < MAX_VOUCHERS_PER_ORDER) vouchers.push(f.voucher);
  }
  const pricing = priceCards({ lines: input.lines, shipping: input.shipping, code, vouchers });
  const entries = found.map(({ code: c, f }) => {
    if (f.kind === 'invalid') {
      return {
        code: c,
        kind: 'invalid' as const,
        amount: 0,
        problem: f.problem,
        minGoodsCents: f.minGoodsCents,
      };
    }
    if (f.kind === 'discount') {
      return {
        code: f.code.code,
        kind: 'discount' as const,
        amount: pricing.code?.id === f.code.id ? pricing.code.amount : 0,
      };
    }
    const used = [...pricing.promo, ...pricing.paid].find((p) => p.voucherId === f.voucher.id);
    return {
      code: f.voucher.code,
      kind: 'voucher' as const,
      origin: f.voucher.origin,
      amount: used?.amount ?? 0,
      balance: f.voucher.balance_cents,
    };
  });
  return { pricing, entries };
}

/**
 * Records the code and vouchers on a new order and takes the amounts off the vouchers (held
 * until the order is paid; the database gives them back if it is not).
 */
export async function holdRedemptions(
  tx: Tx,
  orderId: number,
  email: string | null,
  pricing: Pick<CardPricing, 'code' | 'promo' | 'paid'>,
  codeDiscount?: { id: number; amount: number } | null,
): Promise<void> {
  const code =
    codeDiscount ?? (pricing.code ? { id: pricing.code.id, amount: pricing.code.amount } : null);
  if (code) {
    await tx`INSERT INTO discount_code_uses (code_id, order_id, email, discount_cents)
             VALUES (${code.id}, ${orderId}, ${email}, ${code.amount})`;
  }
  for (const v of [...pricing.promo, ...pricing.paid]) {
    const r = await tx`
      UPDATE vouchers SET balance_cents = balance_cents - ${v.amount}
       WHERE id = ${v.voucherId} AND balance_cents >= ${v.amount} AND status = 'active'`;
    if (r.count !== 1) throw new Error(`voucher ${v.code} changed while the order was created`);
    await tx`INSERT INTO voucher_redemptions (voucher_id, order_id, amount_cents)
             VALUES (${v.voucherId}, ${orderId}, ${v.amount})`;
    await tx`INSERT INTO voucher_movements (voucher_id, order_id, kind, amount_cents)
             VALUES (${v.voucherId}, ${orderId}, 'redeemed', ${-v.amount})`;
  }
}

/**
 * A payment came in for an order that had already been given up (its vouchers released): take
 * them again. False if a voucher no longer covers its part.
 */
export async function reholdRedemptions(tx: Tx, orderId: number): Promise<boolean> {
  const rows = await tx<{ id: number; voucher_id: number; amount_cents: number }[]>`
    SELECT id, voucher_id, amount_cents FROM voucher_redemptions
     WHERE order_id = ${orderId} AND status = 'released' ORDER BY id FOR UPDATE`;
  for (const r of rows) {
    const ok = await tx`
      UPDATE vouchers SET balance_cents = balance_cents - ${r.amount_cents}
       WHERE id = ${r.voucher_id} AND balance_cents >= ${r.amount_cents}`;
    if (ok.count !== 1) return false;
  }
  for (const r of rows) {
    await tx`UPDATE voucher_redemptions SET status = 'held' WHERE id = ${r.id}`;
    await tx`INSERT INTO voucher_movements (voucher_id, order_id, kind, amount_cents)
             VALUES (${r.voucher_id}, ${orderId}, 'redeemed', ${-r.amount_cents})`;
  }
  await tx`UPDATE discount_code_uses SET status = 'held' WHERE order_id = ${orderId} AND status = 'released'`;
  return true;
}

/**
 * Puts `amount` of a refund back onto the order's vouchers (latest first), of the given origin.
 * Returns what went back to which voucher.
 */
export async function restoreVouchers(
  tx: Tx,
  orderId: number,
  amount: number,
  origin: 'sold' | 'promo',
  actor: string,
): Promise<AppliedVoucher[]> {
  if (amount <= 0) return [];
  const rows = await tx<
    { id: number; voucher_id: number; code: string; left: number; status: string }[]
  >`
    SELECT r.id, r.voucher_id, v.code, r.amount_cents - r.restored_cents AS left, v.status
      FROM voucher_redemptions r JOIN vouchers v ON v.id = r.voucher_id
     WHERE r.order_id = ${orderId} AND r.status = 'used' AND v.origin = ${origin}
       AND r.restored_cents < r.amount_cents
     ORDER BY r.id DESC FOR UPDATE OF r, v`;
  const out: AppliedVoucher[] = [];
  let rest = amount;
  for (const r of rows) {
    if (rest <= 0) break;
    const take = Math.min(rest, r.left);
    await tx`UPDATE voucher_redemptions SET restored_cents = restored_cents + ${take} WHERE id = ${r.id}`;
    await tx`UPDATE vouchers SET balance_cents = balance_cents + ${take},
                    status = CASE WHEN status = 'cancelled' THEN 'active' ELSE status END
              WHERE id = ${r.voucher_id}`;
    await tx`INSERT INTO voucher_movements (voucher_id, order_id, kind, amount_cents, actor)
             VALUES (${r.voucher_id}, ${orderId}, 'restored', ${take}, ${actor})`;
    out.push({ voucherId: r.voucher_id, code: r.code, amount: take });
    rest -= take;
  }
  return out;
}

/** Codes and vouchers of an order, for the invoice, mails and pages. */
export async function orderRedemptions(
  db: Db,
  orderId: number,
): Promise<{
  code: { code: string; label: { de: string; en: string }; amount: number } | null;
  promo: AppliedVoucher[];
  paid: AppliedVoucher[];
}> {
  const [c] = await db<(DiscountCodeRow & { discount_cents: number })[]>`
    SELECT d.code, d.kind, d.percent_bp, d.amount_cents, u.discount_cents
      FROM discount_code_uses u JOIN discount_codes d ON d.id = u.code_id
     WHERE u.order_id = ${orderId} AND u.status <> 'released'`;
  const vs = await db<
    { voucher_id: number; code: string; origin: 'sold' | 'promo'; amount_cents: number }[]
  >`
    SELECT r.voucher_id, v.code, v.origin, r.amount_cents
      FROM voucher_redemptions r JOIN vouchers v ON v.id = r.voucher_id
     WHERE r.order_id = ${orderId} AND r.status <> 'released' ORDER BY r.id`;
  return {
    code: c ? { code: c.code, label: codeLabel(c), amount: c.discount_cents } : null,
    promo: vs
      .filter((v) => v.origin === 'promo')
      .map((v) => ({ voucherId: v.voucher_id, code: v.code, amount: v.amount_cents })),
    paid: vs
      .filter((v) => v.origin === 'sold')
      .map((v) => ({ voucherId: v.voucher_id, code: v.code, amount: v.amount_cents })),
  };
}

// ---------------------------------------------------------------------------
// Admin: promotional vouchers and discount codes
// ---------------------------------------------------------------------------

export const PromoVoucherInput = z.object({
  valueCents: z.number().int().min(100).max(100_000),
  count: z.number().int().min(1).max(200),
  expiresAt: z.date().nullable(),
  note: z.string().trim().max(300).optional(),
  recipientName: z.string().trim().max(80).optional(),
  message: z.string().trim().max(300).optional(),
});

/** Creates promotional vouchers (given away, no money came in). Returns their codes. */
export async function createPromoVouchers(
  sql: Sql,
  input: z.infer<typeof PromoVoucherInput>,
  actor: string,
): Promise<{ id: number; code: string }[]> {
  const v = PromoVoucherInput.parse(input);
  return sql.begin(async (tx) => {
    const out: { id: number; code: string }[] = [];
    for (let i = 0; i < v.count; i++) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newVoucherCode();
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO vouchers (code, origin, value_cents, balance_cents, recipient_name, message,
                                note, expires_at, created_by)
          VALUES (${code}, 'promo', ${v.valueCents}, ${v.valueCents}, ${v.recipientName || null},
                  ${v.message || null}, ${v.note || null}, ${v.expiresAt}, ${actor})
          ON CONFLICT (code) DO NOTHING RETURNING id`;
        if (!row) continue;
        await tx`INSERT INTO voucher_movements (voucher_id, kind, amount_cents, actor)
                 VALUES (${row.id}, 'issued', ${v.valueCents}, ${actor})`;
        out.push({ id: row.id, code });
        break;
      }
    }
    if (out.length !== v.count) throw new Error('could not allocate voucher codes');
    return out;
  });
}

/** Blocks or unblocks a voucher (e.g. a lost or misused code); its balance stays. */
export async function setVoucherBlocked(sql: Sql, id: number, blocked: boolean): Promise<void> {
  await sql`UPDATE vouchers SET status = ${blocked ? 'blocked' : 'active'}
             WHERE id = ${id} AND status <> 'cancelled'`;
}

export const DiscountCodeInput = z
  .object({
    code: z.string().trim().regex(DISCOUNT_CODE, 'code').optional(),
    /** Several single-use codes at once: PREFIX-XXXXXX. */
    count: z.number().int().min(1).max(500).default(1),
    prefix: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{2,12}$/, 'prefix')
      .optional(),
    campaign: z.string().trim().max(80).optional(),
    kind: z.enum(['percent', 'amount']),
    percentBp: z.number().int().min(1).max(10_000).optional(),
    amountCents: z.number().int().min(1).max(100_000).optional(),
    appliesTo: z.enum(['cards', 'licenses', 'both']),
    minGoodsCents: z.number().int().min(0).max(1_000_000).default(0),
    maxLicenses: z.number().int().min(1).max(50).nullable().default(null),
    maxUses: z.number().int().min(1).max(1_000_000).nullable().default(null),
    oncePerCustomer: z.boolean().default(true),
    validFrom: z.date().nullable().default(null),
    validUntil: z.date().nullable().default(null),
    note: z.string().trim().max(300).optional(),
  })
  .refine((v) => (v.kind === 'percent' ? !!v.percentBp : !!v.amountCents), { message: 'value' })
  .refine((v) => v.count === 1 || !!v.prefix, { message: 'prefix' })
  .refine((v) => v.count > 1 || !!v.code, { message: 'code' })
  .refine((v) => !v.validFrom || !v.validUntil || v.validUntil > v.validFrom, {
    message: 'dates',
  });

/** Creates a discount code, or `count` single-use codes with a prefix (one campaign). */
export async function createDiscountCodes(
  sql: Sql,
  input: z.input<typeof DiscountCodeInput>,
  actor: string,
): Promise<{ id: number; code: string }[]> {
  const v = DiscountCodeInput.parse(input);
  return sql.begin(async (tx) => {
    const out: { id: number; code: string }[] = [];
    const batch = v.count > 1;
    for (let i = 0; i < v.count; i++) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = batch ? newDiscountCode(v.prefix) : v.code!;
        const [taken] = await tx`SELECT 1 FROM discount_codes WHERE upper(code) = upper(${code})`;
        if (taken) {
          if (!batch) throw new DiscountCodeTaken(code);
          continue;
        }
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO discount_codes (code, campaign, kind, percent_bp, amount_cents, applies_to,
                                      min_goods_cents, max_licenses, max_uses, once_per_customer,
                                      valid_from, valid_until, note, created_by)
          VALUES (${code}, ${v.campaign || null}, ${v.kind},
                  ${v.kind === 'percent' ? v.percentBp! : null},
                  ${v.kind === 'amount' ? v.amountCents! : null}, ${v.appliesTo}, ${v.minGoodsCents},
                  ${v.maxLicenses}, ${batch ? 1 : v.maxUses}, ${v.oncePerCustomer}, ${v.validFrom},
                  ${v.validUntil}, ${v.note || null}, ${actor})
          RETURNING id`;
        out.push({ id: row!.id, code });
        break;
      }
    }
    if (out.length !== v.count) throw new Error('could not allocate discount codes');
    return out;
  });
}

export class DiscountCodeTaken extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`discount code ${code} exists`);
    this.code = code;
  }
}

export async function setDiscountCodeActive(
  sql: Sql,
  ids: number[],
  active: boolean,
): Promise<void> {
  await sql`UPDATE discount_codes SET active = ${active} WHERE id = ANY(${ids}::bigint[])`;
}

// ---------------------------------------------------------------------------
// Admin: lists, details and the books
// ---------------------------------------------------------------------------

export type VoucherListRow = {
  id: number;
  code: string;
  origin: 'sold' | 'promo';
  value_cents: number;
  balance_cents: number;
  status: 'active' | 'blocked' | 'cancelled';
  expires_at: Date | null;
  created_at: Date;
  created_by: string;
  note: string | null;
  recipient_name: string | null;
  order_number: string | null;
  redeemed_cents: number;
  /** Held by orders still waiting for payment. */
  held_cents: number;
};

export async function listVouchers(
  db: Db,
  input: { origin?: 'sold' | 'promo'; q?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: VoucherListRow[]; total: number }> {
  const q = input.q?.trim() ? `%${input.q.trim()}%` : null;
  const origin = input.origin ?? null;
  const where = db`
    WHERE (${origin}::text IS NULL OR v.origin = ${origin}::text)
      AND (${q}::text IS NULL OR v.code ILIKE ${q}::text OR v.note ILIKE ${q}::text
           OR v.recipient_name ILIKE ${q}::text OR o.number ILIKE ${q}::text OR o.email ILIKE ${q}::text)`;
  const rows = await db<VoucherListRow[]>`
    SELECT v.id, v.code, v.origin, v.value_cents, v.balance_cents, v.status, v.expires_at,
           v.created_at, v.created_by, v.note, v.recipient_name, o.number AS order_number,
           coalesce((SELECT sum(r.amount_cents - r.restored_cents) FROM voucher_redemptions r
                      WHERE r.voucher_id = v.id AND r.status = 'used'), 0)::int AS redeemed_cents,
           coalesce((SELECT sum(r.amount_cents) FROM voucher_redemptions r
                      WHERE r.voucher_id = v.id AND r.status = 'held'), 0)::int AS held_cents
      FROM vouchers v LEFT JOIN orders o ON o.id = v.order_id
     ${where}
     ORDER BY v.created_at DESC, v.id DESC
     LIMIT ${input.limit ?? 50} OFFSET ${input.offset ?? 0}`;
  const [n] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM vouchers v LEFT JOIN orders o ON o.id = v.order_id ${where}`;
  return { rows, total: n!.n };
}

/**
 * What vouchers stand for in the books: bought ones that can still be redeemed are money the
 * shop owes (a liability), promotional ones only a possible future discount.
 */
export async function voucherTotals(db: Db) {
  const [r] = await db<
    {
      sold_count: number;
      sold_value: number;
      sold_open: number;
      promo_count: number;
      promo_value: number;
      promo_open: number;
    }[]
  >`
    SELECT count(*) FILTER (WHERE origin = 'sold' AND status <> 'cancelled')::int AS sold_count,
           coalesce(sum(value_cents) FILTER (WHERE origin = 'sold' AND status <> 'cancelled'), 0)::int AS sold_value,
           coalesce(sum(balance_cents) FILTER (WHERE origin = 'sold' AND status <> 'cancelled'), 0)::int AS sold_open,
           count(*) FILTER (WHERE origin = 'promo')::int AS promo_count,
           coalesce(sum(value_cents) FILTER (WHERE origin = 'promo'), 0)::int AS promo_value,
           coalesce(sum(balance_cents) FILTER (WHERE origin = 'promo' AND status = 'active'
                      AND (expires_at IS NULL OR expires_at > now())), 0)::int AS promo_open
      FROM vouchers`;
  return r!;
}

export async function voucherDetail(db: Db, id: number) {
  const [v] = await db<
    (VoucherListRow & {
      message: string | null;
      order_id: number | null;
      order_email: string | null;
      paid_cents: number | null;
      paid_at: Date | null;
      payment_method_type: string | null;
    })[]
  >`
    SELECT v.id, v.code, v.origin, v.value_cents, v.balance_cents, v.status, v.expires_at,
           v.created_at, v.created_by, v.note, v.recipient_name, v.message, v.order_id,
           o.number AS order_number, o.email AS order_email, o.total_cents AS paid_cents,
           o.paid_at, o.payment_method_type, 0 AS redeemed_cents
      FROM vouchers v LEFT JOIN orders o ON o.id = v.order_id
     WHERE v.id = ${id}`;
  if (!v) return null;
  const movements = await db<
    {
      id: number;
      kind: string;
      amount_cents: number;
      actor: string;
      created_at: Date;
      order_id: number | null;
      order_number: string | null;
    }[]
  >`
    SELECT m.id, m.kind, m.amount_cents, m.actor, m.created_at, m.order_id, o.number AS order_number
      FROM voucher_movements m LEFT JOIN orders o ON o.id = m.order_id
     WHERE m.voucher_id = ${id} ORDER BY m.id`;
  return { voucher: v, movements };
}

export type LedgerRow = {
  at: Date;
  kind: string;
  code: string;
  origin: 'sold' | 'promo';
  order_number: string | null;
  amount_cents: number;
  balance_after: number;
};

/**
 * Every voucher movement in a period, for the books: sales (money in, no revenue yet),
 * redemptions (bought: payment of an invoice; promotional: a discount), refunds, cancellations.
 */
export async function voucherLedger(db: Db, from: Date, to: Date): Promise<LedgerRow[]> {
  return db<LedgerRow[]>`
    SELECT m.created_at AS at, m.kind, v.code, v.origin, o.number AS order_number, m.amount_cents,
           (sum(m.amount_cents) OVER (PARTITION BY m.voucher_id ORDER BY m.id))::int AS balance_after
      FROM voucher_movements m JOIN vouchers v ON v.id = m.voucher_id
      LEFT JOIN orders o ON o.id = m.order_id
     WHERE m.created_at >= ${from} AND m.created_at < ${to}
     ORDER BY m.created_at, m.id`;
}

export type DiscountCodeListRow = DiscountCodeRow & {
  note: string | null;
  created_at: Date;
  used: number;
  held: number;
  discount_total: number;
};

export async function listDiscountCodes(
  db: Db,
  input: { q?: string; campaign?: string; limit?: number; offset?: number } = {},
): Promise<{
  rows: DiscountCodeListRow[];
  total: number;
  campaigns: { campaign: string; n: number; used: number }[];
}> {
  const q = input.q?.trim() ? `%${input.q.trim()}%` : null;
  const campaign = input.campaign?.trim() || null;
  const where = db`
    WHERE (${q}::text IS NULL OR d.code ILIKE ${q}::text OR d.campaign ILIKE ${q}::text OR d.note ILIKE ${q}::text)
      AND (${campaign}::text IS NULL OR d.campaign = ${campaign}::text)`;
  const rows = await db<DiscountCodeListRow[]>`
    SELECT d.id, d.code, d.campaign, d.kind, d.percent_bp, d.amount_cents, d.applies_to,
           d.min_goods_cents, d.max_licenses, d.max_uses, d.once_per_customer, d.valid_from,
           d.valid_until, d.active, d.note, d.created_at,
           count(u.id) FILTER (WHERE u.status = 'used')::int AS used,
           count(u.id) FILTER (WHERE u.status = 'held')::int AS held,
           coalesce(sum(u.discount_cents) FILTER (WHERE u.status = 'used'), 0)::int AS discount_total
      FROM discount_codes d LEFT JOIN discount_code_uses u ON u.code_id = d.id
     ${where}
     GROUP BY d.id
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT ${input.limit ?? 100} OFFSET ${input.offset ?? 0}`;
  const [n] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM discount_codes d ${where}`;
  const campaigns = await db<{ campaign: string; n: number; used: number }[]>`
    SELECT d.campaign, count(DISTINCT d.id)::int AS n,
           count(u.id) FILTER (WHERE u.status = 'used')::int AS used
      FROM discount_codes d LEFT JOIN discount_code_uses u ON u.code_id = d.id
     WHERE d.campaign IS NOT NULL
     GROUP BY d.campaign ORDER BY max(d.created_at) DESC LIMIT 50`;
  return { rows, total: n!.n, campaigns };
}

/** Orders that used a code (admin detail). */
export async function discountCodeUses(db: Db, codeId: number) {
  return db<
    {
      order_id: number;
      number: string;
      kind: string;
      email: string | null;
      discount_cents: number;
      status: string;
      created_at: Date;
    }[]
  >`
    SELECT u.order_id, o.number, o.kind, u.email, u.discount_cents, u.status, u.created_at
      FROM discount_code_uses u JOIN orders o ON o.id = u.order_id
     WHERE u.code_id = ${codeId} AND u.status <> 'released'
     ORDER BY u.created_at DESC LIMIT 200`;
}

import { sum, type Cents } from './money.ts';
import { quoteShipping, type CountryShippingSettings, type ShippingQuote } from './shipping.ts';

export type CartLine = {
  productId: number;
  quantity: number;
  unitPrice: Cents;
  highValue: boolean;
  /** Copies that can be sold right now: quantity − reserved, never below 0. */
  available: number;
  active: boolean;
};

export type CheckoutProblem =
  | { code: 'country_not_delivered'; country: string }
  | { code: 'below_minimum'; minimum: Cents; missing: Cents }
  | { code: 'unavailable'; productId: number; requested: number; available: number }
  | { code: 'empty_cart' }
  | { code: 'invalid_quantity'; productId: number }
  /** A code in the cart can no longer be used (checked again with the buyer's e-mail). */
  | { code: 'code_problem'; entry: string; problem: string };

export type CheckoutCheck = {
  ok: boolean;
  problems: CheckoutProblem[];
  goodsSubtotal: Cents;
  shipping: ShippingQuote | null;
  total: Cents | null;
};

/**
 * The checks run before stock is reserved and Stripe is opened:
 * country switched on, minimum order reached, every card still available.
 * The cart itself never reserves anything.
 */
export function checkCheckout(input: {
  lines: readonly CartLine[];
  country: CountryShippingSettings | null;
  countryCode: string;
}): CheckoutCheck {
  const problems: CheckoutProblem[] = [];
  const { lines, country } = input;

  if (lines.length === 0) problems.push({ code: 'empty_cart' });

  for (const l of lines) {
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1) {
      problems.push({ code: 'invalid_quantity', productId: l.productId });
      continue;
    }
    const available = l.active ? Math.max(0, l.available) : 0;
    if (l.quantity > available) {
      problems.push({
        code: 'unavailable',
        productId: l.productId,
        requested: l.quantity,
        available,
      });
    }
  }

  const goodsSubtotal = sum(lines.map((l) => l.unitPrice * Math.max(0, l.quantity)));

  if (!country || !country.deliveryEnabled) {
    problems.push({ code: 'country_not_delivered', country: input.countryCode });
    return { ok: false, problems, goodsSubtotal, shipping: null, total: null };
  }

  if (goodsSubtotal < country.minOrder) {
    problems.push({
      code: 'below_minimum',
      minimum: country.minOrder,
      missing: country.minOrder - goodsSubtotal,
    });
  }

  const shipping = quoteShipping({
    goodsSubtotal,
    hasHighValue: lines.some((l) => l.highValue),
    country,
  });

  return {
    ok: problems.length === 0,
    problems,
    goodsSubtotal,
    shipping,
    total: goodsSubtotal + shipping.price,
  };
}

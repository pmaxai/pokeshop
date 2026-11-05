import { percentOf, type BasisPoints, type Cents } from './money.ts';

/** Per-country delivery settings, one row of the admin country table. */
export type CountryShippingSettings = {
  code: string;
  deliveryEnabled: boolean;
  /** Goods subtotal the cart must reach. */
  minOrder: Cents;
  /** Standard shipping, 0 by default. */
  standardShipping: Cents;
  /** Insured-shipping charge as share of the goods subtotal, e.g. 2000 = 20 %. */
  insuredRate: BasisPoints;
  /** Lowest insured-shipping charge, e.g. 500 = € 5. */
  insuredMinimum: Cents;
  /**
   * Above this goods subtotal the order ships tracked but uninsured and the
   * charge falls away; null = always insured. Order value itself is unlimited.
   */
  insuredMaxOrder: Cents | null;
  /** Optional cap on the insured-shipping charge; null = no cap. */
  insuredMaxCharge: Cents | null;
};

export type ShippingMethod = 'standard' | 'insured' | 'tracked';

export type ShippingQuote = {
  method: ShippingMethod;
  price: Cents;
};

/**
 * Picks the shipping method and price for a cart.
 * - No high-value card: standard shipping (free by default).
 * - High-value card and subtotal up to the insurance limit: insured shipping,
 *   20 % of the goods subtotal, at least the minimum (and at most the cap, if set).
 * - High-value card and subtotal above the limit: tracked, signed-for,
 *   uninsured shipping at the standard price.
 */
export function quoteShipping(input: {
  goodsSubtotal: Cents;
  hasHighValue: boolean;
  country: CountryShippingSettings;
}): ShippingQuote {
  const { goodsSubtotal, hasHighValue, country } = input;
  if (!hasHighValue) {
    return { method: 'standard', price: country.standardShipping };
  }
  if (country.insuredMaxOrder !== null && goodsSubtotal > country.insuredMaxOrder) {
    return { method: 'tracked', price: country.standardShipping };
  }
  let price = Math.max(percentOf(goodsSubtotal, country.insuredRate), country.insuredMinimum);
  if (country.insuredMaxCharge !== null) price = Math.min(price, country.insuredMaxCharge);
  return { method: 'insured', price };
}

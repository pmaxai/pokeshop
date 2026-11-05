/**
 * Money is always handled as integer euro cents. Rates are basis points
 * (2000 = 20 %), so no floating-point value ever reaches a stored amount.
 */

export type Cents = number;
export type BasisPoints = number;

export function assertCents(value: number, label = 'amount'): asserts value is Cents {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be an integer number of cents, got ${value}`);
  }
}

/** Rounds half away from zero, the usual commercial rounding in Austria. */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Splits a gross amount (VAT included) into net and VAT.
 * VAT = gross × rate / (100 % + rate), rounded to the cent; net = gross − VAT,
 * so net + VAT always equals the gross amount the customer paid.
 */
export function splitGross(gross: Cents, rate: BasisPoints): { net: Cents; vat: Cents } {
  assertCents(gross, 'gross');
  assertCents(rate, 'rate');
  if (rate < 0) throw new RangeError('rate must not be negative');
  const vat = roundHalfAwayFromZero((gross * rate) / (10_000 + rate));
  return { net: gross - vat, vat };
}

/** Percentage of an amount, e.g. 20 % insured-shipping charge. */
export function percentOf(amount: Cents, rate: BasisPoints): Cents {
  assertCents(amount);
  assertCents(rate, 'rate');
  return roundHalfAwayFromZero((amount * rate) / 10_000);
}

export function sum(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) {
    assertCents(v);
    total += v;
  }
  return total;
}

const formatters = new Map<string, Intl.NumberFormat>();

/** Formats cents as euro in the shop locale: 12900 → "€ 129,00" (de-AT) or "€129.00" (en). */
export function formatEuro(amount: Cents, locale: 'de' | 'en' = 'de'): string {
  assertCents(amount);
  const tag = locale === 'de' ? 'de-AT' : 'en-IE';
  let f = formatters.get(tag);
  if (!f) {
    f = new Intl.NumberFormat(tag, { style: 'currency', currency: 'EUR' });
    formatters.set(tag, f);
  }
  return f.format(amount / 100);
}

/** Formats a basis-point rate as a percentage: 2000 → "20 %", 2550 → "25,5 %". */
export function formatRate(rate: BasisPoints, locale: 'de' | 'en' = 'de'): string {
  const value = rate / 100;
  const text = new Intl.NumberFormat(locale === 'de' ? 'de-AT' : 'en-IE', {
    maximumFractionDigits: 2,
  }).format(value);
  return locale === 'de' ? `${text} %` : `${text}%`;
}

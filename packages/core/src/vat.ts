import { splitGross, type BasisPoints, type Cents } from './money.ts';

/** Shop seat: all tax is Austrian unless OSS is switched on. */
export const HOME_COUNTRY = 'AT';

export const EU_COUNTRIES = [
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
] as const;

export type EuCountry = (typeof EU_COUNTRIES)[number];

export function isEuCountry(code: string): code is EuCountry {
  return (EU_COUNTRIES as readonly string[]).includes(code);
}

/**
 * Standard VAT rates in basis points as known in mid-2026. They are only
 * seed values for the admin table: check them with the tax adviser before
 * switching on OSS, because member states change rates from time to time.
 */
export const STANDARD_VAT_RATES: Record<EuCountry, BasisPoints> = {
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
};

export type VatContext = {
  /** Delivery country (ISO 3166-1 alpha-2). */
  country: string;
  /** OSS switch from the admin settings. */
  ossEnabled: boolean;
  /**
   * Small business scheme (Kleinunternehmerregelung, § 6 Abs. 1 Z 27 UStG): no VAT at all.
   * Setting `small_business`.
   */
  smallBusiness?: boolean;
  /** Current rates table from the database; falls back to the seed values. */
  rates?: Partial<Record<string, BasisPoints>>;
};

export type VatDecision = {
  rate: BasisPoints;
  /** Country whose VAT is charged; null for a tax-free export. */
  taxCountry: string | null;
  regime: VatRegime;
};

export type VatRegime = 'domestic' | 'oss' | 'export' | 'small_business';

/** Invoice note for a sale under the small business scheme. */
export const SMALL_BUSINESS_NOTE = {
  de: 'Umsatzsteuerbefreit, Kleinunternehmer gemäß § 6 Abs. 1 Z 27 UStG',
  en: 'VAT-exempt small business pursuant to § 6 (1) Z 27 UStG (Austrian VAT Act)',
} as const;

/**
 * Decides which VAT applies to a consumer sale shipped from Austria.
 * - Small business scheme: no VAT, whatever the destination.
 * - Non-EU destination: tax-free export (0 %).
 * - EU destination with OSS off: Austrian VAT.
 * - EU destination other than Austria with OSS on: destination standard rate.
 */
export function vatFor(ctx: VatContext): VatDecision {
  const country = ctx.country.toUpperCase();
  const rateOf = (c: EuCountry): BasisPoints => ctx.rates?.[c] ?? STANDARD_VAT_RATES[c];
  if (ctx.smallBusiness) {
    return { rate: 0, taxCountry: HOME_COUNTRY, regime: 'small_business' };
  }
  if (!isEuCountry(country)) {
    return { rate: 0, taxCountry: null, regime: 'export' };
  }
  if (country !== HOME_COUNTRY && ctx.ossEnabled) {
    return { rate: rateOf(country), taxCountry: country, regime: 'oss' };
  }
  return { rate: rateOf(HOME_COUNTRY), taxCountry: HOME_COUNTRY, regime: 'domestic' };
}

export type VatLine = { gross: Cents };

export type VatBreakdown = {
  rate: BasisPoints;
  regime: VatDecision['regime'];
  taxCountry: string | null;
  gross: Cents;
  net: Cents;
  vat: Cents;
};

/**
 * VAT for a whole order. All lines of one order carry the same rate (one
 * delivery country, standard rate only), so the tax is computed once on the
 * total gross – this keeps invoice and Stripe amounts identical to the cent.
 * For exports the gross price stays the same and contains no VAT.
 */
export function orderVat(lines: readonly VatLine[], ctx: VatContext): VatBreakdown {
  const decision = vatFor(ctx);
  const gross = lines.reduce((acc, l) => acc + l.gross, 0);
  const { net, vat } = splitGross(gross, decision.rate);
  return { ...decision, gross, net, vat };
}

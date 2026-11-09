/**
 * Licences for the ScanPM app, sold in the shop by Antalyse GmbH. A purchase is an order of
 * kind 'license' and seller 'gmbh': no cards and no shipping, paid through the GmbH's own
 * Stripe account, which works out the VAT (Stripe Tax) and issues invoice and credit notes.
 * After the payment the worker asks the licence service for the keys and e-mails key, QR code,
 * download link and Stripe's invoice (job 'license.issue').
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Db, Sql } from './db.ts';
import { issueCreditNoteForLicense, issueInvoice } from './fulfilment.ts';
import { enqueueJob } from './jobs.ts';
import { currentLegalVersions } from './legal.ts';
import type { LicenseClient } from './license-client.ts';
import { splitGross } from './money.ts';
import { newOrderNumber } from './numbering.ts';
import { orderEvent, startPayment, validPostcode, type CreatedOrder } from './orders.ts';
import { alertShop, enqueueMail, type MailAttachment } from './outbox.ts';
import type { PaymentProvider, SessionInfo } from './payments.ts';
import { STRIPE_MIN_SESSION_MINUTES } from './reservation.ts';
import { licenseCountryAllowed, parseTaxId, type TaxId, type ViesChecker } from './tax-id.ts';
import { HOME_COUNTRY, isEuCountry, STANDARD_VAT_RATES } from './vat.ts';

export const APP_NAME = 'ScanPM';
/** The licence service issues at most 50 keys per order. */
export const MAX_LICENSES_PER_ORDER = 50;
export const DEFAULT_LICENSE_PRICE_CENTS = 13900;

// ---------------------------------------------------------------------------
// Checkout form
// ---------------------------------------------------------------------------

const required = (max: number) => z.string().trim().min(1, 'required').max(max, 'too_long');
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'too_long')
    .transform((v) => v || undefined)
    .optional();

/**
 * The billing address is required: invoices above € 400 must name the buyer's address
 * (§ 11 UStG), and three licences are already more. Business buyers name their company;
 * abroad they also give their tax id (EU: VAT id, checked with VIES).
 */
export const LicenseCheckout = z.object({
  buyer: z.enum(['consumer', 'business'], 'required'),
  name: required(100),
  company: optional(100),
  vatId: optional(40),
  email: z.email('invalid_email').trim().toLowerCase().max(200, 'too_long'),
  street: required(120),
  postcode: z.string().trim().min(1, 'required').max(10, 'too_long'),
  city: required(80),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'required'),
  quantity: z.coerce
    .number('invalid')
    .int('invalid')
    .min(1, 'invalid')
    .max(MAX_LICENSES_PER_ORDER, 'too_many'),
  acceptTerms: z.literal(true, 'terms'),
  /** § 18 Abs. 1 Z 11 FAGG: start right away, the right of withdrawal ends with delivery. */
  immediateDelivery: z.literal(true, 'consent'),
});
export type LicenseCheckout = z.infer<typeof LicenseCheckout>;

/**
 * Form check without the network: field formats, company and tax id where the buyer type
 * needs them, and whether the country may buy at all. VIES comes after (checkLicenseBuyer).
 */
export function validateLicenseCheckout(
  input: unknown,
): { ok: true; data: LicenseCheckout } | { ok: false; errors: Record<string, string> } {
  const r = LicenseCheckout.safeParse(input);
  const errors: Record<string, string> = {};
  if (!r.success) {
    for (const i of r.error.issues) {
      const k = i.path.join('.') || '_';
      errors[k] ??= i.message.startsWith('Invalid') ? 'invalid' : i.message;
    }
  }
  // Rules across fields, reported alongside the rest (zod skips refinements of broken objects).
  const raw = (input ?? {}) as Record<string, unknown>;
  const text = (k: string) => String(raw[k] ?? '').trim();
  const country = text('country').toUpperCase();
  const business = raw.buyer === 'business';
  const postcode = text('postcode');
  const hasCountry = /^[A-Z]{2}$/.test(country);
  if (!errors.postcode && postcode && hasCountry && !validPostcode(country, postcode)) {
    errors.postcode = 'invalid_postcode';
  }
  if (business && !errors.company && !text('company')) errors.company = 'required';
  if (hasCountry && !errors.country && !licenseCountryAllowed(country, business)) {
    errors.country = licenseCountryAllowed(country, true) ? 'consumer_eu_only' : 'country';
  }
  if (business && hasCountry && !errors.vatId && !errors.country) {
    const id = text('vatId');
    if (!id && !isEuCountry(country)) errors.vatId = 'required';
    else if (id && !parseTaxId(country, id)) errors.vatId = 'invalid_tax_id';
  }
  if (r.success && Object.keys(errors).length === 0) return { ok: true, data: r.data };
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------
// Price and VAT by buyer
// ---------------------------------------------------------------------------

/** Stripe product tax codes: downloadable software for personal or for business use. */
export const LICENSE_TAX_CODES = {
  consumer: 'txcd_10202000',
  business: 'txcd_10202003',
} as const;

/**
 * The set price includes Austrian VAT. Business buyers abroad pay it without (they account
 * for the tax themselves): € 139 → € 115.83.
 */
export const netLicensePrice = (grossCents: number) =>
  Math.round((grossCents * 10_000) / (10_000 + STANDARD_VAT_RATES[HOME_COUNTRY]));

export type LicenseRegime = 'domestic' | 'oss' | 'reverse_charge' | 'export';

export type LicensePricing = {
  /** Per licence, as on the payment page: gross ('inclusive') or net ('exclusive'). */
  unitCents: number;
  behavior: 'inclusive' | 'exclusive';
  regime: LicenseRegime;
  /** Country whose VAT is charged (Stripe Tax has the last word); null when none is. */
  taxCountry: string | null;
  /** Expected rate in basis points. */
  rateBp: number;
  /** Stripe customer setting: 'reverse' for business buyers abroad. */
  taxExempt: 'none' | 'reverse';
  taxCode: string;
};

/**
 * - Consumers (EU only) and Austrian businesses: the set price including VAT, Austrian or
 *   the buyer's country's (OSS).
 * - Businesses elsewhere in the EU with a valid VAT id: net price, reverse charge.
 * - EU businesses without a VAT id: as consumers.
 * - Businesses outside the EU (CH, LI, NO, IS, GB, US, CA, AU): net price, not taxable in
 *   Austria (place of supply is the buyer's seat).
 */
export function licensePricing(input: {
  grossCents: number;
  business: boolean;
  country: string;
  taxId: TaxId | null;
  /** Current VAT rates (countries table); falls back to the seed values. */
  rates?: Partial<Record<string, number>>;
}): LicensePricing {
  const code = input.business ? LICENSE_TAX_CODES.business : LICENSE_TAX_CODES.consumer;
  const rateOf = (c: string) =>
    input.rates?.[c] ?? (STANDARD_VAT_RATES as Record<string, number>)[c] ?? 0;
  const eu = isEuCountry(input.country);
  if (input.business && input.country !== HOME_COUNTRY && (!eu || input.taxId)) {
    return {
      unitCents: netLicensePrice(input.grossCents),
      behavior: 'exclusive',
      regime: eu ? 'reverse_charge' : 'export',
      taxCountry: null,
      rateBp: 0,
      taxExempt: 'reverse',
      taxCode: code,
    };
  }
  const home = input.country === HOME_COUNTRY;
  return {
    unitCents: input.grossCents,
    behavior: 'inclusive',
    regime: home ? 'domestic' : 'oss',
    taxCountry: input.country,
    rateBp: rateOf(input.country),
    taxExempt: 'none',
    taxCode: code,
  };
}

export type LicenseBuyer = {
  business: boolean;
  country: string;
  taxId: TaxId | null;
  /** Name VIES has for the VAT id (shown in the admin). */
  viesName: string | null;
  pricing: LicensePricing;
};

/**
 * After validateLicenseCheckout: checks an EU VAT id with VIES and settles price and VAT.
 * A VAT id VIES cannot confirm right now is not taken on trust (reverse charge needs it).
 */
export async function checkLicenseBuyer(
  db: Db,
  d: LicenseCheckout,
  input: { grossCents: number; vies: ViesChecker },
): Promise<{ ok: true; buyer: LicenseBuyer } | { ok: false; errors: Record<string, string> }> {
  const business = d.buyer === 'business';
  const [c] = await db<{ code: string; vat_rate_bp: number }[]>`
    SELECT code, vat_rate_bp FROM countries WHERE code = ${d.country}`;
  if (!c || !licenseCountryAllowed(c.code, business)) {
    return { ok: false, errors: { country: business ? 'country' : 'consumer_eu_only' } };
  }
  let taxId: TaxId | null = null;
  let viesName: string | null = null;
  if (business && d.vatId) {
    taxId = parseTaxId(c.code, d.vatId);
    if (!taxId) return { ok: false, errors: { vatId: 'invalid_tax_id' } };
    if (taxId.type === 'eu_vat') {
      const v = await input.vies(taxId.value);
      if (v.status === 'invalid') return { ok: false, errors: { vatId: 'vat_id_invalid' } };
      if (v.status === 'unavailable') return { ok: false, errors: { vatId: 'vies_unavailable' } };
      viesName = v.name;
    }
  } else if (business && !isEuCountry(c.code)) {
    return { ok: false, errors: { vatId: 'required' } };
  }
  const pricing = licensePricing({
    grossCents: input.grossCents,
    business,
    country: c.code,
    taxId,
    rates: { [c.code]: c.vat_rate_bp || undefined },
  });
  return { ok: true, buyer: { business, country: c.code, taxId, viesName, pricing } };
}

// ---------------------------------------------------------------------------
// What is on sale
// ---------------------------------------------------------------------------

export type AppRelease = {
  id: number;
  version: string;
  storageKey: string;
  sizeBytes: number;
  sha256: string;
  notes: string | null;
  uploadedBy: string;
  createdAt: Date;
};

type ReleaseRow = {
  id: number;
  version: string;
  storage_key: string;
  size_bytes: string | number;
  sha256: string;
  notes: string | null;
  uploaded_by: string;
  created_at: Date;
};

const release = (r: ReleaseRow): AppRelease => ({
  id: Number(r.id),
  version: r.version,
  storageKey: r.storage_key,
  sizeBytes: Number(r.size_bytes),
  sha256: r.sha256,
  notes: r.notes,
  uploadedBy: r.uploaded_by,
  createdAt: r.created_at,
});

export async function listReleases(db: Db, limit = 20): Promise<AppRelease[]> {
  const rows = await db<ReleaseRow[]>`
    SELECT * FROM app_releases ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
  return rows.map(release);
}

export async function currentRelease(db: Db): Promise<AppRelease | null> {
  return (await listReleases(db, 1))[0] ?? null;
}

export async function addRelease(
  db: Db,
  input: {
    version: string;
    storageKey: string;
    sizeBytes: number;
    sha256: string;
    notes?: string | null;
    uploadedBy: string;
  },
): Promise<AppRelease> {
  const [r] = await db<ReleaseRow[]>`
    INSERT INTO app_releases (version, storage_key, size_bytes, sha256, notes, uploaded_by)
    VALUES (${input.version.trim()}, ${input.storageKey}, ${input.sizeBytes}, ${input.sha256},
            ${input.notes?.trim() || null}, ${input.uploadedBy})
    RETURNING *`;
  return release(r!);
}

export type AppSales = {
  priceCents: number;
  /** Set once the app is in the Play Store: replaces the APK download. */
  playStoreUrl: string | null;
  release: AppRelease | null;
  /** Licences can be bought: the licence service is set up and there is something to install. */
  open: boolean;
};

export async function appSales(db: Db, serviceConfigured: boolean): Promise<AppSales> {
  const rows = await db<{ key: string; value: unknown }[]>`
    SELECT key, value FROM settings WHERE key IN ('app_license_price_cents', 'app_play_store_url')`;
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const price = Number(get('app_license_price_cents') ?? DEFAULT_LICENSE_PRICE_CENTS);
  const store = get('app_play_store_url');
  const playStoreUrl = typeof store === 'string' && store.startsWith('https://') ? store : null;
  const rel = await currentRelease(db);
  return {
    priceCents: Number.isInteger(price) && price > 0 ? price : DEFAULT_LICENSE_PRICE_CENTS,
    playStoreUrl,
    release: rel,
    open: serviceConfigured && (rel !== null || playStoreUrl !== null),
  };
}

export const AppSettings = z.object({
  priceCents: z.number().int().min(100).max(100_000),
  /** The GmbH's address for licence e-mails (sender and replies). */
  senderEmail: z.email('invalid_email').trim().toLowerCase().max(200).optional(),
  playStoreUrl: z
    .string()
    .trim()
    .max(300)
    .refine(
      (v) => v === '' || /^https:\/\/play\.google\.com\/store\/apps\/details\?id=[\w.]+/.test(v),
      {
        message: 'play_store_url',
      },
    ),
});

export async function saveAppSettings(sql: Sql, input: z.infer<typeof AppSettings>): Promise<void> {
  const v = AppSettings.parse(input);
  await sql.begin(async (tx) => {
    for (const [key, value] of [
      ['app_license_price_cents', v.priceCents],
      ['app_play_store_url', v.playStoreUrl || null],
    ] as const) {
      const json = value === null ? tx`'null'::jsonb` : tx`${tx.json(value as never)}`;
      await tx`INSERT INTO settings (key, value) VALUES (${key}, ${json})
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    }
    if (v.senderEmail) {
      await tx`UPDATE settings SET value = jsonb_set(value, '{email}', ${tx.json(v.senderEmail)})
                WHERE key = 'license_seller'`;
    }
  });
}

/** Antalyse GmbH, seller of the licences (setting license_seller). */
export type LicenseSeller = {
  name: string;
  street: string;
  postcode: string;
  city: string;
  country: string;
  email: string;
  register_number: string;
  register_court: string;
  vat_id: string;
  managing_director: string;
  chamber?: string;
  supervisory_authority?: string;
};

export async function licenseSeller(db: Db): Promise<LicenseSeller> {
  const [r] = await db<{ value: Partial<LicenseSeller> }[]>`
    SELECT value FROM settings WHERE key = 'license_seller'`;
  const v = r?.value ?? {};
  return {
    name: v.name ?? 'Antalyse GmbH',
    street: v.street ?? '',
    postcode: v.postcode ?? '',
    city: v.city ?? '',
    country: v.country ?? 'AT',
    email: v.email ?? '',
    register_number: v.register_number ?? '',
    register_court: v.register_court ?? '',
    vat_id: v.vat_id ?? '',
    managing_director: v.managing_director ?? '',
    chamber: v.chamber,
    supervisory_authority: v.supervisory_authority,
  };
}

/** Footer of the GmbH's Stripe invoices: who issues it, and why there is no VAT, if none. */
export function licenseInvoiceFooter(
  seller: LicenseSeller,
  regime: LicenseRegime,
  locale: 'de' | 'en',
): string {
  const de = locale === 'de';
  const who = [
    seller.name,
    `${seller.street}, ${seller.postcode} ${seller.city}, ${de ? 'Österreich' : 'Austria'}`,
    [seller.register_number, seller.register_court].filter(Boolean).join(', '),
    seller.vat_id ? `UID ${seller.vat_id}` : '',
    seller.managing_director
      ? `${de ? 'Geschäftsführer' : 'Managing director'}: ${seller.managing_director}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const tax =
    regime === 'reverse_charge'
      ? de
        ? 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge, Art. 196 MwSt-RL).'
        : 'Reverse charge: VAT to be accounted for by the recipient (Art. 196 VAT Directive).'
      : regime === 'export'
        ? de
          ? 'Nicht in Österreich steuerbar: Leistungsort ist der Sitz des Leistungsempfängers (§ 3a Abs. 6 UStG).'
          : 'Not subject to Austrian VAT: the place of supply is the recipient’s seat (§ 3a (6) UStG).'
        : '';
  const date = de
    ? 'Leistungsdatum = Rechnungsdatum (Lieferung der Lizenz per E-Mail).'
    : 'Date of supply = invoice date (licence delivered by e-mail).';
  return [who, tax, date].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// The order
// ---------------------------------------------------------------------------

export class LicenseCheckoutRejected extends Error {
  readonly code: 'country' | 'closed';
  constructor(code: 'country' | 'closed') {
    super(`licence checkout rejected: ${code}`);
    this.code = code;
  }
}

/** Creates the unpaid order; startLicensePayment then opens the GmbH's Stripe page for it. */
export async function createLicenseOrder(
  sql: Sql,
  input: {
    locale: 'de' | 'en';
    details: LicenseCheckout;
    buyer: LicenseBuyer;
    now?: Date;
  },
): Promise<CreatedOrder> {
  const now = input.now ?? new Date();
  const d = input.details;
  const b = input.buyer;
  const pricing = b.pricing;
  return sql.begin(async (tx) => {
    const [country] = await tx<{ code: string }[]>`
      SELECT code FROM countries WHERE code = ${b.country}`;
    if (!country || !licenseCountryAllowed(country.code, b.business)) {
      throw new LicenseCheckoutRejected('country');
    }
    const total = pricing.unitCents * d.quantity;
    // What we expect Stripe Tax to charge; the paid session's figures replace it.
    const vat = pricing.behavior === 'inclusive' ? splitGross(total, pricing.rateBp).vat : 0;
    const legal = await currentLegalVersions(tx);
    let number = '';
    for (let i = 0; i < 6 && !number; i++) {
      const candidate = newOrderNumber(now);
      const [taken] = await tx`SELECT 1 FROM orders WHERE number = ${candidate}`;
      if (!taken) number = candidate;
    }
    if (!number) throw new Error('could not allocate an order number');
    const token = randomBytes(24).toString('base64url');
    // Nothing is held; the order just lives as long as its Stripe page.
    const until = new Date(now.getTime() + (STRIPE_MIN_SESSION_MINUTES + 5) * 60_000);
    const company = b.business ? d.company : undefined;
    const billing = {
      name: d.name,
      company,
      street: d.street,
      postcode: d.postcode,
      city: d.city,
      country: country.code,
      ...(b.taxId ? { tax_id: b.taxId.value } : {}),
      ...(b.viesName ? { vies_name: b.viesName } : {}),
    };
    // The GmbH's licence terms (with its withdrawal information) are the contract; the shop's
    // AGB and withdrawal texts do not apply.
    const [o] = await tx<{ id: number }[]>`
      INSERT INTO orders (number, lookup_token, kind, seller, status, locale, country, email,
                          customer_name, billing_address, goods_cents, shipping_cents, total_cents,
                          shipping_method, vat_regime, tax_country, vat_rate_bp, vat_cents,
                          buyer_business, buyer_tax_id, buyer_tax_id_type,
                          reserved_until, agb_version, privacy_version, withdrawal_version,
                          terms_accepted_at, created_at)
      VALUES (${number}, ${token}, 'license', 'gmbh', 'checkout', ${input.locale}, ${country.code},
              ${d.email}, ${d.name}, ${tx.json(billing as never)}, ${total}, 0, ${total}, 'none',
              ${pricing.regime}, ${pricing.taxCountry}, ${pricing.rateBp}, ${vat},
              ${b.business}, ${b.taxId?.value ?? null}, ${b.taxId?.type ?? null},
              ${until}, NULL, ${legal.privacy}, NULL, ${now}, ${now})
      RETURNING id`;
    await tx`
      INSERT INTO order_licenses (order_id, quantity, unit_price_cents, immediate_delivery_consent_at,
                                  terms_version)
      VALUES (${o!.id}, ${d.quantity}, ${pricing.unitCents}, ${now}, ${legal.license_terms})`;
    await orderEvent(tx, o!.id, 'created', {
      kind: 'license',
      seller: 'gmbh',
      quantity: d.quantity,
      regime: pricing.regime,
      ...(b.taxId ? { tax_id: b.taxId.value, vies: b.viesName ?? 'valid' } : {}),
    });
    return {
      id: o!.id,
      number,
      token,
      totalCents: total,
      reservedUntil: until,
      replacedSessions: [],
    };
  });
}

/**
 * Opens the GmbH's Stripe page: a Stripe customer with address and tax id (for Stripe Tax and
 * the invoice), then the session with automatic tax and an invoice. If Stripe refuses the
 * customer, the order is cancelled and the error tells which field was wrong.
 */
export async function startLicensePayment(
  sql: Sql,
  provider: PaymentProvider,
  order: CreatedOrder,
  input: {
    details: LicenseCheckout;
    buyer: LicenseBuyer;
    locale: 'de' | 'en';
    successUrl: string;
    cancelUrl: string;
    now?: Date;
  },
): Promise<string> {
  if (provider.seller !== 'gmbh') throw new Error('licences are paid to the GmbH account');
  const d = input.details;
  const b = input.buyer;
  let customerId: string;
  try {
    customerId = await provider.createCustomer({
      orderId: order.id,
      orderNumber: order.number,
      email: d.email,
      name: d.name,
      company: b.business ? d.company : undefined,
      locale: input.locale,
      address: { line1: d.street, postcode: d.postcode, city: d.city, country: b.country },
      taxId: b.taxId,
      taxExempt: b.pricing.taxExempt,
    });
  } catch (e) {
    await sql`UPDATE orders SET status = 'cancelled', cancelled_at = now(), reserved_until = NULL
               WHERE id = ${order.id} AND status = 'checkout'`;
    await orderEvent(sql, order.id, 'cancelled', {
      reason: 'customer_rejected',
      error: (e as Error).message.slice(0, 300),
    });
    throw e;
  }
  await sql`UPDATE orders SET stripe_customer_id = ${customerId} WHERE id = ${order.id}`;
  const seller = await licenseSeller(sql);
  return startPayment(sql, provider, order, {
    email: d.email,
    locale: input.locale,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    now: input.now,
    customerId,
    tax: { behavior: b.pricing.behavior, code: b.pricing.taxCode },
    invoice: {
      footer: licenseInvoiceFooter(seller, b.pricing.regime, input.locale),
      fields: [
        { name: input.locale === 'de' ? 'Bestellnummer' : 'Order number', value: order.number },
      ],
    },
  });
}

/** Payment page line for a licence order, in the buyer's language. */
export async function licensePaymentLine(db: Db, orderId: number, locale: 'de' | 'en') {
  const [l] = await db<{ quantity: number; unit_price_cents: number }[]>`
    SELECT quantity, unit_price_cents FROM order_licenses WHERE order_id = ${orderId}`;
  if (!l) return null;
  return {
    name: locale === 'en' ? `${APP_NAME} licence (beta)` : `${APP_NAME}-Lizenz (Beta)`,
    description:
      locale === 'en'
        ? 'One-off licence for the Android app, one device at a time, updates included'
        : 'Einmal-Lizenz für die Android-App, ein Gerät gleichzeitig, inkl. Updates',
    unitAmount: l.unit_price_cents,
    quantity: l.quantity,
  };
}

/** Invoice and credit-note line for the licences. */
export function licenseDocumentLine(quantity: number, unitCents: number) {
  return {
    de: `${APP_NAME} – Einmal-Lizenz für die Android-App (Beta), inkl. Updates`,
    en: `${APP_NAME} – one-off licence for the Android app (beta), updates included`,
    quantity,
    unit_cents: unitCents,
  };
}

/**
 * Inside the payment transaction (processPaidSession): marks the order paid and queues the
 * licence delivery. Keys come from the licence service, which is called outside the database
 * transaction by the worker.
 */
export async function licenseOrderPaid(
  tx: Db,
  o: { id: number; number: string; total_cents: number; seller: 'shop' | 'gmbh' },
  session: SessionInfo,
  now: Date,
): Promise<void> {
  let total = o.total_cents;
  if (o.seller === 'gmbh') total = await recordStripeTax(tx, o.id, session);
  await tx`UPDATE orders SET status = 'paid', paid_at = ${now}, reserved_until = NULL
            WHERE id = ${o.id}`;
  await enqueueJob(tx, 'license.issue', { order_id: o.id }, { dedupeKey: `license.issue:${o.id}` });
  await alertShop(
    tx,
    `${APP_NAME}-Lizenz verkauft: ${o.number}`,
    `Bezahlt${o.seller === 'gmbh' ? ' an die GmbH' : ''}: ${(total / 100).toFixed(2).replace('.', ',')} €. Der Schlüssel geht automatisch per E-Mail an den Kunden.`,
    `license_sold:${o.id}`,
  );
}

/**
 * GmbH orders: Stripe Tax decided the VAT, so the order takes the paid session's figures
 * (total, tax, rate, country) and remembers the invoice Stripe created.
 */
async function recordStripeTax(tx: Db, orderId: number, s: SessionInfo): Promise<number> {
  const [o] = await tx<
    {
      number: string;
      total_cents: number;
      vat_regime: string;
      tax_country: string | null;
      vat_rate_bp: number;
    }[]
  >`SELECT number, total_cents, vat_regime, tax_country, vat_rate_bp FROM orders WHERE id = ${orderId}`;
  const total = s.amountTotal ?? o!.total_cents;
  const line = (s.taxes ?? []).find((t) => t.amount > 0) ?? s.taxes?.[0] ?? null;
  const tax = s.amountTax ?? null;
  const problem = stripeTaxProblem(o!, tax, line);
  if (problem) {
    await alertShop(
      tx,
      `Umsatzsteuer prüfen: ${o!.number}`,
      `Stripe Tax hat anders gerechnet als erwartet: ${problem} Bitte die Steuereinstellungen (Registrierungen Österreich und OSS) im Stripe-Konto der GmbH prüfen; die Rechnung von Stripe zeigt, was berechnet wurde.`,
      `stripe_tax:${orderId}`,
    );
  }
  await tx`
    UPDATE orders SET goods_cents = ${total}, total_cents = ${total},
           vat_cents = coalesce(${tax}::int, vat_cents),
           vat_rate_bp = CASE WHEN ${tax}::int = 0 THEN 0
                              ELSE coalesce(${line?.rateBp ?? null}::int, vat_rate_bp) END,
           tax_country = CASE WHEN ${tax}::int = 0 THEN NULL
                              ELSE coalesce(${line?.country ?? null}::text, tax_country) END
     WHERE id = ${orderId}`;
  await tx`UPDATE order_licenses SET stripe_invoice_id = ${s.invoiceId ?? null}
            WHERE order_id = ${orderId}`;
  return total;
}

/**
 * Compares what Stripe Tax charged with what the buyer was shown: VAT of the expected country
 * and rate for consumers and Austrian businesses, none for businesses abroad. Null when it fits.
 */
export function stripeTaxProblem(
  expected: { vat_regime: string; tax_country: string | null; vat_rate_bp: number },
  tax: number | null,
  line: { rateBp: number | null; country: string | null; reason: string | null } | null,
): string | null {
  if (tax === null) return 'Stripe hat für diese Zahlung keine Steuer berechnet (Stripe Tax aus?).';
  const net = expected.vat_regime === 'reverse_charge' || expected.vat_regime === 'export';
  if (net) {
    return tax === 0 ? null : `Erwartet war keine Umsatzsteuer, berechnet wurden ${tax} Cent.`;
  }
  if (tax === 0) {
    return `Erwartet war ${expected.vat_rate_bp / 100} % USt. (${expected.tax_country}), berechnet wurde keine${line?.reason ? ` (${line.reason})` : ''}.`;
  }
  if (!line) return null;
  if (line.country && expected.tax_country && line.country !== expected.tax_country) {
    return `Erwartet war die USt. von ${expected.tax_country}, berechnet wurde die von ${line.country}.`;
  }
  if (line.rateBp !== null && line.rateBp !== expected.vat_rate_bp) {
    return `Erwartet waren ${expected.vat_rate_bp / 100} %, berechnet wurden ${line.rateBp / 100} %.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

type LicenseOrderRow = {
  id: number;
  number: string;
  seller: 'shop' | 'gmbh';
  status: string;
  locale: 'de' | 'en';
  email: string | null;
  customer_name: string | null;
  lookup_token: string;
  quantity: number;
  unit_price_cents: number;
  license_ids: string[];
  issued_at: Date | null;
  revoked_at: Date | null;
  stripe_session_id: string | null;
  stripe_invoice_id: string | null;
};

async function licenseOrderRow(db: Db, orderId: number, lock = false) {
  const [o] = await db<LicenseOrderRow[]>`
    SELECT o.id, o.number, o.seller, o.status, o.locale, o.email, o.customer_name, o.lookup_token,
           o.stripe_session_id, l.quantity, l.unit_price_cents, l.license_ids, l.issued_at,
           l.revoked_at, l.stripe_invoice_id
      FROM orders o JOIN order_licenses l ON l.order_id = o.id
     WHERE o.id = ${orderId} AND o.kind = 'license'
     ${lock ? db`FOR UPDATE OF o, l` : db``}`;
  return o ?? null;
}

/**
 * Worker job 'license.issue': gets the keys for a paid order (the service answers a retry
 * with the same keys), takes the invoice – Stripe's for GmbH orders, the shop's own for older
 * ones – and queues the e-mail. Safe to run twice. A Stripe invoice that is not final yet
 * makes the job retry a minute later.
 */
export async function issueOrderLicenses(
  sql: Sql,
  client: LicenseClient,
  orderId: number,
  now = new Date(),
  gmbh: PaymentProvider | null = null,
): Promise<'issued' | 'already' | 'skipped'> {
  const o = await licenseOrderRow(sql, orderId);
  if (!o) throw new Error(`licence order ${orderId} not found`);
  if (o.issued_at) return 'already';
  if (o.status !== 'paid') return 'skipped';
  if (!o.email) throw new Error(`licence order ${o.number} has no e-mail address`);

  let stripeInvoice: { id: string; number: string; url: string | null; pdf: string | null } | null =
    null;
  if (o.seller === 'gmbh') {
    if (!gmbh || gmbh.seller !== 'gmbh') throw new Error('GmbH Stripe account not configured');
    let invoiceId = o.stripe_invoice_id;
    if (!invoiceId && o.stripe_session_id) {
      invoiceId = (await gmbh.getSession(o.stripe_session_id)).invoiceId ?? null;
    }
    if (!invoiceId) throw new Error(`Stripe has no invoice for ${o.number} yet`);
    const inv = await gmbh.getInvoice(invoiceId);
    if (!inv.number) throw new Error(`Stripe invoice for ${o.number} is not final yet`);
    stripeInvoice = { id: inv.id, number: inv.number, url: inv.hostedUrl, pdf: inv.pdfUrl };
  }

  const licenses = await client.issue({
    orderRef: o.number,
    email: o.email,
    name: o.customer_name ?? '',
    count: o.quantity,
  });
  return sql.begin(async (tx) => {
    const cur = await licenseOrderRow(tx, orderId, true);
    if (!cur || cur.issued_at) return 'already' as const;
    if (cur.status !== 'paid') return 'skipped' as const;
    await tx`UPDATE order_licenses SET license_ids = ${licenses.map((l) => l.id)}::text[], issued_at = ${now}
              WHERE order_id = ${orderId}`;
    let invoiceNumber: string | null;
    let attachments: MailAttachment[];
    if (stripeInvoice) {
      await tx`
        UPDATE order_licenses SET stripe_invoice_id = ${stripeInvoice.id},
               invoice_number = ${stripeInvoice.number}, invoice_url = ${stripeInvoice.url},
               invoice_pdf_url = ${stripeInvoice.pdf}
         WHERE order_id = ${orderId}`;
      invoiceNumber = stripeInvoice.number;
      // Stripe's invoice and the GmbH's licence terms (with the withdrawal information).
      attachments = [
        {
          kind: 'stripe',
          seller: 'gmbh',
          doc: 'invoice',
          id: stripeInvoice.id,
          number: stripeInvoice.number,
        },
        { kind: 'legal', kinds: ['license_terms'] },
      ];
    } else {
      const invoice = await issueInvoice(tx, orderId, now);
      invoiceNumber = invoice?.number ?? null;
      attachments = [
        ...(invoice ? [{ kind: 'document' as const, id: invoice.id }] : []),
        { kind: 'legal', kinds: ['agb', 'withdrawal'] },
      ];
    }
    await tx`UPDATE orders SET status = 'completed' WHERE id = ${orderId} AND status = 'paid'`;
    // Licence, invoice and – on a durable medium – terms, withdrawal information and the
    // confirmation that the right of withdrawal ended with delivery (§ 7 Abs. 3 FAGG).
    await enqueueMail(tx, {
      template: 'license_delivery',
      to: cur.email!,
      locale: cur.locale,
      payload: { order_id: orderId },
      attachments,
      dedupeKey: `license_delivery:${orderId}`,
    });
    await orderEvent(tx, orderId, 'licenses_issued', {
      licenses: licenses.map((l) => l.id),
      invoice: invoiceNumber,
    });
    return 'issued' as const;
  });
}

/** Admin: sends the licence e-mail of an order again (keys, QR codes, download link). */
export async function resendOrderLicenses(db: Db, orderId: number, actor: string): Promise<void> {
  const o = await licenseOrderRow(db, orderId);
  if (!o?.issued_at || !o.email) throw new Error('Diese Bestellung hat noch keine Lizenzen.');
  await enqueueMail(db, {
    template: 'license_delivery',
    to: o.email,
    locale: o.locale,
    payload: { order_id: orderId, again: true },
    dedupeKey: `license_delivery:${orderId}:${Date.now()}`,
  });
  await orderEvent(db, orderId, 'license_mail_resent', {}, actor);
}

/**
 * "Licence e-mail lost?" on the app page. Always answers the same, so nobody can find out
 * which addresses bought a licence; at most one look-up per address and hour.
 */
export async function requestLicenseResend(
  db: Db,
  email: string,
  locale: 'de' | 'en',
  now = new Date(),
): Promise<void> {
  const addr = email.trim().toLowerCase();
  if (!z.email().safeParse(addr).success || addr.length > 200) return;
  const hour = now.toISOString().slice(0, 13);
  await enqueueJob(
    db,
    'license.resend',
    { email: addr, locale },
    { dedupeKey: `license.resend:${addr}:${hour}`, maxAttempts: 3 },
  );
}

/** Worker job 'license.resend': mails the address its licences, if it has any. */
export async function resendLicensesByEmail(
  db: Db,
  client: LicenseClient,
  email: string,
  locale: 'de' | 'en',
  now = new Date(),
): Promise<number> {
  const licenses = (await client.byEmail(email)).filter((l) => !l.revoked_at);
  if (!licenses.length) return 0;
  await enqueueMail(db, {
    template: 'license_resend',
    to: email,
    locale,
    payload: { license_ids: licenses.map((l) => l.id) },
    dedupeKey: `license_resend:${email}:${now.toISOString().slice(0, 13)}`,
  });
  return licenses.length;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export type LicenseOrderView = {
  id: number;
  number: string;
  status: string;
  locale: 'de' | 'en';
  email: string | null;
  name: string | null;
  quantity: number;
  totalCents: number;
  paidAt: Date | null;
  issuedAt: Date | null;
  /** Paid, keys issued and not refunded: the APK may be downloaded. */
  canDownload: boolean;
};

export async function licenseOrderByToken(db: Db, token: string): Promise<LicenseOrderView | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [o] = await db<(LicenseOrderRow & { total_cents: number; paid_at: Date | null })[]>`
    SELECT o.id, o.number, o.status, o.locale, o.email, o.customer_name, o.total_cents, o.paid_at,
           l.quantity, l.issued_at, l.revoked_at
      FROM orders o JOIN order_licenses l ON l.order_id = o.id
     WHERE o.lookup_token = ${token} AND o.kind = 'license'`;
  if (!o) return null;
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    locale: o.locale,
    email: o.email,
    name: o.customer_name,
    quantity: o.quantity,
    totalCents: o.total_cents,
    paidAt: o.paid_at,
    issuedAt: o.issued_at,
    canDownload: ['paid', 'completed'].includes(o.status) && !o.revoked_at,
  };
}

export async function recordDownload(db: Db, orderId: number): Promise<void> {
  await db`UPDATE order_licenses SET downloads = downloads + 1, last_download_at = now()
            WHERE order_id = ${orderId}`;
}

/** Path of the download link in e-mails (the order's secret token is the credential). */
export const downloadPath = (token: string) => `/api/app/download/${token}`;

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/**
 * Worker job 'license.revoke': the order was refunded, so its keys stop working. The app
 * locks at its next online check.
 */
export async function revokeOrderLicenses(
  sql: Sql,
  client: LicenseClient,
  orderId: number,
  reason: string,
): Promise<number> {
  const o = await licenseOrderRow(sql, orderId);
  if (!o) return 0;
  for (const id of o.license_ids) await client.revoke(id, reason);
  await sql`UPDATE order_licenses SET revoked_at = coalesce(revoked_at, now()) WHERE order_id = ${orderId}`;
  if (o.license_ids.length) {
    await orderEvent(sql, orderId, 'licenses_revoked', { licenses: o.license_ids, reason });
  }
  return o.license_ids.length;
}

/** Called when a licence order is refunded in full (admin, or the Stripe dashboard). */
export async function queueLicenseRevoke(db: Db, orderId: number, reason: string): Promise<void> {
  await enqueueJob(
    db,
    'license.revoke',
    { order_id: orderId, reason },
    { dedupeKey: `license.revoke:${orderId}` },
  );
}

/**
 * Admin: refunds a licence order in full and revokes its keys. GmbH orders get Stripe's credit
 * note (which reverses the VAT and makes the refund); older shop orders a refund and the shop's
 * own correction document.
 */
export async function refundLicenseOrder(
  sql: Sql,
  provider: PaymentProvider,
  input: { orderId: number; actor: string; reason: string },
  now = new Date(),
): Promise<{ amount: number; creditNote: string | null }> {
  const prep = await sql.begin(async (tx) => {
    const [o] = await tx<
      {
        id: number;
        number: string;
        seller: 'shop' | 'gmbh';
        status: string;
        total_cents: number;
        refunded_cents: number;
        stripe_payment_intent_id: string | null;
        stripe_invoice_id: string | null;
        locale: 'de' | 'en';
      }[]
    >`SELECT o.id, o.number, o.seller, o.status, o.total_cents, o.refunded_cents,
             o.stripe_payment_intent_id, l.stripe_invoice_id, o.locale
        FROM orders o JOIN order_licenses l ON l.order_id = o.id
       WHERE o.id = ${input.orderId} AND o.kind = 'license' FOR UPDATE OF o`;
    if (!o) throw new Error('Lizenzbestellung nicht gefunden.');
    if (o.seller !== provider.seller) {
      throw new Error('Diese Bestellung gehört zu einem anderen Stripe-Konto.');
    }
    if (!['paid', 'completed'].includes(o.status))
      throw new Error('Diese Bestellung kann nicht erstattet werden.');
    if (!o.stripe_payment_intent_id) throw new Error('Zu dieser Bestellung gibt es keine Zahlung.');
    const amount = o.total_cents - o.refunded_cents;
    if (amount <= 0) throw new Error('Es ist nichts mehr zu erstatten.');
    if (o.seller === 'gmbh') {
      if (!o.stripe_invoice_id)
        throw new Error('Zu dieser Bestellung gibt es noch keine Rechnung.');
      if (o.refunded_cents > 0) {
        throw new Error(
          'Ein Teil wurde schon in Stripe erstattet. Bitte die Gutschrift im Stripe-Dashboard der GmbH abschließen.',
        );
      }
    }
    const [r] = await tx<{ id: number }[]>`
      INSERT INTO refunds (order_id, amount_cents, shipping_cents, reason, status, created_by)
      VALUES (${o.id}, ${amount}, 0, ${input.reason.trim().slice(0, 500) || null}, 'pending', ${input.actor})
      RETURNING id`;
    return {
      refundId: r!.id,
      amount,
      pi: o.stripe_payment_intent_id,
      number: o.number,
      seller: o.seller,
      invoiceId: o.stripe_invoice_id,
      locale: o.locale,
    };
  });
  let stripeId: string;
  let credit: { id: string; number: string; pdfUrl: string | null } | null = null;
  try {
    if (prep.seller === 'gmbh') {
      const cn = await provider.creditInvoice({
        invoiceId: prep.invoiceId!,
        // Printed on the buyer's credit note: never the admin's internal reason.
        memo:
          prep.locale === 'en'
            ? `Refund of order ${prep.number}`
            : `Erstattung zur Bestellung ${prep.number}`,
        idempotencyKey: `refund-${prep.refundId}`,
      });
      if (cn.total !== prep.amount && cn.total > 0) {
        await alertShop(
          sql,
          `Gutschrift weicht ab: ${prep.number}`,
          `Stripe hat eine Gutschrift über ${(cn.total / 100).toFixed(2)} € erstellt, erwartet waren ${(prep.amount / 100).toFixed(2)} €.`,
          `credit_mismatch:${prep.refundId}`,
        );
      }
      stripeId = cn.refundId ?? cn.id;
      credit = { id: cn.id, number: cn.number, pdfUrl: cn.pdfUrl };
    } else {
      stripeId = (
        await provider.refund({
          paymentIntentId: prep.pi,
          amount: prep.amount,
          idempotencyKey: `refund-${prep.refundId}`,
        })
      ).id;
    }
  } catch (e) {
    await sql`UPDATE refunds SET status = 'failed', error = ${(e as Error).message.slice(0, 1000)}
               WHERE id = ${prep.refundId}`;
    throw new Error(`Stripe hat die Erstattung abgelehnt: ${(e as Error).message}`);
  }
  return sql.begin(async (tx) => {
    await tx`UPDATE refunds SET status = 'succeeded', stripe_refund_id = ${stripeId},
                    stripe_credit_note_id = ${credit?.id ?? null},
                    credit_note_number = ${credit?.number ?? null},
                    credit_note_pdf_url = ${credit?.pdfUrl ?? null}
              WHERE id = ${prep.refundId}`;
    const [o] = await tx<{ email: string | null; locale: 'de' | 'en' }[]>`
      UPDATE orders SET refunded_cents = refunded_cents + ${prep.amount}, status = 'refunded'
       WHERE id = ${input.orderId} RETURNING email, locale`;
    let attachments: MailAttachment[] = [];
    let creditNumber: string | null = null;
    if (credit) {
      creditNumber = credit.number;
      attachments = [
        {
          kind: 'stripe',
          seller: 'gmbh',
          doc: 'credit_note',
          id: credit.id,
          number: credit.number,
        },
      ];
    } else {
      const doc = await issueCreditNoteForLicense(tx, input.orderId, prep.refundId, now);
      creditNumber = doc?.number ?? null;
      attachments = doc ? [{ kind: 'document', id: doc.id }] : [];
    }
    await queueLicenseRevoke(tx, input.orderId, `refund ${prep.refundId}`);
    if (o?.email) {
      await enqueueMail(tx, {
        template: 'refund_issued',
        to: o.email,
        locale: o.locale,
        payload: { order_id: input.orderId, refund_id: prep.refundId },
        attachments,
        dedupeKey: `refund_issued:${prep.refundId}`,
      });
    }
    await orderEvent(
      tx,
      input.orderId,
      'refunded',
      { amount: prep.amount, refund: stripeId, credit_note: creditNumber },
      input.actor,
    );
    return { amount: prep.amount, creditNote: creditNumber };
  });
}

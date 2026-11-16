// App subscriptions: Collector (Scanner, Trading mode, web portal) and Creator (+ YouTube mode
// with recording), each with one device and extra devices on top. Sold by Antalyse GmbH through
// its Stripe account (billing.ts); the shop can also give one away (complimentary).
//
// What a customer may use is worked out in one place, entitlements(), for the portal and the app.
import { z } from 'zod';
import type { Account } from './accounts.ts';
import type { BillingProvider, BillingSubscription, Plan, TaxBehavior } from './billing.ts';
import { PLANS } from './billing.ts';
import type { Db, Sql } from './db.ts';
import { licenseSeller, type LicenseSeller } from './licenses.ts';
import { validPostcode } from './orders.ts';
import { enqueueMail } from './outbox.ts';
import { isEuCountry, HOME_COUNTRY, STANDARD_VAT_RATES } from './vat.ts';
import { parseTaxId, type TaxId, type ViesChecker } from './tax-id.ts';

export { PLANS, type Plan };

export const MAX_EXTRA_DEVICES = 20;

export type SubscriptionPrices = {
  collector: number;
  creator: number;
  collector_device: number;
  creator_device: number;
  /** Usage services (S3 per GB, pipeline per video minute); null until set. */
  s3_gb: number | null;
  pipeline_minute: number | null;
};

export const DEFAULT_PRICES: SubscriptionPrices = {
  collector: 700,
  creator: 1200,
  collector_device: 400,
  creator_device: 700,
  s3_gb: null,
  pipeline_minute: null,
};

export async function subscriptionPrices(db: Db): Promise<SubscriptionPrices> {
  const [r] = await db<{ value: Partial<SubscriptionPrices> }[]>`
    SELECT value FROM settings WHERE key = 'subscription_prices'`;
  const v = r?.value ?? {};
  const cents = (x: unknown, d: number) =>
    Number.isInteger(x) && (x as number) > 0 ? (x as number) : d;
  const opt = (x: unknown) => (Number.isInteger(x) && (x as number) > 0 ? (x as number) : null);
  return {
    collector: cents(v.collector, DEFAULT_PRICES.collector),
    creator: cents(v.creator, DEFAULT_PRICES.creator),
    collector_device: cents(v.collector_device, DEFAULT_PRICES.collector_device),
    creator_device: cents(v.creator_device, DEFAULT_PRICES.creator_device),
    s3_gb: opt(v.s3_gb),
    pipeline_minute: opt(v.pipeline_minute),
  };
}

const priceField = z.coerce
  .number('invalid')
  .int('invalid')
  .min(50, 'invalid')
  .max(100_000, 'invalid');
const usageField = z.union([
  z.literal(null),
  z.coerce.number('invalid').int('invalid').min(1, 'invalid').max(100_000, 'invalid'),
]);
export const PricesForm = z.object({
  collector: priceField,
  creator: priceField,
  collector_device: priceField,
  creator_device: priceField,
  s3_gb: usageField,
  pipeline_minute: usageField,
});

/** New prices apply to new subscriptions and changes; running ones keep theirs. */
export async function saveSubscriptionPrices(db: Db, input: unknown): Promise<SubscriptionPrices> {
  const v = PricesForm.parse(input);
  await db`
    INSERT INTO settings (key, value) VALUES ('subscription_prices', ${db.json(v as never)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return v;
}

/** The net price for reverse-charge customers: the gross price less Austrian VAT. */
export const netPrice = (grossCents: number) =>
  Math.round((grossCents * 10_000) / (10_000 + STANDARD_VAT_RATES[HOME_COUNTRY]));

export function planCents(
  prices: SubscriptionPrices,
  plan: Plan,
  behavior: TaxBehavior = 'incl',
): { base: number; device: number } {
  const base = prices[plan];
  const device = prices[`${plan}_device`];
  return behavior === 'incl'
    ? { base, device }
    : { base: netPrice(base), device: netPrice(device) };
}

export const monthlyCents = (
  prices: SubscriptionPrices,
  plan: Plan,
  extraDevices: number,
  behavior: TaxBehavior = 'incl',
) => {
  const c = planCents(prices, plan, behavior);
  return c.base + extraDevices * c.device;
};

// ---------------------------------------------------------------------------
// The subscription row
// ---------------------------------------------------------------------------

export type Subscription = {
  id: number;
  accountId: number;
  /** stripe: bought on the website; google_play / app_store: bought in the app (store_purchases) */
  source: 'stripe' | 'complimentary' | 'google_play' | 'app_store';
  plan: Plan;
  extraDevices: number;
  status: string;
  stripeSubscriptionId: string | null;
  taxBehavior: TaxBehavior | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  endsAt: Date | null;
  endedAt: Date | null;
  items: { base?: string; devices?: string };
  note: string | null;
  grantedBy: string | null;
  startedAt: Date;
  /** store subscriptions: the store's product id */
  storeProductId?: string | null;
};

type SubRow = {
  id: number;
  account_id: number;
  source: Subscription['source'];
  plan: Plan;
  extra_devices: number;
  status: string;
  stripe_subscription_id: string | null;
  tax_behavior: TaxBehavior | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  ends_at: Date | null;
  ended_at: Date | null;
  items: Subscription['items'];
  note: string | null;
  granted_by: string | null;
  started_at: Date;
};

const toSub = (r: SubRow): Subscription => ({
  id: Number(r.id),
  accountId: Number(r.account_id),
  source: r.source,
  plan: r.plan,
  extraDevices: r.extra_devices,
  status: r.status,
  stripeSubscriptionId: r.stripe_subscription_id,
  taxBehavior: r.tax_behavior,
  currentPeriodEnd: r.current_period_end,
  cancelAtPeriodEnd: r.cancel_at_period_end,
  endsAt: r.ends_at,
  endedAt: r.ended_at,
  items: r.items ?? {},
  note: r.note,
  grantedBy: r.granted_by,
  startedAt: r.started_at,
});

/** The subscriptions row: bought on the website (Stripe) or given by the shop. */
export async function websiteSubscription(db: Db, accountId: number): Promise<Subscription | null> {
  const [r] = await db<SubRow[]>`SELECT * FROM subscriptions WHERE account_id = ${accountId}`;
  return r ? toSub(r) : null;
}

/** States of a store purchase that keep the subscription running (until expires_at). */
export const STORE_RUNNING = ['active', 'canceled', 'grace'];

type StoreRow = {
  id: number;
  account_id: number;
  store: 'google_play' | 'app_store';
  product_id: string;
  plan: Plan | null;
  state: string;
  expires_at: Date | null;
  auto_renew: boolean;
  created_at: Date;
};

const storeSub = (r: StoreRow): Subscription => ({
  id: Number(r.id),
  accountId: Number(r.account_id),
  source: r.store,
  plan: r.plan ?? 'collector',
  extraDevices: 0,
  status: r.state,
  stripeSubscriptionId: null,
  taxBehavior: null,
  currentPeriodEnd: r.expires_at,
  cancelAtPeriodEnd: !r.auto_renew,
  endsAt: r.auto_renew ? null : r.expires_at,
  endedAt: STORE_RUNNING.includes(r.state) ? null : r.expires_at,
  items: {},
  note: null,
  grantedBy: null,
  startedAt: r.created_at,
  storeProductId: r.product_id,
});

/**
 * The account's subscription: a running app-store purchase if there is one (it is paid, so it
 * comes before a free one), else the website's row, else the last store purchase (ended).
 */
export async function subscriptionOf(
  db: Db,
  accountId: number,
  now = new Date(),
): Promise<Subscription | null> {
  const [[row], [store]] = await Promise.all([
    db<SubRow[]>`SELECT * FROM subscriptions WHERE account_id = ${accountId}`,
    db<StoreRow[]>`
      SELECT id, account_id, store, product_id, plan, state, expires_at, auto_renew, created_at
        FROM store_purchases
       WHERE account_id = ${accountId} AND replaced_by IS NULL AND refused IS NULL
         AND state <> 'pending' AND plan IS NOT NULL
       ORDER BY (state IN ('active', 'canceled', 'grace') AND expires_at > ${now}) DESC,
                expires_at DESC NULLS LAST
       LIMIT 1`,
  ]);
  const storeRunning =
    store && STORE_RUNNING.includes(store.state) && store.expires_at && store.expires_at > now;
  if (store && storeRunning) return storeSub(store);
  if (row) return toSub(row);
  return store ? storeSub(store) : null;
}

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

export type SubscriptionState =
  'active' | 'past_due' | 'canceled' | 'ended' | 'complimentary' | 'none';

export type Features = {
  scanner: boolean;
  trading: boolean;
  youtube: boolean;
  recording: boolean;
  s3_upload: boolean;
  pipeline: boolean;
  webshop: boolean;
  collection: boolean;
  wanted: boolean;
};

export type Services = { s3: boolean; pipeline: boolean };

export type Entitlements = {
  /** A running subscription: the app and the portal are unlocked. */
  active: boolean;
  plan: Plan | null;
  state: SubscriptionState;
  /** Devices allowed at the same time. */
  seats: number;
  extraDevices: number;
  renewsAt: Date | null;
  endsAt: Date | null;
  /** How long the app may work offline on this answer. */
  validUntil: Date;
  features: Features;
  services: Services;
  webshopHost: string | null;
};

/** Days after the paid period the app keeps working while Stripe retries a payment. */
export const GRACE_DAYS = 3;
/** The app asks again at least this often. */
export const MAX_OFFLINE_DAYS = 35;

const NO_FEATURES: Features = {
  scanner: false,
  trading: false,
  youtube: false,
  recording: false,
  s3_upload: false,
  pipeline: false,
  webshop: false,
  collection: false,
  wanted: false,
};

const RUNNING = new Set(['active', 'trialing', 'past_due']);

export function entitlements(
  sub: Subscription | null,
  account: Pick<Account, 'webshopHost'>,
  now = new Date(),
  services: Services = { s3: false, pipeline: false },
): Entitlements {
  const cap = new Date(now.getTime() + MAX_OFFLINE_DAYS * 86400_000);
  const min = (a: Date, b: Date) => (a < b ? a : b);
  let state: SubscriptionState = 'none';
  let renewsAt: Date | null = null;
  let endsAt: Date | null = null;
  let validUntil = now;
  if (sub?.source === 'complimentary') {
    if (sub.endsAt && sub.endsAt <= now) state = 'ended';
    else {
      state = 'complimentary';
      endsAt = sub.endsAt;
      validUntil = min(sub.endsAt ?? cap, cap);
    }
  } else if (sub && (sub.source === 'google_play' || sub.source === 'app_store')) {
    // the store's expiry is the end; in the grace period it is the end of the grace period
    const end = sub.currentPeriodEnd;
    if (STORE_RUNNING.includes(sub.status) && end && end > now) {
      state =
        sub.status === 'grace' ? 'past_due' : sub.status === 'canceled' ? 'canceled' : 'active';
      if (sub.status === 'canceled') endsAt = end;
      else if (sub.status === 'active') renewsAt = end;
      validUntil = min(end, cap);
    } else {
      state = sub.status === 'pending' ? 'none' : 'ended';
    }
  } else if (sub) {
    if (RUNNING.has(sub.status)) {
      const end = sub.currentPeriodEnd ?? now;
      state =
        sub.status === 'past_due' ? 'past_due' : sub.cancelAtPeriodEnd ? 'canceled' : 'active';
      if (sub.cancelAtPeriodEnd) endsAt = sub.endsAt ?? end;
      else renewsAt = end;
      const graceEnd = new Date(end.getTime() + GRACE_DAYS * 86400_000);
      validUntil = min(sub.cancelAtPeriodEnd ? (endsAt ?? end) : graceEnd, cap);
      if (validUntil <= now) state = 'ended';
    } else if (sub.status !== 'incomplete') {
      state = 'ended';
    }
  }
  const active =
    state === 'active' || state === 'past_due' || state === 'canceled' || state === 'complimentary';
  if (!active) {
    return {
      active: false,
      plan: sub && state === 'ended' ? sub.plan : null,
      state,
      seats: 0,
      extraDevices: 0,
      renewsAt: null,
      endsAt: state === 'ended' ? (sub?.endedAt ?? sub?.endsAt ?? null) : null,
      validUntil: now,
      features: { ...NO_FEATURES },
      services: { s3: false, pipeline: false },
      webshopHost: account.webshopHost,
    };
  }
  const plan = sub!.plan;
  const creator = plan === 'creator';
  const svc = { s3: creator && services.s3, pipeline: creator && services.pipeline };
  return {
    active: true,
    plan,
    state,
    seats: 1 + sub!.extraDevices,
    extraDevices: sub!.extraDevices,
    renewsAt,
    endsAt,
    validUntil,
    features: {
      scanner: true,
      trading: true,
      youtube: creator,
      recording: creator,
      s3_upload: svc.s3,
      pipeline: svc.s3 && svc.pipeline,
      webshop: Boolean(account.webshopHost),
      collection: true,
      wanted: true,
    },
    services: svc,
    webshopHost: account.webshopHost,
  };
}

export async function accountEntitlements(
  db: Db,
  account: Pick<Account, 'id' | 'webshopHost'>,
  now = new Date(),
): Promise<Entitlements> {
  const [sub, services] = await Promise.all([
    subscriptionOf(db, account.id),
    accountServices(db, account.id),
  ]);
  return entitlements(sub, account, now, services);
}

/** Usage services the shop switched on for the customer (S3 storage, video pipeline). */
export async function accountServices(db: Db, accountId: number): Promise<Services> {
  const rows = await db<{ service: 's3' | 'pipeline' }[]>`
    SELECT service FROM account_services WHERE account_id = ${accountId} AND disabled_at IS NULL`;
  return {
    s3: rows.some((r) => r.service === 's3'),
    pipeline: rows.some((r) => r.service === 'pipeline'),
  };
}

// ---------------------------------------------------------------------------
// Subscribing
// ---------------------------------------------------------------------------

const required = (max: number) => z.string().trim().min(1, 'required').max(max, 'too_long');
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'too_long')
    .transform((v) => v || undefined)
    .optional();

export const SubscribeForm = z.object({
  plan: z.enum(PLANS as [Plan, ...Plan[]], 'required'),
  extraDevices: z.coerce
    .number('invalid')
    .int('invalid')
    .min(0, 'invalid')
    .max(MAX_EXTRA_DEVICES, 'too_many'),
  buyer: z.enum(['consumer', 'business'], 'required'),
  name: required(100),
  company: optional(100),
  vatId: optional(40),
  street: required(120),
  postcode: z.string().trim().min(1, 'required').max(10, 'too_long'),
  city: required(80),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'required'),
  acceptTerms: z.literal(true, 'terms'),
  /** § 18 Abs. 1 Z 11 FAGG: start right away (the right of withdrawal ends with that). */
  immediateStart: z.literal(true, 'consent'),
});
export type SubscribeForm = z.infer<typeof SubscribeForm>;

export function validateSubscribe(
  input: unknown,
): { ok: true; data: SubscribeForm } | { ok: false; errors: Record<string, string> } {
  const r = SubscribeForm.safeParse(input);
  const errors: Record<string, string> = {};
  if (!r.success) {
    for (const i of r.error.issues) {
      const k = i.path.join('.') || '_';
      errors[k] ??= i.message.startsWith('Invalid') ? 'invalid' : i.message;
    }
  }
  const raw = (input ?? {}) as Record<string, unknown>;
  const text = (k: string) => String(raw[k] ?? '').trim();
  const country = text('country').toUpperCase();
  const business = raw.buyer === 'business';
  const hasCountry = /^[A-Z]{2}$/.test(country);
  if (
    !errors.postcode &&
    text('postcode') &&
    hasCountry &&
    !validPostcode(country, text('postcode'))
  ) {
    errors.postcode = 'invalid_postcode';
  }
  if (business && !errors.company && !text('company')) errors.company = 'required';
  if (hasCountry && !errors.country && !isEuCountry(country)) errors.country = 'country';
  if (business && hasCountry && !errors.vatId && !errors.country) {
    const id = text('vatId');
    if (id && !parseTaxId(country, id)) errors.vatId = 'invalid_tax_id';
  }
  if (r.success && Object.keys(errors).length === 0) return { ok: true, data: r.data };
  return { ok: false, errors };
}

export type Regime = 'domestic' | 'oss' | 'reverse_charge';

/** VAT treatment: EU businesses outside Austria with a VIES-confirmed VAT id pay net. */
export async function checkSubscriber(
  d: SubscribeForm,
  vies: ViesChecker,
): Promise<
  | {
      ok: true;
      regime: Regime;
      behavior: TaxBehavior;
      taxId: TaxId | null;
      viesName: string | null;
    }
  | { ok: false; errors: Record<string, string> }
> {
  let taxId: TaxId | null = null;
  let viesName: string | null = null;
  if (d.buyer === 'business' && d.vatId) {
    taxId = parseTaxId(d.country, d.vatId);
    if (!taxId) return { ok: false, errors: { vatId: 'invalid_tax_id' } };
    const v = await vies(taxId.value);
    if (v.status === 'invalid') return { ok: false, errors: { vatId: 'vat_id_invalid' } };
    if (v.status === 'unavailable') return { ok: false, errors: { vatId: 'vies_unavailable' } };
    viesName = v.name;
  }
  const reverse = d.buyer === 'business' && taxId !== null && d.country !== HOME_COUNTRY;
  return {
    ok: true,
    regime: reverse ? 'reverse_charge' : d.country === HOME_COUNTRY ? 'domestic' : 'oss',
    behavior: reverse ? 'excl' : 'incl',
    taxId,
    viesName,
  };
}

/** Footer of the GmbH's subscription invoices. */
export function subscriptionInvoiceFooter(
  seller: LicenseSeller,
  regime: Regime,
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
      : '';
  const period = de
    ? 'Leistungszeitraum: der bei den Positionen angegebene Abrechnungszeitraum.'
    : 'Service period: the billing period shown on the line items.';
  return [who, tax, period].filter(Boolean).join('\n');
}

export class SubscribeRejected extends Error {
  readonly reason: 'already_active' | 'complimentary';
  constructor(reason: 'already_active' | 'complimentary') {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Saves the billing details at Stripe and opens Stripe Checkout. The subscription itself is
 * stored when Stripe reports it (webhook, or the success page asking).
 */
export async function startSubscription(
  sql: Sql,
  billing: BillingProvider,
  input: {
    account: Account;
    form: SubscribeForm;
    tax: { regime: Regime; behavior: TaxBehavior; taxId: TaxId | null; viesName: string | null };
    locale: 'de' | 'en';
    successUrl: string;
    cancelUrl: string;
  },
): Promise<string> {
  const { account, form, tax } = input;
  const existing = await subscriptionOf(sql, account.id);
  const ent = entitlements(existing, account);
  if (ent.active)
    throw new SubscribeRejected(
      existing?.source === 'complimentary' ? 'complimentary' : 'already_active',
    );
  const [row] = await sql<{ stripe_customer_id: string | null }[]>`
    SELECT stripe_customer_id FROM accounts WHERE id = ${account.id}`;
  const seller = await licenseSeller(sql);
  const customerId = await billing.saveCustomer(
    {
      accountId: account.id,
      publicId: account.publicId,
      email: account.email,
      name: form.name,
      company: form.buyer === 'business' ? (form.company ?? null) : null,
      locale: input.locale,
      address: {
        line1: form.street,
        postcode: form.postcode,
        city: form.city,
        country: form.country,
      },
      taxId: tax.taxId,
      taxExempt: tax.regime === 'reverse_charge' ? 'reverse' : 'none',
      invoiceFooter: subscriptionInvoiceFooter(seller, tax.regime, input.locale),
    },
    row?.stripe_customer_id ?? null,
  );
  await sql`
    UPDATE accounts
       SET stripe_customer_id = ${customerId},
           billing = ${sql.json({
             buyer: form.buyer,
             name: form.name,
             company: form.buyer === 'business' ? (form.company ?? null) : null,
             vat_id: tax.taxId?.value ?? null,
             vies_name: tax.viesName,
             street: form.street,
             postcode: form.postcode,
             city: form.city,
             country: form.country,
             regime: tax.regime,
           } as never)},
           name = coalesce(name, ${form.name})
     WHERE id = ${account.id}`;
  const prices = await subscriptionPrices(sql);
  const cents = planCents(prices, form.plan, tax.behavior);
  const s = await billing.startCheckout({
    accountId: account.id,
    publicId: account.publicId,
    customerId,
    locale: input.locale,
    plan: form.plan,
    extraDevices: form.extraDevices,
    baseCents: cents.base,
    deviceCents: cents.device,
    behavior: tax.behavior,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
  });
  return s.url;
}

/**
 * Stores what Stripe says about a subscription (the source of truth): creates or updates the
 * account's row and sends the mails that belong to a change. Safe to run more than once.
 */
export async function syncStripeSubscription(
  sql: Sql,
  billing: BillingProvider,
  subscriptionId: string,
): Promise<Subscription | null> {
  const s = await billing.getSubscription(subscriptionId);
  if (!s) return null;
  return storeStripeSubscription(sql, s);
}

export async function storeStripeSubscription(
  sql: Sql,
  s: BillingSubscription,
): Promise<Subscription | null> {
  return sql.begin(async (tx) => {
    let accountId = s.accountId;
    if (!accountId) {
      const [a] = await tx<
        { id: number }[]
      >`SELECT id FROM accounts WHERE stripe_customer_id = ${s.customerId}`;
      accountId = a ? Number(a.id) : null;
    }
    if (!accountId || !s.plan) return null;
    const [acc] = await tx<{ id: number; email: string; locale: 'de' | 'en' }[]>`
      SELECT id, email, locale FROM accounts WHERE id = ${accountId} FOR UPDATE`;
    if (!acc) return null;
    const [before] = await tx<
      SubRow[]
    >`SELECT * FROM subscriptions WHERE account_id = ${accountId}`;
    // A newer subscription replaces an ended one; an old one's late event changes nothing.
    if (
      before?.stripe_subscription_id &&
      before.stripe_subscription_id !== s.id &&
      RUNNING.has(before.status) &&
      !RUNNING.has(s.status)
    ) {
      return toSub(before);
    }
    const endsAt = s.cancelAtPeriodEnd ? (s.cancelAt ?? s.currentPeriodEnd) : null;
    const [row] = await tx<SubRow[]>`
      INSERT INTO subscriptions (account_id, source, plan, extra_devices, status, stripe_subscription_id,
                                 tax_behavior, current_period_end, cancel_at_period_end, ends_at, ended_at,
                                 items, started_at)
      VALUES (${accountId}, 'stripe', ${s.plan}, ${s.extraDevices}, ${s.status}, ${s.id}, ${s.behavior},
              ${s.currentPeriodEnd}, ${s.cancelAtPeriodEnd}, ${endsAt}, ${s.endedAt},
              ${tx.json(s.items as never)}, now())
      ON CONFLICT (account_id) DO UPDATE SET
        source = 'stripe', plan = EXCLUDED.plan, extra_devices = EXCLUDED.extra_devices,
        status = EXCLUDED.status, stripe_subscription_id = EXCLUDED.stripe_subscription_id,
        tax_behavior = EXCLUDED.tax_behavior, current_period_end = EXCLUDED.current_period_end,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end, ends_at = EXCLUDED.ends_at,
        ended_at = EXCLUDED.ended_at, items = EXCLUDED.items, note = NULL, granted_by = NULL,
        started_at = CASE WHEN subscriptions.stripe_subscription_id IS DISTINCT FROM EXCLUDED.stripe_subscription_id
                          THEN now() ELSE subscriptions.started_at END
      RETURNING *`;
    const wasRunning = before
      ? RUNNING.has(before.status) && before.stripe_subscription_id === s.id
      : false;
    if (wasRunning && !RUNNING.has(s.status)) {
      await enqueueMail(tx, {
        template: 'subscription_ended',
        to: acc.email,
        locale: acc.locale,
        payload: { account_id: accountId, subscription: s.id, plan: s.plan },
        dedupeKey: `subscription_ended:${s.id}`,
      });
    }
    return toSub(row!);
  });
}

/** Stripe webhook events of the subscriptions (GmbH account). */
export async function handleBillingEvent(
  sql: Sql,
  billing: BillingProvider,
  event:
    | { type: 'subscription'; subscriptionId: string }
    | { type: 'checkout_completed'; subscriptionId: string | null }
    | {
        type: 'invoice_paid';
        invoiceId: string;
        subscriptionId: string | null;
        reason: string | null;
      }
    | {
        type: 'invoice_failed';
        invoiceId: string;
        subscriptionId: string | null;
        nextAttempt: Date | null;
      }
    | { type: 'other' },
): Promise<string> {
  switch (event.type) {
    case 'subscription':
    case 'checkout_completed': {
      if (!event.subscriptionId) return 'no subscription';
      const sub = await syncStripeSubscription(sql, billing, event.subscriptionId);
      return sub ? `synced ${sub.plan} ${sub.status}` : 'unknown account';
    }
    case 'invoice_paid':
    case 'invoice_failed': {
      if (!event.subscriptionId) return 'not a subscription invoice';
      const sub = await syncStripeSubscription(sql, billing, event.subscriptionId);
      if (!sub) return 'unknown account';
      const [acc] = await sql<{ email: string; locale: 'de' | 'en' }[]>`
        SELECT email, locale FROM accounts WHERE id = ${sub.accountId}`;
      if (!acc) return 'unknown account';
      if (event.type === 'invoice_paid') {
        const inv = await billing.invoice(event.invoiceId);
        if (inv.total <= 0 && event.reason !== 'subscription_create') return 'zero invoice';
        await enqueueMail(sql, {
          template:
            event.reason === 'subscription_create'
              ? 'subscription_welcome'
              : 'subscription_invoice',
          to: acc.email,
          locale: acc.locale,
          payload: {
            account_id: sub.accountId,
            invoice_id: event.invoiceId,
            number: inv.number,
            total: inv.total,
          },
          attachments:
            inv.total > 0
              ? [
                  {
                    kind: 'stripe',
                    seller: 'gmbh',
                    doc: 'invoice',
                    id: event.invoiceId,
                    number: inv.number ?? '',
                  },
                ]
              : [],
          dedupeKey: `subscription_invoice:${event.invoiceId}`,
        });
        return 'invoice mailed';
      }
      await enqueueMail(sql, {
        template: 'subscription_payment_failed',
        to: acc.email,
        locale: acc.locale,
        payload: {
          account_id: sub.accountId,
          invoice_id: event.invoiceId,
          next_attempt: event.nextAttempt?.toISOString() ?? null,
        },
        dedupeKey: `subscription_failed:${event.invoiceId}:${event.nextAttempt?.toISOString() ?? 'last'}`,
      });
      return 'payment failure mailed';
    }
    default:
      return 'ignored';
  }
}

// ---------------------------------------------------------------------------
// Changing a running subscription
// ---------------------------------------------------------------------------

export type ChangeProblem =
  'not_active' | 'complimentary' | 'devices_in_use' | 'unchanged' | 'payment_failed';

export class ChangeRejected extends Error {
  readonly reason: ChangeProblem;
  readonly inUse: number;
  constructor(reason: ChangeProblem, inUse = 0) {
    super(reason);
    this.reason = reason;
    this.inUse = inUse;
  }
}

export async function activeDeviceCount(db: Db, accountId: number): Promise<number> {
  const [c] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM devices WHERE account_id = ${accountId} AND ended_at IS NULL`;
  return c?.n ?? 0;
}

/**
 * Plan and number of extra devices. More (plan up or devices added) is charged right away and
 * applies once paid; less is credited on the next invoice. Fewer devices than are connected
 * can't be chosen: the customer removes one first.
 */
export async function changeSubscription(
  sql: Sql,
  billing: BillingProvider,
  account: Account,
  want: { plan: Plan; extraDevices: number },
): Promise<Subscription> {
  const sub = await subscriptionOf(sql, account.id);
  const ent = entitlements(sub, account);
  if (!sub || !ent.active) throw new ChangeRejected('not_active');
  if (sub.source !== 'stripe' || !sub.stripeSubscriptionId)
    throw new ChangeRejected('complimentary');
  if (want.plan === sub.plan && want.extraDevices === sub.extraDevices)
    throw new ChangeRejected('unchanged');
  const inUse = await activeDeviceCount(sql, account.id);
  if (1 + want.extraDevices < inUse) throw new ChangeRejected('devices_in_use', inUse);
  const prices = await subscriptionPrices(sql);
  const behavior = sub.taxBehavior ?? 'incl';
  const cents = planCents(prices, want.plan, behavior);
  const before = monthlyCents(prices, sub.plan, sub.extraDevices, behavior);
  const after = monthlyCents(prices, want.plan, want.extraDevices, behavior);
  const increase = after > before || (want.plan === 'creator' && sub.plan === 'collector');
  let updated: BillingSubscription;
  try {
    updated = await billing.changeSubscription(sub.stripeSubscriptionId, {
      plan: want.plan,
      extraDevices: want.extraDevices,
      baseCents: cents.base,
      deviceCents: cents.device,
      behavior,
      increase,
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'card_declined' || code === 'payment_intent_payment_attempt_failed') {
      throw new ChangeRejected('payment_failed');
    }
    throw e;
  }
  return (await storeStripeSubscription(sql, updated)) ?? sub;
}

export async function setCancelAtPeriodEnd(
  sql: Sql,
  billing: BillingProvider,
  account: Account,
  cancel: boolean,
): Promise<Subscription> {
  const sub = await subscriptionOf(sql, account.id);
  if (!sub || !entitlements(sub, account).active) throw new ChangeRejected('not_active');
  if (sub.source !== 'stripe' || !sub.stripeSubscriptionId)
    throw new ChangeRejected('complimentary');
  const updated = await billing.setCancelAtPeriodEnd(sub.stripeSubscriptionId, cancel);
  return (await storeStripeSubscription(sql, updated)) ?? sub;
}

// ---------------------------------------------------------------------------
// Given by the shop
// ---------------------------------------------------------------------------

export const ComplimentaryForm = z.object({
  plan: z.enum(PLANS as [Plan, ...Plan[]]),
  extraDevices: z.coerce.number().int().min(0).max(MAX_EXTRA_DEVICES),
  /** yyyy-mm-dd, the last day; empty = no end */
  until: z
    .string()
    .trim()
    .regex(/^(\d{4}-\d{2}-\d{2})?$/, 'invalid'),
  note: z.string().trim().max(500),
});

/**
 * A free subscription (friends, marketing). Not possible while a paid one runs: that is
 * cancelled first in the Stripe dashboard or by the customer.
 */
export async function grantComplimentary(
  sql: Sql,
  accountId: number,
  input: z.infer<typeof ComplimentaryForm>,
  by: string,
): Promise<Subscription> {
  const v = ComplimentaryForm.parse(input);
  return sql.begin(async (tx) => {
    const [a] = await tx<
      { webshop_host: string | null }[]
    >`SELECT webshop_host FROM accounts WHERE id = ${accountId} FOR UPDATE`;
    if (!a) throw new Error('unknown account');
    const current = await subscriptionOf(tx, accountId);
    if (current?.source === 'stripe' && entitlements(current, { webshopHost: null }).active) {
      throw new ChangeRejected('not_active');
    }
    // the end of the chosen day, Vienna time
    const endsAt = v.until ? new Date(`${v.until}T23:59:59+01:00`) : null;
    const [row] = await tx<SubRow[]>`
      INSERT INTO subscriptions (account_id, source, plan, extra_devices, status, ends_at, note, granted_by)
      VALUES (${accountId}, 'complimentary', ${v.plan}, ${v.extraDevices}, 'complimentary', ${endsAt},
              ${v.note || null}, ${by})
      ON CONFLICT (account_id) DO UPDATE SET
        source = 'complimentary', plan = EXCLUDED.plan, extra_devices = EXCLUDED.extra_devices,
        status = 'complimentary', stripe_subscription_id = NULL, tax_behavior = NULL,
        current_period_end = NULL, cancel_at_period_end = false, ends_at = EXCLUDED.ends_at,
        ended_at = NULL, items = '{}', note = EXCLUDED.note, granted_by = EXCLUDED.granted_by,
        started_at = CASE WHEN subscriptions.source = 'complimentary' AND subscriptions.ended_at IS NULL
                          THEN subscriptions.started_at ELSE now() END
      RETURNING *`;
    return toSub(row!);
  });
}

export async function endComplimentary(db: Db, accountId: number): Promise<void> {
  await db`
    UPDATE subscriptions SET ends_at = now(), ended_at = now()
     WHERE account_id = ${accountId} AND source = 'complimentary' AND ended_at IS NULL`;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export type CustomerRow = {
  id: number;
  publicId: string;
  email: string;
  name: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  plan: Plan | null;
  source: Subscription['source'] | null;
  status: string | null;
  extraDevices: number;
  devices: number;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  endsAt: Date | null;
  webshopHost: string | null;
};

export async function listCustomers(
  db: Db,
  opts: { query?: string; filter?: 'all' | 'subscribed' | 'free' } = {},
): Promise<CustomerRow[]> {
  const q = opts.query?.trim().toLowerCase();
  const like = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const rows = await db<
    {
      id: number;
      public_id: string;
      email: string;
      name: string | null;
      created_at: Date;
      last_login_at: Date | null;
      plan: Plan | null;
      source: Subscription['source'] | null;
      status: string | null;
      extra_devices: number | null;
      devices: number;
      current_period_end: Date | null;
      cancel_at_period_end: boolean | null;
      ends_at: Date | null;
      webshop_host: string | null;
    }[]
  >`
    SELECT a.id, a.public_id, a.email, a.name, a.created_at, a.last_login_at, a.webshop_host,
           coalesce(sp.plan, s.plan) AS plan, coalesce(sp.store, s.source) AS source,
           coalesce(sp.status, s.status) AS status,
           CASE WHEN sp.store IS NULL THEN s.extra_devices ELSE 0 END AS extra_devices,
           coalesce(sp.expires_at, s.current_period_end) AS current_period_end,
           CASE WHEN sp.store IS NULL THEN s.cancel_at_period_end ELSE NOT sp.auto_renew END AS cancel_at_period_end,
           CASE WHEN sp.store IS NULL THEN s.ends_at END AS ends_at,
           (SELECT count(*)::int FROM devices d WHERE d.account_id = a.id AND d.ended_at IS NULL) AS devices
      FROM accounts a
      LEFT JOIN subscriptions s ON s.account_id = a.id
      -- a running app-store subscription comes first
      LEFT JOIN LATERAL (
        SELECT p.store, p.plan, CASE p.state WHEN 'grace' THEN 'past_due' ELSE 'active' END AS status,
               p.expires_at, p.auto_renew
          FROM store_purchases p
         WHERE p.account_id = a.id AND p.replaced_by IS NULL AND p.refused IS NULL
           AND p.state IN ('active', 'canceled', 'grace') AND p.expires_at > now()
         ORDER BY p.expires_at DESC LIMIT 1) sp ON true
     WHERE (${like}::text IS NULL OR a.email LIKE ${like} OR lower(coalesce(a.name, '')) LIKE ${like}
            OR a.public_id = ${q ?? ''})
       AND (${opts.filter ?? 'all'} = 'all'
            OR (${opts.filter ?? 'all'} = 'subscribed' AND (sp.store IS NOT NULL OR (
                s.status IN ('active', 'trialing', 'past_due', 'complimentary')
                AND (s.ends_at IS NULL OR s.ends_at > now() OR s.source = 'stripe'))))
            OR (${opts.filter ?? 'all'} = 'free' AND sp.store IS NULL
                AND (s.id IS NULL OR s.status NOT IN ('active', 'trialing', 'past_due', 'complimentary'))))
     ORDER BY a.created_at DESC LIMIT 300`;
  return rows.map((r) => ({
    id: Number(r.id),
    publicId: r.public_id,
    email: r.email,
    name: r.name,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    plan: r.plan,
    source: r.source,
    status: r.status,
    extraDevices: r.extra_devices ?? 0,
    devices: r.devices,
    periodEnd: r.current_period_end,
    cancelAtPeriodEnd: r.cancel_at_period_end ?? false,
    endsAt: r.ends_at,
    webshopHost: r.webshop_host,
  }));
}

export async function subscriptionCounts(
  db: Db,
): Promise<{ collector: number; creator: number; mrrCents: number }> {
  const prices = await subscriptionPrices(db);
  const rows = await db<{ plan: Plan; extra_devices: number; tax_behavior: TaxBehavior | null }[]>`
    SELECT plan, extra_devices, tax_behavior FROM subscriptions
     WHERE source = 'stripe' AND status IN ('active', 'trialing', 'past_due')`;
  let mrr = 0;
  for (const r of rows)
    mrr += monthlyCents(prices, r.plan, r.extra_devices, r.tax_behavior ?? 'incl');
  // accounts with a running subscription (a store one counts once, before a free one)
  const [c] = await db<{ collector: number; creator: number }[]>`
    WITH running AS (
      SELECT DISTINCT ON (account_id) account_id, plan FROM (
        SELECT account_id, plan, 1 AS rank FROM store_purchases
         WHERE replaced_by IS NULL AND refused IS NULL AND account_id IS NOT NULL
           AND state IN ('active', 'canceled', 'grace') AND expires_at > now()
        UNION ALL
        SELECT account_id, plan, 2 FROM subscriptions
         WHERE (source = 'stripe' AND status IN ('active', 'trialing', 'past_due'))
            OR (source = 'complimentary' AND ended_at IS NULL AND (ends_at IS NULL OR ends_at > now()))
      ) x ORDER BY account_id, rank)
    SELECT count(*) FILTER (WHERE plan = 'collector')::int AS collector,
           count(*) FILTER (WHERE plan = 'creator')::int AS creator
      FROM running`;
  return { collector: c?.collector ?? 0, creator: c?.creator ?? 0, mrrCents: mrr };
}

export async function setWebshopHost(
  db: Db,
  accountId: number,
  host: string | null,
): Promise<void> {
  const h =
    host
      ?.trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '') || null;
  if (h && !/^[a-z0-9.-]{3,253}$/.test(h)) throw new Error('invalid host');
  await db`UPDATE accounts SET webshop_host = ${h} WHERE id = ${accountId}`;
}

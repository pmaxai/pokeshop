// Subscriptions on the Stripe account of Antalyse GmbH (STRIPE_LICENSE_*, a name kept from the
// app licences it sold first): Stripe Checkout in
// subscription mode, Stripe Tax, Stripe's invoices, the Billing customer portal for payment
// methods and invoices. A local stand-in plays Stripe on localhost and in tests.
//
// Prices are Stripe Price objects found by lookup key, created on first use:
//   oc_<item>_<cents>_<incl|excl>   e.g. oc_collector_700_incl, oc_creator_device_583_excl
// "incl" prices include the VAT (consumers, Austrian businesses: Stripe Tax takes the buyer's
// country's VAT out of it), "excl" are net prices for EU businesses with a VAT id (reverse charge).
import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';

export type Plan = 'collector' | 'creator';
export const PLANS: readonly Plan[] = ['collector', 'creator'];
export type PriceItem = Plan | 'collector_device' | 'creator_device';
export type TaxBehavior = 'incl' | 'excl';

/** Stripe product tax code: software as a service. */
export const SUBSCRIPTION_TAX_CODE = 'txcd_10103000';

/** Usage services billed by Stripe meters: S3 per MB uploaded, the pipeline per video second. */
export type UsageService = 's3' | 'pipeline';
export const USAGE_SERVICES: readonly UsageService[] = ['s3', 'pipeline'];
/** Meter event names in Stripe (one meter each, sum of the values). */
export const METER_EVENTS: Record<UsageService, string> = {
  s3: 'oc_s3_mb',
  pipeline: 'oc_pipeline_seconds',
};
/** The admin's price is per GB / per minute; the meter counts MB / seconds. */
export const UNITS_PER_PRICE: Record<UsageService, number> = { s3: 1024, pipeline: 60 };

/** Lookup key of a metered price, by the price per GB / minute: oc_s3_gb_10_incl. */
export const meteredLookupKey = (service: UsageService, cents: number, behavior: TaxBehavior) =>
  `oc_${service === 's3' ? 's3_gb' : 'pipeline_minute'}_${cents}_${behavior}`;

export function parseMeteredKey(
  key: string | null | undefined,
): { service: UsageService; cents: number; behavior: TaxBehavior } | null {
  const m = /^oc_(s3_gb|pipeline_minute)_(\d+)_(incl|excl)$/.exec(key ?? '');
  if (!m) return null;
  return {
    service: m[1] === 's3_gb' ? 's3' : 'pipeline',
    cents: Number(m[2]),
    behavior: m[3] as TaxBehavior,
  };
}

/** Cents per MB / second as Stripe's unit_amount_decimal (at most 12 decimals). */
export const unitAmountDecimal = (service: UsageService, cents: number) =>
  (cents / UNITS_PER_PRICE[service]).toFixed(12).replace(/0+$/, '').replace(/\.$/, '');

export type MeterEventInput = {
  service: UsageService;
  customerId: string;
  value: number;
  /** when it happened (Stripe takes up to 35 days back) */
  timestamp: Date;
  /** unique per event, makes a retry safe */
  identifier: string;
};

export type BillingCustomerInput = {
  accountId: number;
  publicId: string;
  email: string;
  name: string;
  company?: string | null;
  locale: 'de' | 'en';
  address: { line1: string; postcode: string; city: string; country: string };
  taxId?: { type: string; value: string } | null;
  taxExempt: 'none' | 'reverse';
  /** Printed on every invoice of the customer (the GmbH's details, reverse-charge note). */
  invoiceFooter: string;
};

export type BillingSubscription = {
  id: string;
  /**
   * plan: the website subscription (plan + extra devices). devices: only extra devices, for a
   * subscription bought in an app store (metadata kind=devices).
   */
  kind: 'plan' | 'devices';
  customerId: string;
  /** Stripe's status: incomplete, active, trialing, past_due, canceled, unpaid, paused … */
  status: string;
  accountId: number | null;
  plan: Plan | null;
  extraDevices: number;
  /** the plan whose device price the devices item has */
  devicePlan: Plan | null;
  behavior: TaxBehavior | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Set when a cancellation at period end is scheduled, or once it ended. */
  cancelAt: Date | null;
  endedAt: Date | null;
  items: { base?: string; devices?: string };
  /** Metered items (usage services) on the subscription. */
  metered: Partial<Record<UsageService, string>>;
  /** the affiliate code whose discount the checkout applied (metadata) */
  affiliateCode: string | null;
};

export type BillingEvent =
  | { id: string; type: 'subscription'; subscriptionId: string }
  | {
      id: string;
      type: 'checkout_completed';
      sessionId: string;
      subscriptionId: string | null;
      accountId: number | null;
    }
  | {
      id: string;
      type: 'invoice_paid';
      invoiceId: string;
      subscriptionId: string | null;
      reason: string | null;
    }
  | {
      id: string;
      type: 'invoice_failed';
      invoiceId: string;
      subscriptionId: string | null;
      nextAttempt: Date | null;
    }
  | { id: string; type: 'other'; stripeType: string };

export type CheckoutInput = {
  accountId: number;
  publicId: string;
  customerId: string;
  locale: 'de' | 'en';
  plan: Plan;
  extraDevices: number;
  /** only the extra devices (at least one), for a subscription bought in an app store */
  devicesOnly?: boolean;
  /** an affiliate link's discount: a coupon instead of promotion codes */
  discount?: { code: string; percent: number; months: number | null } | null;
  /** Amount per month in cents for the chosen tax behaviour. */
  baseCents: number;
  deviceCents: number;
  behavior: TaxBehavior;
  successUrl: string;
  cancelUrl: string;
};

export type DeviceRefund = {
  refundedCents: number;
  creditNote: { id: string; number: string } | null;
};

export type DevicesChangeInput = {
  plan: Plan;
  devices: number;
  deviceCents: number;
  behavior: TaxBehavior;
  /** more devices: charged right away, applied once paid */
  increase: boolean;
};

export type ChangeInput = {
  plan: Plan;
  extraDevices: number;
  baseCents: number;
  deviceCents: number;
  behavior: TaxBehavior;
  /** More than before (plan up or more devices): charged right away, applied once paid. */
  increase: boolean;
};

export interface BillingProvider {
  readonly name: 'stripe' | 'fake';
  /** Creates the Stripe customer, or updates the existing one (address, tax id, footer). */
  saveCustomer(input: BillingCustomerInput, existingId?: string | null): Promise<string>;
  startCheckout(input: CheckoutInput): Promise<{ id: string; url: string }>;
  /** The subscription a completed Checkout session created. */
  checkoutSubscription(sessionId: string): Promise<string | null>;
  getSubscription(id: string): Promise<BillingSubscription | null>;
  changeSubscription(id: string, input: ChangeInput): Promise<BillingSubscription>;
  setCancelAtPeriodEnd(id: string, cancel: boolean): Promise<BillingSubscription>;
  /** Ends it right away (admin), without a refund. */
  cancelNow(id: string): Promise<void>;
  /** A device subscription: number of devices and the plan's device price. */
  changeDevices(id: string, input: DevicesChangeInput): Promise<BillingSubscription>;
  /**
   * Ends a device subscription now and refunds the unused part of its last payment (a credit
   * note on that invoice, refunded to the card). Safe to repeat.
   */
  cancelWithRefund(id: string, now?: Date): Promise<DeviceRefund>;
  /** Stripe's customer portal: payment method, invoices. */
  portalUrl(customerId: string, returnUrl: string, locale: 'de' | 'en'): Promise<string>;
  /**
   * Adds the metered price of a usage service to the subscription (no charge now; Stripe bills
   * the period's usage with the next invoice). Returns the subscription item.
   */
  addMeteredItem(
    subscriptionId: string,
    service: UsageService,
    cents: number,
    behavior: TaxBehavior,
  ): Promise<string>;
  /** Reports usage to the service's meter. */
  meterEvent(input: MeterEventInput): Promise<void>;
  /** The PDF link of an invoice, for the mail. */
  invoice(id: string): Promise<{
    number: string | null;
    pdfUrl: string | null;
    total: number;
    subscriptionId: string | null;
  }>;
}

export const lookupKey = (item: PriceItem, cents: number, behavior: TaxBehavior) =>
  `oc_${item}_${cents}_${behavior}`;

/** collector / creator / collector_device … from a lookup key. */
export function parseLookupKey(
  key: string | null | undefined,
): { item: PriceItem; cents: number; behavior: TaxBehavior } | null {
  const m = /^oc_(collector|creator)(_device)?_(\d+)_(incl|excl)$/.exec(key ?? '');
  if (!m) return null;
  return {
    item: `${m[1]}${m[2] ?? ''}` as PriceItem,
    cents: Number(m[3]),
    behavior: m[4] as TaxBehavior,
  };
}

const PRODUCT_NAMES: Record<PriceItem, string> = {
  collector: 'Overpriced Cardboard – Collector',
  creator: 'Overpriced Cardboard – Creator',
  collector_device: 'Zusätzliches Gerät (Collector) / Extra device (Collector)',
  creator_device: 'Zusätzliches Gerät (Creator) / Extra device (Creator)',
};

const stripeId = (v: string | { id: string } | null | undefined) =>
  typeof v === 'string' ? v : (v?.id ?? null);

function toBilling(s: Stripe.Subscription): BillingSubscription {
  let plan: Plan | null = null;
  let devices = 0;
  let devicePlan: Plan | null = null;
  let behavior: TaxBehavior | null = null;
  let periodEnd: number | null = null;
  let periodStart: number | null = null;
  const items: BillingSubscription['items'] = {};
  const metered: BillingSubscription['metered'] = {};
  for (const it of s.items.data) {
    const mk = parseMeteredKey(it.price.lookup_key);
    if (mk) {
      metered[mk.service] = it.id;
      continue;
    }
    const k = parseLookupKey(it.price.lookup_key);
    if (!k) continue;
    if (k.item === 'collector' || k.item === 'creator') {
      plan = k.item;
      behavior = k.behavior;
      items.base = it.id;
      periodEnd = it.current_period_end;
      periodStart = it.current_period_start;
    } else {
      devices = it.quantity ?? 0;
      devicePlan = k.item === 'creator_device' ? 'creator' : 'collector';
      items.devices = it.id;
      if (!items.base) {
        behavior = k.behavior;
        periodEnd = it.current_period_end;
        periodStart = it.current_period_start;
      }
    }
  }
  const acc = Number(s.metadata?.account_id);
  return {
    id: s.id,
    kind: s.metadata?.kind === 'devices' ? 'devices' : 'plan',
    customerId: stripeId(s.customer) ?? '',
    status: s.status,
    accountId: Number.isSafeInteger(acc) && acc > 0 ? acc : null,
    plan,
    extraDevices: devices,
    devicePlan,
    behavior,
    currentPeriodStart: periodStart ? new Date(periodStart * 1000) : null,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    cancelAtPeriodEnd: s.cancel_at_period_end,
    cancelAt: s.cancel_at ? new Date(s.cancel_at * 1000) : null,
    endedAt: s.ended_at ? new Date(s.ended_at * 1000) : null,
    items,
    metered,
    affiliateCode: s.metadata?.affiliate || null,
  };
}

/** Stripe coupon of an affiliate discount, shared by all links with the same one. */
export const affiliateCouponId = (percent: number, months: number | null) =>
  `oc_aff_${percent}_${months ?? 'forever'}`;

export function normaliseBillingEvent(e: Stripe.Event): BillingEvent {
  switch (e.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      return { id: e.id, type: 'subscription', subscriptionId: e.data.object.id };
    case 'checkout.session.completed': {
      const s = e.data.object;
      const acc = Number(s.metadata?.account_id);
      return {
        id: e.id,
        type: 'checkout_completed',
        sessionId: s.id,
        subscriptionId: stripeId(s.subscription as never),
        accountId: Number.isSafeInteger(acc) && acc > 0 ? acc : null,
      };
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const inv = e.data.object;
      const sub = stripeId(inv.parent?.subscription_details?.subscription as never);
      if (e.type === 'invoice.paid') {
        return {
          id: e.id,
          type: 'invoice_paid',
          invoiceId: inv.id ?? '',
          subscriptionId: sub,
          reason: inv.billing_reason ?? null,
        };
      }
      return {
        id: e.id,
        type: 'invoice_failed',
        invoiceId: inv.id ?? '',
        subscriptionId: sub,
        nextAttempt: inv.next_payment_attempt ? new Date(inv.next_payment_attempt * 1000) : null,
      };
    }
    default:
      return { id: e.id, type: 'other', stripeType: e.type };
  }
}

/** Is this Stripe event (already verified) one for the subscriptions? */
export function isBillingEvent(e: {
  type: string;
  data?: { object?: { mode?: string } };
}): boolean {
  if (e.type.startsWith('customer.subscription.')) return true;
  if (e.type === 'invoice.paid' || e.type === 'invoice.payment_failed') return true;
  return e.type === 'checkout.session.completed' && e.data?.object?.mode === 'subscription';
}

export function stripeBilling(opts: { secretKey: string; client?: Stripe }): BillingProvider {
  const stripe =
    opts.client ?? new Stripe(opts.secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
  const priceCache = new Map<string, string>();

  /** The Stripe price for an item and amount, created with its product on first use. */
  async function price(item: PriceItem, cents: number, behavior: TaxBehavior): Promise<string> {
    const key = lookupKey(item, cents, behavior);
    const cached = priceCache.get(key);
    if (cached) return cached;
    const found = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
    let id = found.data[0]?.id;
    if (!id) {
      const product = `oc_${item}`;
      try {
        await stripe.products.create({
          id: product,
          name: PRODUCT_NAMES[item],
          tax_code: SUBSCRIPTION_TAX_CODE,
          metadata: { item },
        });
      } catch (e) {
        if ((e as { code?: string }).code !== 'resource_already_exists') throw e;
      }
      const p = await stripe.prices.create(
        {
          product,
          currency: 'eur',
          unit_amount: cents,
          recurring: { interval: 'month' },
          tax_behavior: behavior === 'incl' ? 'inclusive' : 'exclusive',
          lookup_key: key,
          metadata: { item },
        },
        { idempotencyKey: `price-${key}` },
      );
      id = p.id;
    }
    priceCache.set(key, id);
    return id;
  }

  /** The coupon for an affiliate discount, created on first use. */
  async function coupon(percent: number, months: number | null): Promise<string> {
    const id = affiliateCouponId(percent, months);
    if (priceCache.has(id)) return id;
    try {
      await stripe.coupons.retrieve(id);
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e;
      try {
        await stripe.coupons.create({
          id,
          percent_off: percent,
          ...(months
            ? { duration: 'repeating', duration_in_months: months }
            : { duration: 'forever' }),
          name: months
            ? `Creator-Code −${percent} % (${months} ${months === 1 ? 'Monat' : 'Monate'})`
            : `Creator-Code −${percent} %`,
          metadata: { kind: 'affiliate' },
        });
      } catch (e2) {
        if ((e2 as { code?: string }).code !== 'resource_already_exists') throw e2;
      }
    }
    priceCache.set(id, id);
    return id;
  }

  const meterCache = new Map<UsageService, string>();
  /** The service's meter, created on first use. */
  async function meter(service: UsageService): Promise<string> {
    const cached = meterCache.get(service);
    if (cached) return cached;
    const event = METER_EVENTS[service];
    let id: string | undefined;
    for await (const m of stripe.billing.meters.list({ status: 'active', limit: 100 })) {
      if (m.event_name === event) {
        id = m.id;
        break;
      }
    }
    if (!id) {
      const m = await stripe.billing.meters.create(
        {
          display_name: service === 's3' ? 'S3 upload (MB)' : 'Video pipeline (seconds)',
          event_name: event,
          default_aggregation: { formula: 'sum' },
          customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
          value_settings: { event_payload_key: 'value' },
        },
        { idempotencyKey: `meter-${event}` },
      );
      id = m.id;
    }
    meterCache.set(service, id);
    return id;
  }

  /** The metered price of a service for a price per GB / minute, created on first use. */
  async function meteredPrice(
    service: UsageService,
    cents: number,
    behavior: TaxBehavior,
  ): Promise<string> {
    const key = meteredLookupKey(service, cents, behavior);
    const cached = priceCache.get(key);
    if (cached) return cached;
    const found = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
    let id = found.data[0]?.id;
    if (!id) {
      const product = `oc_${service}`;
      try {
        await stripe.products.create({
          id: product,
          name:
            service === 's3'
              ? 'S3-Speicher (pro GB hochgeladen) / S3 storage (per GB uploaded)'
              : 'Automatic Content Processing (pro Videominute) / (per video minute)',
          tax_code: SUBSCRIPTION_TAX_CODE,
          unit_label: service === 's3' ? 'MB' : 's',
          metadata: { item: service },
        });
      } catch (e) {
        if ((e as { code?: string }).code !== 'resource_already_exists') throw e;
      }
      const p = await stripe.prices.create(
        {
          product,
          currency: 'eur',
          unit_amount_decimal: Stripe.Decimal.from(unitAmountDecimal(service, cents)),
          recurring: { interval: 'month', usage_type: 'metered', meter: await meter(service) },
          tax_behavior: behavior === 'incl' ? 'inclusive' : 'exclusive',
          lookup_key: key,
          metadata: {
            item: service,
            per: service === 's3' ? 'gb' : 'minute',
            cents: String(cents),
          },
        },
        { idempotencyKey: `price-${key}` },
      );
      id = p.id;
    }
    priceCache.set(key, id);
    return id;
  }

  const lines = async (input: Omit<ChangeInput, 'increase'> & { devicesOnly?: boolean }) => {
    if (input.devicesOnly) {
      return [
        {
          price: await price(`${input.plan}_device`, input.deviceCents, input.behavior),
          quantity: input.extraDevices,
        },
      ];
    }
    const out = [{ price: await price(input.plan, input.baseCents, input.behavior), quantity: 1 }];
    if (input.extraDevices > 0) {
      out.push({
        price: await price(`${input.plan}_device`, input.deviceCents, input.behavior),
        quantity: input.extraDevices,
      });
    }
    return out;
  };

  return {
    name: 'stripe',
    async saveCustomer(input, existingId) {
      const fields = {
        email: input.email,
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
        invoice_settings: { footer: input.invoiceFooter.slice(0, 5000) },
        metadata: { account_id: String(input.accountId), account: input.publicId },
      };
      let id = existingId ?? null;
      if (id) {
        await stripe.customers.update(id, { ...fields, tax: { validate_location: 'immediately' } });
      } else {
        const c = await stripe.customers.create({
          ...fields,
          tax: { validate_location: 'immediately' },
        });
        id = c.id;
      }
      if (input.taxId) {
        const existing = await stripe.customers.listTaxIds(id, { limit: 10 });
        if (!existing.data.some((t) => t.value === input.taxId!.value)) {
          await stripe.customers.createTaxId(id, {
            type: input.taxId.type as Stripe.TaxIdCreateParams.Type,
            value: input.taxId.value,
          });
        }
      }
      return id;
    },
    async startCheckout(input) {
      const s = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: input.customerId,
        locale: input.locale,
        client_reference_id: input.publicId,
        line_items: await lines(input),
        automatic_tax: { enabled: true },
        // an affiliate discount is a coupon; Stripe allows either that or promotion codes
        ...(input.discount && input.discount.percent > 0 && !input.devicesOnly
          ? { discounts: [{ coupon: await coupon(input.discount.percent, input.discount.months) }] }
          : { allow_promotion_codes: true }),
        subscription_data: {
          metadata: {
            account_id: String(input.accountId),
            account: input.publicId,
            ...(input.devicesOnly ? { kind: 'devices' } : {}),
            ...(input.discount && input.discount.percent > 0 && !input.devicesOnly
              ? { affiliate: input.discount.code }
              : {}),
          },
        },
        metadata: {
          account_id: String(input.accountId),
          kind: input.devicesOnly ? 'devices' : 'subscription',
        },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      });
      if (!s.url) throw new Error('Stripe returned a session without URL');
      return { id: s.id, url: s.url };
    },
    async checkoutSubscription(sessionId) {
      const s = await stripe.checkout.sessions.retrieve(sessionId);
      return s.status === 'complete' ? stripeId(s.subscription as never) : null;
    },
    async getSubscription(id) {
      try {
        return toBilling(await stripe.subscriptions.retrieve(id));
      } catch (e) {
        if ((e as { statusCode?: number }).statusCode === 404) return null;
        throw e;
      }
    },
    async changeSubscription(id, input) {
      const s = await stripe.subscriptions.retrieve(id);
      const current = toBilling(s);
      const want = await lines(input);
      const items: Stripe.SubscriptionUpdateParams.Item[] = [];
      // base plan: swap the price on the same item
      items.push(
        current.items.base
          ? { id: current.items.base, price: want[0]!.price }
          : { price: want[0]!.price },
      );
      // extra devices: change, add or remove the item
      const deviceLine = want[1];
      if (current.items.devices && deviceLine) {
        items.push({
          id: current.items.devices,
          price: deviceLine.price,
          quantity: deviceLine.quantity,
        });
      } else if (current.items.devices) {
        items.push({ id: current.items.devices, deleted: true });
      } else if (deviceLine) {
        items.push(deviceLine);
      }
      const updated = await stripe.subscriptions.update(id, {
        items,
        proration_behavior: input.increase ? 'always_invoice' : 'create_prorations',
        ...(input.increase ? { payment_behavior: 'pending_if_incomplete' as const } : {}),
      });
      return toBilling(updated);
    },
    async setCancelAtPeriodEnd(id, cancel) {
      return toBilling(await stripe.subscriptions.update(id, { cancel_at_period_end: cancel }));
    },
    async cancelNow(id) {
      await stripe.subscriptions.cancel(id, { prorate: false });
    },
    async changeDevices(id, input) {
      const current = toBilling(await stripe.subscriptions.retrieve(id));
      const p = await price(`${input.plan}_device`, input.deviceCents, input.behavior);
      const updated = await stripe.subscriptions.update(id, {
        items: [
          current.items.devices
            ? { id: current.items.devices, price: p, quantity: input.devices }
            : { price: p, quantity: input.devices },
        ],
        cancel_at_period_end: false,
        proration_behavior: input.increase ? 'always_invoice' : 'create_prorations',
        ...(input.increase ? { payment_behavior: 'pending_if_incomplete' as const } : {}),
      });
      return toBilling(updated);
    },
    async cancelWithRefund(id, now = new Date()) {
      const s = await stripe.subscriptions.retrieve(id, { expand: ['latest_invoice'] });
      if (s.status === 'canceled' || s.status === 'incomplete_expired') {
        return { refundedCents: 0, creditNote: null };
      }
      const b = toBilling(s);
      const inv = s.latest_invoice as Stripe.Invoice | null;
      let refund = 0;
      let creditNote: DeviceRefund['creditNote'] = null;
      if (inv?.id && inv.status === 'paid' && b.currentPeriodStart && b.currentPeriodEnd) {
        const total = b.currentPeriodEnd.getTime() - b.currentPeriodStart.getTime();
        const left = Math.max(0, b.currentPeriodEnd.getTime() - now.getTime());
        const credited = inv.post_payment_credit_notes_amount ?? 0;
        refund = Math.max(
          0,
          Math.min(
            inv.amount_paid - credited,
            Math.floor((inv.amount_paid * left) / Math.max(1, total)),
          ),
        );
        if (refund > 0) {
          const cn = await stripe.creditNotes.create(
            {
              invoice: inv.id,
              amount: refund,
              refund_amount: refund,
              reason: 'order_change',
              memo: 'Abo aus dem App-Store beendet / App store subscription ended',
            },
            { idempotencyKey: `device-refund-${id}` },
          );
          creditNote = { id: cn.id, number: cn.number };
        }
      }
      await stripe.subscriptions.cancel(id, { prorate: false });
      return { refundedCents: refund, creditNote };
    },
    async portalUrl(customerId, returnUrl, locale) {
      const s = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
        locale,
      });
      return s.url;
    },
    async addMeteredItem(subscriptionId, service, cents, behavior) {
      const it = await stripe.subscriptionItems.create(
        {
          subscription: subscriptionId,
          price: await meteredPrice(service, cents, behavior),
          proration_behavior: 'none',
        },
        { idempotencyKey: `metered-${subscriptionId}-${service}-${cents}-${behavior}` },
      );
      return it.id;
    },
    async meterEvent(input) {
      await stripe.billing.meterEvents.create({
        event_name: METER_EVENTS[input.service],
        identifier: input.identifier,
        timestamp: Math.floor(input.timestamp.getTime() / 1000),
        payload: { stripe_customer_id: input.customerId, value: String(input.value) },
      });
    },
    async invoice(id) {
      const i = await stripe.invoices.retrieve(id);
      return {
        number: i.number ?? null,
        pdfUrl: i.invoice_pdf ?? null,
        total: i.total,
        subscriptionId: stripeId(i.parent?.subscription_details?.subscription as never),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Local stand-in: subscriptions in memory; /dev/abo/<id> plays the Stripe Checkout page.
// ---------------------------------------------------------------------------

/** The stand-in remembers the device price, to work out a refund. */
type FakeSubscription = BillingSubscription & { fakeDeviceCents?: number };

type FakeSession = {
  id: string;
  input: CheckoutInput;
  status: 'open' | 'complete';
  subscriptionId: string | null;
};
type FakeStore = {
  meterEvents?: MeterEventInput[];
  refunds?: { subscriptionId: string; cents: number }[];
  sessions: Map<string, FakeSession>;
  subs: Map<string, FakeSubscription>;
  customers: Map<string, BillingCustomerInput>;
  invoices: Map<string, { subscriptionId: string; total: number; number: string }>;
};

export type FakeBilling = BillingProvider & {
  store: FakeStore;
  /** The customer pays on the stand-in page: returns the subscription and its first invoice. */
  pay(sessionId: string, now?: Date): { subscriptionId: string; invoiceId: string };
  /** Moves a subscription to the next period (tests): a new paid invoice. */
  renew(subscriptionId: string): { invoiceId: string };
};

export function fakeBilling(baseUrl: string): FakeBilling {
  const g = globalThis as unknown as { __pokeshopFakeBilling?: FakeStore };
  const store: FakeStore = (g.__pokeshopFakeBilling ??= {
    sessions: new Map(),
    subs: new Map(),
    customers: new Map(),
    invoices: new Map(),
  });
  const rid = (p: string) => `${p}_fake_${randomBytes(8).toString('hex')}`;
  const month = (d: Date) => new Date(d.getTime() + 30 * 86400_000);
  const invoiceFor = (sub: BillingSubscription, total: number) => {
    const id = rid('in');
    store.invoices.set(id, {
      subscriptionId: sub.id,
      total,
      number: `TEST-${id.slice(-6).toUpperCase()}`,
    });
    return id;
  };
  return {
    name: 'fake',
    store,
    async saveCustomer(input, existingId) {
      const id = existingId && store.customers.has(existingId) ? existingId : rid('cus');
      if (input.taxId && /INVALID/i.test(input.taxId.value)) throw new Error('tax_id_invalid');
      store.customers.set(id, input);
      return id;
    },
    async startCheckout(input) {
      const id = rid('cs_sub');
      store.sessions.set(id, { id, input, status: 'open', subscriptionId: null });
      return { id, url: `${baseUrl}/dev/abo/${id}` };
    },
    async checkoutSubscription(sessionId) {
      return store.sessions.get(sessionId)?.subscriptionId ?? null;
    },
    async getSubscription(id) {
      const s = store.subs.get(id);
      return s ? { ...s, items: { ...s.items }, metered: { ...s.metered } } : null;
    },
    async addMeteredItem(subscriptionId, service) {
      const s = store.subs.get(subscriptionId);
      if (!s) throw new Error(`unknown subscription ${subscriptionId}`);
      s.metered[service] ??= rid('si');
      return s.metered[service];
    },
    async meterEvent(input) {
      store.meterEvents ??= [];
      if (store.meterEvents.some((e) => e.identifier === input.identifier)) return;
      store.meterEvents.push(input);
    },
    async changeSubscription(id, input) {
      const s = store.subs.get(id);
      if (!s) throw new Error(`unknown subscription ${id}`);
      s.plan = input.plan;
      s.extraDevices = input.extraDevices;
      s.behavior = input.behavior;
      s.items = {
        base: s.items.base,
        ...(input.extraDevices > 0 ? { devices: s.items.devices ?? rid('si') } : {}),
      };
      return { ...s, metered: { ...s.metered } };
    },
    async setCancelAtPeriodEnd(id, cancel) {
      const s = store.subs.get(id);
      if (!s) throw new Error(`unknown subscription ${id}`);
      s.cancelAtPeriodEnd = cancel;
      s.cancelAt = cancel ? s.currentPeriodEnd : null;
      return { ...s };
    },
    async cancelNow(id) {
      const s = store.subs.get(id);
      if (!s) return;
      s.status = 'canceled';
      s.endedAt = new Date();
    },
    async changeDevices(id, input) {
      const s = store.subs.get(id);
      if (!s) throw new Error(`unknown subscription ${id}`);
      s.extraDevices = input.devices;
      s.devicePlan = input.plan;
      s.fakeDeviceCents = input.deviceCents;
      s.behavior = input.behavior;
      s.cancelAtPeriodEnd = false;
      s.cancelAt = null;
      return { ...s, items: { ...s.items }, metered: { ...s.metered } };
    },
    async cancelWithRefund(id, now = new Date()) {
      const s = store.subs.get(id);
      if (!s || s.status === 'canceled') return { refundedCents: 0, creditNote: null };
      const paid = s.extraDevices * (s.fakeDeviceCents ?? 0);
      const start = s.currentPeriodStart?.getTime() ?? now.getTime();
      const end = s.currentPeriodEnd?.getTime() ?? now.getTime();
      const cents = Math.floor(
        (paid * Math.max(0, end - now.getTime())) / Math.max(1, end - start),
      );
      store.refunds ??= [];
      if (cents > 0) store.refunds.push({ subscriptionId: id, cents });
      s.status = 'canceled';
      s.endedAt = now;
      return { refundedCents: cents, creditNote: null };
    },
    async portalUrl(customerId, returnUrl) {
      return `${baseUrl}/dev/abo/portal?customer=${encodeURIComponent(customerId)}&return=${encodeURIComponent(returnUrl)}`;
    },
    async invoice(id) {
      const i = store.invoices.get(id);
      return {
        number: i?.number ?? null,
        pdfUrl: null,
        total: i?.total ?? 0,
        subscriptionId: i?.subscriptionId ?? null,
      };
    },
    pay(sessionId, now = new Date()) {
      const s = store.sessions.get(sessionId);
      if (!s || s.status !== 'open') throw new Error('session is not open');
      const only = s.input.devicesOnly === true;
      const sub: FakeSubscription = {
        id: rid('sub'),
        kind: only ? 'devices' : 'plan',
        customerId: s.input.customerId,
        status: 'active',
        accountId: s.input.accountId,
        plan: only ? null : s.input.plan,
        extraDevices: s.input.extraDevices,
        devicePlan: s.input.extraDevices > 0 ? s.input.plan : null,
        behavior: s.input.behavior,
        currentPeriodStart: now,
        currentPeriodEnd: month(now),
        cancelAtPeriodEnd: false,
        cancelAt: null,
        endedAt: null,
        items: {
          ...(only ? {} : { base: rid('si') }),
          ...(s.input.extraDevices > 0 ? { devices: rid('si') } : {}),
        },
        metered: {},
        fakeDeviceCents: s.input.deviceCents,
        affiliateCode:
          !only && s.input.discount && s.input.discount.percent > 0 ? s.input.discount.code : null,
      };
      store.subs.set(sub.id, sub);
      s.status = 'complete';
      s.subscriptionId = sub.id;
      const full = (only ? 0 : s.input.baseCents) + s.input.extraDevices * s.input.deviceCents;
      const off = sub.affiliateCode ? (s.input.discount?.percent ?? 0) : 0;
      const invoiceId = invoiceFor(sub, Math.round((full * (100 - off)) / 100));
      return { subscriptionId: sub.id, invoiceId };
    },
    renew(subscriptionId) {
      const sub = store.subs.get(subscriptionId);
      if (!sub) throw new Error('unknown subscription');
      sub.currentPeriodStart = sub.currentPeriodEnd ?? new Date();
      sub.currentPeriodEnd = month(sub.currentPeriodEnd ?? new Date());
      return { invoiceId: invoiceFor(sub, 0) };
    },
  };
}

const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** Stripe (GmbH account) when STRIPE_LICENSE_SECRET_KEY is set; the stand-in on localhost. */
export function billingFromEnv(env: NodeJS.ProcessEnv = process.env): BillingProvider | null {
  const key = env.STRIPE_LICENSE_SECRET_KEY?.trim();
  if (key) return stripeBilling({ secretKey: key });
  const base = env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
  return LOCALHOST.test(base) ? fakeBilling(base) : null;
}

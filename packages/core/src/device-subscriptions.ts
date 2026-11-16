// Extra devices for a subscription bought in an app store, bought in the portal: a Stripe
// subscription that holds only the device item (Antalyse GmbH, like the website subscription).
// In the app they are Play add-ons instead (store.ts). The device price follows the store
// subscription's plan; when the store subscription no longer runs, the device subscription ends
// at once and the unused part of its last payment is refunded (settleDeviceSubscriptions).
import type { Account } from './accounts.ts';
import type { BillingProvider, TaxBehavior } from './billing.ts';
import type { Sql } from './db.ts';
import { enqueueMail } from './outbox.ts';
import type { TaxId } from './tax-id.ts';
import {
  activeDeviceCount,
  deviceSubscriptionOf,
  deviceSubscriptionRunning,
  entitlements,
  MAX_EXTRA_DEVICES,
  planCents,
  saveBillingCustomer,
  storeDeviceSubscription,
  subscriptionOf,
  subscriptionPrices,
  type DeviceSubscription,
  type Regime,
  type Subscription,
  type SubscribeForm,
} from './subscriptions.ts';

export type DevicesProblem =
  | 'no_store_subscription'
  | 'already_active'
  | 'not_active'
  | 'unchanged'
  | 'too_many'
  | 'devices_in_use'
  | 'payment_failed';

export class DevicesRejected extends Error {
  readonly reason: DevicesProblem;
  readonly inUse: number;
  constructor(reason: DevicesProblem, inUse = 0) {
    super(reason);
    this.reason = reason;
    this.inUse = inUse;
  }
}

const isStore = (sub: Subscription | null): sub is Subscription =>
  sub?.source === 'google_play' || sub?.source === 'app_store';

/** How many devices the portal may still sell next to the app's add-ons. */
export const maxWebDevices = (sub: Subscription) =>
  Math.max(0, MAX_EXTRA_DEVICES - (sub.devicesInStore ?? 0));

async function runningStoreSubscription(sql: Sql, account: Account): Promise<Subscription> {
  const sub = await subscriptionOf(sql, account.id);
  if (!isStore(sub) || !entitlements(sub, account).active) {
    throw new DevicesRejected('no_store_subscription');
  }
  return sub;
}

/**
 * Saves the billing details and opens Stripe Checkout for `form.extraDevices` devices at the
 * device price of the store subscription's plan (the form's plan is ignored).
 */
export async function startDeviceCheckout(
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
  const sub = await runningStoreSubscription(sql, input.account);
  const existing = await deviceSubscriptionOf(sql, input.account.id);
  if (existing && deviceSubscriptionRunning(existing)) throw new DevicesRejected('already_active');
  const n = input.form.extraDevices;
  if (n < 1) throw new DevicesRejected('unchanged');
  if (n > maxWebDevices(sub)) throw new DevicesRejected('too_many');
  const customerId = await saveBillingCustomer(sql, billing, input);
  const cents = planCents(await subscriptionPrices(sql), sub.plan, input.tax.behavior);
  const s = await billing.startCheckout({
    accountId: input.account.id,
    publicId: input.account.publicId,
    customerId,
    locale: input.locale,
    plan: sub.plan,
    extraDevices: n,
    devicesOnly: true,
    baseCents: cents.base,
    deviceCents: cents.device,
    behavior: input.tax.behavior,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
  });
  return s.url;
}

/**
 * Another number of devices on the running device subscription. More is charged right away;
 * fewer is credited on the next invoice; 0 ends it with the paid month. Fewer devices than are
 * connected can't be chosen.
 */
export async function changeDeviceSubscription(
  sql: Sql,
  billing: BillingProvider,
  account: Account,
  devices: number,
): Promise<DeviceSubscription> {
  const sub = await runningStoreSubscription(sql, account);
  const d = await deviceSubscriptionOf(sql, account.id);
  if (!d || !deviceSubscriptionRunning(d)) throw new DevicesRejected('not_active');
  if (devices === d.devices && !d.cancelAtPeriodEnd) throw new DevicesRejected('unchanged');
  if (devices === 0 && d.cancelAtPeriodEnd) throw new DevicesRejected('unchanged');
  if (devices < 0 || devices > maxWebDevices(sub)) throw new DevicesRejected('too_many');
  const inUse = await activeDeviceCount(sql, account.id);
  if (1 + (sub.devicesInStore ?? 0) + devices < inUse) {
    throw new DevicesRejected('devices_in_use', inUse);
  }
  try {
    const updated =
      devices === 0
        ? await billing.setCancelAtPeriodEnd(d.stripeSubscriptionId, true)
        : await billing.changeDevices(d.stripeSubscriptionId, {
            plan: sub.plan,
            devices,
            deviceCents: planCents(await subscriptionPrices(sql), sub.plan, d.taxBehavior ?? 'incl')
              .device,
            behavior: d.taxBehavior ?? 'incl',
            increase: devices > d.devices,
          });
    return (await storeDeviceSubscription(sql, updated)) ?? d;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'card_declined' || code === 'payment_intent_payment_attempt_failed') {
      throw new DevicesRejected('payment_failed');
    }
    throw e;
  }
}

/**
 * Worker, every 10 minutes: a device subscription whose store subscription no longer runs (ended,
 * refunded, on hold, or replaced by a website subscription) ends now, with the unused part of its
 * last payment refunded; one whose store plan changed gets the other plan's device price.
 */
export async function settleDeviceSubscriptions(
  sql: Sql,
  billing: BillingProvider,
  now = new Date(),
): Promise<{ ended: number; repriced: number; failed: number }> {
  const rows = await sql<{ account_id: number }[]>`
    SELECT DISTINCT account_id FROM device_subscriptions
     WHERE status IN ('active', 'trialing', 'past_due') AND ended_at IS NULL`;
  let ended = 0;
  let repriced = 0;
  let failed = 0;
  for (const r of rows) {
    const accountId = Number(r.account_id);
    try {
      const d = await deviceSubscriptionOf(sql, accountId);
      if (!d || !deviceSubscriptionRunning(d, now)) continue;
      const sub = await subscriptionOf(sql, accountId, now);
      const storeRuns = isStore(sub) && entitlements(sub, { webshopHost: null }, now).active;
      if (!storeRuns) {
        const refund = await billing.cancelWithRefund(d.stripeSubscriptionId, now);
        await sql`
          UPDATE device_subscriptions
             SET status = 'canceled', ended_at = ${now}, ended_reason = 'store_ended',
                 refunded_cents = ${refund.refundedCents}
           WHERE id = ${d.id}`;
        const [acc] = await sql<{ email: string; locale: 'de' | 'en' }[]>`
          SELECT email, locale FROM accounts WHERE id = ${accountId}`;
        if (acc) {
          await enqueueMail(sql, {
            template: 'devices_ended',
            to: acc.email,
            locale: acc.locale,
            payload: {
              account_id: accountId,
              devices: d.devices,
              refunded_cents: refund.refundedCents,
              store: sub?.source === 'app_store' ? 'app_store' : 'google_play',
            },
            attachments: refund.creditNote
              ? [
                  {
                    kind: 'stripe',
                    seller: 'gmbh',
                    doc: 'credit_note',
                    id: refund.creditNote.id,
                    number: refund.creditNote.number,
                  },
                ]
              : [],
            dedupeKey: `devices_ended:${d.stripeSubscriptionId}`,
          });
        }
        ended++;
      } else if (sub.plan !== d.plan && !d.cancelAtPeriodEnd) {
        const behavior = d.taxBehavior ?? 'incl';
        const updated = await billing.changeDevices(d.stripeSubscriptionId, {
          plan: sub.plan,
          devices: d.devices,
          deviceCents: planCents(await subscriptionPrices(sql), sub.plan, behavior).device,
          behavior,
          // the new price applies from now; the difference comes with the next invoice
          increase: false,
        });
        await storeDeviceSubscription(sql, updated);
        repriced++;
      }
    } catch (e) {
      failed++;
      console.error(`[devices] account ${accountId}:`, (e as Error).message);
    }
  }
  return { ended, repriced, failed };
}

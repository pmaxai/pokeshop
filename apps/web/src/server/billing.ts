import 'server-only';
import { billingFromEnv, type BillingProvider } from '@pokeshop/core/billing';

const g = globalThis as unknown as { __pokeshopBilling?: BillingProvider | null };

/** Subscriptions on Antalyse GmbH's Stripe account; the stand-in on localhost; else null. */
export function billing(): BillingProvider | null {
  if (g.__pokeshopBilling === undefined) g.__pokeshopBilling = billingFromEnv(process.env);
  return g.__pokeshopBilling;
}

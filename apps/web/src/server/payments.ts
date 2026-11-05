import 'server-only';
import { paymentsFromEnv } from '@pokeshop/core/payments';

type Provider = NonNullable<ReturnType<typeof paymentsFromEnv>>;
const g = globalThis as unknown as { __pokeshopPayments?: Provider | null };

/** Stripe in production; the local stand-in on localhost; null if neither is possible. */
export function payments(): Provider | null {
  if (g.__pokeshopPayments === undefined) g.__pokeshopPayments = paymentsFromEnv();
  return g.__pokeshopPayments;
}

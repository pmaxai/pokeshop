import 'server-only';
import { paymentsFromEnv, type Seller } from '@pokeshop/core/payments';
import { viesFromEnv, type ViesChecker } from '@pokeshop/core/tax-id';
import { db } from './config';

type Provider = NonNullable<ReturnType<typeof paymentsFromEnv>>;
const g = globalThis as unknown as {
  __pokeshopPayments?: Partial<Record<Seller, Provider | null>>;
};

/**
 * Stripe in production; the local stand-in on localhost; null if neither is possible.
 * 'shop' is the shop's account (cards), 'gmbh' the account of Antalyse GmbH (app licences).
 */
export function payments(seller: Seller = 'shop'): Provider | null {
  const all = (g.__pokeshopPayments ??= {});
  if (all[seller] === undefined) all[seller] = paymentsFromEnv(process.env, seller);
  return all[seller] ?? null;
}

/** The provider of the account an order was paid to. */
export async function paymentsForOrder(orderId: number): Promise<Provider | null> {
  const [o] = await db()<{ seller: Seller }[]>`SELECT seller FROM orders WHERE id = ${orderId}`;
  return o ? payments(o.seller) : null;
}

let vies: ViesChecker | undefined;
/** EU VAT id check for business buyers of licences (VIES; a stand-in with VIES_FAKE=1 locally). */
export function viesCheck(): ViesChecker {
  vies ??= viesFromEnv();
  return vies;
}

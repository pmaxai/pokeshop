import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import type Stripe from 'stripe';
import { isBillingEvent, normaliseBillingEvent } from '@pokeshop/core/billing';
import { claimStripeEvent, finishStripeEvent, handlePaymentEvent } from '@pokeshop/core/orders';
import { handleBillingEvent } from '@pokeshop/core/subscriptions';
import type { Seller } from '@pokeshop/core/payments';
import { db } from '@/server/config';
import { payments } from '@/server/payments';
import { billing } from '@/server/billing';

/**
 * Stripe webhook of one account. The signature is checked on the raw body with that account's
 * secret; each event is stored once and processed once. A failure answers 500, so Stripe
 * retries later.
 */
export async function stripeWebhook(req: NextRequest, seller: Seller) {
  const provider = payments(seller);
  if (!provider || provider.name !== 'stripe' || !('parseWebhook' in provider)) {
    return NextResponse.json({ error: 'stripe_not_configured' }, { status: 503 });
  }
  const raw = await req.text();
  let event;
  try {
    event = provider.parseWebhook(raw, req.headers.get('stripe-signature') ?? '');
  } catch {
    return NextResponse.json({ error: 'bad_signature' }, { status: 400 });
  }
  const sql = db();
  const stripeType = event.type === 'other' ? event.stripeType : event.type;
  if (
    !(await claimStripeEvent(sql, { id: event.id, type: stripeType, payload: JSON.parse(raw) }))
  ) {
    return NextResponse.json({ received: true, duplicate: true });
  }
  try {
    // The GmbH's account also carries the app subscriptions (Stripe Billing).
    const parsed = JSON.parse(raw) as Stripe.Event;
    const sub = seller === 'gmbh' && isBillingEvent(parsed as never) ? billing() : null;
    const result = sub
      ? await handleBillingEvent(sql, sub, normaliseBillingEvent(parsed))
      : await handlePaymentEvent(sql, provider, event);
    await finishStripeEvent(sql, event.id);
    return NextResponse.json({ received: true, result });
  } catch (e) {
    console.error('[stripe] event', event.id, (e as Error).message);
    await finishStripeEvent(sql, event.id, (e as Error).message);
    return NextResponse.json({ error: 'processing_failed' }, { status: 500 });
  }
}

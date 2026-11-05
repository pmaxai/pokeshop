import { NextResponse, type NextRequest } from 'next/server';
import { claimStripeEvent, finishStripeEvent, handlePaymentEvent } from '@pokeshop/core/orders';
import { db } from '@/server/config';
import { payments } from '@/server/payments';

export const dynamic = 'force-dynamic';

/**
 * Stripe webhook. The signature is checked on the raw body; each event is stored once and
 * processed once. A failure answers 500, so Stripe retries later.
 */
export async function POST(req: NextRequest) {
  const provider = payments();
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
    const result = await handlePaymentEvent(sql, provider, event);
    await finishStripeEvent(sql, event.id);
    return NextResponse.json({ received: true, result });
  } catch (e) {
    console.error('[stripe] event', event.id, (e as Error).message);
    await finishStripeEvent(sql, event.id, (e as Error).message);
    return NextResponse.json({ error: 'processing_failed' }, { status: 500 });
  }
}

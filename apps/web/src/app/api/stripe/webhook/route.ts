import type { NextRequest } from 'next/server';
import { stripeWebhook } from '@/server/stripe-webhook';

export const dynamic = 'force-dynamic';

/** Webhook of the shop's Stripe account (card orders). */
export async function POST(req: NextRequest) {
  return stripeWebhook(req, 'shop');
}

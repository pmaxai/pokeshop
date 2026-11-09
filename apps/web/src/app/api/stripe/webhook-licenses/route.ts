import type { NextRequest } from 'next/server';
import { stripeWebhook } from '@/server/stripe-webhook';

export const dynamic = 'force-dynamic';

/** Webhook of the Stripe account of Antalyse GmbH (app licences; STRIPE_LICENSE_WEBHOOK_SECRET). */
export async function POST(req: NextRequest) {
  return stripeWebhook(req, 'gmbh');
}

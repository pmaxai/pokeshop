import type { NextRequest } from 'next/server';
import { stripeWebhook } from '@/server/stripe-webhook';

export const dynamic = 'force-dynamic';

/**
 * Webhook of the Stripe account of Antalyse GmbH: the app's subscriptions
 * (STRIPE_LICENSE_WEBHOOK_SECRET; path and name are kept from the app licences it sold first).
 */
export async function POST(req: NextRequest) {
  return stripeWebhook(req, 'gmbh');
}

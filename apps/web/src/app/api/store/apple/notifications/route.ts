import { NextResponse, type NextRequest } from 'next/server';
import { handleAppleNotification } from '@pokeshop/core/store-apple';
import { appStore, db } from '@/server/config';

export const dynamic = 'force-dynamic';

/**
 * POST /api/store/apple/notifications – App Store Server Notifications V2 (production and
 * sandbox). The body { signedPayload } is signed by Apple; the server then reads the subscription
 * from the App Store Server API and stores what it says. 200 = done; anything else is retried by
 * Apple (after 1, 12, 24, 48 and 72 hours), so this is safe to repeat.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const status = await handleAppleNotification(db(), appStore(), body);
  return new NextResponse(null, { status });
}

import { NextResponse, type NextRequest } from 'next/server';
import { verifyJwt } from '@pokeshop/core/jwt';
import { GOOGLE_ISSUERS } from '@pokeshop/core/app-signin';
import {
  googlePlayPackage,
  parseDeveloperNotification,
  processGooglePurchase,
  PurchaseInvalid,
  revokeGooglePurchase,
} from '@pokeshop/core/store';
import { db, googlePlay, googleSigningKeys, pubSubAuth } from '@/server/config';

export const dynamic = 'force-dynamic';

const status = (n: number) => new NextResponse(null, { status: n });

/**
 * POST /api/store/google/notifications – Google Play real-time developer notifications through
 * a Cloud Pub/Sub push subscription. The push is signed (OIDC token); the server then reads the
 * subscription from Google and stores what it says. 2xx = done; anything else is retried by
 * Pub/Sub, so this is safe to repeat.
 */
export async function POST(req: NextRequest) {
  const auth = pubSubAuth();
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!bearer) return status(401);
  try {
    const c = await verifyJwt(bearer, {
      keys: googleSigningKeys(),
      issuers: GOOGLE_ISSUERS,
      audiences: [auth.audience],
    });
    if (auth.email && (c.email !== auth.email || c.email_verified !== true)) return status(403);
  } catch (e) {
    if ((e as { code?: string }).code === 'keys_unavailable') return status(503);
    return status(401);
  }
  const n = parseDeveloperNotification(await req.json().catch(() => null));
  if (!n) return status(204);
  if (n.packageName && n.packageName !== googlePlayPackage()) return status(204);
  if (n.kind === 'test' || n.kind === 'other') {
    console.log(`[store] Google notification: ${n.kind}`);
    return status(204);
  }
  if (n.kind === 'voided') {
    await revokeGooglePurchase(db(), n.token);
    return status(204);
  }
  const play = googlePlay();
  if (!play) return status(503);
  try {
    await processGooglePurchase(db(), play, { token: n.token, accountId: null });
  } catch (e) {
    if (e instanceof PurchaseInvalid) return status(204);
    console.error('[store] Google notification failed:', (e as Error).message);
    return status(503);
  }
  return status(204);
}

import type { NextRequest } from 'next/server';
import { appPackFileUrl, appPackUrlKey, currentAppPack } from '@pokeshop/core/app-pack';
import { accountEntitlements } from '@pokeshop/core/subscriptions';
import { apiMasterKey, config, db } from '@/server/config';
import { apiError, appAuth, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/**
 * GET /api/app/v1/pack – the nightly data pack for the store editions: version and the files
 * with size, SHA-256 and a download URL valid one hour. Subscribers only (402 otherwise).
 */
export async function GET(req: NextRequest) {
  const a = await appAuth(req);
  if (!a.ok) return a.response;
  const ent = await accountEntitlements(db(), a.account);
  if (!ent.active) {
    return apiError(402, 'subscription_required', 'The account has no running subscription.');
  }
  const pack = await currentAppPack(db());
  if (!pack) {
    return apiError(
      503,
      'pack_unavailable',
      'The data pack is not available yet. Try again later.',
      {},
      {
        'retry-after': '3600',
      },
    );
  }
  const key = appPackUrlKey(apiMasterKey());
  const now = new Date();
  return ok({
    version: pack.version,
    files: pack.files.map((f) => ({
      name: f.name,
      size: f.size,
      sha256: f.sha256,
      url: appPackFileUrl(config.baseUrl, key, f, now),
    })),
  });
}

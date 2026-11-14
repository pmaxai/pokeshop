import type { NextRequest } from 'next/server';
import { accountEntitlements } from '@pokeshop/core/subscriptions';
import { db } from '@/server/config';
import { apiError, appAuth } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/** GET /api/app/v1/services/s3 – the S3 settings the shop set up for the customer. */
export async function GET(req: NextRequest) {
  const a = await appAuth(req);
  if (!a.ok) return a.response;
  const ent = await accountEntitlements(db(), a.account);
  if (!ent.features.s3_upload) {
    return apiError(403, 'feature_not_included', 'S3 storage is not set up for this account.');
  }
  return apiError(404, 'not_configured', 'The S3 settings are not ready yet.');
}

import type { NextRequest } from 'next/server';
import { accountEntitlements } from '@pokeshop/core/subscriptions';
import { s3Config } from '@pokeshop/core/usage';
import { apiMasterKey, db } from '@/server/config';
import { apiError, appAuth, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/** GET /api/app/v1/services/s3 – the S3 settings the shop set up for the customer. */
export async function GET(req: NextRequest) {
  const a = await appAuth(req);
  if (!a.ok) return a.response;
  const ent = await accountEntitlements(db(), a.account);
  if (!ent.features.s3_upload) {
    return apiError(403, 'feature_not_included', 'S3 storage is not set up for this account.');
  }
  const c = await s3Config(db(), a.account.id, apiMasterKey());
  if (!c) return apiError(404, 'not_configured', 'The S3 settings are not ready yet.');
  return ok({
    provider: c.provider,
    endpoint: c.endpoint,
    region: c.region,
    bucket: c.bucket,
    prefix: c.prefix,
    access_key_id: c.access_key_id,
    secret_access_key: c.secret_access_key,
    updated_at: c.updatedAt.toISOString(),
  });
}

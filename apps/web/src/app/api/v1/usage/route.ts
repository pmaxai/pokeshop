import { ApiError } from '@pokeshop/core/errors';
import { recordUsage, usageJson } from '@pokeshop/core/usage';
import { signed } from '@/server/signed-api';
import { db } from '@/server/config';

export const dynamic = 'force-dynamic';

const MESSAGES = {
  invalid_request: 'Check the fields.',
  unknown_account: 'No customer with this account id.',
  service_not_enabled: 'The service is not switched on for this customer.',
} as const;

/** POST /api/v1/usage – the video pipeline reports S3 megabytes or video seconds of a customer. */
export const POST = signed('usage:write', async ({ json, client }) => {
  const r = await recordUsage(db(), json, { apiClientId: client.id });
  if (!r.ok) throw new ApiError(r.status, r.code, MESSAGES[r.code], r.fields);
  return { status: 201, body: usageJson(r.event) };
});

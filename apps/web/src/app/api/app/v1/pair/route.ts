import type { NextRequest } from 'next/server';
import { pairDevice } from '@pokeshop/core/devices';
import { db } from '@/server/config';
import { apiError, deviceFields, jsonBody, signedIn } from '@/server/app-api';
import { clientIp, rateLimited } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

const MESSAGES = {
  invalid_code: [400, 'That is not a pairing code.'],
  unknown_code: [404, 'This pairing code does not exist.'],
  code_expired: [
    410,
    'This pairing code has expired or was already used. Show a new one in your account.',
  ],
  subscription_required: [402, 'The account has no running subscription.'],
  device_limit: [409, 'All devices of this subscription are in use.'],
} as const;

/** POST /api/app/v1/pair – docs/app-account-api.md */
export async function POST(req: NextRequest) {
  if (rateLimited(`pair:${clientIp(req.headers)}`, 10, 15 * 60_000)) {
    return apiError(
      429,
      'rate_limited',
      'Too many attempts. Wait a few minutes.',
      {},
      { 'retry-after': '300' },
    );
  }
  const b = await jsonBody(req);
  const d = deviceFields(b);
  const fields = d.ok ? {} : { ...d.fields };
  const code = typeof b?.code === 'string' ? b.code : '';
  if (!code) fields.code = 'required';
  if (!b || !d.ok || Object.keys(fields).length) {
    return apiError(400, 'invalid_request', 'Check the request body.', { fields });
  }
  const r = await pairDevice(db(), { code, ...d.device });
  if (!r.ok) {
    const [status, message] = MESSAGES[r.problem];
    return apiError(status, r.problem, message, r.seats !== undefined ? { seats: r.seats } : {});
  }
  return signedIn(r, 201, b);
}

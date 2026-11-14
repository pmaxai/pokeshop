import type { NextRequest } from 'next/server';
import { appStatus, pairDevice } from '@pokeshop/core/devices';
import { config, db } from '@/server/config';
import { apiError, jsonBody, ok } from '@/server/app-api';
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
  const fields: Record<string, string> = {};
  const code = typeof b?.code === 'string' ? b.code : '';
  const deviceUuid = typeof b?.device_id === 'string' ? b.device_id.trim() : '';
  if (!code) fields.code = 'required';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(deviceUuid))
    fields.device_id = deviceUuid ? 'invalid' : 'required';
  if (b?.platform !== undefined && b.platform !== 'android') fields.platform = 'invalid';
  for (const [k, max] of [
    ['device_name', 80],
    ['app_version', 40],
  ] as const) {
    if (
      b?.[k] !== undefined &&
      b[k] !== null &&
      (typeof b[k] !== 'string' || (b[k] as string).length > max)
    ) {
      fields[k] = 'invalid';
    }
  }
  if (!b || Object.keys(fields).length) {
    return apiError(400, 'invalid_request', 'Check the request body.', { fields });
  }
  const r = await pairDevice(db(), {
    code,
    deviceUuid,
    name: (b.device_name as string | undefined) ?? null,
    appVersion: (b.app_version as string | undefined) ?? null,
    platform: 'android',
  });
  if (!r.ok) {
    const [status, message] = MESSAGES[r.problem];
    return apiError(status, r.problem, message, r.seats !== undefined ? { seats: r.seats } : {});
  }
  const status = await appStatus(db(), r.account, r.device, { baseUrl: config.baseUrl });
  return ok(
    {
      token: r.token,
      device: {
        id: r.device.publicId,
        name: r.device.name,
        paired_at: r.device.pairedAt.toISOString(),
      },
      status,
    },
    201,
  );
}

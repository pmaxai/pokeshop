import type { NextRequest } from 'next/server';
import { verifyAppCode } from '@pokeshop/core/app-signin';
import { config, db } from '@/server/config';
import { apiError, deviceFields, jsonBody, signedIn, signInLimited } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/** POST /api/app/v1/login/email/verify – the code from the e-mail; signs in (or registers). */
export async function POST(req: NextRequest) {
  const limited = signInLimited(req);
  if (limited) return limited;
  const b = await jsonBody(req);
  const d = deviceFields(b);
  const fields = d.ok ? {} : { ...d.fields };
  if (typeof b?.email !== 'string' || !b.email) fields.email = 'required';
  if (typeof b?.code !== 'string' || !b.code) fields.code = 'required';
  if (!b || !d.ok || Object.keys(fields).length) {
    return apiError(400, 'invalid_request', 'Check the request body.', { fields });
  }
  const r = await verifyAppCode(db(), {
    email: b.email as string,
    code: b.code as string,
    device: d.device,
    baseUrl: config.baseUrl,
    review: config.review,
    testHooks: config.storeTestHooks,
  });
  if (r.ok) return signedIn(r, 200, b);
  switch (r.problem) {
    case 'invalid_email':
      return apiError(400, 'invalid_email', 'That is not an e-mail address.');
    case 'wrong_code':
      return apiError(400, 'wrong_code', 'The code does not match.', { tries_left: r.triesLeft });
    case 'code_expired':
      return apiError(410, 'code_expired', 'The code has expired or was already used.');
    case 'rate_limited':
      return apiError(
        429,
        'rate_limited',
        'Too many wrong codes. Ask for a new one.',
        {},
        {
          'retry-after': '60',
        },
      );
    case 'device_limit':
      return apiError(409, 'device_limit', 'All devices of this subscription are in use.', {
        seats: r.seats,
      });
    default:
      return apiError(400, 'invalid_request', 'Check the request body.');
  }
}

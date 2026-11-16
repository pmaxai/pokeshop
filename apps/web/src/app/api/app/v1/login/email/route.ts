import type { NextRequest } from 'next/server';
import { requestAppCode } from '@pokeshop/core/app-signin';
import { config, db } from '@/server/config';
import { apiError, jsonBody, ok, signInLimited } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/** POST /api/app/v1/login/email – "Use another email": e-mails a 6-digit code. */
export async function POST(req: NextRequest) {
  const limited = signInLimited(req);
  if (limited) return limited;
  const b = await jsonBody(req);
  const email = typeof b?.email === 'string' ? b.email : '';
  const r = await requestAppCode(db(), {
    email,
    review: config.review,
    testHooks: config.storeTestHooks,
  });
  if (!r.ok) {
    if (r.problem === 'invalid_email') {
      return apiError(400, 'invalid_email', 'That is not an e-mail address.');
    }
    return apiError(
      429,
      'rate_limited',
      'Too many codes for this address. Wait a while.',
      {},
      { 'retry-after': String(r.retryAfter) },
    );
  }
  return ok({ resend_after: r.resendAfter }, 202);
}

import type { NextRequest } from 'next/server';
import { affiliateDiscount } from '@pokeshop/core/affiliates';
import { db } from '@/server/config';
import { applyAppCode, discountJson } from '@/server/affiliate';
import { apiError, appAuth, jsonBody, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/** GET /api/app/v1/affiliate – the account's affiliate discount for its first subscription. */
export async function GET(req: NextRequest) {
  const a = await appAuth(req);
  if (!a.ok) return a.response;
  return ok({ affiliate: discountJson(await affiliateDiscount(db(), a.account.id)) });
}

/**
 * POST /api/app/v1/affiliate { "code": "MISTY" } – an influencer's code, typed in or from the
 * Play install referrer. The first code counts; only before the first paid subscription.
 */
export async function POST(req: NextRequest) {
  const a = await appAuth(req);
  if (!a.ok) return a.response;
  const b = await jsonBody(req);
  if (typeof b?.code !== 'string' || !b.code.trim()) {
    return apiError(400, 'invalid_request', 'Send {"code": "…"}.', {
      fields: { code: 'required' },
    });
  }
  const r = await applyAppCode(a.account.id, b.code);
  if (r.result === 'unknown_code') {
    return apiError(404, 'unknown_code', 'There is no active code like this.');
  }
  if (r.result === 'already_registered') {
    return apiError(409, 'already_registered', 'The account already uses another code.', {
      affiliate: r.affiliate,
    });
  }
  if (r.result === 'already_customer') {
    return apiError(409, 'already_customer', 'Codes are only for the first subscription.');
  }
  return ok({ affiliate: r.affiliate });
}

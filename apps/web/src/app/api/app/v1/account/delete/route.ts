import type { NextRequest } from 'next/server';
import { deleteAccountEverywhere } from '@/server/account-delete';
import { apiError, appAuth, jsonBody, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/**
 * POST /api/app/v1/account/delete { "confirm": true } – deletes the account from the app (both
 * stores require it). Sign-in ends on all devices at once; the data goes (orders and invoices
 * stay as the law requires). Renewals stop: a website subscription and a Google Play one are
 * cancelled by the server and run to the end of the paid period; an App Store one must be
 * cancelled by the person (manage_url).
 */
export async function POST(req: NextRequest) {
  const a = await appAuth(req);
  if (!a.ok) return a.response;
  const b = await jsonBody(req);
  if (b?.confirm !== true) {
    return apiError(400, 'invalid_request', 'Send {"confirm": true} to delete the account.', {
      fields: { confirm: 'required' },
    });
  }
  const r = await deleteAccountEverywhere(a.account);
  if (!r.ok) {
    return apiError(503, 'internal', 'The subscription could not be cancelled. Try again later.');
  }
  return ok({ deleted: true, manage_url: r.manageUrl }, 202);
}

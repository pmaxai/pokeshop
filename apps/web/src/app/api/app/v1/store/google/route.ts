import type { NextRequest } from 'next/server';
import { appStatus } from '@pokeshop/core/devices';
import { processGooglePurchase, PurchaseInvalid, StoreUnavailable } from '@pokeshop/core/store';
import { config, db, googlePlay } from '@/server/config';
import { apiError, appAuth, jsonBody, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/**
 * POST /api/app/v1/store/google – the app reports a Google Play purchase (also "Restore
 * purchases"). The server reads it from Google, checks it was bought for this account,
 * acknowledges it and answers the status. The same token again gives the same answer.
 */
export async function POST(req: NextRequest) {
  const a = await appAuth(req);
  if (!a.ok) return a.response;
  const b = await jsonBody(req);
  const productId = typeof b?.product_id === 'string' ? b.product_id.trim() : '';
  const token = typeof b?.purchase_token === 'string' ? b.purchase_token.trim() : '';
  const fields: Record<string, string> = {};
  if (!/^[a-z0-9][a-z0-9._]{0,149}$/.test(productId))
    fields.product_id = productId ? 'invalid' : 'required';
  if (!token || token.length > 4096) fields.purchase_token = token ? 'invalid' : 'required';
  if (Object.keys(fields).length) {
    return apiError(400, 'invalid_request', 'Check the request body.', { fields });
  }
  try {
    const r = await processGooglePurchase(db(), googlePlay(), {
      token,
      productId,
      accountId: a.account.id,
      storeRef: a.account.storeRef,
      testHooks: config.storeTestHooks,
    });
    if (!r.ok) {
      if (r.problem === 'linked_elsewhere') {
        return apiError(409, 'linked_elsewhere', 'This purchase belongs to another account.', {
          owner: r.owner,
        });
      }
      if (r.problem === 'already_subscribed') {
        return apiError(
          409,
          'already_subscribed',
          'The account already has a running subscription. This purchase was not accepted; Google refunds it within 3 days.',
          { source: r.source },
        );
      }
      return apiError(400, 'invalid_purchase', 'This purchase is not one of our subscriptions.');
    }
  } catch (e) {
    if (e instanceof PurchaseInvalid) {
      return apiError(400, 'invalid_purchase', 'Google does not know this purchase.');
    }
    if (e instanceof StoreUnavailable) {
      console.error('[store] Google Play:', e.message);
      return apiError(
        503,
        'store_unavailable',
        'Google did not answer. Keep the purchase and try again.',
        {},
        {
          'retry-after': '30',
        },
      );
    }
    throw e;
  }
  return ok(await appStatus(db(), a.account, a.device, { baseUrl: config.baseUrl }));
}

import type { NextRequest } from 'next/server';
import { appStatus } from '@pokeshop/core/devices';
import { PurchaseInvalid, storeManageUrl, StoreUnavailable } from '@pokeshop/core/store';
import { APPLE_REFUND_URL, processApplePurchase } from '@pokeshop/core/store-apple';
import { appStore, config, db } from '@/server/config';
import { apiError, appAuth, jsonBody, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/**
 * POST /api/app/v1/store/apple – the app reports an App Store transaction (StoreKit 2's signed
 * JWS; also "Restore purchases"), before it finishes it. The server checks Apple's signature,
 * reads the subscription from the App Store Server API, checks it was bought for this account and
 * answers the status. The same transaction again gives the same answer.
 */
export async function POST(req: NextRequest) {
  const a = await appAuth(req);
  if (!a.ok) return a.response;
  const b = await jsonBody(req);
  const signed = typeof b?.signed_transaction === 'string' ? b.signed_transaction.trim() : '';
  if (!signed || signed.length > 64_000) {
    return apiError(400, 'invalid_request', 'Check the request body.', {
      fields: { signed_transaction: signed ? 'invalid' : 'required' },
    });
  }
  try {
    const r = await processApplePurchase(db(), appStore(), {
      signedTransaction: signed,
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
        // Apple can't be told to refund: the person cancels it and asks Apple
        return apiError(
          409,
          'already_subscribed',
          'The account already has a running subscription, so this purchase does not count. Cancel it in the App Store and ask Apple for a refund.',
          {
            source: r.source,
            manage_url: storeManageUrl('app_store', r.purchase.productId),
            refund_url: APPLE_REFUND_URL,
          },
        );
      }
      return apiError(400, 'invalid_purchase', 'This purchase is not one of our subscriptions.');
    }
  } catch (e) {
    if (e instanceof PurchaseInvalid) {
      return apiError(400, 'invalid_purchase', 'The App Store does not know this purchase.');
    }
    if (e instanceof StoreUnavailable) {
      console.error('[store] App Store:', e.message);
      return apiError(
        503,
        'store_unavailable',
        'The App Store did not answer. Keep the transaction unfinished and try again.',
        {},
        { 'retry-after': '30' },
      );
    }
    throw e;
  }
  return ok(await appStatus(db(), a.account, a.device, { baseUrl: config.baseUrl }));
}

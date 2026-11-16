import 'server-only';
import { deleteAccount, type Account } from '@pokeshop/core/accounts';
import { cancelRequestedRenewals, storeManageUrl, type Store } from '@pokeshop/core/store';
import {
  deviceSubscriptionOf,
  deviceSubscriptionRunning,
  entitlements,
  storeDeviceSubscription,
  storeStripeSubscription,
  websiteSubscription,
} from '@pokeshop/core/subscriptions';
import { billing } from './billing';
import { db, googlePlay } from './config';

export type DeleteResult =
  { ok: true; manageUrl: string | null } | { ok: false; reason: 'subscription' };

/**
 * Deletes an account – from the portal, the public delete page and the app
 * (POST /api/app/v1/account/delete) alike. Renewals stop first: a website subscription is set to
 * end with its paid period (Stripe), a Google Play one is cancelled at Google (now, or by the
 * worker if Google does not answer). An App Store subscription can only be cancelled by the
 * person: its manage URL comes back for the app to show.
 */
export async function deleteAccountEverywhere(account: Account): Promise<DeleteResult> {
  const web = await websiteSubscription(db(), account.id);
  if (
    web?.source === 'stripe' &&
    web.stripeSubscriptionId &&
    !web.cancelAtPeriodEnd &&
    entitlements(web, account).active
  ) {
    const bill = billing();
    if (!bill) return { ok: false, reason: 'subscription' };
    try {
      await storeStripeSubscription(
        db(),
        await bill.setCancelAtPeriodEnd(web.stripeSubscriptionId, true),
      );
    } catch (e) {
      console.error('[account] cancelling the Stripe subscription failed:', (e as Error).message);
      return { ok: false, reason: 'subscription' };
    }
  }
  // extra devices bought in the portal for a store subscription: no renewal either
  const devices = await deviceSubscriptionOf(db(), account.id);
  if (devices && deviceSubscriptionRunning(devices) && !devices.cancelAtPeriodEnd) {
    const bill = billing();
    if (!bill) return { ok: false, reason: 'subscription' };
    try {
      await storeDeviceSubscription(
        db(),
        await bill.setCancelAtPeriodEnd(devices.stripeSubscriptionId, true),
      );
    } catch (e) {
      console.error('[account] cancelling the device subscription failed:', (e as Error).message);
      return { ok: false, reason: 'subscription' };
    }
  }
  const r = await deleteAccount(db(), account.id);
  await cancelRequestedRenewals(db(), googlePlay()).catch((e: Error) =>
    console.error('[account] cancelling store renewals:', e.message),
  );
  const apple = r.cancelInStore[0];
  return {
    ok: true,
    manageUrl: apple ? storeManageUrl(apple.store as Store, apple.productId) : null,
  };
}

import type { NextRequest } from 'next/server';
import { affiliateDiscount } from '@pokeshop/core/affiliates';
import { storeAddonOffers, storeOffers, storeProducts } from '@pokeshop/core/store';
import { db } from '@/server/config';
import { discountJson } from '@/server/affiliate';
import { appAuth, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/**
 * GET /api/app/v1/store/offers – the plans on sale in the stores, with their product ids, and the
 * add-ons on sale beside them. With an affiliate discount, `google.offer_id` is the Play offer to
 * buy with and `affiliate` says which.
 */
export async function GET(req: NextRequest) {
  const a = await appAuth(req);
  if (!a.ok) return a.response;
  const [products, discount] = await Promise.all([
    storeProducts(db()),
    affiliateDiscount(db(), a.account.id),
  ]);
  return ok({
    offers: storeOffers(products, discount),
    addons: storeAddonOffers(products),
    affiliate: discountJson(discount),
  });
}

import type { NextRequest } from 'next/server';
import { storeOffers, storeProducts } from '@pokeshop/core/store';
import { db } from '@/server/config';
import { appAuth, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/** GET /api/app/v1/store/offers – the plans on sale in the stores, with their product ids. */
export async function GET(req: NextRequest) {
  const a = await appAuth(req);
  if (!a.ok) return a.response;
  return ok({ offers: storeOffers(await storeProducts(db())) });
}

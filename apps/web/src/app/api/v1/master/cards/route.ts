import { ApiError } from '@pokeshop/core/errors';
import { searchMaster } from '@pokeshop/core/products';
import { signed } from '@/server/signed-api';
import { db } from '@/server/config';

export const dynamic = 'force-dynamic';

export const GET = signed('products:read', async ({ req }) => {
  const q = req.nextUrl.searchParams;
  const lang = q.get('lang') === 'en' ? 'en' : 'de';
  const query = {
    card_ref: q.get('card_ref') ?? undefined,
    set: q.get('set') ?? undefined,
    number: q.get('number') ?? undefined,
    q: q.get('q') ?? undefined,
    lang,
  } as const;
  if (!query.card_ref && !query.set && !query.q) {
    throw new ApiError(422, 'validation', 'send card_ref, set (with or without number) or q');
  }
  return { status: 200, body: { items: await searchMaster(db(), query) } };
});

import { ApiError } from '@pokeshop/core/errors';
import { listProducts } from '@pokeshop/core/products';
import { signed } from '@/server/signed-api';
import { db } from '@/server/config';

export const dynamic = 'force-dynamic';

export const GET = signed('products:read', async ({ req, options }) => {
  const q = req.nextUrl.searchParams;
  const since = q.get('updated_since');
  const updatedSince = since ? new Date(since) : undefined;
  if (updatedSince && Number.isNaN(updatedSince.getTime())) {
    throw new ApiError(422, 'validation', 'updated_since must be an ISO date-time');
  }
  const status = q.get('status') ?? undefined;
  if (status && !['draft', 'active', 'archived'].includes(status)) {
    throw new ApiError(422, 'validation', 'status must be draft, active or archived');
  }
  const body = await listProducts(
    db(),
    {
      external_id: q.get('external_id') ?? undefined,
      card_ref: q.get('card_ref') ?? undefined,
      storage_location: q.get('storage_location') ?? undefined,
      status,
      updated_since: updatedSince,
      limit: q.get('limit') ? Number(q.get('limit')) : undefined,
      cursor: q.get('cursor') ?? undefined,
    },
    options,
  );
  return { status: 200, body };
});

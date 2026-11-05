import { IntakeRequest, parse } from '@pokeshop/core/api-schemas';
import { intake } from '@pokeshop/core/products';
import { signed } from '@/server/signed-api';
import { db } from '@/server/config';

export const dynamic = 'force-dynamic';

export const POST = signed('stock:write', async ({ json, actor, options }) => {
  const input = parse(IntakeRequest, json);
  const r = await intake(db(), input, actor, options);
  return {
    status: r.created ? 201 : 200,
    body: {
      created: r.created,
      product: r.product,
      ...(r.warnings.length ? { warnings: r.warnings } : {}),
    },
  };
});

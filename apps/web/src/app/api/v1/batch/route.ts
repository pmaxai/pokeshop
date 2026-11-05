import {
  BatchRequest,
  IntakeRequest,
  parse,
  ProductInput,
  StockChange,
} from '@pokeshop/core/api-schemas';
import { ApiError } from '@pokeshop/core/errors';
import { changeStock, intake, replaceProduct } from '@pokeshop/core/products';
import { signed } from '@/server/signed-api';
import { db } from '@/server/config';

export const dynamic = 'force-dynamic';

/** Up to 100 operations; each one stands alone and gets its own result. */
export const POST = signed('stock:write', async ({ json, actor, options }) => {
  const { operations } = parse(BatchRequest, json);
  const results: { status: number; body: unknown }[] = [];
  for (const [i, op] of operations.entries()) {
    const opActor = { ...actor, reference: actor.reference ? `${actor.reference}#${i}` : null };
    try {
      if (op.op === 'intake') {
        const r = await intake(db(), parse(IntakeRequest, op.body), opActor, options);
        results.push({
          status: r.created ? 201 : 200,
          body: { created: r.created, product: r.product, warnings: r.warnings },
        });
      } else if (op.op === 'upsert') {
        const r = await replaceProduct(
          db(),
          op.sku,
          parse(ProductInput, op.body),
          opActor,
          options,
        );
        results.push({ status: r.created ? 201 : 200, body: r.product });
      } else {
        results.push({
          status: 200,
          body: await changeStock(db(), op.sku, parse(StockChange, op.body), opActor),
        });
      }
    } catch (e) {
      if (e instanceof ApiError) results.push({ status: e.status, body: e.toJSON() });
      else {
        console.error('[api batch]', i, e);
        results.push({ status: 500, body: { error: 'internal' } });
      }
    }
  }
  return { status: 200, body: { results } };
});

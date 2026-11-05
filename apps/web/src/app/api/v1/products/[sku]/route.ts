import { parse, ProductInput, ProductPatch } from '@pokeshop/core/api-schemas';
import { notFound } from '@pokeshop/core/errors';
import { getProduct, patchProduct, replaceProduct } from '@pokeshop/core/products';
import { signed } from '@/server/signed-api';
import { db } from '@/server/config';

export const dynamic = 'force-dynamic';

export const GET = signed('products:read', async ({ params, options }) => {
  const p = await getProduct(db(), decodeURIComponent(params.sku!), options);
  if (!p) throw notFound();
  return { status: 200, body: p };
});

export const PUT = signed('products:write', async ({ params, json, actor, options }) => {
  const r = await replaceProduct(
    db(),
    decodeURIComponent(params.sku!),
    parse(ProductInput, json),
    actor,
    options,
  );
  return {
    status: r.created ? 201 : 200,
    body: r.warnings.length ? { ...r.product, warnings: r.warnings } : r.product,
  };
});

export const PATCH = signed('products:write', async ({ params, json, actor, options }) => {
  const r = await patchProduct(
    db(),
    decodeURIComponent(params.sku!),
    parse(ProductPatch, json),
    actor,
    options,
  );
  return {
    status: 200,
    body: r.warnings.length ? { ...r.product, warnings: r.warnings } : r.product,
  };
});

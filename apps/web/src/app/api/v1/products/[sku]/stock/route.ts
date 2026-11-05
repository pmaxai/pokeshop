import { parse, StockChange } from '@pokeshop/core/api-schemas';
import { changeStock } from '@pokeshop/core/products';
import { signed } from '@/server/signed-api';
import { db } from '@/server/config';

export const dynamic = 'force-dynamic';

export const POST = signed('stock:write', async ({ params, json, actor }) => ({
  status: 200,
  body: await changeStock(db(), decodeURIComponent(params.sku!), parse(StockChange, json), actor),
}));

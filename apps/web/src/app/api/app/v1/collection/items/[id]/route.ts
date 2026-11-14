import { NextResponse, type NextRequest } from 'next/server';
import { deleteItem, itemJson, updateItem } from '@pokeshop/core/collection';
import { db } from '@/server/config';
import { apiError, appLocale, appPortal, jsonBody, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const idOf = async (ctx: Ctx) => {
  const n = Number((await ctx.params).id);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** PATCH /api/app/v1/collection/items/{id} */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const a = await appPortal(req);
  if (!a.ok) return a.response;
  const id = await idOf(ctx);
  const b = await jsonBody(req);
  if (!id) return apiError(404, 'not_found', 'No such item.');
  if (!b) return apiError(400, 'invalid_request', 'The body must be a JSON object.');
  const r = await updateItem(db(), a.account.id, id, b, appLocale(a));
  if (!r) return apiError(404, 'not_found', 'No such item.');
  if (!r.ok) return apiError(400, 'invalid_request', 'Check the fields.', { fields: r.errors });
  return ok(itemJson(r.item));
}

/** DELETE /api/app/v1/collection/items/{id} */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const a = await appPortal(req);
  if (!a.ok) return a.response;
  const id = await idOf(ctx);
  if (id) await deleteItem(db(), a.account.id, id);
  return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

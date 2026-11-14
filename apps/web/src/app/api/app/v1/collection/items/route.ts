import type { NextRequest } from 'next/server';
import { addItem, itemJson, syncItems } from '@pokeshop/core/collection';
import { db } from '@/server/config';
import { apiError, appLocale, appPortal, jsonBody, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/** GET /api/app/v1/collection/items – the collection, page by page, with deletions since a time. */
export async function GET(req: NextRequest) {
  const a = await appPortal(req);
  if (!a.ok) return a.response;
  const sp = req.nextUrl.searchParams;
  const since = sp.get('updated_since');
  const sinceDate = since ? new Date(since) : null;
  const limit = Number(sp.get('limit') ?? 200);
  const fields: Record<string, string> = {};
  if (sinceDate && Number.isNaN(sinceDate.getTime())) fields.updated_since = 'invalid';
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) fields.limit = 'invalid';
  if (Object.keys(fields).length)
    return apiError(400, 'invalid_request', 'Check the query.', { fields });
  const now = new Date();
  const r = await syncItems(db(), a.account.id, {
    updatedSince: sinceDate,
    cursor: sp.get('cursor'),
    limit,
    locale: appLocale(a),
  });
  return ok({
    items: r.items.map((i) =>
      'deleted' in i
        ? { id: i.id, deleted: true, updated_at: i.updatedAt.toISOString() }
        : itemJson(i),
    ),
    next_cursor: r.nextCursor,
    server_time: now.toISOString(),
  });
}

/** POST /api/app/v1/collection/items – add a card (client_ref makes it safe to repeat). */
export async function POST(req: NextRequest) {
  const a = await appPortal(req);
  if (!a.ok) return a.response;
  const b = await jsonBody(req);
  if (!b) return apiError(400, 'invalid_request', 'The body must be a JSON object.');
  const clientRef = typeof b.client_ref === 'string' ? b.client_ref : null;
  if (!clientRef)
    return apiError(400, 'invalid_request', 'client_ref is required.', {
      fields: { client_ref: 'required' },
    });
  const r = await addItem(db(), a.account.id, b, {
    source: 'app',
    clientRef,
    merge: b.merge !== false,
    locale: appLocale(a),
  });
  if (!r.ok) return apiError(400, 'invalid_request', 'Check the fields.', { fields: r.errors });
  return ok(itemJson(r.item), r.created ? 201 : 200);
}

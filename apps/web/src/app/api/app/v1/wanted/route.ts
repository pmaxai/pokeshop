import type { NextRequest } from 'next/server';
import { addWanted, listWanted, wantedJson } from '@pokeshop/core/wanted';
import { db } from '@/server/config';
import { apiError, appLocale, appPortal, jsonBody, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/** GET /api/app/v1/wanted – the open missing cards, newest first. */
export async function GET(req: NextRequest) {
  const a = await appPortal(req);
  if (!a.ok) return a.response;
  const list = await listWanted(db(), a.account.id, appLocale(a));
  return ok({ items: list.map(wantedJson) });
}

/** POST /api/app/v1/wanted – put a card on the list (client_ref makes it safe to repeat). */
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
  const r = await addWanted(db(), a.account.id, b, { clientRef, locale: appLocale(a) });
  if (!r.ok) return apiError(400, 'invalid_request', 'Check the fields.', { fields: r.errors });
  return ok(wantedJson(r.wanted), r.created ? 201 : 200);
}

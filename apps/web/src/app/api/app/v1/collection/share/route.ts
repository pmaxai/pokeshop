import { NextResponse, type NextRequest } from 'next/server';
import {
  appShare,
  ensureAppShare,
  revokePublicShares,
  shareJson,
  type AppShare,
} from '@pokeshop/core/collection';
import { config, db } from '@/server/config';
import { apiError, appPortal, jsonBody, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

// The Share button in the app: the collection's public link (the whole collection, with prices),
// made on request, and Make private, which switches off every public link of the account.

const body = (s: AppShare, locale: 'de' | 'en') => ({
  public: s.share ? shareJson(s.share, config.baseUrl, locale) : null,
  other_public: s.otherPublic,
});

/** GET /api/app/v1/collection/share – the app's link (or null) and the other public links. */
export async function GET(req: NextRequest) {
  const a = await appPortal(req);
  if (!a.ok) return a.response;
  return ok(body(await appShare(db(), a.account.id), a.account.locale));
}

/** POST /api/app/v1/collection/share – the app's link, made if there is none (201) or not (200). */
export async function POST(req: NextRequest) {
  const a = await appPortal(req);
  if (!a.ok) return a.response;
  const b = (await jsonBody(req)) ?? {};
  // links without prices are made in the portal
  if (b.show_prices !== undefined && b.show_prices !== true) {
    return apiError(400, 'invalid_request', 'The app shares the collection with prices.', {
      fields: { show_prices: 'invalid' },
    });
  }
  const r = await ensureAppShare(db(), a.account.id);
  return ok(body(r, a.account.locale), r.created ? 201 : 200);
}

/** DELETE /api/app/v1/collection/share – Make private: every public link stops; personal ones stay. */
export async function DELETE(req: NextRequest) {
  const a = await appPortal(req);
  if (!a.ok) return a.response;
  await revokePublicShares(db(), a.account.id);
  return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

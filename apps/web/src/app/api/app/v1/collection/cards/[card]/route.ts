import type { NextRequest } from 'next/server';
import { itemJson, itemsOfCard } from '@pokeshop/core/collection';
import { db } from '@/server/config';
import { appLocale, appPortal, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/** GET /api/app/v1/collection/cards/{card_id} – the customer's lines of one card. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ card: string }> }) {
  const a = await appPortal(req);
  if (!a.ok) return a.response;
  const card = decodeURIComponent((await ctx.params).card).slice(0, 80);
  const items = await itemsOfCard(db(), a.account.id, card, appLocale(a));
  return ok({ items: items.map(itemJson) });
}

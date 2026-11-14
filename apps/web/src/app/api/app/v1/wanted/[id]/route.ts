import { NextResponse, type NextRequest } from 'next/server';
import { removeWanted } from '@pokeshop/core/wanted';
import { db } from '@/server/config';
import { appPortal } from '@/server/app-api';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** DELETE /api/app/v1/wanted/{id} – take a card off the list (also when already gone). */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const a = await appPortal(req);
  if (!a.ok) return a.response;
  const n = Number((await ctx.params).id);
  if (Number.isSafeInteger(n) && n > 0) await removeWanted(db(), a.account.id, n);
  return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

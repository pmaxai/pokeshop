import type { NextRequest } from 'next/server';
import { listBinders } from '@pokeshop/core/collection';
import { db } from '@/server/config';
import { appPortal, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/** GET /api/app/v1/collection/binders */
export async function GET(req: NextRequest) {
  const a = await appPortal(req);
  if (!a.ok) return a.response;
  const binders = await listBinders(db(), a.account.id);
  return ok({ binders: binders.map((b) => ({ id: b.id, name: b.name })) });
}

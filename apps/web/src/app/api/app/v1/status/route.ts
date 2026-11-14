import type { NextRequest } from 'next/server';
import { appStatus } from '@pokeshop/core/devices';
import { config, db } from '@/server/config';
import { appAuth, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/** GET /api/app/v1/status – what the app may do, and until when offline. */
export async function GET(req: NextRequest) {
  const a = await appAuth(req);
  if (!a.ok) return a.response;
  return ok(await appStatus(db(), a.account, a.device, { baseUrl: config.baseUrl }));
}

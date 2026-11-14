import type { NextRequest } from 'next/server';
import { createTransferCode, formatCode, pairUrl } from '@pokeshop/core/devices';
import { config, db } from '@/server/config';
import { appAuth, ok } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/** POST /api/app/v1/transfer – a QR code that moves this device's slot to a new phone. */
export async function POST(req: NextRequest) {
  const a = await appAuth(req);
  if (!a.ok) return a.response;
  const t = await createTransferCode(db(), a.device);
  return ok(
    {
      code: formatCode(t.code),
      url: pairUrl(config.baseUrl, t.code),
      expires_at: t.expiresAt.toISOString(),
    },
    201,
  );
}

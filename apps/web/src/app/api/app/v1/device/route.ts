import { NextResponse, type NextRequest } from 'next/server';
import { endDevice } from '@pokeshop/core/devices';
import { db } from '@/server/config';
import { appAuth } from '@/server/app-api';

export const dynamic = 'force-dynamic';

/** DELETE /api/app/v1/device – the app disconnects itself; the slot is free again. */
export async function DELETE(req: NextRequest) {
  const a = await appAuth(req);
  if (!a.ok) return a.response;
  await endDevice(db(), a.account.id, a.device.publicId, 'disconnected');
  return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

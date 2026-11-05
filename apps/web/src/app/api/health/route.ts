import { NextResponse } from 'next/server';
import { db } from '@/server/config';

export const dynamic = 'force-dynamic';

/** Container health check: the app is up and the database answers. */
export async function GET() {
  try {
    await db()`SELECT 1`;
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ ok: false, error: 'database' }, { status: 503 });
  }
}

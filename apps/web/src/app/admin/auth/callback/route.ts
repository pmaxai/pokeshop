import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';
import { finishEntraLogin } from '@/server/admin-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  if (q.get('error')) redirect('/admin/login?err=cancelled');
  const r = await finishEntraLogin(q.get('code'), q.get('state'));
  redirect(r.ok ? '/admin' : `/admin/login?err=${r.reason}`);
}

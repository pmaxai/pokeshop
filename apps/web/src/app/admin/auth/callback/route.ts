import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';
import { entraAuthorizeError, finishEntraLogin } from '@/server/admin-auth';

export const dynamic = 'force-dynamic';

const back = (reason: string, code?: number) =>
  `/admin/login?err=${reason}${code ? `&code=${code}` : ''}`;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const error = q.get('error');
  if (error) {
    const r = entraAuthorizeError(error, q.get('error_description'));
    redirect(back(r.reason, r.code));
  }
  const r = await finishEntraLogin(q.get('code'), q.get('state'));
  redirect(r.ok ? '/admin' : back(r.reason, r.code));
}

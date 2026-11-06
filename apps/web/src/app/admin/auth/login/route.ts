import { redirect } from 'next/navigation';
import { startEntraLogin } from '@/server/admin-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const r = await startEntraLogin();
  if ('problem' in r)
    redirect(r.problem === 'missing' ? '/admin/login?err=entra' : `/admin/login?err=${r.problem}`);
  redirect(r.url.toString());
}

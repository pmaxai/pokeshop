import { redirect } from 'next/navigation';
import { entraConfigured, startEntraLogin } from '@/server/admin-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!entraConfigured()) redirect('/admin/login?err=entra');
  redirect((await startEntraLogin()).toString());
}

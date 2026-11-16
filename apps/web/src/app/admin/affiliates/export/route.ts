import { NextResponse, type NextRequest } from 'next/server';
import { affiliateCsv, affiliateRegistrations } from '@pokeshop/core/affiliates';
import { config, db } from '@/server/config';
import { currentAdmin } from '@/server/admin-auth';
import { periodOf } from '../period';

export const dynamic = 'force-dynamic';

/**
 * Admin: every affiliate registration of a period (all influencers) as CSV, for the payouts.
 * ?from=2026-11-01&to=2026-11-30 (both days included, Vienna time).
 */
export async function GET(req: NextRequest) {
  if (!(await currentAdmin())) return NextResponse.redirect(`${config.baseUrl}/admin/login`, 303);
  const p = periodOf(req.nextUrl.searchParams.get('from'), req.nextUrl.searchParams.get('to'));
  const csv = affiliateCsv(await affiliateRegistrations(db(), { from: p.from, to: p.to }));
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="Affiliates-${p.fromDay}-bis-${p.toDay}.csv"`,
      'cache-control': 'private, no-store',
    },
  });
}

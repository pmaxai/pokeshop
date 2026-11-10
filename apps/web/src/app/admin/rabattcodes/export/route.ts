import { NextResponse, type NextRequest } from 'next/server';
import { config, db } from '@/server/config';
import { currentAdmin } from '@/server/admin-auth';

export const dynamic = 'force-dynamic';

/** Admin: the codes of a campaign as CSV (to print on flyers or send to friends). */
export async function GET(req: NextRequest) {
  if (!(await currentAdmin())) return NextResponse.redirect(`${config.baseUrl}/admin/login`, 303);
  const campaign = req.nextUrl.searchParams.get('campaign') ?? '';
  const rows = await db()<{ code: string; active: boolean; used: number }[]>`
    SELECT d.code, d.active,
           (SELECT count(*) FROM discount_code_uses u WHERE u.code_id = d.id AND u.status = 'used')::int AS used
      FROM discount_codes d WHERE d.campaign = ${campaign} ORDER BY d.id`;
  const lines = [
    'Code;Aktiv;Eingelöst',
    ...rows.map((r) => `${r.code};${r.active ? 'ja' : 'nein'};${r.used}`),
  ];
  const safe = campaign.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'Codes';
  return new NextResponse(`﻿${lines.join('\r\n')}\r\n`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="Rabattcodes-${safe}.csv"`,
      'cache-control': 'private, no-store',
    },
  });
}

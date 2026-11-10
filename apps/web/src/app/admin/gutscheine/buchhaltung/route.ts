import { NextResponse, type NextRequest } from 'next/server';
import { voucherLedger } from '@pokeshop/core/vouchers';
import { config, db } from '@/server/config';
import { currentAdmin } from '@/server/admin-auth';

export const dynamic = 'force-dynamic';

const KIND: Record<string, string> = {
  issued: 'Ausgestellt',
  redeemed: 'Eingelöst',
  released: 'Zurück (nicht bezahlt)',
  restored: 'Zurückgebucht (Erstattung)',
  cancelled: 'Storniert',
};

/** What each movement means for the books, by the voucher's origin. */
function meaning(kind: string, origin: string): string {
  if (origin === 'sold') {
    if (kind === 'issued') return 'Verkauf: Geld erhalten, Verbindlichkeit (kein Umsatz)';
    if (kind === 'redeemed') return 'Zahlung einer Rechnung mit Gutschein';
    if (kind === 'cancelled') return 'Storno mit Erstattung des Kaufpreises';
    return 'Verbindlichkeit wieder offen';
  }
  if (kind === 'issued') return 'Geschenkt: keine Einnahme';
  if (kind === 'redeemed') return 'Rabatt auf der Rechnung';
  return 'Rabatt nicht genutzt';
}

const csv = (v: unknown) => {
  const s = String(v ?? '');
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Admin: voucher movements of a period as CSV (semicolons, Excel in German opens it). */
export async function GET(req: NextRequest) {
  if (!(await currentAdmin())) return NextResponse.redirect(`${config.baseUrl}/admin/login`, 303);
  const p = req.nextUrl.searchParams;
  const ok = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
  const from = ok(p.get('from'));
  const to = ok(p.get('to'));
  if (!from || !to) return NextResponse.json({ error: 'from_to' }, { status: 400 });
  const rows = await voucherLedger(
    db(),
    new Date(`${from}T00:00:00+01:00`),
    new Date(new Date(`${to}T00:00:00+01:00`).getTime() + 86_400_000),
  );
  const euro = (c: number) => (c / 100).toFixed(2).replace('.', ',');
  const fmt = new Intl.DateTimeFormat('de-AT', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Vienna',
  });
  const lines = [
    [
      'Datum',
      'Gutschein',
      'Herkunft',
      'Bewegung',
      'Bedeutung',
      'Bestellung',
      'Betrag (€)',
      'Restwert danach (€)',
    ].join(';'),
    ...rows.map((r) =>
      [
        fmt.format(r.at),
        r.code,
        r.origin === 'sold' ? 'verkauft (bezahlt)' : 'geschenkt (ohne Einnahme)',
        KIND[r.kind] ?? r.kind,
        meaning(r.kind, r.origin),
        r.order_number ?? '',
        euro(r.amount_cents),
        euro(r.balance_after),
      ]
        .map(csv)
        .join(';'),
    ),
  ];
  return new NextResponse(`﻿${lines.join('\r\n')}\r\n`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="Gutscheine-${from}-bis-${to}.csv"`,
      'cache-control': 'private, no-store',
    },
  });
}

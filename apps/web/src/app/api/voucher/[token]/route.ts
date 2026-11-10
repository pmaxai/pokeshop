import { NextResponse, type NextRequest } from 'next/server';
import { renderVoucherPdf } from '@pokeshop/core/pdf';
import { config, db } from '@/server/config';

export const dynamic = 'force-dynamic';

/** The bought voucher as PDF, for whoever has the order's secret link (the buyer). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return new NextResponse(null, { status: 404 });
  const [v] = await db()<
    {
      code: string;
      value_cents: number;
      recipient_name: string | null;
      message: string | null;
      expires_at: Date | null;
      locale: 'de' | 'en';
    }[]
  >`
    SELECT v.code, v.value_cents, v.recipient_name, v.message, v.expires_at, o.locale
      FROM orders o JOIN order_gift_vouchers g ON g.order_id = o.id
      JOIN vouchers v ON v.id = g.voucher_id
     WHERE o.lookup_token = ${token} AND o.kind = 'voucher' AND v.status <> 'cancelled'`;
  if (!v) return new NextResponse(null, { status: 404 });
  const locale = req.nextUrl.searchParams.get('l') === 'en' ? 'en' : v.locale;
  const pdf = await renderVoucherPdf({
    code: v.code,
    valueCents: v.value_cents,
    recipientName: v.recipient_name,
    message: v.message,
    expiresAt: v.expires_at,
    locale,
    shopUrl: config.baseUrl.replace(/^https?:\/\//, ''),
  });
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${locale === 'en' ? 'Gift-voucher' : 'Gutschein'}-${v.code}.pdf"`,
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

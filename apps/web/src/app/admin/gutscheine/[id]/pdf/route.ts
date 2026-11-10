import { NextResponse, type NextRequest } from 'next/server';
import { renderVoucherPdf } from '@pokeshop/core/pdf';
import { config, db } from '@/server/config';
import { currentAdmin } from '@/server/admin-auth';

export const dynamic = 'force-dynamic';

/** Admin: any voucher as PDF (to hand over a promotional one, or send a copy again). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!(await currentAdmin())) return NextResponse.redirect(`${config.baseUrl}/admin/login`, 303);
  const id = Number((await ctx.params).id);
  const [v] = Number.isSafeInteger(id)
    ? await db()<
        {
          code: string;
          value_cents: number;
          recipient_name: string | null;
          message: string | null;
          expires_at: Date | null;
        }[]
      >`SELECT code, value_cents, recipient_name, message, expires_at FROM vouchers WHERE id = ${id}`
    : [];
  if (!v) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const pdf = await renderVoucherPdf({
    code: v.code,
    valueCents: v.value_cents,
    recipientName: v.recipient_name,
    message: v.message,
    expiresAt: v.expires_at,
    locale: 'de',
    shopUrl: config.baseUrl.replace(/^https?:\/\//, ''),
  });
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="Gutschein-${v.code}.pdf"`,
      'cache-control': 'private, no-store',
    },
  });
}

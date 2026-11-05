import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { config, db } from '@/server/config';
import { currentAdmin } from '@/server/admin-auth';

export const dynamic = 'force-dynamic';

/** Invoice or credit note PDF for signed-in staff (rendered by the worker). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!(await currentAdmin())) return NextResponse.redirect(`${config.baseUrl}/admin/login`, 303);
  const id = Number((await ctx.params).id);
  const [d] = Number.isSafeInteger(id)
    ? await db()<{ number: string; kind: string; pdf_key: string | null }[]>`
        SELECT number, kind, pdf_key FROM documents WHERE id = ${id}`
    : [];
  if (!d?.pdf_key) return NextResponse.json({ error: 'not_rendered' }, { status: 404 });
  const path = normalize(join(config.mediaDir, d.pdf_key));
  if (!path.startsWith(normalize(config.mediaDir)))
    return NextResponse.json({ error: 'bad_path' }, { status: 400 });
  const pdf = await readFile(path).catch(() => null);
  if (!pdf) return NextResponse.json({ error: 'missing' }, { status: 404 });
  const name = `${d.kind === 'invoice' ? 'Rechnung' : 'Rechnungskorrektur'}-${d.number}.pdf`;
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${name}"`,
      'cache-control': 'private, no-store',
    },
  });
}

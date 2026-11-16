import { NextResponse, type NextRequest } from 'next/server';
import { affiliateLinkByCode, registerAffiliate } from '@pokeshop/core/affiliates';
import { config, db } from '@/server/config';
import { currentAccount } from '@/server/account';
import { AFF_COOKIE, AFF_COOKIE_DAYS } from '@/server/affiliate';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ code: string }> };

/**
 * An influencer's link: /r/<code>. Keeps the code in a cookie for 90 days (it gives the discount
 * at the first subscription and goes into the Play link as install referrer) and opens the app
 * page in the visitor's language. A signed-in visitor is registered for the link at once.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { code } = await ctx.params;
  const link = await affiliateLinkByCode(db(), decodeURIComponent(code));
  const de = /^\s*de\b/i.test(req.headers.get('accept-language') ?? '');
  const target = new URL(de ? '/de/app' : '/app', config.baseUrl);
  if (!link) return NextResponse.redirect(target, 302);
  const res = NextResponse.redirect(target, 302);
  res.cookies.set(AFF_COOKIE, link.code, {
    maxAge: AFF_COOKIE_DAYS * 86400,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.baseUrl.startsWith('https://'),
    path: '/',
  });
  res.headers.set('cache-control', 'private, no-store');
  const account = await currentAccount();
  if (account)
    await registerAffiliate(db(), { accountId: account.id, code: link.code, via: 'link' });
  return res;
}

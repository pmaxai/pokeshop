import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse, type NextRequest } from 'next/server';
import { appSales, APP_NAME, licenseOrderByToken, recordDownload } from '@pokeshop/core/licenses';
import { config, db, licenseServiceConfigured } from '@/server/config';

export const dynamic = 'force-dynamic';

/**
 * The APK for a paid licence order (its secret token is the credential). Always the newest
 * upload, so the same link in the e-mail keeps working. Once the app is in the Play Store,
 * the link leads there.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const order = await licenseOrderByToken(db(), token);
  if (!order?.canDownload) {
    return new NextResponse('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  const sales = await appSales(db(), licenseServiceConfigured());
  if (sales.playStoreUrl) return NextResponse.redirect(sales.playStoreUrl, 302);
  const release = sales.release;
  if (!release) return new NextResponse('Not available yet', { status: 503 });

  const root = resolve(config.mediaDir);
  const path = resolve(join(root, release.storageKey));
  if (!path.startsWith(root + '/')) return new NextResponse('Not found', { status: 404 });
  const info = await stat(path).catch(() => null);
  if (!info) {
    console.error(`[app download] file missing: ${release.storageKey}`);
    return new NextResponse('Not available', { status: 503 });
  }
  await recordDownload(db(), order.id);
  const name = `${APP_NAME.replace(/\s+/g, '-')}-${release.version.replace(/[^0-9A-Za-z.-]/g, '')}.apk`;
  return new NextResponse(Readable.toWeb(createReadStream(path)) as ReadableStream, {
    headers: {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': String(info.size),
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

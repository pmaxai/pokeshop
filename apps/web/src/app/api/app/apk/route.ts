import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { APP_NAME, currentRelease } from '@pokeshop/core/licenses';
import { accountEntitlements } from '@pokeshop/core/subscriptions';
import { config, db } from '@/server/config';
import { currentAccount } from '@/server/account';

export const dynamic = 'force-dynamic';

/** The newest APK, for logged-in customers with a running subscription. */
export async function GET() {
  const account = await currentAccount();
  const notFound = () =>
    new NextResponse('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  if (!account) return notFound();
  if (!(await accountEntitlements(db(), account)).active) return notFound();
  const release = await currentRelease(db());
  if (!release) return new NextResponse('Not available yet', { status: 503 });
  const root = resolve(config.mediaDir);
  const path = resolve(join(root, release.storageKey));
  if (!path.startsWith(root + '/')) return notFound();
  const info = await stat(path).catch(() => null);
  if (!info) {
    console.error(`[app download] file missing: ${release.storageKey}`);
    return new NextResponse('Not available', { status: 503 });
  }
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

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';
import { appPackBlob, appPackUrlKey, checkAppPackUrl } from '@pokeshop/core/app-pack';
import { apiMasterKey, config } from '@/server/config';
import { apiError } from '@/server/app-api';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ sha: string; name: string }> };

/**
 * A file of the data pack, behind a URL from GET /api/app/v1/pack (signed, valid one hour; no
 * device token needed, so any downloader can fetch it). Supports a single byte range, so an
 * interrupted download can go on where it stopped.
 */
async function serve(req: NextRequest, ctx: Ctx, head: boolean) {
  const { sha, name: rawName } = await ctx.params;
  const name = decodeURIComponent(rawName);
  const q = req.nextUrl.searchParams;
  const check = checkAppPackUrl(appPackUrlKey(apiMasterKey()), {
    sha256: sha,
    name,
    expires: q.get('expires'),
    sig: q.get('sig'),
  });
  if (check === 'invalid') return apiError(403, 'invalid_url', 'This download URL is not valid.');
  if (check === 'expired') {
    return apiError(410, 'url_expired', 'This download URL has expired. Ask /pack for a new one.');
  }
  const path = appPackBlob(config.mediaDir, sha);
  const info = path ? await stat(path).catch(() => null) : null;
  if (!path || !info?.isFile()) {
    return apiError(410, 'url_expired', 'This version of the pack is gone. Ask /pack again.');
  }
  const size = info.size;
  const headers: Record<string, string> = {
    'content-type': name === 'pack.json' ? 'application/json' : 'application/octet-stream',
    'content-disposition': `attachment; filename="${name}"`,
    'accept-ranges': 'bytes',
    etag: `"${sha}"`,
    'cache-control': 'private, max-age=3600, immutable',
  };
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.get('range');
  const ifRange = req.headers.get('if-range');
  if (range && (!ifRange || ifRange === `"${sha}"`)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(Number(m[2]), size - 1);
      } else {
        start = Math.max(0, size - Number(m[2]));
      }
      if (start > end || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { ...headers, 'content-range': `bytes */${size}` },
        });
      }
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
  }
  // Next.js sends route responses chunked and drops Content-Length; the size is in /pack and,
  // for a range, in Content-Range.
  if (head) return new Response(null, { status, headers });
  const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
  return new Response(body, { status, headers });
}

export const GET = (req: NextRequest, ctx: Ctx) => serve(req, ctx, false);
export const HEAD = (req: NextRequest, ctx: Ctx) => serve(req, ctx, true);

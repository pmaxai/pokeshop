import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '@/server/config';

export const dynamic = 'force-dynamic';

// Own processed scans: p/<product>/<image>-<hash>-<width>.<format>
const OWN = /^p\/\d+\/\d+-[0-9a-f]{10}-(320|640|1200)\.(webp|avif)$/;
// TCGdex card pictures and set logos, served through this server so visitors' browsers
// never contact a third party: card/<lang>/<serie>/<set>/<card>/<low|high>.webp
const CARD = /^card\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/){2,5}[A-Za-z0-9_-][A-Za-z0-9._-]*\.webp$/;
const TYPES: Record<string, string> = { webp: 'image/webp', avif: 'image/avif' };

async function exists(p: string) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

function file(body: Buffer, type: string, maxAge: number) {
  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': type,
      'Cache-Control': `public, max-age=${maxAge}${maxAge >= 31536000 ? ', immutable' : ''}`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

const notFound = () =>
  new Response('not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=300' } });

/** Neutral card back shown while TCGdex cannot be reached, so the page never shows a broken image. */
const CARD_BACK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 630 880"><rect width="630" height="880" rx="30" fill="#dce0e8"/><rect x="24" y="24" width="582" height="832" rx="20" fill="#eef0f4"/><circle cx="315" cy="440" r="92" fill="none" stroke="#c4cad6" stroke-width="16"/><path d="M223 440h184" stroke="#c4cad6" stroke-width="16"/></svg>`;
const placeholder = () =>
  new Response(CARD_BACK, {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=600' },
  });

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const rel = (await params).path.join('/');
  if (rel.split('/').some((s) => s === '..' || s === '.')) return notFound();

  if (OWN.test(rel)) {
    const path = join(config.mediaDir, rel);
    if (!(await exists(path))) return notFound();
    return file(await readFile(path), TYPES[rel.split('.').pop()!]!, 31536000);
  }

  if (CARD.test(rel)) {
    const cached = join(config.mediaDir, 'card-cache', rel.slice('card/'.length));
    if (await exists(cached)) return file(await readFile(cached), 'image/webp', 2592000);
    if (await exists(`${cached}.missing`)) {
      const s = await stat(`${cached}.missing`);
      if (Date.now() - s.mtimeMs < 86_400_000) return placeholder();
    }
    try {
      const res = await fetch(`https://assets.tcgdex.net/${rel.slice('card/'.length)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      await mkdir(dirname(cached), { recursive: true });
      if (res.status === 404) {
        await writeFile(`${cached}.missing`, '');
        return placeholder();
      }
      const type = res.headers.get('content-type') ?? '';
      const body = Buffer.from(await res.arrayBuffer());
      if (!res.ok || !type.startsWith('image/') || body.length > 3 * 1024 * 1024)
        return placeholder();
      const tmp = `${cached}.${randomUUID()}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, cached);
      return file(body, 'image/webp', 2592000);
    } catch {
      return placeholder();
    }
  }

  return notFound();
}

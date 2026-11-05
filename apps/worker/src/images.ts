import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Db } from '@pokeshop/core/db';
import { isPublicAddress } from '@pokeshop/core/net-guard';

export const IMAGE_WIDTHS = [320, 640, 1200] as const;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ATTEMPTS = 4;

/** Downloads an https image without following redirects into private networks. */
export function safeDownload(url: string, maxBytes = MAX_BYTES, redirects = 2): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return reject(new PermanentError('invalid URL'));
    }
    if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password) {
      return reject(new PermanentError('only plain https URLs on port 443 are allowed'));
    }
    // Node connects to IP-literal hosts without calling `lookup`, so check those here.
    const literal = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !isPublicAddress(literal)) {
      return reject(new PermanentError(`address ${literal} is not public`));
    }
    const req = request(
      u,
      {
        method: 'GET',
        timeout: 15_000,
        headers: { 'User-Agent': 'pokemonkarten.at image fetcher', Accept: 'image/*' },
        // Every address the connection may use is checked, so DNS cannot point it inside.
        lookup: (host, opts, cb) =>
          lookup(host, { ...opts, all: true }, (err, addrs) => {
            if (err) return (cb as (e: Error) => void)(err);
            const list = addrs as { address: string; family: number }[];
            const bad = list.find((a) => !isPublicAddress(a.address));
            if (bad || list.length === 0) {
              return (cb as (e: Error) => void)(
                new PermanentError(`address ${bad?.address ?? '?'} is not public`),
              );
            }
            if ((opts as { all?: boolean }).all)
              return (cb as (e: null, a: typeof list) => void)(null, list);
            (cb as (e: null, a: string, f: number) => void)(
              null,
              list[0]!.address,
              list[0]!.family,
            );
          }),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(
            safeDownload(new URL(res.headers.location, u).toString(), maxBytes, redirects - 1),
          );
        }
        if (status !== 200) {
          res.resume();
          return reject(
            status === 404 || status === 410
              ? new PermanentError(`HTTP ${status}`)
              : new Error(`HTTP ${status}`),
          );
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new PermanentError('image larger than 10 MB'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('download timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** Errors that will not go away by retrying (bad URL, not an image …). */
export class PermanentError extends Error {}

export type Rendition = { width: number; webp: Buffer; avif: Buffer };

/** Resizes to the shop sizes as WebP and AVIF; rotates by EXIF and drops metadata. */
export async function renderImage(
  input: Buffer,
): Promise<{ width: number; height: number; renditions: Rendition[] }> {
  let meta;
  try {
    meta = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
  } catch {
    throw new PermanentError('not a readable image');
  }
  if (!meta.format || !['jpeg', 'png', 'webp', 'avif', 'heif', 'tiff'].includes(meta.format)) {
    throw new PermanentError(`unsupported image format ${meta.format ?? '?'}`);
  }
  const renditions: Rendition[] = [];
  for (const width of IMAGE_WIDTHS) {
    const base = sharp(input, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width, withoutEnlargement: true, fit: 'inside' });
    const [webp, avif] = await Promise.all([
      base.clone().webp({ quality: 82 }).toBuffer(),
      base.clone().avif({ quality: 55 }).toBuffer(),
    ]);
    renditions.push({ width, webp, avif });
  }
  const rotated = (meta.orientation ?? 1) >= 5;
  return {
    width: (rotated ? meta.height : meta.width) ?? 0,
    height: (rotated ? meta.width : meta.height) ?? 0,
    renditions,
  };
}

type PendingImage = { id: number; product_id: number; source_url: string; attempts: number };

/**
 * Processes one pending product image: download (or read the upload), render,
 * write files under MEDIA_DIR/p/<product>/, mark ready. Returns false when idle.
 */
export async function processNextImage(
  db: Db,
  mediaDir: string,
  download: (url: string) => Promise<Buffer> = safeDownload,
): Promise<boolean> {
  const [img] = await db<PendingImage[]>`
    UPDATE product_images SET attempts = attempts + 1, next_attempt_at = now() + interval '10 minutes'
     WHERE id = (SELECT id FROM product_images WHERE status = 'pending' AND next_attempt_at <= now()
                  ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id, product_id, source_url, attempts`;
  if (!img) return false;

  let uploadPath: string | null = null;
  try {
    let bytes: Buffer;
    if (img.source_url.startsWith('upload:')) {
      const rel = normalize(img.source_url.slice('upload:'.length));
      if (rel.startsWith('..') || !rel.startsWith('incoming/'))
        throw new PermanentError('bad upload path');
      uploadPath = join(mediaDir, rel);
      bytes = await readFile(uploadPath);
    } else {
      bytes = await download(img.source_url);
    }
    const out = await renderImage(bytes);
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 10);
    const key = `p/${img.product_id}/${img.id}-${hash}`;
    for (const r of out.renditions) {
      const file = join(mediaDir, `${key}-${r.width}`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.webp`, r.webp);
      await writeFile(`${file}.avif`, r.avif);
    }
    await db`UPDATE product_images SET status = 'ready', storage_key = ${key}, width = ${out.width},
                                       height = ${out.height}, error = NULL WHERE id = ${img.id}`;
    if (uploadPath) await rm(uploadPath, { force: true });
  } catch (e) {
    const permanent = e instanceof PermanentError || img.attempts >= MAX_ATTEMPTS;
    const msg = (e as Error).message.slice(0, 500);
    if (permanent) {
      await db`UPDATE product_images SET status = 'failed', error = ${msg} WHERE id = ${img.id}`;
    } else {
      await db`UPDATE product_images SET error = ${msg},
                 next_attempt_at = now() + make_interval(mins => ${2 ** img.attempts}) WHERE id = ${img.id}`;
    }
    console.warn(`[images] ${img.id}: ${msg}${permanent ? ' (gave up)' : ' (will retry)'}`);
  }
  return true;
}

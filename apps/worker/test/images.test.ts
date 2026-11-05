import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { freshDatabase } from '../../../packages/core/test/integration/helpers.ts';
import type { Sql } from '@pokeshop/core/db';
import { processNextImage, safeDownload } from '../src/images.ts';

let sql: Sql;
let drop: () => Promise<void>;
let media: string;
let productId: number;

before(async () => {
  ({ sql, drop } = await freshDatabase());
  media = await mkdtemp(join(tmpdir(), 'pokeshop-media-'));
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (sku, slug, set_code, card_number, name_de, name_en, card_language, finish, condition)
    VALUES ('t-1-DE-NM-H', 't-1', 't', '1', 'T', 'T', 'DE', 'holo', 'NM') RETURNING id`;
  productId = p!.id;
});
after(async () => {
  await drop();
  await rm(media, { recursive: true, force: true });
});

const cardScan = () =>
  sharp({
    create: { width: 1500, height: 2100, channels: 3, background: { r: 200, g: 40, b: 30 } },
  })
    .jpeg()
    .toBuffer();

test('an uploaded scan becomes WebP and AVIF in three sizes, the upload is removed', async () => {
  await mkdir(join(media, 'incoming'), { recursive: true });
  await writeFile(join(media, 'incoming', 'a.jpg'), await cardScan());
  const [img] = await sql<{ id: number }[]>`
    INSERT INTO product_images (product_id, source_url) VALUES (${productId}, 'upload:incoming/a.jpg') RETURNING id`;
  assert.equal(await processNextImage(sql, media), true);
  const [row] =
    await sql`SELECT status, storage_key, width, height FROM product_images WHERE id = ${img!.id}`;
  assert.equal(row?.status, 'ready');
  assert.equal(row?.width, 1500);
  const files = (await readdir(join(media, 'p', String(productId)))).sort();
  assert.equal(files.length, 6);
  assert.ok(
    files.some((f) => f.endsWith('-1200.webp')) && files.some((f) => f.endsWith('-320.avif')),
  );
  const big = await sharp(join(media, `${row?.storage_key}-1200.webp`)).metadata();
  assert.equal(big.width, 1200);
  await assert.rejects(stat(join(media, 'incoming', 'a.jpg')));
  assert.equal(await processNextImage(sql, media), false, 'queue empty');
});

test('a URL is fetched through the downloader; non-images fail permanently', async () => {
  const scan = await cardScan();
  await sql`INSERT INTO product_images (product_id, source_url) VALUES (${productId}, 'https://img.example/ok.jpg'),
                                                                        (${productId}, 'https://img.example/bad.txt')`;
  const fake = async (url: string) => (url.endsWith('ok.jpg') ? scan : Buffer.from('hello'));
  await processNextImage(sql, media, fake);
  await processNextImage(sql, media, fake);
  const rows =
    await sql`SELECT source_url, status, error FROM product_images WHERE source_url LIKE 'https://%' ORDER BY id`;
  assert.equal(rows[0]?.status, 'ready');
  assert.equal(rows[1]?.status, 'failed');
  assert.match(String(rows[1]?.error), /not a readable image/);
});

test('upload paths cannot leave the media folder', async () => {
  await sql`INSERT INTO product_images (product_id, source_url) VALUES (${productId}, 'upload:../../etc/passwd')`;
  await processNextImage(sql, media);
  const [row] =
    await sql`SELECT status, error FROM product_images WHERE source_url = 'upload:../../etc/passwd'`;
  assert.equal(row?.status, 'failed');
});

test('downloads refuse plain http, other ports and private addresses', async () => {
  await assert.rejects(safeDownload('http://example.com/a.jpg'), /only plain https/);
  await assert.rejects(safeDownload('https://example.com:8443/a.jpg'), /only plain https/);
  await assert.rejects(safeDownload('https://127.0.0.1/a.jpg'), /not public/);
  await assert.rejects(safeDownload('https://localhost/a.jpg'), /not public/);
});

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ImageInput, parse } from '@pokeshop/core/api-schemas';
import { ApiError, notFound } from '@pokeshop/core/errors';
import { signed } from '@/server/signed-api';
import { config, db } from '@/server/config';

export const dynamic = 'force-dynamic';

const MAX = 10 * 1024 * 1024;

/** Detects the file type from its first bytes instead of trusting the file name. */
function sniff(buf: Uint8Array): 'jpg' | 'png' | 'webp' | null {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (
    Buffer.from(buf.subarray(0, 4)).toString() === 'RIFF' &&
    Buffer.from(buf.subarray(8, 12)).toString() === 'WEBP'
  )
    return 'webp';
  return null;
}

export const POST = signed(
  'products:write',
  async ({ req, raw, json, params }) => {
    const sku = decodeURIComponent(params.sku!);
    const [product] = await db()<{ id: number }[]>`SELECT id FROM products WHERE sku = ${sku}`;
    if (!product) throw notFound();

    let role = 'front';
    let sourceUrl: string;
    const type = req.headers.get('content-type') ?? '';
    if (type.startsWith('multipart/form-data')) {
      const form = await new Request('http://local/upload', {
        method: 'POST',
        headers: { 'content-type': type },
        body: new Uint8Array(raw),
      }).formData();
      const file = form.get('file');
      if (!(file instanceof Blob))
        throw new ApiError(422, 'validation', 'multipart field "file" is missing', {
          file: 'required',
        });
      const r = form.get('role');
      if (typeof r === 'string') {
        if (!['front', 'back', 'extra'].includes(r))
          throw new ApiError(422, 'validation', 'bad role', { role: 'front, back or extra' });
        role = r;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length > MAX) throw new ApiError(413, 'too_large', 'image larger than 10 MB');
      const ext = sniff(bytes);
      if (!ext)
        throw new ApiError(422, 'validation', 'only JPEG, PNG or WebP', {
          file: 'unsupported type',
        });
      const rel = `incoming/${randomUUID()}.${ext}`;
      await mkdir(join(config.mediaDir, 'incoming'), { recursive: true });
      await writeFile(join(config.mediaDir, rel), bytes);
      sourceUrl = `upload:${rel}`;
    } else {
      const input = parse(ImageInput, json);
      role = input.role;
      sourceUrl = input.url;
    }

    const [img] = await db()<{ id: number; role: string; status: string }[]>`
      INSERT INTO product_images (product_id, role, position, source_url)
      SELECT ${product.id}, ${role}, coalesce(max(position) + 1, 0), ${sourceUrl}
        FROM product_images WHERE product_id = ${product.id}
      RETURNING id, role, status`;
    return { status: 202, body: { ...img, url: null } };
  },
  { maxBody: MAX + 64 * 1024 },
);

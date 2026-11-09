import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { NextResponse, type NextRequest } from 'next/server';
import { addRelease } from '@pokeshop/core/licenses';
import { config, db } from '@/server/config';
import { audit, currentAdmin } from '@/server/admin-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

/** APKs are big (card database inside), but not this big. */
const MAX_BYTES = 400 * 1024 * 1024;

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

/**
 * Admin › App: the APK as the raw request body (sent by the upload form's script), streamed
 * to disk. Version and notes come in headers. The newest upload is what buyers download.
 */
export async function PUT(req: NextRequest) {
  const user = await currentAdmin();
  if (!user || user.role !== 'owner') return fail(403, 'Nur der Inhaber kann die App hochladen.');
  // Same-origin only: the session cookie alone must not be enough (CSRF).
  const origin = req.headers.get('origin');
  if (!origin || new URL(origin).host !== req.headers.get('host')) {
    return fail(403, 'Ungültige Herkunft.');
  }
  const version = decodeURIComponent(req.headers.get('x-app-version') ?? '').trim();
  const notes = decodeURIComponent(req.headers.get('x-app-notes') ?? '')
    .trim()
    .slice(0, 1000);
  const fileName = decodeURIComponent(req.headers.get('x-file-name') ?? '');
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/.test(version)) {
    return fail(422, 'Bitte eine Versionsnummer angeben, z. B. 1.2.30.');
  }
  if (!/\.apk$/i.test(fileName)) return fail(422, 'Bitte eine .apk-Datei wählen.');
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) return fail(413, 'Die Datei ist größer als 400 MB.');
  if (!req.body) return fail(422, 'Keine Datei empfangen.');

  const dir = join(config.mediaDir, 'app');
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `upload-${randomBytes(8).toString('hex')}.part`);
  const hash = createHash('sha256');
  let size = 0;
  let head = Buffer.alloc(0);
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > MAX_BYTES) return cb(new Error('too_large'));
      if (head.length < 4) head = Buffer.concat([head, chunk]).subarray(0, 4);
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(req.body as import('node:stream/web').ReadableStream),
      count,
      createWriteStream(tmp),
    );
  } catch (e) {
    await rm(tmp, { force: true });
    return (e as Error).message === 'too_large'
      ? fail(413, 'Die Datei ist größer als 400 MB.')
      : fail(400, 'Upload abgebrochen.');
  }
  // An APK is a ZIP archive.
  if (size === 0 || !head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    await rm(tmp, { force: true });
    return fail(422, 'Das ist keine APK-Datei.');
  }
  const sha256 = hash.digest('hex');
  const storageKey = `app/${sha256}.apk`;
  await rename(tmp, join(config.mediaDir, storageKey));
  const release = await addRelease(db(), {
    version,
    storageKey,
    sizeBytes: size,
    sha256,
    notes: notes || null,
    uploadedBy: user.email,
  });
  await audit(user, 'app.upload', 'app_release', release.id, null, {
    version,
    size,
    sha256,
  });
  return NextResponse.json({ ok: true, version, size, sha256 });
}

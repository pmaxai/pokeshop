// The app's nightly data pack for the store editions (GET /api/app/v1/pack). Those editions
// can't get a new app every night, so they download the pack themselves – from the shop, for
// subscribers only. The worker mirrors the Data pipeline's release "data-pack" (see
// pricepack.ts) into MEDIA_DIR/app-pack: every file once, named by its SHA-256, so a file
// that did not change (the model, usually the index) is neither downloaded nor stored twice.
// The last APP_PACK_KEEP versions stay, so a download in progress survives the next night.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './db.ts';
import { downloadVerified, packUrl } from './pricepack.ts';

/** The files the app downloads; pack.json (version, checksums, model info) comes with them. */
export const APP_PACK_FILES = ['catalog.sqlite', 'index.f16', 'model.onnx', 'texture.u8'] as const;
export const APP_PACK_NAMES: readonly string[] = [...APP_PACK_FILES, 'pack.json'];
export const APP_PACK_KEEP = 3;
/** How long a download URL works. */
export const APP_PACK_URL_SECONDS = 3600;
const MAX_FILE_BYTES = 500 * 1024 * 1024;

export type AppPackFile = { name: string; size: number; sha256: string };
export type AppPack = { version: string; files: AppPackFile[]; createdAt: Date };

export const appPackDir = (mediaDir: string) => join(mediaDir, 'app-pack');
const SHA = /^[0-9a-f]{64}$/;
/** Where a file is kept (null for anything that isn't a SHA-256). */
export const appPackBlob = (mediaDir: string, sha256: string) =>
  SHA.test(sha256) ? join(appPackDir(mediaDir), sha256) : null;

export async function currentAppPack(db: Db): Promise<AppPack | null> {
  const [r] = await db<{ version: string; files: AppPackFile[]; created_at: Date }[]>`
    SELECT version, files, created_at FROM app_packs ORDER BY version DESC LIMIT 1`;
  return r ? { version: r.version, files: r.files, createdAt: r.created_at } : null;
}

type Manifest = { version: string; files: Record<string, { bytes: number; sha256: string }> };

function parseManifest(text: string): Manifest {
  let m: Partial<Manifest>;
  try {
    m = JSON.parse(text) as Partial<Manifest>;
  } catch {
    throw new Error('pack.json is not JSON');
  }
  if (typeof m.version !== 'string' || !/^[0-9A-Za-z:.+-]{1,40}$/.test(m.version)) {
    throw new Error('pack.json without a version');
  }
  for (const name of APP_PACK_FILES) {
    const f = m.files?.[name];
    if (!f || !SHA.test(f.sha256 ?? '') || !Number.isInteger(f.bytes) || f.bytes < 1) {
      throw new Error(`pack.json without ${name}`);
    }
  }
  return m as Manifest;
}

const exists = (path: string) =>
  stat(path).then(
    (s) => s.isFile(),
    () => false,
  );

export type MirrorResult =
  | { status: 'current'; version: string }
  | { status: 'mirrored'; version: string; downloaded: string[] };

/**
 * Mirrors the current release when its version is newer than the last one mirrored. Files are
 * downloaded next to their final name and checked before they get it; the version is recorded
 * only once all its files are in place.
 */
export async function mirrorAppPack(
  db: Db,
  opts: {
    mediaDir: string;
    baseUrl?: string;
    fetch?: typeof fetch;
    log?: (msg: string) => void;
    now?: Date;
  },
): Promise<MirrorResult> {
  const baseUrl = opts.baseUrl ?? packUrl();
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});
  const res = await doFetch(`${baseUrl}/pack.json`, {
    redirect: 'follow',
    headers: { Accept: 'application/json', 'User-Agent': 'overpricedcardboard.com app pack' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`pack.json: HTTP ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  const manifest = parseManifest(raw.toString('utf8'));
  const last = await currentAppPack(db);
  if (last && last.version >= manifest.version) {
    return { status: 'current', version: last.version };
  }
  const dir = appPackDir(opts.mediaDir);
  await mkdir(dir, { recursive: true });
  const files: AppPackFile[] = [];
  const downloaded: string[] = [];
  for (const name of APP_PACK_FILES) {
    const f = manifest.files[name]!;
    const path = join(dir, f.sha256);
    if (!(await exists(path))) {
      const part = `${path}.part`;
      try {
        await downloadVerified(`${baseUrl}/${name}`, part, f, doFetch, MAX_FILE_BYTES);
        await rename(part, path);
      } finally {
        await rm(part, { force: true });
      }
      downloaded.push(name);
    }
    files.push({ name, size: f.bytes, sha256: f.sha256 });
  }
  const packSha = createHash('sha256').update(raw).digest('hex');
  await writeFile(join(dir, packSha), raw);
  files.push({ name: 'pack.json', size: raw.length, sha256: packSha });
  await db`
    INSERT INTO app_packs (version, files) VALUES (${manifest.version}, ${db.json(files)})
    ON CONFLICT (version) DO UPDATE SET files = EXCLUDED.files`;
  log(`[app-pack] ${manifest.version}: downloaded ${downloaded.join(', ') || 'nothing new'}`);
  await pruneAppPacks(db, opts.mediaDir);
  return { status: 'mirrored', version: manifest.version, downloaded };
}

/** Keeps the last APP_PACK_KEEP versions and the files they use; removes the rest. */
export async function pruneAppPacks(db: Db, mediaDir: string): Promise<number> {
  await db`
    DELETE FROM app_packs WHERE version NOT IN (
      SELECT version FROM app_packs ORDER BY version DESC LIMIT ${APP_PACK_KEEP})`;
  const kept = await db<{ files: AppPackFile[] }[]>`SELECT files FROM app_packs`;
  const used = new Set(kept.flatMap((r) => r.files.map((f) => f.sha256)));
  const dir = appPackDir(mediaDir);
  let removed = 0;
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    // a .part file belongs to a download that may still be running in another worker
    if (SHA.test(entry) && !used.has(entry)) {
      await rm(join(dir, entry), { force: true });
      removed++;
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Download URLs: signed, valid APP_PACK_URL_SECONDS; the web serves the file behind them.
// ---------------------------------------------------------------------------

/** A key for the URLs only, derived from the server's master key. */
export const appPackUrlKey = (masterKey: Buffer) =>
  createHmac('sha256', masterKey).update('app-pack download urls').digest();

const signature = (key: Buffer, sha256: string, name: string, expires: number) =>
  createHmac('sha256', key).update(`${sha256}/${name}/${expires}`).digest('base64url');

export function appPackFileUrl(
  baseUrl: string,
  key: Buffer,
  file: AppPackFile,
  now = new Date(),
): string {
  const expires = Math.floor(now.getTime() / 1000) + APP_PACK_URL_SECONDS;
  const sig = signature(key, file.sha256, file.name, expires);
  return `${baseUrl}/api/app/v1/pack/files/${file.sha256}/${encodeURIComponent(file.name)}?expires=${expires}&sig=${sig}`;
}

/** Checks a download URL's parts: 'ok', or why not. */
export function checkAppPackUrl(
  key: Buffer,
  p: { sha256: string; name: string; expires: string | null; sig: string | null },
  now = new Date(),
): 'ok' | 'invalid' | 'expired' {
  if (!SHA.test(p.sha256) || !APP_PACK_NAMES.includes(p.name)) return 'invalid';
  const expires = Number(p.expires);
  if (!Number.isInteger(expires) || !p.sig) return 'invalid';
  const want = Buffer.from(signature(key, p.sha256, p.name, expires));
  const got = Buffer.from(p.sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'invalid';
  return expires * 1000 < now.getTime() ? 'expired' : 'ok';
}

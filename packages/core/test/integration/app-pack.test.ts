import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import {
  APP_PACK_FILES,
  appPackBlob,
  appPackFileUrl,
  appPackUrlKey,
  checkAppPackUrl,
  currentAppPack,
  mirrorAppPack,
} from '../../src/app-pack.ts';
import { packFetch } from '../../src/pricepack.ts';

let sql: Sql;
let drop: () => Promise<void>;
let media: string;
const BASE = 'https://github.com/pmaxai/TCGdex/releases/download/data-pack';

before(async () => {
  ({ sql, drop } = await freshDatabase());
  media = await mkdtemp(join(tmpdir(), 'app-pack-'));
});
after(async () => {
  await drop();
  await rm(media, { recursive: true, force: true });
});

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** The release as GitHub would serve it: pack.json plus the files; counts the downloads. */
class Release {
  files = new Map<string, Buffer>();
  version = '';
  gets: string[] = [];
  publish(version: string, contents: Record<string, string>) {
    this.version = version;
    for (const [k, v] of Object.entries(contents)) this.files.set(k, Buffer.from(v));
  }
  manifest() {
    const files: Record<string, { bytes: number; sha256: string }> = {};
    for (const [k, v] of this.files) files[k] = { bytes: v.length, sha256: sha(v) };
    return JSON.stringify({ version: this.version, model: 'm', files });
  }
  fetch = (async (input: string | URL | Request) => {
    const name = String(input).slice(BASE.length + 1);
    this.gets.push(name);
    if (name === 'pack.json') return new Response(this.manifest());
    const f = this.files.get(name);
    return f ? new Response(new Uint8Array(f)) : new Response(null, { status: 404 });
  }) as typeof fetch;
}

const first = {
  'catalog.sqlite': 'catalog v1',
  'index.f16': 'index v1',
  'model.onnx': 'model v1',
  'texture.u8': 'texture v1',
};

test('mirrors the release once, then only what changed; keeps three versions', async () => {
  const r = new Release();
  r.publish('2026-11-14T00:10:00Z', first);
  const opts = { mediaDir: media, baseUrl: BASE, fetch: r.fetch };

  const m1 = await mirrorAppPack(sql, opts);
  assert.deepEqual(m1, {
    status: 'mirrored',
    version: '2026-11-14T00:10:00Z',
    downloaded: [...APP_PACK_FILES],
  });
  const p1 = (await currentAppPack(sql))!;
  assert.deepEqual(
    p1.files.map((f) => f.name),
    [...APP_PACK_FILES, 'pack.json'],
  );
  for (const f of p1.files) {
    const body = await readFile(appPackBlob(media, f.sha256)!);
    assert.equal(sha(body), f.sha256, f.name);
    assert.equal(body.length, f.size);
  }
  assert.equal(
    JSON.parse(await readFile(appPackBlob(media, p1.files[4]!.sha256)!, 'utf8')).model,
    'm',
  );

  // same version again: nothing downloaded
  r.gets = [];
  assert.deepEqual(await mirrorAppPack(sql, opts), {
    status: 'current',
    version: '2026-11-14T00:10:00Z',
  });
  assert.deepEqual(r.gets, ['pack.json']);

  // next night: only the catalog changed
  r.publish('2026-11-15T00:10:00Z', { 'catalog.sqlite': 'catalog v2' });
  r.gets = [];
  const m2 = await mirrorAppPack(sql, opts);
  assert.equal(m2.status, 'mirrored');
  assert.deepEqual(r.gets, ['pack.json', 'catalog.sqlite']);

  r.publish('2026-11-16T00:10:00Z', { 'catalog.sqlite': 'catalog v3' });
  await mirrorAppPack(sql, opts);
  r.publish('2026-11-17T00:10:00Z', { 'catalog.sqlite': 'catalog v4', 'index.f16': 'index v2' });
  await mirrorAppPack(sql, opts);

  const versions = await sql<{ version: string }[]>`SELECT version FROM app_packs ORDER BY version`;
  assert.deepEqual(
    versions.map((v) => v.version),
    ['2026-11-15T00:10:00Z', '2026-11-16T00:10:00Z', '2026-11-17T00:10:00Z'],
  );
  const onDisk = new Set(await readdir(join(media, 'app-pack')));
  assert.ok(!onDisk.has(sha('catalog v1')), 'the first catalog is gone');
  assert.ok(onDisk.has(sha('catalog v2')));
  assert.ok(onDisk.has(sha('index v1')), 'still used by the two older versions');
  assert.ok(onDisk.has(sha('model v1')));
  assert.ok(![...onDisk].some((f) => f.endsWith('.part')));
});

test('a file that does not match pack.json is not taken', async () => {
  const r = new Release();
  r.publish('2026-11-18T00:10:00Z', { ...first, 'catalog.sqlite': 'catalog v5' });
  const honest = r.fetch;
  r.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith('/catalog.sqlite')) return new Response('tampered');
    return honest(input);
  }) as typeof fetch;
  await assert.rejects(
    mirrorAppPack(sql, { mediaDir: media, baseUrl: BASE, fetch: r.fetch }),
    /catalog\.sqlite does not match pack\.json/,
  );
  assert.equal((await currentAppPack(sql))!.version, '2026-11-17T00:10:00Z');
  const onDisk = await readdir(join(media, 'app-pack'));
  assert.ok(!onDisk.includes(sha('catalog v5')));
  assert.ok(!onDisk.some((f) => f.endsWith('.part')));
});

test('download URLs are signed and expire after an hour', async () => {
  const key = appPackUrlKey(Buffer.alloc(32, 7));
  const file = { name: 'catalog.sqlite', size: 10, sha256: sha('x') };
  const now = new Date('2026-11-16T10:00:00Z');
  const url = new URL(appPackFileUrl('https://overpricedcardboard.com', key, file, now));
  assert.equal(url.pathname, `/api/app/v1/pack/files/${file.sha256}/catalog.sqlite`);
  const parts = {
    sha256: file.sha256,
    name: 'catalog.sqlite',
    expires: url.searchParams.get('expires'),
    sig: url.searchParams.get('sig'),
  };
  assert.equal(checkAppPackUrl(key, parts, now), 'ok');
  assert.equal(checkAppPackUrl(key, parts, new Date(now.getTime() + 3601_000)), 'expired');
  assert.equal(checkAppPackUrl(key, { ...parts, name: 'index.f16' }, now), 'invalid');
  assert.equal(checkAppPackUrl(key, { ...parts, sha256: sha('y') }, now), 'invalid');
  assert.equal(checkAppPackUrl(key, { ...parts, expires: '9999999999' }, now), 'invalid');
  assert.equal(checkAppPackUrl(key, { ...parts, name: '../etc' }, now), 'invalid');
  assert.equal(checkAppPackUrl(appPackUrlKey(Buffer.alloc(32, 8)), parts, now), 'invalid');
});

test('with PACK_GITHUB_TOKEN, release files come through the GitHub API', async () => {
  const calls: { url: string; auth: string | null; accept: string | null }[] = [];
  const base = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    calls.push({ url, auth: h.get('authorization'), accept: h.get('accept') });
    if (url.endsWith('/releases/tags/data-pack')) {
      return Response.json({
        assets: [
          {
            name: 'pack.json',
            url: 'https://api.github.com/repos/pmaxai/TCGdex/releases/assets/1',
          },
          {
            name: 'catalog.sqlite',
            url: 'https://api.github.com/repos/pmaxai/TCGdex/releases/assets/2',
          },
        ],
      });
    }
    return new Response(`asset ${url.slice(-1)}`);
  }) as typeof fetch;

  assert.equal(packFetch({}, base), base, 'no token: plain fetch');
  const f = packFetch({ PACK_GITHUB_TOKEN: 'ghp_x' }, base);
  assert.equal(await (await f(`${BASE}/pack.json`)).text(), 'asset 1');
  assert.equal(await (await f(`${BASE}/catalog.sqlite`)).text(), 'asset 2');
  assert.equal((await f(`${BASE}/missing.bin`)).status, 404);
  assert.equal(
    calls.filter((c) => c.url.endsWith('/releases/tags/data-pack')).length,
    2,
    'the asset list is read once, and again for an unknown name',
  );
  const download = calls.find((c) => c.url.endsWith('/assets/2'))!;
  assert.equal(download.auth, 'Bearer ghp_x');
  assert.equal(download.accept, 'application/octet-stream');
  // other hosts are fetched as they are
  await f('https://example.com/pack/pack.json');
  assert.equal(calls.at(-1)!.auth, null);
});

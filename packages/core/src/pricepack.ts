// The app's data pack, imported every night so the web portal shows exactly the cards and
// prices the app ships with. The Data pipeline (github.com/pmaxai/TCGdex) publishes it as the
// release "data-pack": pack.json (version and checksums) and catalog.sqlite (cards in five
// languages, Cardmarket and TCGplayer prices, PSA prices, price check, price history).
//
// The worker fetches pack.json about hourly; a new version is downloaded, checked against its
// SHA-256 and copied into the pack_* tables in one transaction, so pages see either the old
// or the new pack, never half of each.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import type { Db, Sql } from './db.ts';

export const DEFAULT_PACK_URL = 'https://github.com/pmaxai/TCGdex/releases/download/data-pack';
/** The catalog is ~30 MB; anything far bigger is not what we expect. */
const MAX_CATALOG_BYTES = 400 * 1024 * 1024;

export type PackManifest = {
  version: string;
  files: Record<string, { bytes: number; sha256: string }>;
};

export function packUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PRICE_PACK_URL?.trim() || DEFAULT_PACK_URL).replace(/\/$/, '');
}

export async function fetchManifest(
  baseUrl: string,
  doFetch: typeof fetch = fetch,
): Promise<PackManifest> {
  const res = await doFetch(`${baseUrl}/pack.json`, {
    redirect: 'follow',
    headers: { Accept: 'application/json', 'User-Agent': 'overpricedcardboard.com price import' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`pack.json: HTTP ${res.status}`);
  const m = (await res.json()) as Partial<PackManifest>;
  const cat = m.files?.['catalog.sqlite'];
  if (typeof m.version !== 'string' || !cat || !/^[0-9a-f]{64}$/.test(cat.sha256 ?? '')) {
    throw new Error('pack.json without version or catalog.sqlite checksum');
  }
  return m as PackManifest;
}

export async function lastImport(
  db: Db,
): Promise<{ version: string; importedAt: Date; cards: number; prices: number } | null> {
  const [r] = await db<{ version: string; imported_at: Date; cards: number; prices: number }[]>`
    SELECT version, imported_at, cards, prices FROM pack_imports ORDER BY imported_at DESC LIMIT 1`;
  return r
    ? { version: r.version, importedAt: r.imported_at, cards: r.cards, prices: r.prices }
    : null;
}

/** Downloads one file of the pack and checks size and SHA-256 on the way. */
async function download(
  url: string,
  dest: string,
  expect: { bytes: number; sha256: string },
  doFetch: typeof fetch,
): Promise<void> {
  const res = await doFetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'overpricedcardboard.com price import' },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_CATALOG_BYTES) body.destroy(new Error('catalog.sqlite is too large'));
    hash.update(chunk);
  });
  await pipeline(body, createWriteStream(dest));
  const sha = hash.digest('hex');
  if (bytes !== expect.bytes || sha !== expect.sha256) {
    throw new Error(`catalog.sqlite does not match pack.json (${bytes} bytes, sha256 ${sha})`);
  }
}

type Row = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
};
const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : v == null ? null : String(v);
/** Parsed JSON for a jsonb column (the driver serialises it; a string would be stored as one). */
const json = (v: unknown): unknown => {
  if (typeof v !== 'string' || !v) return null;
  try {
    const parsed: unknown = JSON.parse(v);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

function tableExists(lite: DatabaseSync, name: string): boolean {
  return Boolean(
    lite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

/** Inserts rows in chunks (Postgres takes at most 65,535 parameters per statement). */
async function insertChunks(
  tx: Db,
  table: string,
  columns: string[],
  rows: unknown[][],
  casts: Record<string, string> = {},
): Promise<void> {
  const per = Math.max(1, Math.floor(30_000 / columns.length));
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const values: unknown[] = [];
    const tuples = chunk.map((r) => {
      const ph = r.map((v, j) => {
        values.push(v);
        const cast = casts[columns[j]!];
        return `$${values.length}${cast ? `::${cast}` : ''}`;
      });
      return `(${ph.join(',')})`;
    });
    await tx.unsafe(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`,
      values as never[],
    );
  }
}

export type ImportResult =
  | { status: 'current'; version: string }
  | { status: 'imported'; version: string; cards: number; prices: number; seconds: number };

/**
 * Imports the pack when its version is newer than the last import (or `force`).
 * The SQLite file is read only and deleted afterwards.
 */
export async function importPack(
  sql: Sql,
  opts: {
    baseUrl?: string;
    fetch?: typeof fetch;
    force?: boolean;
    log?: (msg: string) => void;
    /** Tests: a local catalog.sqlite instead of downloading it. */
    catalogPath?: string;
    manifest?: PackManifest;
  } = {},
): Promise<ImportResult> {
  const baseUrl = opts.baseUrl ?? packUrl();
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});
  const manifest = opts.manifest ?? (await fetchManifest(baseUrl, doFetch));
  const last = await lastImport(sql);
  if (!opts.force && last && last.version >= manifest.version) {
    return { status: 'current', version: last.version };
  }
  const started = Date.now();
  const dir = opts.catalogPath ? null : await mkdtemp(join(tmpdir(), 'pack-'));
  const path = opts.catalogPath ?? join(dir!, 'catalog.sqlite');
  try {
    if (!opts.catalogPath) {
      await download(`${baseUrl}/catalog.sqlite`, path, manifest.files['catalog.sqlite']!, doFetch);
      log(`[pack] downloaded ${manifest.version}`);
    }
    const lite = new DatabaseSync(path, { readOnly: true });
    try {
      const all = (q: string) => lite.prepare(q).all() as Row[];
      const sets = all(
        'SELECT id, lang, name, serie_id, serie_name, official, total, release_date FROM sets',
      ).map((r) => [
        str(r.id),
        str(r.lang),
        str(r.name),
        str(r.serie_id),
        str(r.serie_name),
        int(r.official),
        int(r.total),
        str(r.release_date),
      ]);
      const cardCols = new Set(
        (lite.prepare('PRAGMA table_info(cards)').all() as Row[]).map((r) => String(r.name)),
      );
      const alt = cardCols.has('image_alt')
        ? 'image_alt, image_alt_large'
        : 'NULL AS image_alt, NULL AS image_alt_large';
      const cards = all(
        `SELECT id, lang, set_id, local_id, name, image_url, ${alt} FROM cards`,
      ).map((r) => [
        str(r.id),
        str(r.lang),
        str(r.set_id),
        str(r.local_id),
        str(r.name),
        str(r.image_url),
        str(r.image_alt),
        str(r.image_alt_large),
      ]);
      const info = tableExists(lite, 'card_info')
        ? all('SELECT id, rarity, variants, category, dex FROM card_info').map((r) => [
            str(r.id),
            str(r.rarity),
            json(r.variants),
            str(r.category),
            str(r.dex),
          ])
        : [];
      const prices = all(
        `SELECT id, updated, trend, avg, low, avg1, avg7, avg30, trend_holo, avg_holo, low_holo,
                avg30_holo FROM prices`,
      ).map((r) => [
        str(r.id),
        str(r.updated),
        num(r.trend),
        num(r.avg),
        num(r.low),
        num(r.avg1),
        num(r.avg7),
        num(r.avg30),
        num(r.trend_holo),
        num(r.avg_holo),
        num(r.low_holo),
        num(r.avg30_holo),
      ]);
      const tcg = tableExists(lite, 'tcgplayer')
        ? all('SELECT id, updated, data FROM tcgplayer')
            .map((r) => [str(r.id), str(r.updated), json(r.data)])
            .filter((r) => r[2] !== null)
        : [];
      const graded = tableExists(lite, 'graded')
        ? all(
            `SELECT id, printing, currency, updated, psa10, psa10_n, psa9, psa9_n, psa8, psa8_n,
                    source FROM graded`,
          ).map((r) => [
            str(r.id),
            str(r.printing) ?? '',
            str(r.currency),
            str(r.updated),
            num(r.psa10),
            int(r.psa10_n),
            num(r.psa9),
            int(r.psa9_n),
            num(r.psa8),
            int(r.psa8_n),
            str(r.source),
          ])
        : [];
      const checks = tableExists(lite, 'price_check')
        ? all('SELECT id, status, cm_trend, tp_lo, tp_hi, others FROM price_check').map((r) => [
            str(r.id),
            str(r.status),
            num(r.cm_trend),
            num(r.tp_lo),
            num(r.tp_hi),
            str(r.others),
          ])
        : [];
      const history = tableExists(lite, 'history')
        ? all('SELECT id, field, data FROM history').map((r) => [
            str(r.id),
            str(r.field),
            Buffer.from(r.data as Uint8Array),
          ])
        : [];
      const meta = all('SELECT key, value FROM meta').map((r) => [str(r.key), str(r.value)]);

      await sql.begin(async (tx) => {
        for (const t of [
          'pack_sets',
          'pack_cards',
          'pack_card_info',
          'pack_prices',
          'pack_tcgplayer',
          'pack_graded',
          'pack_price_check',
          'pack_history',
          'pack_meta',
        ]) {
          await tx.unsafe(`DELETE FROM ${t}`);
        }
        await insertChunks(
          tx,
          'pack_sets',
          ['id', 'lang', 'name', 'serie_id', 'serie_name', 'official', 'total', 'release_date'],
          sets,
        );
        await insertChunks(
          tx,
          'pack_cards',
          ['id', 'lang', 'set_id', 'local_id', 'name', 'image_url', 'image_alt', 'image_alt_large'],
          cards,
        );
        await insertChunks(
          tx,
          'pack_card_info',
          ['id', 'rarity', 'variants', 'category', 'dex'],
          info,
          {
            variants: 'jsonb',
          },
        );
        await insertChunks(
          tx,
          'pack_prices',
          [
            'id',
            'updated',
            'trend',
            'avg',
            'low',
            'avg1',
            'avg7',
            'avg30',
            'trend_holo',
            'avg_holo',
            'low_holo',
            'avg30_holo',
          ],
          prices,
        );
        await insertChunks(tx, 'pack_tcgplayer', ['id', 'updated', 'data'], tcg, { data: 'jsonb' });
        await insertChunks(
          tx,
          'pack_graded',
          [
            'id',
            'printing',
            'currency',
            'updated',
            'psa10',
            'psa10_n',
            'psa9',
            'psa9_n',
            'psa8',
            'psa8_n',
            'source',
          ],
          graded,
        );
        await insertChunks(
          tx,
          'pack_price_check',
          ['id', 'status', 'cm_trend', 'tp_lo', 'tp_hi', 'others'],
          checks,
        );
        await insertChunks(tx, 'pack_history', ['id', 'field', 'data'], history, { data: 'bytea' });
        await insertChunks(tx, 'pack_meta', ['key', 'value'], meta);
        // search text: name, set, number and id, lower case without accents
        await tx`
          UPDATE pack_cards c
             SET search = shop_unaccent(lower(concat_ws(' ', c.name, s.name, s.serie_name,
                                                         c.local_id, c.id)))
            FROM pack_sets s
           WHERE s.id = c.set_id AND s.lang = c.lang`;
        await tx`
          UPDATE pack_cards SET search = shop_unaccent(lower(concat_ws(' ', name, local_id, id)))
           WHERE search IS NULL`;
        const seconds = Math.round((Date.now() - started) / 100) / 10;
        await tx`
          INSERT INTO pack_imports (version, sha256, cards, prices, seconds)
          VALUES (${manifest.version}, ${manifest.files['catalog.sqlite']!.sha256}, ${cards.length},
                  ${prices.length}, ${seconds})
          ON CONFLICT (version) DO UPDATE SET imported_at = now(), seconds = EXCLUDED.seconds`;
      });
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      log(
        `[pack] imported ${manifest.version}: ${cards.length} cards, ${prices.length} prices, ${seconds} s`,
      );
      return {
        status: 'imported',
        version: manifest.version,
        cards: cards.length,
        prices: prices.length,
        seconds,
      };
    } finally {
      lite.close();
    }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

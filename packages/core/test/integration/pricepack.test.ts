import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import { importPack, lastImport, type PackManifest } from '../../src/pricepack.ts';
import { cardHistory, historyLine, packCard, searchPackCards } from '../../src/pack-cards.ts';

let sql: Sql;
let drop: () => Promise<void>;
let dir: string;

before(async () => {
  ({ sql, drop } = await freshDatabase());
  dir = mkdtempSync(join(tmpdir(), 'pack-test-'));
});
after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await drop();
});

/** A catalog.sqlite with the data pack's tables and two cards. */
function makeCatalog(path: string, trend: number) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE cards(id TEXT, lang TEXT, set_id TEXT, local_id TEXT, name TEXT, image_url TEXT,
                       image_alt TEXT, image_alt_large TEXT, PRIMARY KEY(id, lang));
    CREATE TABLE card_info(id TEXT PRIMARY KEY, rarity TEXT, variants TEXT, category TEXT, dex TEXT);
    CREATE TABLE sets(id TEXT, lang TEXT, name TEXT, serie_id TEXT, serie_name TEXT, official INTEGER,
                      total INTEGER, release_date TEXT, PRIMARY KEY(id, lang));
    CREATE TABLE prices(id TEXT PRIMARY KEY, updated TEXT, trend REAL, avg REAL, low REAL, avg1 REAL,
                        avg7 REAL, avg30 REAL, trend_holo REAL, avg_holo REAL, low_holo REAL, avg30_holo REAL);
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE tcgplayer(id TEXT PRIMARY KEY, updated TEXT, data TEXT);
    CREATE TABLE graded(id TEXT, printing TEXT, currency TEXT, updated TEXT, psa10 REAL, psa10_n INTEGER,
                        psa9 REAL, psa9_n INTEGER, psa8 REAL, psa8_n INTEGER, source TEXT, PRIMARY KEY(id, printing));
    CREATE TABLE price_check(id TEXT PRIMARY KEY, status TEXT NOT NULL, cm_trend REAL, tp_lo REAL, tp_hi REAL, others TEXT);
    CREATE TABLE history(id TEXT NOT NULL, field TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(id, field)) WITHOUT ROWID;
  `);
  const ins = (q: string, ...v: unknown[]) => db.prepare(q).run(...(v as never[]));
  ins("INSERT INTO sets VALUES ('base1','en','Base Set','base','Base',102,102,'1999-01-09')");
  ins("INSERT INTO sets VALUES ('base1','de','Grundset','base','Grund',102,102,'1999-01-09')");
  ins(
    "INSERT INTO cards VALUES ('base1-4','en','base1','4','Charizard','https://assets.tcgdex.net/en/base/base1/4',NULL,NULL)",
  );
  ins("INSERT INTO cards VALUES ('base1-4','de','base1','4','Glurak',NULL,NULL,NULL)");
  ins(
    "INSERT INTO cards VALUES ('base1-58','en','base1','58','Pikachu','https://assets.tcgdex.net/en/base/base1/58',NULL,NULL)",
  );
  ins(
    `INSERT INTO card_info VALUES ('base1-4','Rare','{"holo":true,"firstEdition":true}','Pokemon','6')`,
  );
  ins(`INSERT INTO card_info VALUES ('base1-58','Common','{"normal":true}','Pokemon','25')`);
  ins(
    'INSERT INTO prices VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    'base1-4',
    '2026-11-14',
    trend,
    380,
    90,
    null,
    null,
    400,
    null,
    null,
    null,
    null,
  );
  ins(`INSERT INTO tcgplayer VALUES ('base1-4','2026-11-14','{"holofoil":987.13}')`);
  ins(
    "INSERT INTO graded VALUES ('base1-4','holo','USD','2026-11-14',7273.13,36,2385.89,195,1268.77,248,'PPT')",
  );
  ins("INSERT INTO meta VALUES ('usd_per_eur','1.1052')");
  ins("INSERT INTO meta VALUES ('history_dates','2026-11-12,2026-11-13,2026-11-14')");
  ins("INSERT INTO meta VALUES ('history_rates','1.10,,1.1052')");
  const f16 = Buffer.alloc(6);
  f16.writeUInt16LE(0x5e00, 0); // 384
  f16.writeUInt16LE(0x7e00, 2); // no price
  f16.writeUInt16LE(0x5e08, 4); // 386
  ins('INSERT INTO history VALUES (?,?,?)', 'base1-4', 'cm_trend', deflateSync(f16));
  db.close();
}

const manifest = (version: string): PackManifest => ({
  version,
  files: { 'catalog.sqlite': { bytes: 1, sha256: 'a'.repeat(64) } },
});

test('imports the pack once per version and replaces it as a whole', async () => {
  const path = join(dir, 'catalog.sqlite');
  makeCatalog(path, 385.83);
  const r = await importPack(sql, {
    manifest: manifest('2026-11-14T00:23:29Z'),
    catalogPath: path,
  });
  assert.equal(r.status, 'imported');
  assert.equal((await lastImport(sql))?.cards, 3);
  // same version: nothing to do
  const again = await importPack(sql, {
    manifest: manifest('2026-11-14T00:23:29Z'),
    catalogPath: path,
  });
  assert.equal(again.status, 'current');

  const c = await packCard(sql, 'base1-4', ['de']);
  assert.equal(c?.name, 'Glurak');
  assert.equal(c?.names.en, 'Charizard');
  assert.equal(c?.setName, 'Grundset');
  assert.equal(c?.number, '4/102');
  // German row has no picture: the English one is used
  assert.equal(c?.image?.small, 'https://assets.tcgdex.net/en/base/base1/4/low.webp');
  assert.deepEqual(
    c?.printings.map((p) => [p.kind, p.value]),
    [
      ['holo', 385.83],
      ['first', null],
    ],
  );
  assert.equal(c?.graded.holo?.psa10, 7273.13);

  const hits = await searchPackCards(sql, 'glurak 4', { langs: ['de'] });
  assert.deepEqual(
    hits.map((h) => h.id),
    ['base1-4'],
  );
  assert.deepEqual(
    (await searchPackCards(sql, 'charizard base')).map((h) => h.id),
    ['base1-4'],
  );
  assert.deepEqual(
    (await searchPackCards(sql, 'pikachu 58/102')).map((h) => h.id),
    ['base1-58'],
  );
  assert.deepEqual(await searchPackCards(sql, '  '), []);

  const h = await cardHistory(sql, 'base1-4');
  assert.deepEqual(h?.dates, ['2026-11-12', '2026-11-13', '2026-11-14']);
  assert.deepEqual(historyLine(h!, 'holo', false)?.values, [384, null, 386]);

  // a newer pack replaces every row
  makeCatalog(join(dir, 'catalog2.sqlite'), 400);
  await importPack(sql, {
    manifest: manifest('2026-11-15T00:20:00Z'),
    catalogPath: join(dir, 'catalog2.sqlite'),
  });
  assert.equal((await packCard(sql, 'base1-4'))?.printings[0]?.value, 400);
  const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pack_cards`;
  assert.equal(n!.n, 3);
});

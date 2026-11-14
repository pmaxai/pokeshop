import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';

/** A catalog.sqlite with the data pack's tables and two cards. */
export function makeCatalog(path: string, trend: number) {
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

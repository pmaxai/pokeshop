import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDatabase } from './helpers.ts';
import { makeCatalog } from './pack-fixture.ts';
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
  assert.equal(c?.image?.small, '/media/card/en/base/base1/4/low.webp');
  assert.equal(c?.imageSource, 'https://assets.tcgdex.net/en/base/base1/4');
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

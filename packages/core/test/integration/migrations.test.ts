import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.ts';
import { runMigrations } from '../../src/migrations.ts';
import type { Sql } from '../../src/db.ts';

let sql: Sql;
let drop: () => Promise<void>;
before(async () => ({ sql, drop } = await freshDatabase()));
after(async () => drop());

test('all migrations are recorded and a second run changes nothing', async () => {
  const rows = await sql<
    { version: string }[]
  >`SELECT version FROM schema_migrations ORDER BY version`;
  assert.ok(rows.length >= 5);
  assert.equal(rows[0]?.version, '0001_base');
  assert.deepEqual(await runMigrations(sql, () => {}), []);
});

test('bigint ids come back as numbers', async () => {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO jobs (kind) VALUES ('test') RETURNING id`;
  assert.equal(typeof row?.id, 'number');
});

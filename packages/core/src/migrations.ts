import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from './db.ts';

export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url).pathname;

type Applied = { version: string; checksum: string };

/**
 * Applies every numbered .sql file in migrations/ that is not yet recorded in
 * schema_migrations, each in its own transaction. An advisory lock keeps two
 * runners (e.g. two containers starting at once) from migrating in parallel.
 * Changing an already applied file is an error: add a new migration instead.
 */
export async function runMigrations(
  sql: Sql,
  log: (msg: string) => void = console.log,
  dir = MIGRATIONS_DIR,
): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];

  await sql.reserve().then(async (conn) => {
    try {
      await conn`SELECT pg_advisory_lock(hashtext('pokeshop.migrations'))`;
      await conn`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`;
      const done = new Map(
        (await conn<Applied[]>`SELECT version, checksum FROM schema_migrations`).map((r) => [
          r.version,
          r.checksum,
        ]),
      );
      for (const file of files) {
        const text = await readFile(join(dir, file), 'utf8');
        const checksum = createHash('sha256').update(text).digest('hex');
        const version = file.replace(/\.sql$/, '');
        const known = done.get(version);
        if (known) {
          if (known !== checksum) {
            throw new Error(`migration ${file} was changed after it was applied`);
          }
          continue;
        }
        await conn.unsafe('BEGIN');
        try {
          await conn.unsafe(text);
          await conn`INSERT INTO schema_migrations (version, checksum) VALUES (${version}, ${checksum})`;
          await conn.unsafe('COMMIT');
        } catch (e) {
          await conn.unsafe('ROLLBACK');
          throw new Error(`migration ${file} failed: ${(e as Error).message}`, { cause: e });
        }
        applied.push(version);
        log(`applied ${version}`);
      }
    } finally {
      await conn`SELECT pg_advisory_unlock(hashtext('pokeshop.migrations'))`.catch(() => {});
      conn.release();
    }
  });

  if (applied.length === 0) log('database is up to date');
  return applied;
}

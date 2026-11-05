import { execFileSync } from 'node:child_process';
import { createSql, type Sql } from '../../src/db.ts';
import { runMigrations } from '../../src/migrations.ts';

/**
 * Creates a fresh, migrated database for one test file and drops it afterwards.
 * Uses the libpq variables (PGHOST, PGUSER, PGPASSWORD …) like scripts/db-test.sh.
 */
export async function freshDatabase(): Promise<{ sql: Sql; drop: () => Promise<void> }> {
  const name = `pokeshop_it_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  execFileSync('createdb', [name]);
  const host = process.env.PGHOST ?? 'localhost';
  const user = encodeURIComponent(process.env.PGUSER ?? process.env.USER ?? 'postgres');
  const pass = process.env.PGPASSWORD ? `:${encodeURIComponent(process.env.PGPASSWORD)}` : '';
  const port = process.env.PGPORT ?? '5432';
  const url = `postgres://${user}${pass}@${host}:${port}/${name}`;
  const sql = createSql(url, { max: 5 });
  await runMigrations(sql, () => {});
  return {
    sql,
    drop: async () => {
      await sql.end({ timeout: 5 });
      execFileSync('dropdb', ['--if-exists', name]);
    },
  };
}

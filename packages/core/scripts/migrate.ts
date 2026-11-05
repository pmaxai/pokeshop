// Applies pending database migrations. Used by the "migrate" container on every start.
import { createSql } from '../src/db.ts';
import { runMigrations } from '../src/migrations.ts';

const sql = createSql(process.env.DATABASE_URL, { max: 1, applicationName: 'pokeshop-migrate' });
try {
  await runMigrations(sql);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}

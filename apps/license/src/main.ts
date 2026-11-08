// License service: migrates its own database, then serves the app and the shop.
//   LICENSE_DATABASE_URL  own database (not the shop's)
//   LICENSE_MASTER_KEY    32 bytes, base64: encrypts the stored keys (openssl rand -base64 32)
//   LICENSE_SHOP_TOKEN    the shop's bearer token for /v1/shop/* (openssl rand -base64 32)
//   LICENSE_PORT          default 3100
import { createSql } from '../../../packages/core/src/db.ts';
import { runMigrations } from '../../../packages/core/src/migrations.ts';
import { createLicenseServer } from './server.ts';
import { licenseMasterKey, LICENSE_MIGRATIONS_DIR } from './config.ts';

const shopToken = process.env.LICENSE_SHOP_TOKEN ?? '';
if (shopToken.length < 32)
  throw new Error('LICENSE_SHOP_TOKEN must be set (at least 32 characters)');
const masterKey = licenseMasterKey();
const sql = createSql(process.env.LICENSE_DATABASE_URL, { applicationName: 'pokeshop-license' });

await runMigrations(sql, (m) => console.log(`license: ${m}`), LICENSE_MIGRATIONS_DIR);

const port = Number(process.env.LICENSE_PORT ?? 3100);
const server = createLicenseServer({ sql, masterKey, shopToken });
server.listen(port, '0.0.0.0', () => console.log(`license: listening on :${port}`));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => void sql.end({ timeout: 5 }).then(() => process.exit(0)));
  });
}

// Licence administration, run inside the license container:
//   node apps/license/src/cli.ts issue --email you@example.com [--name "…"] [--note "…"] [--order REF] [--count N]
//   node apps/license/src/cli.ts show <licence id | key | e-mail>
//   node apps/license/src/cli.ts revoke <licence id> [reason …]
import { createSql } from '../../../packages/core/src/db.ts';
import { runMigrations } from '../../../packages/core/src/migrations.ts';
import { licenseMasterKey, LICENSE_MIGRATIONS_DIR } from './config.ts';
import { findLicenses, issueLicenses, revoke, type LicenseView } from './store.ts';

const [cmd, ...args] = process.argv.slice(2);
const sql = createSql(process.env.LICENSE_DATABASE_URL, {
  max: 2,
  applicationName: 'pokeshop-license-cli',
});

function option(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function print(l: LicenseView): void {
  console.log(`${l.id}  ${l.key}`);
  console.log(`  buyer:   ${[l.name, l.email].filter(Boolean).join(' · ') || '–'}`);
  if (l.orderRef) console.log(`  order:   ${l.orderRef}`);
  if (l.note) console.log(`  note:    ${l.note}`);
  console.log(`  created: ${l.createdAt.toISOString()}`);
  if (l.revokedAt) console.log(`  REVOKED: ${l.revokedAt.toISOString()} (${l.revokeReason ?? ''})`);
  console.log(
    l.activeDevice
      ? `  device:  ${l.activeDevice.name ?? 'unnamed'} since ${l.activeDevice.since.toISOString()}, last seen ${l.activeDevice.lastSeen.toISOString()}`
      : '  device:  not activated',
  );
  console.log(`  devices so far: ${l.activations}`);
}

try {
  await runMigrations(sql, () => {}, LICENSE_MIGRATIONS_DIR);
  const masterKey = licenseMasterKey();
  if (cmd === 'issue') {
    const issued = await issueLicenses(sql, masterKey, {
      email: option('email') ?? null,
      name: option('name') ?? null,
      note: option('note') ?? null,
      orderRef: option('order') ?? null,
      count: Number(option('count') ?? 1),
    });
    for (const l of await findLicenses(sql, masterKey, { ids: issued.map((i) => i.id) })) print(l);
  } else if (cmd === 'show') {
    const q = args.join(' ').trim();
    if (!q) throw new Error('usage: show <licence id | key | e-mail>');
    const found = q.startsWith('lic_')
      ? await findLicenses(sql, masterKey, { ids: [q] })
      : q.includes('@')
        ? await findLicenses(sql, masterKey, { email: q })
        : await findLicenses(sql, masterKey, { key: q });
    if (found.length === 0) console.log('no licence found');
    found.forEach(print);
  } else if (cmd === 'revoke') {
    const [id, ...reason] = args;
    if (!id) throw new Error('usage: revoke <licence id> [reason …]');
    const at = await revoke(sql, id, reason.join(' ') || 'revoked by an admin');
    console.log(`${id} revoked at ${at.toISOString()}`);
  } else {
    console.log('commands: issue --email … | show <id | key | e-mail> | revoke <id> [reason]');
    process.exitCode = 2;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}

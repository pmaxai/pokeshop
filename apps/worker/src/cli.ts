// Maintenance commands, run inside the worker container:
//   node apps/worker/src/cli.ts api-client create "Scanner Lager"
//   node apps/worker/src/cli.ts api-client list
//   node apps/worker/src/cli.ts api-client revoke <id>
//   node apps/worker/src/cli.ts tcgdex sync
//   node apps/worker/src/cli.ts tcgdex card sv03.5-199
import { createSql } from '@pokeshop/core/db';
import { createApiClient, listApiClients, revokeApiClient } from '@pokeshop/core/api-clients';
import { parseMasterKey } from '@pokeshop/core/secrets';
import { httpTcgdexClient, syncCardDetails, syncSets } from '@pokeshop/core/tcgdex';

const [cmd, sub, ...rest] = process.argv.slice(2);
const sql = createSql(process.env.DATABASE_URL, { max: 2, applicationName: 'pokeshop-cli' });

try {
  if (cmd === 'api-client' && sub === 'create') {
    const name = rest.join(' ').trim();
    if (!name) throw new Error('usage: api-client create <name>');
    const { client, secret } = await createApiClient(
      sql,
      { name, createdBy: 'cli' },
      parseMasterKey(process.env.API_KEY_MASTER_KEY),
    );
    console.log(`API client "${client.name}" created.`);
    console.log(`  key id: ${client.key_id}`);
    console.log(`  secret: ${secret}   (shown only now – store it in the scanning app)`);
  } else if (cmd === 'api-client' && sub === 'list') {
    for (const c of await listApiClients(sql)) {
      console.log(
        `${c.id}\t${c.key_id}\t${c.name}\t${c.revoked_at ? 'revoked' : 'active'}\tlast used: ${c.last_used_at?.toISOString() ?? '–'}`,
      );
    }
  } else if (cmd === 'api-client' && sub === 'revoke') {
    await revokeApiClient(sql, Number(rest[0]));
    console.log('revoked');
  } else if (cmd === 'tcgdex' && sub === 'sync') {
    const r = await syncSets(sql, httpTcgdexClient(), (m) => console.log(m));
    console.log(
      `done: ${r.sets} sets, ${r.cards} cards (skipped digital-only: ${r.skipped.length})`,
    );
  } else if (cmd === 'tcgdex' && sub === 'card' && rest[0]) {
    console.log(await syncCardDetails(sql, httpTcgdexClient(), rest[0]));
  } else {
    console.log(
      'commands: api-client create <name> | api-client list | api-client revoke <id> | tcgdex sync | tcgdex card <ref>',
    );
    process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}

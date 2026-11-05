import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './helpers.ts';
import type { Sql } from '../../src/db.ts';
import { claimJob, enqueueJob, failJob, finishJob } from '../../src/jobs.ts';

let sql: Sql;
let drop: () => Promise<void>;
before(async () => ({ sql, drop } = await freshDatabase()));
after(async () => drop());

test('one open job per dedupe key; claimed jobs are not handed out twice', async () => {
  assert.equal(await enqueueJob(sql, 'tcgdex.sync', {}, { dedupeKey: 'sync' }), true);
  assert.equal(await enqueueJob(sql, 'tcgdex.sync', {}, { dedupeKey: 'sync' }), false);
  const [a, b] = await Promise.all([claimJob(sql), claimJob(sql)]);
  assert.ok((a === null) !== (b === null), 'exactly one worker gets it');
  const job = (a ?? b)!;
  await finishJob(sql, job.id);
  assert.equal(
    await enqueueJob(sql, 'tcgdex.sync', {}, { dedupeKey: 'sync' }),
    true,
    'free again once done',
  );
});

test('failures retry with backoff, then give up', async () => {
  await sql`DELETE FROM jobs`;
  await enqueueJob(sql, 'x', { n: 1 }, { maxAttempts: 2 });
  let job = (await claimJob(sql))!;
  await failJob(sql, job, 'boom');
  const [r1] = await sql`SELECT status, run_after > now() AS later FROM jobs WHERE id = ${job.id}`;
  assert.deepEqual({ ...r1 }, { status: 'pending', later: true });
  await sql`UPDATE jobs SET run_after = now() WHERE id = ${job.id}`;
  job = (await claimJob(sql))!;
  assert.equal(job.attempts, 2);
  await failJob(sql, job, 'boom again');
  const [r2] = await sql`SELECT status, last_error FROM jobs WHERE id = ${job.id}`;
  assert.deepEqual({ ...r2 }, { status: 'failed', last_error: 'boom again' });
});

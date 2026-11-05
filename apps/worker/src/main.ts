// Background worker: product images, card-data sync, job queue.
// Later milestones add the mail outbox and the 10-minute reservation sweeper here.
import { writeFile } from 'node:fs/promises';
import { createSql } from '@pokeshop/core/db';
import {
  claimJob,
  enqueueJob,
  failJob,
  finishJob,
  requeueStaleJobs,
  type Job,
} from '@pokeshop/core/jobs';
import { httpTcgdexClient, syncCardDetails, syncSets } from '@pokeshop/core/tcgdex';
import { processNextImage } from './images.ts';

export const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/pokeshop-worker.heartbeat';
const mediaDir = process.env.MEDIA_DIR ?? './.media';
const sql = createSql(process.env.DATABASE_URL, { max: 4, applicationName: 'pokeshop-worker' });
const tcgdex = httpTcgdexClient();
let stopping = false;

/** Heartbeat for the Docker health check; long jobs call it as they make progress. */
async function beat() {
  try {
    await writeFile(HEARTBEAT_FILE, new Date().toISOString());
  } catch (e) {
    console.error('[worker] heartbeat:', (e as Error).message);
  }
}

const handlers: Record<string, (job: Job) => Promise<void>> = {
  'tcgdex.sync': async () => {
    const r = await syncSets(sql, tcgdex, () => void beat());
    console.log(`[tcgdex] synced ${r.sets} sets, ${r.cards} cards`);
  },
  'tcgdex.card': async (job) => {
    await syncCardDetails(sql, tcgdex, String(job.payload.card_ref));
  },
};

async function runJobs() {
  for (let i = 0; i < 10 && !stopping; i++) {
    const job = await claimJob(sql);
    if (!job) return;
    const handler = handlers[job.kind];
    try {
      if (!handler) throw new Error(`no handler for ${job.kind}`);
      await handler(job);
      await finishJob(sql, job.id);
    } catch (e) {
      console.error(`[jobs] ${job.kind} #${job.id} failed:`, (e as Error).message);
      await failJob(sql, job, (e as Error).message);
    }
  }
}

async function runImages() {
  for (let i = 0; i < 20 && !stopping; i++) {
    if (!(await processNextImage(sql, mediaDir))) return;
    await beat();
  }
}

/** Card data: right away on an empty database, then nightly between 3 and 5 o'clock Vienna time. */
async function schedule() {
  const [state] = await sql<{ cards: number; recent: boolean }[]>`
    SELECT (SELECT count(*) FROM card_master)::int AS cards,
           EXISTS (SELECT 1 FROM jobs WHERE kind = 'tcgdex.sync' AND created_at > now() - interval '20 hours') AS recent`;
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hour12: false,
      timeZone: 'Europe/Vienna',
    }).format(new Date()),
  );
  if (state && !state.recent && (state.cards === 0 || (hour >= 3 && hour < 5))) {
    if (await enqueueJob(sql, 'tcgdex.sync', {}, { dedupeKey: 'tcgdex.sync', maxAttempts: 3 })) {
      console.log('[schedule] queued card-data sync');
    }
  }
  // Products whose card was never looked up in detail (e.g. created while TCGdex was down).
  const missing = await sql<{ card_ref: string }[]>`
    SELECT DISTINCT p.card_ref FROM products p JOIN card_master cm USING (card_ref)
     WHERE cm.details_fetched_at IS NULL LIMIT 50`;
  for (const m of missing) {
    await enqueueJob(
      sql,
      'tcgdex.card',
      { card_ref: m.card_ref },
      { dedupeKey: `tcgdex.card:${m.card_ref}` },
    );
  }
  await requeueStaleJobs(sql);
}

async function main() {
  console.log('[worker] started');
  let lastSchedule = 0;
  while (!stopping) {
    await beat();
    try {
      if (Date.now() - lastSchedule > 10 * 60_000) {
        await schedule();
        lastSchedule = Date.now();
      }
      await runImages();
      await runJobs();
    } catch (e) {
      console.error('[worker] loop error:', (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  await sql.end({ timeout: 10 });
  console.log('[worker] stopped');
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    stopping = true;
  });
}

await main();

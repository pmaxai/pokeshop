// Background worker: 10-minute holds, e-mail outbox, refunds the shop owes, product images,
// card-data sync, cart clean-up.
import { writeFile } from 'node:fs/promises';
import { deleteStaleCarts } from '@pokeshop/core/cart';
import { createSql } from '@pokeshop/core/db';
import {
  claimJob,
  enqueueJob,
  failJob,
  finishJob,
  requeueStaleJobs,
  type Job,
} from '@pokeshop/core/jobs';
import {
  documentPdf,
  mailTransportFromEnv,
  sendDueMails,
  type MailContext,
} from '@pokeshop/core/mail';
import { expireHolds, runPendingRefunds } from '@pokeshop/core/orders';
import { licenseClientFromEnv } from '@pokeshop/core/license-client';
import {
  issueOrderLicenses,
  resendLicensesByEmail,
  revokeOrderLicenses,
} from '@pokeshop/core/licenses';
import { paymentsFromEnv } from '@pokeshop/core/payments';
import {
  fillLocalNames,
  httpTcgdexClient,
  missingLocalNames,
  syncCardDetails,
  syncLocalName,
  syncSets,
} from '@pokeshop/core/tcgdex';
import { TCGDEX_LOCAL_LANGS } from '@pokeshop/core/catalog';
import { processNextImage } from './images.ts';

export const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/pokeshop-worker.heartbeat';
const mediaDir = process.env.MEDIA_DIR ?? './.media';
const baseUrl = (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const sql = createSql(process.env.DATABASE_URL, { max: 4, applicationName: 'pokeshop-worker' });
const tcgdex = httpTcgdexClient();
// Two Stripe accounts: the shop's (cards) and Antalyse GmbH's (app licences).
const payments = paymentsFromEnv(process.env, 'shop');
const gmbhPayments = paymentsFromEnv(process.env, 'gmbh');
const mailer = mailTransportFromEnv();
const licenses = licenseClientFromEnv();
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
  // Printed name of a French, Italian … card (products created before it was known).
  'tcgdex.local-name': async (job) => {
    const lang = Object.values(TCGDEX_LOCAL_LANGS).find((l) => l === job.payload.lang);
    if (lang) await syncLocalName(sql, tcgdex, String(job.payload.card_ref), lang);
  },
  // App licences: keys from the licence service after payment, e-mail with invoice.
  'license.issue': async (job) => {
    if (!licenses) throw new Error('LICENSE_SERVICE_URL / LICENSE_SHOP_TOKEN not set');
    const r = await issueOrderLicenses(
      sql,
      licenses,
      Number(job.payload.order_id),
      new Date(),
      gmbhPayments,
    );
    console.log(`[licence] order ${String(job.payload.order_id)}: ${r}`);
  },
  'license.revoke': async (job) => {
    if (!licenses) throw new Error('LICENSE_SERVICE_URL / LICENSE_SHOP_TOKEN not set');
    const n = await revokeOrderLicenses(
      sql,
      licenses,
      Number(job.payload.order_id),
      String(job.payload.reason ?? 'refund'),
    );
    console.log(`[licence] order ${String(job.payload.order_id)}: revoked ${n}`);
  },
  // "Licence e-mail lost?" on the app page.
  'license.resend': async (job) => {
    if (!licenses) throw new Error('LICENSE_SERVICE_URL / LICENSE_SHOP_TOKEN not set');
    await resendLicensesByEmail(
      sql,
      licenses,
      String(job.payload.email),
      job.payload.locale === 'en' ? 'en' : 'de',
    );
  },
  // Invoice or credit note PDF requested in the admin before its mail went out.
  'document.render': async (job) => {
    await documentPdf(sql, Number(job.payload.document_id), await mailContext());
  },
};

/** Customer-facing jobs (licence keys right after payment) also run in the fast shop loop. */
const SHOP_JOBS = ['license.issue', 'license.revoke', 'license.resend'];

async function runJobs(kinds?: readonly string[]) {
  for (let i = 0; i < 10 && !stopping; i++) {
    const job = await claimJob(sql, kinds);
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

async function mailContext(): Promise<MailContext> {
  const rows = await sql<{ key: string; value: unknown }[]>`
    SELECT key, value FROM settings WHERE key IN ('company', 'shop_mailbox', 'license_seller')`;
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    baseUrl,
    mediaDir,
    company: (get('company') ?? {}) as MailContext['company'],
    replyTo: String(get('shop_mailbox') ?? 'order@overpricedcardboard.com'),
    licenses,
    licenseSeller: (get('license_seller') ?? null) as MailContext['licenseSeller'],
    gmbhPayments,
  };
}

/** Holds, refunds and mails: own loop every 5 s, so a long card sync never delays them. */
async function runShop() {
  await runJobs(SHOP_JOBS);
  for (const p of [payments, gmbhPayments]) {
    if (!p) continue;
    const n = await expireHolds(sql, p);
    if (n) console.log(`[holds] ${p.seller}: released ${n} expired reservation(s)`);
    await runPendingRefunds(sql, p);
  }
  if (mailer) {
    const sent = await sendDueMails(sql, mailer, await mailContext(), 10, (m) => console.error(m));
    if (sent) console.log(`[mail] sent ${sent}`);
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
  // French, Italian … products without their printed name.
  await fillLocalNames(sql);
  for (const m of await missingLocalNames(sql)) {
    await enqueueJob(sql, 'tcgdex.local-name', m, {
      dedupeKey: `tcgdex.local-name:${m.card_ref}:${m.lang}`,
    });
  }
  await requeueStaleJobs(sql);
  const carts = await deleteStaleCarts(sql);
  if (carts) console.log(`[carts] deleted ${carts} stale cart(s)`);
}

async function main() {
  console.log(
    `[worker] started (payments: ${payments?.name ?? 'off'}, GmbH payments: ${gmbhPayments?.name ?? 'off'}, mail: ${mailer?.name ?? 'off – mails stay queued'})`,
  );
  const shop = (async () => {
    while (!stopping) {
      try {
        await runShop();
      } catch (e) {
        console.error('[shop] loop error:', (e as Error).message);
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  })();
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
  await shop;
  await sql.end({ timeout: 10 });
  console.log('[worker] stopped');
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    stopping = true;
  });
}

await main();

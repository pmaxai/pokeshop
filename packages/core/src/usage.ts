// Usage services: S3 storage for recordings and the video pipeline (Automatic Content
// Processing). The shop switches them on per customer, keeps the S3 settings encrypted for the
// app (GET /api/app/v1/services/s3), takes the pipeline's usage reports (POST /api/v1/usage) and
// passes them on to Stripe's meters, which bill them with the customer's next invoice.
import { z } from 'zod';
import type { Db, Sql } from './db.ts';
import { decryptSecret, encryptSecret } from './secrets.ts';
import type { BillingProvider, TaxBehavior, UsageService } from './billing.ts';
import { netPrice, subscriptionPrices } from './subscriptions.ts';

export type { UsageService };

/** Stripe takes meter events up to 35 days back. */
export const MAX_USAGE_AGE_DAYS = 35;
export const UNIT: Record<UsageService, 'mb' | 'second'> = { s3: 'mb', pipeline: 'second' };

// ---------------------------------------------------------------------------
// Switching services on and off
// ---------------------------------------------------------------------------

export type ServiceState = {
  enabled: boolean;
  enabledAt: Date | null;
  enabledBy: string | null;
  disabledAt: Date | null;
  /** S3 only: settings saved */
  configured: boolean;
  configUpdatedAt: Date | null;
};

export async function serviceStates(
  db: Db,
  accountId: number,
): Promise<Record<UsageService, ServiceState>> {
  const rows = await db<
    {
      service: UsageService;
      enabled_at: Date;
      enabled_by: string | null;
      disabled_at: Date | null;
      configured: boolean;
      config_updated_at: Date | null;
    }[]
  >`
    SELECT service, enabled_at, enabled_by, disabled_at, config_enc IS NOT NULL AS configured,
           config_updated_at
      FROM account_services WHERE account_id = ${accountId}`;
  const state = (s: UsageService): ServiceState => {
    const r = rows.find((x) => x.service === s);
    return {
      enabled: Boolean(r && !r.disabled_at),
      enabledAt: r?.enabled_at ?? null,
      enabledBy: r?.enabled_by ?? null,
      disabledAt: r?.disabled_at ?? null,
      configured: Boolean(r?.configured),
      configUpdatedAt: r?.config_updated_at ?? null,
    };
  };
  return { s3: state('s3'), pipeline: state('pipeline') };
}

/** Switches a service on or off for a customer (the S3 settings are kept when it is off). */
export async function setService(
  db: Db,
  accountId: number,
  service: UsageService,
  on: boolean,
  by: string,
): Promise<void> {
  if (on) {
    await db`
      INSERT INTO account_services (account_id, service, enabled_by)
      VALUES (${accountId}, ${service}, ${by})
      ON CONFLICT (account_id, service) DO UPDATE
        SET enabled_at = CASE WHEN account_services.disabled_at IS NULL THEN account_services.enabled_at ELSE now() END,
            enabled_by = CASE WHEN account_services.disabled_at IS NULL THEN account_services.enabled_by ELSE ${by} END,
            disabled_at = NULL`;
  } else {
    await db`
      UPDATE account_services SET disabled_at = now()
       WHERE account_id = ${accountId} AND service = ${service} AND disabled_at IS NULL`;
  }
}

// ---------------------------------------------------------------------------
// S3 settings
// ---------------------------------------------------------------------------

export const S3_PROVIDERS = ['aws', 'exoscale', 'other'] as const;

export const S3ConfigInput = z.object({
  provider: z.enum(S3_PROVIDERS, 'invalid'),
  endpoint: z
    .string()
    .trim()
    .max(200, 'too_long')
    .refine((v) => /^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(v), 'invalid'),
  region: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,40}$/i, 'invalid'),
  bucket: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'invalid'),
  prefix: z
    .string()
    .trim()
    .max(200, 'too_long')
    .regex(/^[A-Za-z0-9!_.*'()/-]*$/, 'invalid'),
  access_key_id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9+/=_-]{8,128}$/, 'invalid'),
  /** empty when changing: the saved secret stays */
  secret_access_key: z.string().trim().max(256, 'too_long'),
});
export type S3Config = Omit<z.infer<typeof S3ConfigInput>, 'endpoint'> & { endpoint: string };

const fieldErrors = (issues: z.core.$ZodIssue[]) => {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const k = String(i.path[0] ?? '_');
    out[k] ??= i.message === 'too_long' ? 'too_long' : 'invalid';
  }
  return out;
};

/** Saves the S3 settings (encrypted with the master key). The service must be switched on. */
export async function saveS3Config(
  db: Db,
  accountId: number,
  input: unknown,
  masterKey: Buffer,
): Promise<{ ok: true } | { ok: false; errors: Record<string, string> }> {
  const r = S3ConfigInput.safeParse(input);
  if (!r.success) return { ok: false, errors: fieldErrors(r.error.issues) };
  const d = { ...r.data, endpoint: r.data.endpoint.replace(/\/$/, '') };
  const [row] = await db<{ config_enc: string | null }[]>`
    SELECT config_enc FROM account_services WHERE account_id = ${accountId} AND service = 's3'`;
  if (!row) return { ok: false, errors: { _: 'not_enabled' } };
  if (!d.secret_access_key) {
    const old = row.config_enc
      ? (JSON.parse(decryptSecret(row.config_enc, masterKey)) as S3Config)
      : null;
    if (!old?.secret_access_key) return { ok: false, errors: { secret_access_key: 'required' } };
    d.secret_access_key = old.secret_access_key;
  } else if (d.secret_access_key.length < 8) {
    return { ok: false, errors: { secret_access_key: 'invalid' } };
  }
  await db`
    UPDATE account_services SET config_enc = ${encryptSecret(JSON.stringify(d), masterKey)},
                                config_updated_at = now()
     WHERE account_id = ${accountId} AND service = 's3'`;
  return { ok: true };
}

/** The saved S3 settings, or null. */
export async function s3Config(
  db: Db,
  accountId: number,
  masterKey: Buffer,
): Promise<(S3Config & { updatedAt: Date }) | null> {
  const [row] = await db<{ config_enc: string | null; config_updated_at: Date | null }[]>`
    SELECT config_enc, config_updated_at FROM account_services
     WHERE account_id = ${accountId} AND service = 's3'`;
  if (!row?.config_enc) return null;
  const c = JSON.parse(decryptSecret(row.config_enc, masterKey)) as S3Config;
  return { ...c, updatedAt: row.config_updated_at ?? new Date(0) };
}

// ---------------------------------------------------------------------------
// Usage reports
// ---------------------------------------------------------------------------

export const UsageInput = z
  .object({
    account_id: z.string().regex(/^acc_[0-9a-z]{10}$/, 'invalid'),
    service: z.enum(['s3', 'pipeline'], 'invalid'),
    quantity: z.number('invalid').int('invalid').min(1, 'invalid').max(10_000_000, 'invalid'),
    unit: z.enum(['mb', 'second'], 'invalid'),
    occurred_at: z.iso.datetime({ offset: true, error: 'invalid' }),
    reference: z.string().trim().max(200, 'too_long').nullable().optional(),
  })
  .refine((v) => UNIT[v.service] === v.unit, { path: ['unit'], message: 'invalid' });

export type UsageEvent = {
  id: number;
  accountId: number;
  publicId: string;
  service: UsageService;
  quantity: number;
  unit: 'mb' | 'second';
  occurredAt: Date;
  reference: string | null;
  createdAt: Date;
  billing: 'queued' | 'sent' | 'not_billed' | 'failed';
  billingError: string | null;
};

type UsageRow = {
  id: number;
  account_id: number;
  public_id: string;
  service: UsageService;
  quantity: number;
  unit: 'mb' | 'second';
  occurred_at: Date;
  reference: string | null;
  created_at: Date;
  billing: UsageEvent['billing'];
  billing_error: string | null;
};

const toEvent = (r: UsageRow): UsageEvent => ({
  id: Number(r.id),
  accountId: Number(r.account_id),
  publicId: r.public_id,
  service: r.service,
  quantity: r.quantity,
  unit: r.unit,
  occurredAt: r.occurred_at,
  reference: r.reference,
  createdAt: r.created_at,
  billing: r.billing,
  billingError: r.billing_error,
});

export type RecordUsageResult =
  | { ok: true; event: UsageEvent }
  | {
      ok: false;
      status: 400 | 404 | 409;
      code: 'invalid_request' | 'unknown_account' | 'service_not_enabled';
      fields?: Record<string, string>;
    };

/** Takes a usage report of the pipeline. */
export async function recordUsage(
  db: Db,
  input: unknown,
  opts: { apiClientId?: number | null; now?: Date } = {},
): Promise<RecordUsageResult> {
  const r = UsageInput.safeParse(input);
  if (!r.success) {
    return { ok: false, status: 400, code: 'invalid_request', fields: fieldErrors(r.error.issues) };
  }
  const d = r.data;
  const now = opts.now ?? new Date();
  const at = new Date(d.occurred_at);
  if (
    at.getTime() > now.getTime() + 5 * 60_000 ||
    at.getTime() < now.getTime() - MAX_USAGE_AGE_DAYS * 86400_000
  ) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_request',
      fields: { occurred_at: 'out_of_range' },
    };
  }
  const [a] = await db<{ id: number; enabled: boolean }[]>`
    SELECT a.id, EXISTS (SELECT 1 FROM account_services s
                          WHERE s.account_id = a.id AND s.service = ${d.service} AND s.disabled_at IS NULL) AS enabled
      FROM accounts a WHERE a.public_id = ${d.account_id}`;
  if (!a) return { ok: false, status: 404, code: 'unknown_account' };
  if (!a.enabled) return { ok: false, status: 409, code: 'service_not_enabled' };
  const [row] = await db<UsageRow[]>`
    INSERT INTO usage_events (account_id, service, quantity, unit, occurred_at, reference, api_client_id)
    VALUES (${a.id}, ${d.service}, ${d.quantity}, ${d.unit}, ${at}, ${d.reference || null},
            ${opts.apiClientId ?? null})
    RETURNING *, ${d.account_id}::text AS public_id`;
  return { ok: true, event: toEvent(row!) };
}

/** The API's answer for a report (docs/app-account-api.md, part 3). */
export const usageJson = (e: UsageEvent) => ({
  id: e.id,
  account_id: e.publicId,
  service: e.service,
  quantity: e.quantity,
  unit: e.unit,
  occurred_at: e.occurredAt.toISOString(),
  reference: e.reference,
  billed: e.billing,
});

export type UsageTotals = {
  since: Date;
  s3: { mb: number; cents: number | null };
  pipeline: { seconds: number; cents: number | null };
};

/**
 * Usage since a time (the start of the billing period), with the cost at the current prices
 * (incl. VAT; Stripe's invoice is what counts).
 */
export async function usageSince(db: Db, accountId: number, since: Date): Promise<UsageTotals> {
  const [rows, prices] = await Promise.all([
    db<{ service: UsageService; total: number }[]>`
      SELECT service, sum(quantity)::bigint::float8 AS total FROM usage_events
       WHERE account_id = ${accountId} AND occurred_at >= ${since} AND billing <> 'failed'
       GROUP BY service`,
    subscriptionPrices(db),
  ]);
  const total = (s: UsageService) => Number(rows.find((r) => r.service === s)?.total ?? 0);
  const mb = total('s3');
  const seconds = total('pipeline');
  return {
    since,
    s3: { mb, cents: prices.s3_gb === null ? null : Math.round((mb / 1024) * prices.s3_gb) },
    pipeline: {
      seconds,
      cents:
        prices.pipeline_minute === null
          ? null
          : Math.round((seconds / 60) * prices.pipeline_minute),
    },
  };
}

/** Start of the customer's billing period: a month before its end, else the calendar month. */
export async function billingPeriodStart(db: Db, accountId: number): Promise<Date> {
  const [r] = await db<{ start: Date }[]>`
    SELECT coalesce(
             (SELECT current_period_end - interval '1 month' FROM subscriptions
               WHERE account_id = ${accountId} AND source = 'stripe' AND current_period_end > now()),
             date_trunc('month', now() AT TIME ZONE 'Europe/Vienna') AT TIME ZONE 'Europe/Vienna'
           ) AS start`;
  return r!.start;
}

export async function recentUsage(db: Db, accountId: number, limit = 20): Promise<UsageEvent[]> {
  const rows = await db<UsageRow[]>`
    SELECT u.*, a.public_id FROM usage_events u JOIN accounts a ON a.id = u.account_id
     WHERE u.account_id = ${accountId} ORDER BY u.occurred_at DESC, u.id DESC LIMIT ${limit}`;
  return rows.map(toEvent);
}

// ---------------------------------------------------------------------------
// Worker: usage to Stripe
// ---------------------------------------------------------------------------

const RUNNING = ['active', 'trialing', 'past_due'];

/**
 * Sends queued usage to Stripe's meters. The metered price is added to the customer's
 * subscription on first use. Usage of a customer without a paid Stripe subscription (free
 * subscription) is kept but not billed. A Stripe hiccup leaves the report queued for the next run.
 */
export async function reportUsage(
  sql: Sql,
  billing: BillingProvider,
  opts: { now?: Date; limit?: number } = {},
): Promise<{ sent: number; notBilled: number; failed: number; waiting: number }> {
  const now = opts.now ?? new Date();
  const out = { sent: 0, notBilled: 0, failed: 0, waiting: 0 };
  const queued = await sql<UsageRow[]>`
    SELECT u.*, a.public_id FROM usage_events u JOIN accounts a ON a.id = u.account_id
     WHERE u.billing = 'queued' ORDER BY u.id LIMIT ${opts.limit ?? 500}`;
  if (queued.length === 0) return out;
  const prices = await subscriptionPrices(sql);
  const mark = async (
    ids: number[],
    billingState: UsageEvent['billing'],
    error: string | null = null,
  ) => {
    if (ids.length === 0) return;
    await sql`
      UPDATE usage_events SET billing = ${billingState}, billing_error = ${error},
                              billed_at = CASE WHEN ${billingState} = 'sent' THEN now() ELSE billed_at END
       WHERE id = ANY(${ids}::bigint[])`;
  };
  const byAccount = new Map<number, UsageEvent[]>();
  for (const r of queued) {
    const e = toEvent(r);
    byAccount.set(e.accountId, [...(byAccount.get(e.accountId) ?? []), e]);
  }
  for (const [accountId, events] of byAccount) {
    const tooOld = events.filter(
      (e) => e.occurredAt.getTime() < now.getTime() - MAX_USAGE_AGE_DAYS * 86400_000,
    );
    await mark(
      tooOld.map((e) => e.id),
      'failed',
      'older than 35 days',
    );
    out.failed += tooOld.length;
    const open = events.filter((e) => !tooOld.includes(e));
    if (open.length === 0) continue;
    const [s] = await sql<
      { stripe_subscription_id: string | null; tax_behavior: TaxBehavior | null; status: string }[]
    >`
      SELECT stripe_subscription_id, tax_behavior, status FROM subscriptions
       WHERE account_id = ${accountId} AND source = 'stripe'`;
    const sub =
      s?.stripe_subscription_id && RUNNING.includes(s.status)
        ? await billing.getSubscription(s.stripe_subscription_id)
        : null;
    if (!sub || !RUNNING.includes(sub.status)) {
      await mark(
        open.map((e) => e.id),
        'not_billed',
      );
      out.notBilled += open.length;
      continue;
    }
    const behavior: TaxBehavior = sub.behavior ?? s?.tax_behavior ?? 'incl';
    for (const service of ['s3', 'pipeline'] as const) {
      const list = open.filter((e) => e.service === service);
      if (list.length === 0) continue;
      if (!sub.metered[service]) {
        const gross = service === 's3' ? prices.s3_gb : prices.pipeline_minute;
        if (gross === null) {
          // no price set yet: keep it until the shop sets one (Admin › Abo-Preise)
          await mark(
            list.map((e) => e.id),
            'queued',
            'no price set',
          );
          out.waiting += list.length;
          continue;
        }
        const cents = behavior === 'excl' ? netPrice(gross) : gross;
        const item = await billing.addMeteredItem(sub.id, service, cents, behavior);
        sub.metered[service] = item;
        await sql`
          UPDATE account_services SET stripe_item_id = ${item}
           WHERE account_id = ${accountId} AND service = ${service}`;
      }
      for (const e of list) {
        try {
          await billing.meterEvent({
            service,
            customerId: sub.customerId,
            value: e.quantity,
            timestamp: e.occurredAt,
            identifier: `oc_usage_${e.id}`,
          });
          await mark([e.id], 'sent');
          out.sent++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          const msg = (err as Error).message.slice(0, 500);
          if (status && status >= 400 && status < 500 && status !== 429) {
            await mark([e.id], 'failed', msg);
            out.failed++;
          } else {
            await mark([e.id], 'queued', msg);
            out.waiting++;
          }
        }
      }
    }
  }
  return out;
}

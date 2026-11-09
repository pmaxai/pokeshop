/**
 * Licences for the ScanPM app, sold in the shop. A purchase is an order of kind 'license':
 * no cards and no shipping, paid through the same Stripe checkout as card orders. After the
 * payment the worker asks the licence service for the keys, issues the invoice and e-mails
 * key, QR code and download link (job 'license.issue').
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Db, Sql } from './db.ts';
import { issueCreditNoteForLicense, issueInvoice } from './fulfilment.ts';
import { enqueueJob } from './jobs.ts';
import { currentLegalVersions } from './legal.ts';
import type { LicenseClient } from './license-client.ts';
import { newOrderNumber } from './numbering.ts';
import { orderEvent, type CreatedOrder } from './orders.ts';
import { alertShop, enqueueMail } from './outbox.ts';
import type { PaymentProvider } from './payments.ts';
import { STRIPE_MIN_SESSION_MINUTES } from './reservation.ts';
import { orderVat } from './vat.ts';

export const APP_NAME = 'ScanPM';
/** Five licences at € 80 stay within a small-amount invoice (≤ € 400). */
export const MAX_LICENSES_PER_ORDER = 5;

// ---------------------------------------------------------------------------
// Checkout form
// ---------------------------------------------------------------------------

const required = (max: number) => z.string().trim().min(1, 'required').max(max, 'too_long');

export const LicenseCheckout = z.object({
  name: required(100),
  company: z
    .string()
    .trim()
    .max(100, 'too_long')
    .transform((v) => v || undefined)
    .optional(),
  email: z.email('invalid_email').trim().toLowerCase().max(200, 'too_long'),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'required'),
  quantity: z.coerce
    .number('invalid')
    .int('invalid')
    .min(1, 'invalid')
    .max(MAX_LICENSES_PER_ORDER, 'too_many'),
  acceptTerms: z.literal(true, 'terms'),
  /** § 18 Abs. 1 Z 11 FAGG: start right away, the right of withdrawal ends with delivery. */
  immediateDelivery: z.literal(true, 'consent'),
});
export type LicenseCheckout = z.infer<typeof LicenseCheckout>;

export function validateLicenseCheckout(
  input: unknown,
): { ok: true; data: LicenseCheckout } | { ok: false; errors: Record<string, string> } {
  const r = LicenseCheckout.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  const errors: Record<string, string> = {};
  for (const i of r.error.issues) {
    const k = i.path.join('.') || '_';
    errors[k] ??= i.message.startsWith('Invalid') ? 'invalid' : i.message;
  }
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------
// What is on sale
// ---------------------------------------------------------------------------

export type AppRelease = {
  id: number;
  version: string;
  storageKey: string;
  sizeBytes: number;
  sha256: string;
  notes: string | null;
  uploadedBy: string;
  createdAt: Date;
};

type ReleaseRow = {
  id: number;
  version: string;
  storage_key: string;
  size_bytes: string | number;
  sha256: string;
  notes: string | null;
  uploaded_by: string;
  created_at: Date;
};

const release = (r: ReleaseRow): AppRelease => ({
  id: Number(r.id),
  version: r.version,
  storageKey: r.storage_key,
  sizeBytes: Number(r.size_bytes),
  sha256: r.sha256,
  notes: r.notes,
  uploadedBy: r.uploaded_by,
  createdAt: r.created_at,
});

export async function listReleases(db: Db, limit = 20): Promise<AppRelease[]> {
  const rows = await db<ReleaseRow[]>`
    SELECT * FROM app_releases ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
  return rows.map(release);
}

export async function currentRelease(db: Db): Promise<AppRelease | null> {
  return (await listReleases(db, 1))[0] ?? null;
}

export async function addRelease(
  db: Db,
  input: {
    version: string;
    storageKey: string;
    sizeBytes: number;
    sha256: string;
    notes?: string | null;
    uploadedBy: string;
  },
): Promise<AppRelease> {
  const [r] = await db<ReleaseRow[]>`
    INSERT INTO app_releases (version, storage_key, size_bytes, sha256, notes, uploaded_by)
    VALUES (${input.version.trim()}, ${input.storageKey}, ${input.sizeBytes}, ${input.sha256},
            ${input.notes?.trim() || null}, ${input.uploadedBy})
    RETURNING *`;
  return release(r!);
}

export type AppSales = {
  priceCents: number;
  /** Set once the app is in the Play Store: replaces the APK download. */
  playStoreUrl: string | null;
  release: AppRelease | null;
  /** Licences can be bought: the licence service is set up and there is something to install. */
  open: boolean;
};

export async function appSales(db: Db, serviceConfigured: boolean): Promise<AppSales> {
  const rows = await db<{ key: string; value: unknown }[]>`
    SELECT key, value FROM settings WHERE key IN ('app_license_price_cents', 'app_play_store_url')`;
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const price = Number(get('app_license_price_cents') ?? 8000);
  const store = get('app_play_store_url');
  const playStoreUrl = typeof store === 'string' && store.startsWith('https://') ? store : null;
  const rel = await currentRelease(db);
  return {
    priceCents: Number.isInteger(price) && price > 0 ? price : 8000,
    playStoreUrl,
    release: rel,
    open: serviceConfigured && (rel !== null || playStoreUrl !== null),
  };
}

export const AppSettings = z.object({
  priceCents: z.number().int().min(100).max(100_000),
  playStoreUrl: z
    .string()
    .trim()
    .max(300)
    .refine(
      (v) => v === '' || /^https:\/\/play\.google\.com\/store\/apps\/details\?id=[\w.]+/.test(v),
      {
        message: 'play_store_url',
      },
    ),
});

export async function saveAppSettings(sql: Sql, input: z.infer<typeof AppSettings>): Promise<void> {
  const v = AppSettings.parse(input);
  await sql.begin(async (tx) => {
    for (const [key, value] of [
      ['app_license_price_cents', v.priceCents],
      ['app_play_store_url', v.playStoreUrl || null],
    ] as const) {
      const json = value === null ? tx`'null'::jsonb` : tx`${tx.json(value as never)}`;
      await tx`INSERT INTO settings (key, value) VALUES (${key}, ${json})
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    }
  });
}

// ---------------------------------------------------------------------------
// The order
// ---------------------------------------------------------------------------

export class LicenseCheckoutRejected extends Error {
  readonly code: 'country' | 'closed';
  constructor(code: 'country' | 'closed') {
    super(`licence checkout rejected: ${code}`);
    this.code = code;
  }
}

/** Creates the unpaid order; startPayment then opens the Stripe page for it. */
export async function createLicenseOrder(
  sql: Sql,
  input: {
    locale: 'de' | 'en';
    details: LicenseCheckout;
    priceCents: number;
    ossEnabled: boolean;
    smallBusiness: boolean;
    now?: Date;
  },
): Promise<CreatedOrder> {
  const now = input.now ?? new Date();
  const d = input.details;
  return sql.begin(async (tx) => {
    const [country] = await tx<{ code: string; vat_rate_bp: number }[]>`
      SELECT code, vat_rate_bp FROM countries WHERE code = ${d.country} AND is_eu`;
    if (!country) throw new LicenseCheckoutRejected('country');
    const total = input.priceCents * d.quantity;
    const vat = orderVat([{ gross: total }], {
      country: country.code,
      ossEnabled: input.ossEnabled,
      smallBusiness: input.smallBusiness,
      rates: { [country.code]: country.vat_rate_bp },
    });
    const legal = await currentLegalVersions(tx);
    let number = '';
    for (let i = 0; i < 6 && !number; i++) {
      const candidate = newOrderNumber(now);
      const [taken] = await tx`SELECT 1 FROM orders WHERE number = ${candidate}`;
      if (!taken) number = candidate;
    }
    if (!number) throw new Error('could not allocate an order number');
    const token = randomBytes(24).toString('base64url');
    // Nothing is held; the order just lives as long as its Stripe page.
    const until = new Date(now.getTime() + (STRIPE_MIN_SESSION_MINUTES + 5) * 60_000);
    const billing = { name: d.name, company: d.company, country: country.code };
    const [o] = await tx<{ id: number }[]>`
      INSERT INTO orders (number, lookup_token, kind, status, locale, country, email, customer_name,
                          billing_address, goods_cents, shipping_cents, total_cents,
                          shipping_method, vat_regime, tax_country, vat_rate_bp, vat_cents,
                          reserved_until, agb_version, privacy_version, withdrawal_version,
                          terms_accepted_at, created_at)
      VALUES (${number}, ${token}, 'license', 'checkout', ${input.locale}, ${country.code}, ${d.email},
              ${d.name}, ${tx.json(billing as never)}, ${total}, 0, ${total}, 'none',
              ${vat.regime}, ${vat.taxCountry}, ${vat.rate}, ${vat.vat}, ${until},
              ${legal.agb}, ${legal.privacy}, ${legal.withdrawal}, ${now}, ${now})
      RETURNING id`;
    await tx`
      INSERT INTO order_licenses (order_id, quantity, unit_price_cents, immediate_delivery_consent_at)
      VALUES (${o!.id}, ${d.quantity}, ${input.priceCents}, ${now})`;
    await orderEvent(tx, o!.id, 'created', { kind: 'license', quantity: d.quantity });
    return {
      id: o!.id,
      number,
      token,
      totalCents: total,
      reservedUntil: until,
      replacedSessions: [],
    };
  });
}

/** Payment page line for a licence order, in the buyer's language. */
export async function licensePaymentLine(db: Db, orderId: number, locale: 'de' | 'en') {
  const [l] = await db<{ quantity: number; unit_price_cents: number }[]>`
    SELECT quantity, unit_price_cents FROM order_licenses WHERE order_id = ${orderId}`;
  if (!l) return null;
  return {
    name: locale === 'en' ? `${APP_NAME} licence (beta)` : `${APP_NAME}-Lizenz (Beta)`,
    description:
      locale === 'en'
        ? 'One-off licence for the Android app, one device at a time, updates included'
        : 'Einmal-Lizenz für die Android-App, ein Gerät gleichzeitig, inkl. Updates',
    unitAmount: l.unit_price_cents,
    quantity: l.quantity,
  };
}

/** Invoice and credit-note line for the licences. */
export function licenseDocumentLine(quantity: number, unitCents: number) {
  return {
    de: `${APP_NAME} – Einmal-Lizenz für die Android-App (Beta), inkl. Updates`,
    en: `${APP_NAME} – one-off licence for the Android app (beta), updates included`,
    quantity,
    unit_cents: unitCents,
  };
}

/**
 * Inside the payment transaction (processPaidSession): marks the order paid and queues the
 * licence delivery. Keys come from the licence service, which is called outside the database
 * transaction by the worker.
 */
export async function licenseOrderPaid(
  tx: Db,
  o: { id: number; number: string; total_cents: number },
  now: Date,
): Promise<void> {
  await tx`UPDATE orders SET status = 'paid', paid_at = ${now}, reserved_until = NULL
            WHERE id = ${o.id}`;
  await enqueueJob(tx, 'license.issue', { order_id: o.id }, { dedupeKey: `license.issue:${o.id}` });
  await alertShop(
    tx,
    `${APP_NAME}-Lizenz verkauft: ${o.number}`,
    `Bezahlt: ${(o.total_cents / 100).toFixed(2).replace('.', ',')} €. Der Schlüssel geht automatisch per E-Mail an den Kunden.`,
    `license_sold:${o.id}`,
  );
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

type LicenseOrderRow = {
  id: number;
  number: string;
  status: string;
  locale: 'de' | 'en';
  email: string | null;
  customer_name: string | null;
  lookup_token: string;
  quantity: number;
  unit_price_cents: number;
  license_ids: string[];
  issued_at: Date | null;
  revoked_at: Date | null;
};

async function licenseOrderRow(db: Db, orderId: number, lock = false) {
  const [o] = await db<LicenseOrderRow[]>`
    SELECT o.id, o.number, o.status, o.locale, o.email, o.customer_name, o.lookup_token,
           l.quantity, l.unit_price_cents, l.license_ids, l.issued_at, l.revoked_at
      FROM orders o JOIN order_licenses l ON l.order_id = o.id
     WHERE o.id = ${orderId} AND o.kind = 'license'
     ${lock ? db`FOR UPDATE OF o, l` : db``}`;
  return o ?? null;
}

/**
 * Worker job 'license.issue': gets the keys for a paid order (the service answers a retry
 * with the same keys), issues the invoice and queues the e-mail. Safe to run twice.
 */
export async function issueOrderLicenses(
  sql: Sql,
  client: LicenseClient,
  orderId: number,
  now = new Date(),
): Promise<'issued' | 'already' | 'skipped'> {
  const o = await licenseOrderRow(sql, orderId);
  if (!o) throw new Error(`licence order ${orderId} not found`);
  if (o.issued_at) return 'already';
  if (o.status !== 'paid') return 'skipped';
  if (!o.email) throw new Error(`licence order ${o.number} has no e-mail address`);
  const licenses = await client.issue({
    orderRef: o.number,
    email: o.email,
    name: o.customer_name ?? '',
    count: o.quantity,
  });
  return sql.begin(async (tx) => {
    const cur = await licenseOrderRow(tx, orderId, true);
    if (!cur || cur.issued_at) return 'already' as const;
    if (cur.status !== 'paid') return 'skipped' as const;
    await tx`UPDATE order_licenses SET license_ids = ${licenses.map((l) => l.id)}::text[], issued_at = ${now}
              WHERE order_id = ${orderId}`;
    const invoice = await issueInvoice(tx, orderId, now);
    await tx`UPDATE orders SET status = 'completed' WHERE id = ${orderId} AND status = 'paid'`;
    // Licence, invoice and – on a durable medium – terms, withdrawal information and the
    // confirmation that the right of withdrawal ended with delivery (§ 7 Abs. 3 FAGG).
    await enqueueMail(tx, {
      template: 'license_delivery',
      to: cur.email!,
      locale: cur.locale,
      payload: { order_id: orderId },
      attachments: [
        ...(invoice ? [{ kind: 'document' as const, id: invoice.id }] : []),
        { kind: 'legal', kinds: ['agb', 'withdrawal'] },
      ],
      dedupeKey: `license_delivery:${orderId}`,
    });
    await orderEvent(tx, orderId, 'licenses_issued', {
      licenses: licenses.map((l) => l.id),
      invoice: invoice?.number ?? null,
    });
    return 'issued' as const;
  });
}

/** Admin: sends the licence e-mail of an order again (keys, QR codes, download link). */
export async function resendOrderLicenses(db: Db, orderId: number, actor: string): Promise<void> {
  const o = await licenseOrderRow(db, orderId);
  if (!o?.issued_at || !o.email) throw new Error('Diese Bestellung hat noch keine Lizenzen.');
  await enqueueMail(db, {
    template: 'license_delivery',
    to: o.email,
    locale: o.locale,
    payload: { order_id: orderId, again: true },
    dedupeKey: `license_delivery:${orderId}:${Date.now()}`,
  });
  await orderEvent(db, orderId, 'license_mail_resent', {}, actor);
}

/**
 * "Licence e-mail lost?" on the app page. Always answers the same, so nobody can find out
 * which addresses bought a licence; at most one look-up per address and hour.
 */
export async function requestLicenseResend(
  db: Db,
  email: string,
  locale: 'de' | 'en',
  now = new Date(),
): Promise<void> {
  const addr = email.trim().toLowerCase();
  if (!z.email().safeParse(addr).success || addr.length > 200) return;
  const hour = now.toISOString().slice(0, 13);
  await enqueueJob(
    db,
    'license.resend',
    { email: addr, locale },
    { dedupeKey: `license.resend:${addr}:${hour}`, maxAttempts: 3 },
  );
}

/** Worker job 'license.resend': mails the address its licences, if it has any. */
export async function resendLicensesByEmail(
  db: Db,
  client: LicenseClient,
  email: string,
  locale: 'de' | 'en',
  now = new Date(),
): Promise<number> {
  const licenses = (await client.byEmail(email)).filter((l) => !l.revoked_at);
  if (!licenses.length) return 0;
  await enqueueMail(db, {
    template: 'license_resend',
    to: email,
    locale,
    payload: { license_ids: licenses.map((l) => l.id) },
    dedupeKey: `license_resend:${email}:${now.toISOString().slice(0, 13)}`,
  });
  return licenses.length;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export type LicenseOrderView = {
  id: number;
  number: string;
  status: string;
  locale: 'de' | 'en';
  email: string | null;
  name: string | null;
  quantity: number;
  totalCents: number;
  paidAt: Date | null;
  issuedAt: Date | null;
  /** Paid, keys issued and not refunded: the APK may be downloaded. */
  canDownload: boolean;
};

export async function licenseOrderByToken(db: Db, token: string): Promise<LicenseOrderView | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [o] = await db<(LicenseOrderRow & { total_cents: number; paid_at: Date | null })[]>`
    SELECT o.id, o.number, o.status, o.locale, o.email, o.customer_name, o.total_cents, o.paid_at,
           l.quantity, l.issued_at, l.revoked_at
      FROM orders o JOIN order_licenses l ON l.order_id = o.id
     WHERE o.lookup_token = ${token} AND o.kind = 'license'`;
  if (!o) return null;
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    locale: o.locale,
    email: o.email,
    name: o.customer_name,
    quantity: o.quantity,
    totalCents: o.total_cents,
    paidAt: o.paid_at,
    issuedAt: o.issued_at,
    canDownload: ['paid', 'completed'].includes(o.status) && !o.revoked_at,
  };
}

export async function recordDownload(db: Db, orderId: number): Promise<void> {
  await db`UPDATE order_licenses SET downloads = downloads + 1, last_download_at = now()
            WHERE order_id = ${orderId}`;
}

/** Path of the download link in e-mails (the order's secret token is the credential). */
export const downloadPath = (token: string) => `/api/app/download/${token}`;

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/**
 * Worker job 'license.revoke': the order was refunded, so its keys stop working. The app
 * locks at its next online check.
 */
export async function revokeOrderLicenses(
  sql: Sql,
  client: LicenseClient,
  orderId: number,
  reason: string,
): Promise<number> {
  const o = await licenseOrderRow(sql, orderId);
  if (!o) return 0;
  for (const id of o.license_ids) await client.revoke(id, reason);
  await sql`UPDATE order_licenses SET revoked_at = coalesce(revoked_at, now()) WHERE order_id = ${orderId}`;
  if (o.license_ids.length) {
    await orderEvent(sql, orderId, 'licenses_revoked', { licenses: o.license_ids, reason });
  }
  return o.license_ids.length;
}

/** Called when a licence order is refunded in full (admin, or the Stripe dashboard). */
export async function queueLicenseRevoke(db: Db, orderId: number, reason: string): Promise<void> {
  await enqueueJob(
    db,
    'license.revoke',
    { order_id: orderId, reason },
    { dedupeKey: `license.revoke:${orderId}` },
  );
}

/**
 * Admin: refunds a licence order in full and revokes its keys. A correction document is
 * issued when the order had an invoice.
 */
export async function refundLicenseOrder(
  sql: Sql,
  provider: PaymentProvider,
  input: { orderId: number; actor: string; reason: string },
  now = new Date(),
): Promise<{ amount: number; creditNote: string | null }> {
  const prep = await sql.begin(async (tx) => {
    const [o] = await tx<
      {
        id: number;
        status: string;
        total_cents: number;
        refunded_cents: number;
        stripe_payment_intent_id: string | null;
      }[]
    >`SELECT id, status, total_cents, refunded_cents, stripe_payment_intent_id
        FROM orders WHERE id = ${input.orderId} AND kind = 'license' FOR UPDATE`;
    if (!o) throw new Error('Lizenzbestellung nicht gefunden.');
    if (!['paid', 'completed'].includes(o.status))
      throw new Error('Diese Bestellung kann nicht erstattet werden.');
    if (!o.stripe_payment_intent_id) throw new Error('Zu dieser Bestellung gibt es keine Zahlung.');
    const amount = o.total_cents - o.refunded_cents;
    if (amount <= 0) throw new Error('Es ist nichts mehr zu erstatten.');
    const [r] = await tx<{ id: number }[]>`
      INSERT INTO refunds (order_id, amount_cents, shipping_cents, reason, status, created_by)
      VALUES (${o.id}, ${amount}, 0, ${input.reason.trim().slice(0, 500) || null}, 'pending', ${input.actor})
      RETURNING id`;
    return { refundId: r!.id, amount, pi: o.stripe_payment_intent_id };
  });
  let stripeId: string;
  try {
    stripeId = (
      await provider.refund({
        paymentIntentId: prep.pi,
        amount: prep.amount,
        idempotencyKey: `refund-${prep.refundId}`,
      })
    ).id;
  } catch (e) {
    await sql`UPDATE refunds SET status = 'failed', error = ${(e as Error).message.slice(0, 1000)}
               WHERE id = ${prep.refundId}`;
    throw new Error(`Stripe hat die Erstattung abgelehnt: ${(e as Error).message}`);
  }
  return sql.begin(async (tx) => {
    await tx`UPDATE refunds SET status = 'succeeded', stripe_refund_id = ${stripeId} WHERE id = ${prep.refundId}`;
    const [o] = await tx<{ email: string | null; locale: 'de' | 'en' }[]>`
      UPDATE orders SET refunded_cents = refunded_cents + ${prep.amount}, status = 'refunded'
       WHERE id = ${input.orderId} RETURNING email, locale`;
    const credit = await issueCreditNoteForLicense(tx, input.orderId, prep.refundId, now);
    await queueLicenseRevoke(tx, input.orderId, `refund ${prep.refundId}`);
    if (o?.email) {
      await enqueueMail(tx, {
        template: 'refund_issued',
        to: o.email,
        locale: o.locale,
        payload: { order_id: input.orderId, refund_id: prep.refundId },
        attachments: credit ? [{ kind: 'document', id: credit.id }] : [],
        dedupeKey: `refund_issued:${prep.refundId}`,
      });
    }
    await orderEvent(
      tx,
      input.orderId,
      'refunded',
      { amount: prep.amount, refund: stripeId, credit_note: credit?.number ?? null },
      input.actor,
    );
    return { amount: prep.amount, creditNote: credit?.number ?? null };
  });
}

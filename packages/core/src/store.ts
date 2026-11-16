// Subscriptions bought in the app stores. Google Play now; the App Store follows with the iOS app
// (same tables and rules). The app reports a purchase (POST /api/app/v1/store/google), Google
// notifies every change (Pub/Sub), a daily job re-reads what is about to run out. Each time the
// server reads the subscription from Google and stores what Google says; it never acts on a
// notification type alone. See docs/app-account-api.md and docs/deploy.md.
import { z } from 'zod';
import type { Db, Sql } from './db.ts';
import { signRs256 } from './jwt.ts';
import { entitlements, websiteSubscription, type Plan } from './subscriptions.ts';

export type Store = 'google_play' | 'app_store';

/** The Play edition's application id (GOOGLE_PLAY_PACKAGE). */
export const googlePlayPackage = () =>
  process.env.GOOGLE_PLAY_PACKAGE?.trim() || 'com.overpricedcardboard.app';

/** Where a store subscription is managed (cancelled, changed). */
export function storeManageUrl(store: Store, productId: string | null | undefined): string {
  if (store === 'app_store') return 'https://apps.apple.com/account/subscriptions';
  const q = new URLSearchParams({
    ...(productId ? { sku: productId } : {}),
    package: googlePlayPackage(),
  });
  return `https://play.google.com/store/account/subscriptions?${q}`;
}
export type StoreState =
  'pending' | 'active' | 'canceled' | 'grace' | 'on_hold' | 'paused' | 'expired' | 'revoked';
export type Period = 'monthly' | 'yearly';

// ---------------------------------------------------------------------------
// What is on sale (Admin › App-Stores)
// ---------------------------------------------------------------------------

const googleId = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._]{0,149}$/, 'invalid')
  .nullable();
const basePlanId = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'invalid')
  .nullable();
const appleId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/, 'invalid')
  .nullable();
const empty = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

const GooglePlan = z.object({
  product_id: z.preprocess(empty, googleId),
  base_plans: z.object({
    monthly: z.preprocess(empty, basePlanId),
    yearly: z.preprocess(empty, basePlanId),
  }),
});
const ApplePlan = z.object({
  monthly: z.preprocess(empty, appleId),
  yearly: z.preprocess(empty, appleId),
});
export const StoreProducts = z.object({
  google: z.object({ collector: GooglePlan, creator: GooglePlan }),
  apple: z.object({ collector: ApplePlan, creator: ApplePlan }),
});
export type StoreProducts = z.infer<typeof StoreProducts>;

const EMPTY_PRODUCTS: StoreProducts = {
  google: {
    collector: { product_id: null, base_plans: { monthly: null, yearly: null } },
    creator: { product_id: null, base_plans: { monthly: null, yearly: null } },
  },
  apple: {
    collector: { monthly: null, yearly: null },
    creator: { monthly: null, yearly: null },
  },
};

export async function storeProducts(db: Db): Promise<StoreProducts> {
  const [r] = await db<
    { value: unknown }[]
  >`SELECT value FROM settings WHERE key = 'store_products'`;
  const p = StoreProducts.safeParse(r?.value);
  return p.success ? p.data : EMPTY_PRODUCTS;
}

export async function saveStoreProducts(
  db: Db,
  input: unknown,
): Promise<{ ok: true; products: StoreProducts } | { ok: false; errors: string[] }> {
  const p = StoreProducts.safeParse(input);
  if (!p.success) return { ok: false, errors: p.error.issues.map((i) => i.path.join('.')) };
  const v = p.data;
  const g = [v.google.collector.product_id, v.google.creator.product_id].filter(Boolean);
  if (new Set(g).size !== g.length) return { ok: false, errors: ['google.creator.product_id'] };
  await db`
    INSERT INTO settings (key, value) VALUES ('store_products', ${db.json(v)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  return { ok: true, products: v };
}

/** The plan and period of a Google product + base plan, or null when it isn't on sale. */
export function googlePlanOf(
  products: StoreProducts,
  productId: string,
  basePlan: string | null,
): { plan: Plan; period: Period | null } | null {
  for (const plan of ['collector', 'creator'] as const) {
    const p = products.google[plan];
    if (p.product_id && p.product_id === productId) {
      const period =
        basePlan && basePlan === p.base_plans.yearly
          ? 'yearly'
          : basePlan && basePlan === p.base_plans.monthly
            ? 'monthly'
            : null;
      return { plan, period };
    }
  }
  return null;
}

/** GET /store/offers: the plans on sale, with the stores' product ids. */
export function storeOffers(products: StoreProducts) {
  const features = {
    collector: ['scanner', 'trading', 'collection', 'wanted'],
    creator: ['scanner', 'trading', 'youtube', 'recording', 'collection', 'wanted'],
  };
  return (['collector', 'creator'] as const).map((plan) => ({
    plan,
    name: plan === 'collector' ? 'Collector' : 'Creator',
    features: features[plan],
    google: products.google[plan].product_id
      ? {
          product_id: products.google[plan].product_id,
          base_plans: products.google[plan].base_plans,
        }
      : null,
    apple:
      products.apple[plan].monthly || products.apple[plan].yearly
        ? { product_ids: products.apple[plan] }
        : null,
  }));
}

// ---------------------------------------------------------------------------
// Google Play Developer API
// ---------------------------------------------------------------------------

/** Google didn't answer (or answered 5xx/429): keep the purchase and try again. */
export class StoreUnavailable extends Error {}
/** Google doesn't know the token, or it belongs to another app. */
export class PurchaseInvalid extends Error {}

/** A subscription as Google reports it, reduced to what the shop uses. */
export type GoogleSubscription = {
  state: StoreState;
  productId: string;
  basePlanId: string | null;
  expiresAt: Date | null;
  autoRenew: boolean;
  acknowledged: boolean;
  linkedToken: string | null;
  /** obfuscatedExternalAccountId: the account's store_ref, if the app passed it */
  storeRef: string | null;
  test: boolean;
  latestOrderId: string | null;
  raw: Record<string, unknown>;
};

export interface GooglePlay {
  getSubscription(token: string): Promise<GoogleSubscription>;
  acknowledge(productId: string, token: string): Promise<void>;
  /** Stops the renewal; the subscription runs to the end of the paid period. */
  cancel(productId: string, token: string): Promise<void>;
}

const STATES: Record<string, StoreState> = {
  SUBSCRIPTION_STATE_ACTIVE: 'active',
  SUBSCRIPTION_STATE_CANCELED: 'canceled',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'grace',
  SUBSCRIPTION_STATE_ON_HOLD: 'on_hold',
  SUBSCRIPTION_STATE_PAUSED: 'paused',
  SUBSCRIPTION_STATE_EXPIRED: 'expired',
  SUBSCRIPTION_STATE_PENDING: 'pending',
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'expired',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** purchases.subscriptionsv2 → GoogleSubscription. */
export function parseGoogleSubscription(raw: Record<string, unknown>): GoogleSubscription {
  type Line = {
    productId?: string;
    expiryTime?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
    offerDetails?: { basePlanId?: string };
  };
  const lines = (Array.isArray(raw.lineItems) ? raw.lineItems : []) as Line[];
  // the line that runs longest is the one that counts
  const line = [...lines].sort(
    (a, b) => Date.parse(b.expiryTime ?? '') - Date.parse(a.expiryTime ?? ''),
  )[0];
  if (!line?.productId) throw new PurchaseInvalid('no line item');
  const ext = (raw.externalAccountIdentifiers ?? {}) as { obfuscatedExternalAccountId?: string };
  const ref = ext.obfuscatedExternalAccountId ?? '';
  const expires = line.expiryTime ? new Date(line.expiryTime) : null;
  return {
    state: STATES[String(raw.subscriptionState)] ?? 'expired',
    productId: line.productId,
    basePlanId: line.offerDetails?.basePlanId ?? null,
    expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null,
    autoRenew: Boolean(line.autoRenewingPlan?.autoRenewEnabled),
    acknowledged: raw.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    linkedToken: typeof raw.linkedPurchaseToken === 'string' ? raw.linkedPurchaseToken : null,
    storeRef: UUID.test(ref) ? ref.toLowerCase() : null,
    test: raw.testPurchase !== undefined && raw.testPurchase !== null,
    latestOrderId: typeof raw.latestOrderId === 'string' ? raw.latestOrderId.slice(0, 100) : null,
    raw,
  };
}

export type ServiceAccount = { client_email: string; private_key: string; private_key_id?: string };

/** GOOGLE_PLAY_SERVICE_ACCOUNT: the key file's JSON, as is or base64. */
export function parseServiceAccount(v: string | undefined): ServiceAccount | null {
  const s = v?.trim();
  if (!s) return null;
  const text = s.startsWith('{') ? s : Buffer.from(s, 'base64').toString('utf8');
  const j = JSON.parse(text) as Partial<ServiceAccount>;
  if (!j.client_email || !j.private_key) throw new Error('service account: missing fields');
  return {
    client_email: j.client_email,
    private_key: j.private_key,
    private_key_id: j.private_key_id,
  };
}

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

/** The real Google Play Developer API, with the company's service account. */
export function googlePlayClient(opts: {
  packageName: string;
  account: ServiceAccount;
  fetch?: typeof fetch;
}): GooglePlay {
  const f = opts.fetch ?? fetch;
  let token: { value: string; until: number } | null = null;
  const accessToken = async () => {
    if (token && token.until > Date.now() + 60_000) return token.value;
    const now = Math.floor(Date.now() / 1000);
    const assertion = signRs256(
      {
        iss: opts.account.client_email,
        scope: 'https://www.googleapis.com/auth/androidpublisher',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      },
      opts.account.private_key,
      opts.account.private_key_id,
    );
    let r: Response;
    try {
      r = await f('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new StoreUnavailable(`token: ${(e as Error).message}`);
    }
    if (!r.ok) throw new StoreUnavailable(`token: HTTP ${r.status}`);
    const j = (await r.json()) as { access_token: string; expires_in?: number };
    token = { value: j.access_token, until: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return token.value;
  };
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    let r: Response;
    try {
      r = await f(`${API}/${encodeURIComponent(opts.packageName)}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      if (e instanceof StoreUnavailable) throw e;
      throw new StoreUnavailable((e as Error).message);
    }
    if (r.status === 429 || r.status >= 500) throw new StoreUnavailable(`HTTP ${r.status}`);
    if (r.status === 401 || r.status === 403) {
      token = null;
      throw new StoreUnavailable(`HTTP ${r.status} (service account rights?)`);
    }
    if (!r.ok) throw new PurchaseInvalid(`HTTP ${r.status}`);
    const text = await r.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };
  const tok = (t: string) => encodeURIComponent(t);
  return {
    async getSubscription(t) {
      return parseGoogleSubscription(
        await call('GET', `/purchases/subscriptionsv2/tokens/${tok(t)}`),
      );
    },
    async acknowledge(productId, t) {
      await call(
        'POST',
        `/purchases/subscriptions/${tok(productId)}/tokens/${tok(t)}:acknowledge`,
        {},
      );
    },
    async cancel(productId, t) {
      await call('POST', `/purchases/subscriptions/${tok(productId)}/tokens/${tok(t)}:cancel`);
    },
  };
}

/**
 * Staging: purchase tokens test_active, test_canceled, test_grace, test_on_hold, test_expired,
 * test_refunded (optionally with a suffix, e.g. test_active-42) stand for a purchase in that
 * state, bought for the reporting account.
 */
export function testGoogleSubscription(
  token: string,
  productId: string,
  storeRef: string | null,
  now = new Date(),
): GoogleSubscription | null {
  const m =
    /^test_(active|canceled|grace|on_hold|expired|refunded)(?:[-_.][A-Za-z0-9-]{1,40})?$/.exec(
      token,
    );
  if (!m) return null;
  const state = (m[1] === 'refunded' ? 'revoked' : m[1]) as StoreState;
  const day = 86400_000;
  const expiresAt = new Date(
    now.getTime() +
      (state === 'expired' || state === 'revoked' || state === 'on_hold' ? -day : 30 * day),
  );
  return {
    state,
    productId,
    basePlanId: /year/i.test(token) ? 'yearly' : 'monthly',
    expiresAt: state === 'grace' ? new Date(now.getTime() + 3 * day) : expiresAt,
    autoRenew: state === 'active' || state === 'grace',
    acknowledged: false,
    linkedToken: null,
    storeRef,
    test: true,
    latestOrderId: `TEST.${token}`,
    raw: { test: true, token },
  };
}

// ---------------------------------------------------------------------------
// Storing a purchase
// ---------------------------------------------------------------------------

export type StorePurchase = {
  id: number;
  store: Store;
  accountId: number | null;
  purchaseToken: string;
  productId: string;
  basePlanId: string | null;
  plan: Plan | null;
  period: Period | null;
  state: StoreState;
  expiresAt: Date | null;
  autoRenew: boolean;
  acknowledged: boolean;
  test: boolean;
  refused: string | null;
  replacedBy: number | null;
  latestOrderId: string | null;
  cancelRequestedAt: Date | null;
  createdAt: Date;
  checkedAt: Date;
};

type PurchaseRow = {
  id: number;
  store: Store;
  account_id: number | null;
  purchase_token: string;
  product_id: string;
  base_plan_id: string | null;
  plan: Plan | null;
  period: Period | null;
  state: StoreState;
  expires_at: Date | null;
  auto_renew: boolean;
  acknowledged: boolean;
  test: boolean;
  refused: string | null;
  replaced_by: number | null;
  latest_order_id: string | null;
  cancel_requested_at: Date | null;
  created_at: Date;
  checked_at: Date;
};

const toPurchase = (r: PurchaseRow): StorePurchase => ({
  id: Number(r.id),
  store: r.store,
  accountId: r.account_id === null ? null : Number(r.account_id),
  purchaseToken: r.purchase_token,
  productId: r.product_id,
  basePlanId: r.base_plan_id,
  plan: r.plan,
  period: r.period,
  state: r.state,
  expiresAt: r.expires_at,
  autoRenew: r.auto_renew,
  acknowledged: r.acknowledged,
  test: r.test,
  refused: r.refused,
  replacedBy: r.replaced_by === null ? null : Number(r.replaced_by),
  latestOrderId: r.latest_order_id,
  cancelRequestedAt: r.cancel_requested_at,
  createdAt: r.created_at,
  checkedAt: r.checked_at,
});

const PAID: StoreState[] = ['active', 'canceled', 'grace'];

/** a***@example.com */
export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

export type ApplyResult =
  | { ok: true; purchase: StorePurchase; accountId: number | null; acknowledge: boolean }
  | { ok: false; problem: 'invalid_purchase' }
  | { ok: false; problem: 'linked_elsewhere'; owner: string }
  | {
      ok: false;
      problem: 'already_subscribed';
      source: 'web' | 'google_play' | 'app_store';
      purchase: StorePurchase;
    };

/**
 * Stores what Google says about a purchase token. `accountId` is the account that reported it
 * (the app), or null for a notification. The purchase belongs to the account whose store_ref
 * Google returns; without one, to the account it was stored for before, else the reporting one.
 * A paid purchase is refused while the account has another paid subscription (one paid source
 * at a time); a refused purchase is never acknowledged, so Google refunds it.
 */
export async function applyGooglePurchase(
  sql: Sql,
  token: string,
  g: GoogleSubscription,
  opts: { accountId: number | null; now?: Date },
): Promise<ApplyResult> {
  const now = opts.now ?? new Date();
  const products = await storeProducts(sql);
  const plan =
    g.test && !googlePlanOf(products, g.productId, g.basePlanId)
      ? { plan: (/creator/i.test(g.productId) ? 'creator' : 'collector') as Plan, period: null }
      : googlePlanOf(products, g.productId, g.basePlanId);
  if (!plan) return { ok: false, problem: 'invalid_purchase' };
  return sql.begin(async (tx): Promise<ApplyResult> => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`store:google_play:${token}`}))`;
    const [existing] = await tx<PurchaseRow[]>`
      SELECT * FROM store_purchases WHERE store = 'google_play' AND purchase_token = ${token} FOR UPDATE`;
    // whose purchase is it?
    let owner: { id: number; email: string } | undefined;
    if (g.storeRef) {
      [owner] = await tx<{ id: number; email: string }[]>`
        SELECT id, email FROM accounts WHERE store_ref = ${g.storeRef}::uuid`;
    }
    if (!owner && existing?.account_id) {
      [owner] = await tx<{ id: number; email: string }[]>`
        SELECT id, email FROM accounts WHERE id = ${existing.account_id}`;
    }
    if (!owner && opts.accountId !== null && !g.storeRef) {
      [owner] = await tx<{ id: number; email: string }[]>`
        SELECT id, email FROM accounts WHERE id = ${opts.accountId}`;
    }
    if (opts.accountId !== null && owner && Number(owner.id) !== opts.accountId) {
      return { ok: false, problem: 'linked_elsewhere', owner: maskEmail(owner.email) };
    }
    if (opts.accountId !== null && !owner) {
      // bought for an account that no longer exists
      return { ok: false, problem: 'invalid_purchase' };
    }
    const accountId = owner ? Number(owner.id) : null;

    // one paid source at a time
    let refusedBy: 'web' | 'google_play' | 'app_store' | null = null;
    if (accountId !== null && PAID.includes(g.state) && !existing?.acknowledged) {
      const web = await websiteSubscription(tx, accountId);
      if (web?.source === 'stripe' && entitlements(web, { webshopHost: null }, now).active) {
        refusedBy = 'web';
      } else {
        const [other] = await tx<{ store: Store }[]>`
          SELECT store FROM store_purchases
           WHERE account_id = ${accountId} AND purchase_token <> ${token}
             AND (${g.linkedToken}::text IS NULL OR purchase_token <> ${g.linkedToken})
             AND replaced_by IS NULL AND refused IS NULL
             AND state IN ('active', 'canceled', 'grace') AND expires_at > ${now}`;
        if (other) refusedBy = other.store;
      }
    }
    const refused = refusedBy ? 'already_subscribed' : (existing?.refused ?? null);
    const [row] = await tx<PurchaseRow[]>`
      INSERT INTO store_purchases (store, account_id, store_ref, purchase_token, product_id, base_plan_id,
                                   plan, period, state, expires_at, auto_renew, acknowledged, test,
                                   latest_order_id, refused, raw, checked_at)
      VALUES ('google_play', ${accountId}, ${g.storeRef}::uuid, ${token}, ${g.productId}, ${g.basePlanId},
              ${plan.plan}, ${plan.period}, ${g.state}, ${g.expiresAt}, ${g.autoRenew}, ${g.acknowledged},
              ${g.test}, ${g.latestOrderId}, ${refused}, ${tx.json(g.raw as never)}, ${now})
      ON CONFLICT (store, purchase_token) DO UPDATE SET
        account_id = coalesce(store_purchases.account_id, EXCLUDED.account_id),
        store_ref = coalesce(EXCLUDED.store_ref, store_purchases.store_ref),
        product_id = EXCLUDED.product_id, base_plan_id = EXCLUDED.base_plan_id,
        plan = EXCLUDED.plan, period = EXCLUDED.period,
        -- a refund (voided purchase) is final
        state = CASE WHEN store_purchases.state = 'revoked' THEN 'revoked' ELSE EXCLUDED.state END,
        expires_at = EXCLUDED.expires_at, auto_renew = EXCLUDED.auto_renew,
        acknowledged = store_purchases.acknowledged OR EXCLUDED.acknowledged,
        test = EXCLUDED.test, latest_order_id = EXCLUDED.latest_order_id,
        refused = EXCLUDED.refused, raw = EXCLUDED.raw, checked_at = EXCLUDED.checked_at
      RETURNING *`;
    if (g.linkedToken) {
      await tx`
        UPDATE store_purchases SET replaced_by = ${row!.id}
         WHERE store = 'google_play' AND purchase_token = ${g.linkedToken} AND id <> ${row!.id}`;
    }
    const purchase = toPurchase(row!);
    if (refusedBy) return { ok: false, problem: 'already_subscribed', source: refusedBy, purchase };
    return {
      ok: true,
      purchase,
      accountId,
      acknowledge: !purchase.acknowledged && PAID.includes(purchase.state) && !purchase.refused,
    };
  });
}

export async function markAcknowledged(db: Db, id: number): Promise<void> {
  await db`UPDATE store_purchases SET acknowledged = true WHERE id = ${id}`;
}

/** A refund or chargeback (voidedPurchaseNotification): access ends at once. */
export async function revokeGooglePurchase(db: Db, token: string): Promise<boolean> {
  const r = await db`
    UPDATE store_purchases SET state = 'revoked', auto_renew = false
     WHERE store = 'google_play' AND purchase_token = ${token} AND state <> 'revoked'`;
  return r.count > 0;
}

/**
 * Reads a token from Google (or the staging test hook), stores it and acknowledges it when
 * needed. Throws StoreUnavailable / PurchaseInvalid.
 */
export async function processGooglePurchase(
  sql: Sql,
  play: GooglePlay | null,
  input: {
    token: string;
    productId?: string;
    accountId: number | null;
    storeRef?: string | null;
    testHooks?: boolean;
    now?: Date;
  },
): Promise<ApplyResult> {
  const test =
    input.testHooks && input.token.startsWith('test_')
      ? testGoogleSubscription(
          input.token,
          input.productId ?? 'test_collector',
          input.storeRef ?? null,
          input.now,
        )
      : null;
  if (input.testHooks && input.token.startsWith('test_') && !test) {
    throw new PurchaseInvalid('unknown test token');
  }
  if (!test && !play) throw new StoreUnavailable('Google Play is not set up on this server');
  const g = test ?? (await play!.getSubscription(input.token));
  if (input.productId && g.productId !== input.productId && !test) {
    throw new PurchaseInvalid('product does not match');
  }
  const r = await applyGooglePurchase(sql, input.token, g, {
    accountId: input.accountId,
    now: input.now,
  });
  if (r.ok && r.acknowledge) {
    if (!test) await play!.acknowledge(g.productId, input.token);
    await markAcknowledged(sql, r.purchase.id);
    r.purchase.acknowledged = true;
  }
  return r;
}

/** The account's store purchases, newest first (admin). */
export async function storePurchasesOf(db: Db, accountId: number): Promise<StorePurchase[]> {
  const rows = await db<PurchaseRow[]>`
    SELECT * FROM store_purchases WHERE account_id = ${accountId} ORDER BY created_at DESC LIMIT 20`;
  return rows.map(toPurchase);
}

/**
 * Daily: re-read store purchases that end within 2 days or have ended without a final state —
 * catches notifications that never arrived. Each at most every 12 hours.
 */
export async function recheckGooglePurchases(
  sql: Sql,
  play: GooglePlay,
  opts: { now?: Date; limit?: number } = {},
): Promise<{ checked: number; failed: number }> {
  const now = opts.now ?? new Date();
  const due = await sql<{ purchase_token: string; account_id: number | null }[]>`
    SELECT purchase_token, account_id FROM store_purchases
     WHERE store = 'google_play' AND NOT test AND replaced_by IS NULL
       AND state NOT IN ('expired', 'revoked')
       AND (expires_at IS NULL OR expires_at < ${now}::timestamptz + interval '2 days')
       AND checked_at < ${now}::timestamptz - interval '12 hours'
     ORDER BY expires_at NULLS FIRST LIMIT ${opts.limit ?? 200}`;
  let checked = 0;
  let failed = 0;
  for (const d of due) {
    try {
      await processGooglePurchase(sql, play, { token: d.purchase_token, accountId: null, now });
      checked++;
    } catch (e) {
      failed++;
      if (e instanceof PurchaseInvalid) {
        await sql`
          UPDATE store_purchases SET state = 'expired', checked_at = ${now}
           WHERE store = 'google_play' AND purchase_token = ${d.purchase_token}`;
      }
    }
  }
  return { checked, failed };
}

/** Staging: moves the account's latest store purchase to a state (POST /test/store-event). */
export async function setTestStoreState(
  db: Db,
  storeRef: string,
  state: StoreState | 'refunded' | 'renewed',
  now = new Date(),
): Promise<StorePurchase | null> {
  if (!UUID.test(storeRef)) return null;
  const day = 86400_000;
  const s: StoreState = state === 'refunded' ? 'revoked' : state === 'renewed' ? 'active' : state;
  const expires =
    state === 'renewed' || state === 'active' || state === 'canceled'
      ? new Date(now.getTime() + 30 * day)
      : state === 'grace'
        ? new Date(now.getTime() + 3 * day)
        : new Date(now.getTime() - 60_000);
  const [r] = await db<PurchaseRow[]>`
    UPDATE store_purchases SET state = ${s}, expires_at = ${expires},
           auto_renew = ${s === 'active' || s === 'grace'}, checked_at = ${now}
     WHERE id = (SELECT p.id FROM store_purchases p JOIN accounts a ON a.id = p.account_id
                  WHERE a.store_ref = ${storeRef}::uuid AND p.test AND p.replaced_by IS NULL
                    AND p.refused IS NULL
                  ORDER BY p.created_at DESC LIMIT 1)
    RETURNING *`;
  return r ? toPurchase(r) : null;
}

// ---------------------------------------------------------------------------
// Real-time developer notifications (Cloud Pub/Sub push)
// ---------------------------------------------------------------------------

export type DeveloperNotification =
  | { kind: 'subscription'; packageName: string; token: string; type: number }
  | { kind: 'voided'; packageName: string; token: string }
  | { kind: 'test'; packageName: string }
  | { kind: 'other'; packageName: string };

/** The Pub/Sub push body: { message: { data: base64(DeveloperNotification) } }. */
export function parseDeveloperNotification(body: unknown): DeveloperNotification | null {
  const data = (body as { message?: { data?: unknown } } | null)?.message?.data;
  if (typeof data !== 'string') return null;
  let n: Record<string, unknown>;
  try {
    n = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const packageName = typeof n.packageName === 'string' ? n.packageName : '';
  const sub = n.subscriptionNotification as { purchaseToken?: string; notificationType?: number };
  if (sub?.purchaseToken) {
    return {
      kind: 'subscription',
      packageName,
      token: sub.purchaseToken,
      type: Number(sub.notificationType ?? 0),
    };
  }
  const voided = n.voidedPurchaseNotification as { purchaseToken?: string; productType?: number };
  if (voided?.purchaseToken) return { kind: 'voided', packageName, token: voided.purchaseToken };
  if (n.testNotification) return { kind: 'test', packageName };
  return { kind: 'other', packageName };
}

/**
 * Deleted accounts: stop the renewal of their Google Play subscriptions (they run to the end of
 * the paid period). Test purchases are only marked. Worker; also right after the deletion.
 */
export async function cancelRequestedRenewals(
  sql: Sql,
  play: GooglePlay | null,
  now = new Date(),
): Promise<{ cancelled: number; failed: number }> {
  const due = await sql<
    { id: number; product_id: string; purchase_token: string; test: boolean }[]
  >`
    SELECT id, product_id, purchase_token, test FROM store_purchases
     WHERE store = 'google_play' AND cancel_requested_at IS NOT NULL AND cancelled_at_store IS NULL
       AND state NOT IN ('expired', 'revoked')
     ORDER BY cancel_requested_at LIMIT 100`;
  let cancelled = 0;
  let failed = 0;
  for (const d of due) {
    try {
      // purchases made with the test hooks (test_… tokens) do not exist at Google
      if (!(d.test && d.purchase_token.startsWith('test_'))) {
        if (!play) {
          failed++;
          continue;
        }
        await play.cancel(d.product_id, d.purchase_token);
      }
      await sql`
        UPDATE store_purchases SET cancelled_at_store = ${now}, auto_renew = false,
               state = CASE WHEN state = 'active' THEN 'canceled' ELSE state END
         WHERE id = ${d.id}`;
      cancelled++;
    } catch (e) {
      if (e instanceof PurchaseInvalid) {
        await sql`UPDATE store_purchases SET cancelled_at_store = ${now} WHERE id = ${d.id}`;
      } else {
        failed++;
      }
    }
  }
  return { cancelled, failed };
}

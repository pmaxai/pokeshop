// Subscriptions bought in the App Store, with the iPhone app. Same tables and rules as Google
// Play (store.ts): the app reports every transaction (POST /api/app/v1/store/apple), Apple
// notifies every change (App Store Server Notifications V2), a daily job re-reads what is about to
// run out. Each time the server reads the subscription from the App Store Server API and stores
// what Apple says. Differences to Google:
//   - extra devices are their own subscriptions (one group per plan); such a purchase is a row
//     of kind 'devices' and counts for a running App Store subscription of the same plan;
//   - nothing can be refused or cancelled at Apple: a second paid subscription is marked refused
//     (the person cancels it and asks Apple for a refund) and checked again each time;
//   - a purchase through Apple's offer-code sheet carries no appAccountToken: it belongs to the
//     account that reports it.
import type { Sql } from './db.ts';
import {
  parseAppleNotification,
  parseAppleTransaction,
  type AppleSubscription,
  type AppStore,
} from './apple.ts';
import { JwtError } from './jwt.ts';
import {
  applePlanOf,
  maskEmail,
  MAX_STORE_DEVICES,
  PAID,
  PurchaseInvalid,
  storeProducts,
  StoreUnavailable,
  testAppleId,
  toPurchase,
  type AppleProduct,
  type ApplyResult,
  type PurchaseRow,
  type Store,
  type StoreState,
} from './store.ts';
import { entitlements, subscriptionOf, websiteSubscription } from './subscriptions.ts';
import { noteAffiliatePurchase, registerFromOfferCode } from './affiliates.ts';
import { enqueueMail } from './outbox.ts';
import { isAddonId, type AddonId } from './addon-catalog.ts';

/** Where a refund for an App Store purchase is asked for. */
export const APPLE_REFUND_URL = 'https://reportaproblem.apple.com';

/**
 * Staging: signed_transaction values test_active, test_canceled, test_grace, test_on_hold,
 * test_expired, test_refunded stand for a purchase in that state, bought for the reporting
 * account. Parts after a dash: yearly (the yearly product), creator (the Creator plan), d1 … d4
 * (the plan's extra-devices subscription with that many devices, instead of the plan), code or
 * code<CODE> (bought through Apple's offer-code sheet: no appAccountToken, offer <CODE>), psa (the
 * PSA prices add-on instead of the plan); anything else is ignored (e.g. a number). Like at Apple,
 * an account has one purchase per group: test_active and then test_active-creator is an upgrade
 * of the same subscription.
 */
export function testAppleSubscription(
  token: string,
  storeRef: string | null,
  now = new Date(),
): AppleSubscription | null {
  const m =
    /^test_(active|canceled|grace|on_hold|expired|refunded)((?:[-_.][A-Za-z0-9]{1,40}){0,8})$/.exec(
      token,
    );
  if (!m || !storeRef) return null;
  const flags = m[2]!.split(/[-_.]/).filter(Boolean);
  const has = (f: string) => flags.some((x) => x.toLowerCase() === f);
  const state = (m[1] === 'refunded' ? 'revoked' : m[1]) as StoreState;
  const plan = has('creator') ? 'creator' : 'collector';
  const period = has('yearly') ? 'yearly' : 'monthly';
  const devices = Number(flags.map((f) => /^d([1-4])$/i.exec(f)?.[1]).find(Boolean) ?? 0);
  const code = flags.map((f) => /^code([A-Za-z0-9]*)$/i.exec(f)).find(Boolean);
  const addon = has('psa') ? 'psa_prices' : null;
  const day = 86400_000;
  const end =
    state === 'grace'
      ? new Date(now.getTime() + 3 * day)
      : new Date(
          now.getTime() +
            (state === 'expired' || state === 'revoked' || state === 'on_hold' ? -day : 30 * day),
        );
  return {
    originalTransactionId: testAppleId(
      storeRef,
      addon ? `addon-${addon}` : devices ? `devices-${plan}` : 'main',
    ),
    state,
    productId: addon
      ? `test_${addon}_${period}`
      : devices
        ? `test_${plan}_${period}_devices_${devices}`
        : `test_${plan}_${period}`,
    expiresAt: end,
    autoRenew: state === 'active' || state === 'grace',
    storeRef: code ? null : storeRef.toLowerCase(),
    test: true,
    latestOrderId: `TEST.${token}`.slice(0, 100),
    offerType: code ? 3 : null,
    offerIdentifier: code?.[1] ? code[1].toUpperCase() : null,
    country: 'AT',
    raw: { test: true, token },
  };
}

/** Test products (sandbox before the products are entered, the staging hooks): by their name. */
function guessTestProduct(productId: string): AppleProduct {
  const plan = /creator/i.test(productId) ? 'creator' : 'collector';
  const period = /year/i.test(productId) ? 'yearly' : 'monthly';
  if (/psa/i.test(productId)) return { kind: 'addon', addon: 'psa_prices', period };
  const devices = Number(/devices?[_.-]?([1-4])\b/i.exec(productId)?.[1] ?? 0);
  return devices ? { kind: 'devices', plan, period, devices } : { kind: 'plan', plan, period };
}

/**
 * Stores what Apple says about a subscription. `accountId` is the account that reported it (the
 * app), or null for a notification. It belongs to the account whose store_ref is its
 * appAccountToken; without one (offer-code sheet), to the account it was stored for before, else
 * the reporting one. A paid subscription (not its extra devices or an add-on) is refused while the
 * account has another paid one; Apple can't be told, so it is checked again at every read and
 * counts once the other one has ended. An add-on is stored as the account's add-on, never
 * refused, also without a running plan.
 */
export async function applyApplePurchase(
  sql: Sql,
  s: AppleSubscription,
  opts: { accountId: number | null; now?: Date },
): Promise<ApplyResult> {
  const now = opts.now ?? new Date();
  const products = await storeProducts(sql);
  const product =
    applePlanOf(products, s.productId) ?? (s.test ? guessTestProduct(s.productId) : null);
  if (!product) return { ok: false, problem: 'invalid_purchase' };
  const token = s.originalTransactionId;
  return sql.begin(async (tx): Promise<ApplyResult> => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`store:app_store:${token}`}))`;
    const [existing] = await tx<PurchaseRow[]>`
      SELECT * FROM store_purchases WHERE store = 'app_store' AND purchase_token = ${token} FOR UPDATE`;
    let owner: { id: number; email: string } | undefined;
    if (s.storeRef) {
      [owner] = await tx<{ id: number; email: string }[]>`
        SELECT id, email FROM accounts WHERE store_ref = ${s.storeRef}::uuid`;
    }
    if (!owner && existing?.account_id) {
      [owner] = await tx<{ id: number; email: string }[]>`
        SELECT id, email FROM accounts WHERE id = ${existing.account_id}`;
    }
    if (!owner && opts.accountId !== null && !s.storeRef) {
      [owner] = await tx<{ id: number; email: string }[]>`
        SELECT id, email FROM accounts WHERE id = ${opts.accountId}`;
    }
    if (opts.accountId !== null && owner && Number(owner.id) !== opts.accountId) {
      return { ok: false, problem: 'linked_elsewhere', owner: maskEmail(owner.email) };
    }
    if (opts.accountId !== null && !owner) return { ok: false, problem: 'invalid_purchase' };
    const accountId = owner ? Number(owner.id) : null;

    // one paid source at a time; a subscription that was already running stays accepted
    let refusedBy: 'web' | 'google_play' | 'app_store' | null = null;
    const ranBefore =
      existing &&
      existing.refused === null &&
      PAID.includes(existing.state) &&
      existing.expires_at !== null &&
      existing.expires_at > now;
    if (accountId !== null && product.kind === 'plan' && PAID.includes(s.state) && !ranBefore) {
      const web = await websiteSubscription(tx, accountId);
      if (web?.source === 'stripe' && entitlements(web, { webshopHost: null }, now).active) {
        refusedBy = 'web';
      } else {
        const [other] = await tx<{ store: Store }[]>`
          SELECT store FROM store_purchases
           WHERE account_id = ${accountId} AND kind = 'plan'
             AND NOT (store = 'app_store' AND purchase_token = ${token})
             AND replaced_by IS NULL AND refused IS NULL
             AND state IN ('active', 'canceled', 'grace') AND expires_at > ${now}`;
        if (other) refusedBy = other.store;
      }
    }
    const refused = refusedBy
      ? 'already_subscribed'
      : ranBefore || !PAID.includes(s.state)
        ? (existing?.refused ?? null)
        : null;
    const devices = product.kind === 'devices' ? product.devices : null;
    const addon = product.kind === 'addon' ? product.addon : null;
    const plan = product.kind === 'addon' ? null : product.plan;
    const [row] = await tx<PurchaseRow[]>`
      INSERT INTO store_purchases (store, account_id, store_ref, purchase_token, product_id, plan,
                                   period, state, expires_at, auto_renew, acknowledged, test,
                                   latest_order_id, refused, kind, devices, addon, raw, checked_at)
      VALUES ('app_store', ${accountId}, ${s.storeRef}::uuid, ${token}, ${s.productId},
              ${plan}, ${product.period}, ${s.state}, ${s.expiresAt}, ${s.autoRenew}, true,
              ${s.test}, ${s.latestOrderId}, ${refused}, ${product.kind}, ${devices}, ${addon},
              ${tx.json(s.raw as never)}, ${now})
      ON CONFLICT (store, purchase_token) DO UPDATE SET
        account_id = coalesce(store_purchases.account_id, EXCLUDED.account_id),
        store_ref = coalesce(EXCLUDED.store_ref, store_purchases.store_ref),
        product_id = EXCLUDED.product_id, plan = EXCLUDED.plan, period = EXCLUDED.period,
        -- the same original transaction can be bought again after a refund: Apple's state counts
        state = EXCLUDED.state, expires_at = EXCLUDED.expires_at, auto_renew = EXCLUDED.auto_renew,
        test = EXCLUDED.test, latest_order_id = EXCLUDED.latest_order_id,
        refused = EXCLUDED.refused, kind = EXCLUDED.kind, devices = EXCLUDED.devices,
        addon = EXCLUDED.addon, raw = EXCLUDED.raw, checked_at = EXCLUDED.checked_at
      RETURNING *`;
    const purchase = toPurchase(row!);
    if (refusedBy) return { ok: false, problem: 'already_subscribed', source: refusedBy, purchase };
    return { ok: true, purchase, accountId, acknowledge: false };
  });
}

/**
 * Reads a subscription from the App Store (or the staging test hook) and stores it: from the
 * signed transaction the app reports (checked: Apple's signature, this app), or by its original
 * transaction id (notifications, re-reads). Throws StoreUnavailable / PurchaseInvalid.
 */
export async function processApplePurchase(
  sql: Sql,
  store: AppStore | null,
  input: {
    signedTransaction?: string;
    originalTransactionId?: string;
    sandbox?: boolean;
    accountId: number | null;
    storeRef?: string | null;
    testHooks?: boolean;
    now?: Date;
  },
): Promise<ApplyResult> {
  const signed = input.signedTransaction;
  let s: AppleSubscription;
  if (input.testHooks && signed?.startsWith('test_')) {
    const test = testAppleSubscription(signed, input.storeRef ?? null, input.now);
    if (!test) throw new PurchaseInvalid('unknown test transaction');
    s = test;
  } else {
    if (!store) throw new StoreUnavailable('The App Store is not set up on this server');
    let id = input.originalTransactionId ?? '';
    let sandbox = input.sandbox ?? false;
    if (signed) {
      let payload: Record<string, unknown>;
      try {
        payload = store.verify(signed);
      } catch (e) {
        if (e instanceof JwtError) throw new PurchaseInvalid(`not signed by Apple (${e.code})`);
        throw e;
      }
      const tx = parseAppleTransaction(payload);
      if (tx.bundleId !== store.bundleId) throw new PurchaseInvalid('another app');
      if (tx.type !== 'Auto-Renewable Subscription')
        throw new PurchaseInvalid('not a subscription');
      id = tx.originalTransactionId;
      sandbox = tx.environment === 'Sandbox';
    }
    s = await store.getSubscription(id, { sandbox });
  }
  const r = await applyApplePurchase(sql, s, { accountId: input.accountId, now: input.now });
  // the first paid subscription of an account that came through an affiliate link or code
  if (
    r.ok &&
    r.accountId !== null &&
    r.purchase.kind === 'plan' &&
    PAID.includes(r.purchase.state) &&
    !r.purchase.refused
  ) {
    const offerCode = s.offerType === 3;
    if (offerCode && s.offerIdentifier) {
      await registerFromOfferCode(sql, r.accountId, s.offerIdentifier, r.purchase.id, input.now);
    }
    await noteAffiliatePurchase(sql, r.accountId, {
      source: 'app_store',
      plan: r.purchase.plan,
      period: r.purchase.period,
      country: s.country,
      discountUsed: offerCode,
      at: input.now,
    });
  }
  return r;
}

/**
 * POST /api/store/apple/notifications: checks the notification (Apple's signature, this app),
 * then reads the subscription it is about from the App Store and stores it. The answer's status:
 * 200 done (also for what the shop doesn't sell), 400 not Apple's, 503 try again (Apple retries).
 */
export async function handleAppleNotification(
  sql: Sql,
  store: AppStore | null,
  body: unknown,
  now = new Date(),
): Promise<200 | 400 | 503> {
  if (!store) return 503;
  let n: ReturnType<typeof parseAppleNotification>;
  try {
    n = parseAppleNotification(body, store.verify);
  } catch (e) {
    if (e instanceof JwtError || e instanceof PurchaseInvalid) return 400;
    throw e;
  }
  if (!n) return 400;
  if (n.bundleId && n.bundleId !== store.bundleId) return 200;
  const tx = n.transaction;
  if (!tx || tx.type !== 'Auto-Renewable Subscription') {
    console.log(`[store] Apple notification ${n.type}${n.subtype ? `/${n.subtype}` : ''}`);
    return 200;
  }
  try {
    await processApplePurchase(sql, store, {
      originalTransactionId: tx.originalTransactionId,
      sandbox: n.environment === 'Sandbox',
      accountId: null,
      now,
    });
  } catch (e) {
    if (e instanceof PurchaseInvalid) return 200;
    console.error('[store] Apple notification failed:', (e as Error).message);
    return 503;
  }
  return 200;
}

/**
 * Daily: re-read App Store subscriptions that end within 2 days or have ended without a final
 * state – catches notifications that never arrived. Each at most every 12 hours.
 */
export async function recheckApplePurchases(
  sql: Sql,
  store: AppStore,
  opts: { now?: Date; limit?: number } = {},
): Promise<{ checked: number; failed: number }> {
  const now = opts.now ?? new Date();
  const due = await sql<{ purchase_token: string }[]>`
    SELECT purchase_token FROM store_purchases
     WHERE store = 'app_store' AND NOT test AND replaced_by IS NULL
       AND state NOT IN ('expired', 'revoked')
       AND (expires_at IS NULL OR expires_at < ${now}::timestamptz + interval '2 days')
       AND checked_at < ${now}::timestamptz - interval '12 hours'
     ORDER BY expires_at NULLS FIRST LIMIT ${opts.limit ?? 200}`;
  let checked = 0;
  let failed = 0;
  for (const d of due) {
    try {
      await processApplePurchase(sql, store, {
        originalTransactionId: d.purchase_token,
        accountId: null,
        now,
      });
      checked++;
    } catch (e) {
      failed++;
      if (e instanceof PurchaseInvalid) {
        await sql`
          UPDATE store_purchases SET state = 'expired', checked_at = ${now}
           WHERE store = 'app_store' AND purchase_token = ${d.purchase_token}`;
      }
    }
  }
  return { checked, failed };
}

/**
 * Extra devices bought in the App Store that renew without counting – the account's App Store
 * subscription of that plan has ended, or it now runs another plan – can't be cancelled by the
 * shop. The person is told once per paid period (worker), an hour after the purchase at the
 * earliest.
 */
export async function noticeUncountedAppleDevices(sql: Sql, now = new Date()): Promise<number> {
  const rows = await sql<
    {
      id: number;
      account_id: number;
      plan: 'collector' | 'creator';
      devices: number;
      expires_at: Date;
      email: string;
      locale: 'de' | 'en';
    }[]
  >`
    SELECT p.id, p.account_id, p.plan, p.devices, p.expires_at, a.email, a.locale
      FROM store_purchases p JOIN accounts a ON a.id = p.account_id AND a.deleted_at IS NULL
     WHERE p.store = 'app_store' AND p.kind = 'devices' AND p.auto_renew
       AND p.refused IS NULL AND p.replaced_by IS NULL
       AND p.state IN ('active', 'grace') AND p.expires_at > ${now}
       AND p.created_at < ${now}::timestamptz - interval '1 hour'
       AND (p.devices_notice_for IS NULL OR p.devices_notice_for < p.expires_at)`;
  let sent = 0;
  for (const r of rows) {
    const sub = await subscriptionOf(sql, Number(r.account_id), now);
    const runs =
      sub && sub.source === 'app_store' && entitlements(sub, { webshopHost: null }, now).active;
    if (runs && sub.plan === r.plan) continue;
    await enqueueMail(sql, {
      template: 'store_devices_running',
      to: r.email,
      locale: r.locale,
      payload: {
        account_id: Number(r.account_id),
        devices: Math.min(MAX_STORE_DEVICES, r.devices),
        plan: r.plan,
        reason: runs ? 'other_plan' : 'no_subscription',
        current_plan: runs ? sub.plan : null,
        renews_at: r.expires_at.toISOString(),
      },
      dedupeKey: `store_devices_running:${r.id}:${r.expires_at.toISOString()}`,
    });
    await sql`UPDATE store_purchases SET devices_notice_for = ${r.expires_at} WHERE id = ${r.id}`;
    sent++;
  }
  return sent;
}

/**
 * Add-ons bought in the App Store that renew while they don't count – the account's plan has
 * ended, or it runs a plan the add-on isn't for – can't be cancelled by the shop either. The
 * person is told once per paid period (worker), an hour after the purchase at the earliest.
 */
export async function noticeUncountedAppleAddons(sql: Sql, now = new Date()): Promise<number> {
  const rows = await sql<
    {
      id: number;
      account_id: number;
      addon: AddonId;
      expires_at: Date;
      email: string;
      locale: 'de' | 'en';
    }[]
  >`
    SELECT p.id, p.account_id, p.addon, p.expires_at, a.email, a.locale
      FROM store_purchases p JOIN accounts a ON a.id = p.account_id AND a.deleted_at IS NULL
     WHERE p.store = 'app_store' AND p.kind = 'addon' AND p.auto_renew
       AND p.refused IS NULL AND p.replaced_by IS NULL
       AND p.state IN ('active', 'grace') AND p.expires_at > ${now}
       AND p.created_at < ${now}::timestamptz - interval '1 hour'
       AND (p.devices_notice_for IS NULL OR p.devices_notice_for < p.expires_at)`;
  if (!rows.length) return 0;
  const products = await storeProducts(sql);
  let sent = 0;
  for (const r of rows) {
    if (!isAddonId(r.addon)) continue;
    const sub = await subscriptionOf(sql, Number(r.account_id), now);
    const ent = entitlements(sub, { webshopHost: null }, now);
    const runs = ent.active && ent.plan !== null;
    if (runs && products.addons[r.addon].plans.includes(ent.plan!)) continue;
    await enqueueMail(sql, {
      template: 'store_addon_running',
      to: r.email,
      locale: r.locale,
      payload: {
        account_id: Number(r.account_id),
        addon: r.addon,
        reason: runs ? 'other_plan' : 'no_subscription',
        current_plan: runs ? ent.plan : null,
        renews_at: r.expires_at.toISOString(),
      },
      dedupeKey: `store_addon_running:${r.id}:${r.expires_at.toISOString()}`,
    });
    await sql`UPDATE store_purchases SET devices_notice_for = ${r.expires_at} WHERE id = ${r.id}`;
    sent++;
  }
  return sent;
}

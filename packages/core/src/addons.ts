// What an account has of the add-ons (addon-catalog.ts): App Store subscriptions of kind 'addon'
// in store_purchases, and add-ons the shop gave away (account_addons). An add-on counts – its
// feature flag is on – while the account's plan runs, the plan is one of the add-on's plans
// (Admin › App-Stores) and the add-on runs. It never ends with the plan: an App Store add-on keeps
// billing until the person cancels it there.
import { z } from 'zod';
import type { Db } from './db.ts';
import { ADDON_IDS, ADDONS, isAddonId, type AddonId, type AddonsConfig } from './addon-catalog.ts';
import { storeManageUrl, type Period, type Store, type StoreState } from './store.ts';
import type { Entitlements } from './subscriptions.ts';

export type AddonState = 'active' | 'past_due' | 'canceled' | 'ended' | 'complimentary';

/** One add-on of an account, as GET /status lists it. */
export type AddonEntry = {
  id: AddonId;
  state: AddonState;
  source: 'web' | 'google_play' | 'app_store';
  /** monthly or yearly; null when given by the shop */
  basePlan: Period | null;
  renewsAt: Date | null;
  endsAt: Date | null;
  manageUrl: string | null;
  /** it runs (active, canceled until its end, past_due in the grace period, complimentary) */
  runs: boolean;
};

/** Each of an account's add-on purchases and gifts, newest first (admin). */
export type AddonRecord = AddonEntry & {
  kind: 'store' | 'complimentary';
  /** store_purchases.id or account_addons.id */
  recordId: number;
  note: string | null;
  grantedBy: string | null;
  createdAt: Date;
};

const RUNS: StoreState[] = ['active', 'canceled', 'grace'];

/** All of an account's add-on purchases and gifts, newest first. */
export async function addonRecords(
  db: Db,
  accountId: number,
  now = new Date(),
): Promise<AddonRecord[]> {
  const [store, gifts] = await Promise.all([
    db<
      {
        id: number;
        store: Store;
        addon: string;
        state: StoreState;
        period: Period | null;
        expires_at: Date | null;
        product_id: string;
        created_at: Date;
      }[]
    >`
      SELECT id, store, addon, state, period, expires_at, product_id, created_at
        FROM store_purchases
       WHERE account_id = ${accountId} AND kind = 'addon' AND refused IS NULL
         AND replaced_by IS NULL AND state <> 'pending'`,
    db<
      {
        id: number;
        addon: string;
        ends_at: Date | null;
        ended_at: Date | null;
        note: string | null;
        granted_by: string;
        created_at: Date;
      }[]
    >`SELECT * FROM account_addons WHERE account_id = ${accountId}`,
  ]);
  const out: AddonRecord[] = [];
  for (const p of store) {
    if (!isAddonId(p.addon)) continue;
    const runs = RUNS.includes(p.state) && p.expires_at !== null && p.expires_at > now;
    const state: AddonState = !runs
      ? 'ended'
      : p.state === 'grace'
        ? 'past_due'
        : p.state === 'canceled'
          ? 'canceled'
          : 'active';
    out.push({
      id: p.addon,
      kind: 'store',
      recordId: Number(p.id),
      state,
      source: p.store,
      basePlan: p.period,
      renewsAt: state === 'active' ? p.expires_at : null,
      endsAt: state === 'active' || state === 'past_due' ? null : p.expires_at,
      manageUrl: storeManageUrl(p.store, p.product_id),
      runs,
      note: null,
      grantedBy: null,
      createdAt: p.created_at,
    });
  }
  for (const g of gifts) {
    if (!isAddonId(g.addon)) continue;
    const runs = g.ended_at === null && (g.ends_at === null || g.ends_at > now);
    out.push({
      id: g.addon,
      kind: 'complimentary',
      recordId: Number(g.id),
      state: runs ? 'complimentary' : 'ended',
      source: 'web',
      basePlan: null,
      renewsAt: null,
      endsAt: runs ? g.ends_at : (g.ended_at ?? g.ends_at),
      manageUrl: null,
      runs,
      note: g.note,
      grantedBy: g.granted_by,
      createdAt: g.created_at,
    });
  }
  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * The account's add-ons, one per add-on: a running store subscription first (it bills and is
 * managed in the store), then a running gift, else the newest that ended. Empty: none.
 */
export async function accountAddons(
  db: Db,
  accountId: number,
  now = new Date(),
): Promise<AddonEntry[]> {
  const records = await addonRecords(db, accountId, now);
  const rank = (r: AddonRecord) => (r.runs ? (r.kind === 'store' ? 0 : 1) : 2);
  const out: AddonEntry[] = [];
  for (const id of ADDON_IDS) {
    const best = records
      .filter((r) => r.id === id)
      .sort((a, b) => rank(a) - rank(b) || b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (best) {
      const { kind: _k, recordId: _r, note: _n, grantedBy: _g, createdAt: _c, ...entry } = best;
      out.push(entry);
    }
  }
  return out;
}

/**
 * The add-ons' feature flags: on while the plan runs, the plan is one of the add-on's plans and
 * the add-on runs.
 */
export function withAddons(
  ent: Entitlements,
  addons: AddonEntry[],
  config: AddonsConfig,
): Entitlements {
  const features = { ...ent.features };
  for (const id of ADDON_IDS) {
    features[ADDONS[id].feature] =
      ent.active &&
      ent.plan !== null &&
      config[id].plans.includes(ent.plan) &&
      addons.some((a) => a.id === id && a.runs);
  }
  return { ...ent, features };
}

/** GET /status › addons. */
export const addonJson = (a: AddonEntry) => ({
  id: a.id,
  state: a.state,
  source: a.source,
  base_plan: a.basePlan,
  renews_at: a.renewsAt?.toISOString() ?? null,
  ends_at: a.endsAt?.toISOString() ?? null,
  manage_url: a.manageUrl,
});

export const AddonGiftForm = z.object({
  addon: z.enum(ADDON_IDS as [AddonId, ...AddonId[]]),
  /** the last day it counts (Vienna time); empty: no end */
  until: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  note: z.string().trim().max(500).optional(),
});

/**
 * Gives an add-on away (Admin › customer), with or without an end. A gift of the same add-on that
 * still runs is replaced.
 */
export async function grantAddon(
  db: Db,
  accountId: number,
  input: z.input<typeof AddonGiftForm>,
  by: string,
  now = new Date(),
): Promise<{ ok: true; id: number } | { ok: false; errors: string[] }> {
  const p = AddonGiftForm.safeParse(input);
  if (!p.success) return { ok: false, errors: p.error.issues.map((i) => i.path.join('.')) };
  const v = p.data;
  const endsAt = v.until ? new Date(`${v.until}T23:59:59+01:00`) : null;
  if (endsAt && endsAt <= now) return { ok: false, errors: ['until'] };
  await endAddon(db, accountId, v.addon, now);
  const [r] = await db<{ id: number }[]>`
    INSERT INTO account_addons (account_id, addon, ends_at, note, granted_by)
    VALUES (${accountId}, ${v.addon}, ${endsAt}, ${v.note || null}, ${by.slice(0, 200)})
    RETURNING id`;
  return { ok: true, id: Number(r!.id) };
}

/** Ends a gift of this add-on now (store subscriptions are the store's). */
export async function endAddon(
  db: Db,
  accountId: number,
  addon: AddonId,
  now = new Date(),
): Promise<number> {
  const r = await db`
    UPDATE account_addons SET ended_at = ${now}
     WHERE account_id = ${accountId} AND addon = ${addon} AND ended_at IS NULL
       AND (ends_at IS NULL OR ends_at > ${now})`;
  return r.count;
}

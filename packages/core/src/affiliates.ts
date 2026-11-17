// Affiliate links for the app subscription (Antalyse GmbH). An influencer (affiliate) has one or
// more links, each with a code: overpricedcardboard.com/r/<CODE>, or the code typed in on the
// website or in the app. An account that comes with a code before its first paid subscription is
// registered for that link (one link per account, the first one counts) and gets the link's
// discount on its first subscription: a Stripe coupon on the website, the link's Google Play offer
// or App Store offer code in the app. Its first purchase is noted on the registration. Payouts are
// made by hand from the export of the registrations of a period.
import { z } from 'zod';
import type { Db } from './db.ts';

export type Affiliate = {
  id: number;
  name: string;
  email: string | null;
  country: string | null;
  commission: string | null;
  payoutDetails: string | null;
  note: string | null;
  active: boolean;
  createdAt: Date;
};

export type AffiliateLink = {
  id: number;
  affiliateId: number;
  affiliateName: string;
  code: string;
  label: string | null;
  discountPercent: number;
  /** null: as long as the subscription runs */
  discountMonths: number | null;
  googleOfferId: string | null;
  /** the custom offer code in App Store Connect with the link's discount */
  appleOfferCode: string | null;
  active: boolean;
  createdAt: Date;
};

/** What an account gets at its first subscription. */
export type AffiliateDiscount = {
  code: string;
  percent: number;
  months: number | null;
  googleOfferId: string | null;
  appleOfferCode: string | null;
};

export type AffiliateVia = 'link' | 'code' | 'app' | 'admin';

const CODE = /^[A-Z0-9][A-Z0-9-]{2,29}$/;

/** "misty-yt " → "MISTY-YT"; null when it can't be a code. */
export function normalizeAffiliateCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const c = input.trim().toUpperCase();
  return CODE.test(c) ? c : null;
}

// ---------------------------------------------------------------------------
// Admin: influencers and their links
// ---------------------------------------------------------------------------

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'too_long')
    .transform((v) => v || null)
    .nullable()
    .optional()
    .transform((v) => v ?? null);

export const AffiliateInput = z.object({
  name: z.string().trim().min(1, 'required').max(120, 'too_long'),
  email: z
    .string()
    .trim()
    .max(254)
    .refine((v) => v === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'invalid')
    .transform((v) => v || null)
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === '' || /^[A-Z]{2}$/.test(v), 'invalid')
    .transform((v) => v || null)
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  commission: text(500),
  payoutDetails: text(1000),
  note: text(2000),
  active: z.boolean().default(true),
});
export type AffiliateInput = z.input<typeof AffiliateInput>;

export const AffiliateLinkInput = z
  .object({
    affiliateId: z.coerce.number().int().positive(),
    code: z
      .string()
      .transform((v) => normalizeAffiliateCode(v) ?? '')
      .refine((v) => v !== '', 'invalid'),
    label: text(80),
    discountPercent: z.coerce.number().int('invalid').min(0, 'invalid').max(90, 'invalid'),
    discountMonths: z
      .union([z.literal(''), z.null(), z.coerce.number().int().min(1).max(36)])
      .optional()
      .transform((v) => (typeof v === 'number' ? v : null)),
    googleOfferId: z
      .string()
      .trim()
      .refine((v) => v === '' || /^[a-z0-9][a-z0-9-]{0,62}$/.test(v), 'invalid')
      .transform((v) => v || null)
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    // letters and digits only (App Store Connect's rule for custom codes)
    appleOfferCode: z
      .string()
      .trim()
      .refine((v) => v === '' || /^[A-Za-z0-9]{1,64}$/.test(v), 'invalid')
      .transform((v) => v.toUpperCase() || null)
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    active: z.boolean().default(true),
  })
  .refine((v) => v.discountPercent > 0 || v.discountMonths === null, {
    path: ['discountMonths'],
    message: 'without_discount',
  });
export type AffiliateLinkInput = z.input<typeof AffiliateLinkInput>;

type Problems = Record<string, string>;
const problems = (e: z.ZodError): Problems =>
  Object.fromEntries(e.issues.map((i) => [i.path.join('.') || '_', i.message]));

export async function saveAffiliate(
  db: Db,
  input: AffiliateInput,
  id?: number,
): Promise<{ ok: true; id: number } | { ok: false; errors: Problems }> {
  const p = AffiliateInput.safeParse(input);
  if (!p.success) return { ok: false, errors: problems(p.error) };
  const v = p.data;
  const [r] = id
    ? await db<{ id: number }[]>`
        UPDATE affiliates SET name = ${v.name}, email = ${v.email}, country = ${v.country},
               commission = ${v.commission}, payout_details = ${v.payoutDetails}, note = ${v.note},
               active = ${v.active}
         WHERE id = ${id} RETURNING id`
    : await db<{ id: number }[]>`
        INSERT INTO affiliates (name, email, country, commission, payout_details, note, active)
        VALUES (${v.name}, ${v.email}, ${v.country}, ${v.commission}, ${v.payoutDetails}, ${v.note},
                ${v.active})
        RETURNING id`;
  return r ? { ok: true, id: Number(r.id) } : { ok: false, errors: { _: 'not_found' } };
}

export async function saveAffiliateLink(
  db: Db,
  input: AffiliateLinkInput,
  id?: number,
): Promise<{ ok: true; id: number } | { ok: false; errors: Problems }> {
  const p = AffiliateLinkInput.safeParse(input);
  if (!p.success) return { ok: false, errors: problems(p.error) };
  const v = p.data;
  try {
    const [r] = id
      ? await db<{ id: number }[]>`
          UPDATE affiliate_links SET code = ${v.code}, label = ${v.label},
                 discount_percent = ${v.discountPercent}, discount_months = ${v.discountMonths},
                 google_offer_id = ${v.googleOfferId}, apple_offer_code = ${v.appleOfferCode},
                 active = ${v.active}
           WHERE id = ${id} AND affiliate_id = ${v.affiliateId} RETURNING id`
      : await db<{ id: number }[]>`
          INSERT INTO affiliate_links (affiliate_id, code, label, discount_percent, discount_months,
                                       google_offer_id, apple_offer_code, active)
          VALUES (${v.affiliateId}, ${v.code}, ${v.label}, ${v.discountPercent}, ${v.discountMonths},
                  ${v.googleOfferId}, ${v.appleOfferCode}, ${v.active})
          RETURNING id`;
    return r ? { ok: true, id: Number(r.id) } : { ok: false, errors: { _: 'not_found' } };
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return { ok: false, errors: { code: 'taken' } };
    if ((e as { code?: string }).code === '23503') {
      return { ok: false, errors: { affiliateId: 'not_found' } };
    }
    throw e;
  }
}

type LinkRow = {
  id: number;
  affiliate_id: number;
  affiliate_name: string;
  code: string;
  label: string | null;
  discount_percent: number;
  discount_months: number | null;
  google_offer_id: string | null;
  apple_offer_code: string | null;
  active: boolean;
  created_at: Date;
};

const toLink = (r: LinkRow): AffiliateLink => ({
  id: Number(r.id),
  affiliateId: Number(r.affiliate_id),
  affiliateName: r.affiliate_name,
  code: r.code,
  label: r.label,
  discountPercent: r.discount_percent,
  discountMonths: r.discount_months,
  googleOfferId: r.google_offer_id,
  appleOfferCode: r.apple_offer_code,
  active: r.active,
  createdAt: r.created_at,
});

export type AffiliateOverview = Affiliate & {
  links: (AffiliateLink & { registrations: number; purchases: number; total: number })[];
};

/** Admin: every influencer with their links and the registrations / first purchases in a period. */
export async function listAffiliates(
  db: Db,
  period: { from: Date; to: Date },
): Promise<AffiliateOverview[]> {
  const [affs, links] = await Promise.all([
    db<
      {
        id: number;
        name: string;
        email: string | null;
        country: string | null;
        commission: string | null;
        payout_details: string | null;
        note: string | null;
        active: boolean;
        created_at: Date;
      }[]
    >`SELECT * FROM affiliates ORDER BY active DESC, lower(name)`,
    db<(LinkRow & { registrations: number; purchases: number; total: number })[]>`
      SELECT l.*, a.name AS affiliate_name,
             (SELECT count(*) FROM affiliate_registrations r
               WHERE r.link_id = l.id AND r.registered_at >= ${period.from}
                 AND r.registered_at < ${period.to})::int AS registrations,
             (SELECT count(*) FROM affiliate_registrations r
               WHERE r.link_id = l.id AND r.first_purchase_at >= ${period.from}
                 AND r.first_purchase_at < ${period.to})::int AS purchases,
             (SELECT count(*) FROM affiliate_registrations r WHERE r.link_id = l.id)::int AS total
        FROM affiliate_links l JOIN affiliates a ON a.id = l.affiliate_id
       ORDER BY l.active DESC, l.code`,
  ]);
  return affs.map((a) => ({
    id: Number(a.id),
    name: a.name,
    email: a.email,
    country: a.country,
    commission: a.commission,
    payoutDetails: a.payout_details,
    note: a.note,
    active: a.active,
    createdAt: a.created_at,
    links: links
      .filter((l) => Number(l.affiliate_id) === Number(a.id))
      .map((l) => ({
        ...toLink(l),
        registrations: l.registrations,
        purchases: l.purchases,
        total: l.total,
      })),
  }));
}

/** An active link of an active influencer, by its code. */
export async function affiliateLinkByCode(db: Db, code: string): Promise<AffiliateLink | null> {
  const c = normalizeAffiliateCode(code);
  if (!c) return null;
  const [r] = await db<LinkRow[]>`
    SELECT l.*, a.name AS affiliate_name
      FROM affiliate_links l JOIN affiliates a ON a.id = l.affiliate_id
     WHERE l.code = ${c} AND l.active AND a.active`;
  return r ? toLink(r) : null;
}

// ---------------------------------------------------------------------------
// Registering an account, its discount, its first purchase
// ---------------------------------------------------------------------------

/**
 * Has the account ever paid for a subscription (website or store)? Free ones don't count;
 * `exceptPurchase`: leaving out this store purchase.
 */
async function everPaid(db: Db, accountId: number, exceptPurchase?: number): Promise<boolean> {
  const [r] = await db<{ paid: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM subscriptions
                    WHERE account_id = ${accountId} AND source = 'stripe'
                      AND status NOT IN ('incomplete', 'incomplete_expired'))
        OR EXISTS (SELECT 1 FROM store_purchases
                    WHERE account_id = ${accountId} AND refused IS NULL AND state <> 'pending'
                      AND kind = 'plan' AND id <> ${exceptPurchase ?? 0})
           AS paid`;
  return Boolean(r?.paid);
}

export type RegisterResult =
  | { ok: true; link: AffiliateLink; created: boolean }
  | { ok: false; problem: 'unknown_code' | 'already_registered' | 'already_customer' };

/**
 * Registers the account for the link with this code. The first link counts; an account that has
 * paid for a subscription before can't be registered any more. The same code again is fine.
 */
export async function registerAffiliate(
  db: Db,
  input: { accountId: number; code: string; via: AffiliateVia; now?: Date },
): Promise<RegisterResult> {
  const link = await affiliateLinkByCode(db, input.code);
  if (!link) return { ok: false, problem: 'unknown_code' };
  const [existing] = await db<{ link_id: number }[]>`
    SELECT link_id FROM affiliate_registrations WHERE account_id = ${input.accountId}`;
  if (existing) {
    return Number(existing.link_id) === link.id
      ? { ok: true, link, created: false }
      : { ok: false, problem: 'already_registered' };
  }
  if (await everPaid(db, input.accountId)) return { ok: false, problem: 'already_customer' };
  const [acc] = await db<{ public_id: string }[]>`
    SELECT public_id FROM accounts WHERE id = ${input.accountId} AND deleted_at IS NULL`;
  if (!acc) return { ok: false, problem: 'unknown_code' };
  const r = await db`
    INSERT INTO affiliate_registrations (link_id, account_id, account_public_id, registered_at, via)
    VALUES (${link.id}, ${input.accountId}, ${acc.public_id}, ${input.now ?? new Date()}, ${input.via})
    ON CONFLICT (account_id) DO NOTHING`;
  if (r.count === 0) return registerAffiliate(db, input);
  return { ok: true, link, created: true };
}

export type AccountAffiliate = {
  link: AffiliateLink;
  registeredAt: Date;
  via: AffiliateVia;
  firstPurchaseAt: Date | null;
  discountUsed: boolean | null;
};

export async function accountAffiliate(
  db: Db,
  accountId: number,
): Promise<AccountAffiliate | null> {
  const [r] = await db<
    (LinkRow & {
      registered_at: Date;
      via: AffiliateVia;
      first_purchase_at: Date | null;
      discount_used: boolean | null;
      link_id: number;
    })[]
  >`
    SELECT l.*, a.name AS affiliate_name, r.registered_at, r.via, r.first_purchase_at,
           r.discount_used, r.link_id
      FROM affiliate_registrations r
      JOIN affiliate_links l ON l.id = r.link_id
      JOIN affiliates a ON a.id = l.affiliate_id
     WHERE r.account_id = ${accountId}`;
  if (!r) return null;
  return {
    link: toLink(r),
    registeredAt: r.registered_at,
    via: r.via,
    firstPurchaseAt: r.first_purchase_at,
    discountUsed: r.discount_used,
  };
}

/**
 * The discount the account gets at its first subscription: from its link, while the link and
 * its influencer are active and the account has never paid for a subscription.
 */
export async function affiliateDiscount(
  db: Db,
  accountId: number,
): Promise<AffiliateDiscount | null> {
  const a = await accountAffiliate(db, accountId);
  if (!a || !a.link.active || a.firstPurchaseAt) return null;
  if (a.link.discountPercent === 0 && !a.link.googleOfferId && !a.link.appleOfferCode) return null;
  const [inf] = await db<{ active: boolean }[]>`
    SELECT active FROM affiliates WHERE id = ${a.link.affiliateId}`;
  if (!inf?.active || (await everPaid(db, accountId))) return null;
  return {
    code: a.link.code,
    percent: a.link.discountPercent,
    months: a.link.discountMonths,
    googleOfferId: a.link.googleOfferId,
    appleOfferCode: a.link.appleOfferCode,
  };
}

/**
 * An App Store purchase made with an offer code (offerType 3) by an account without a link: if
 * the offer is a link's (offerIdentifier = its offer code or its code, as set up in App Store
 * Connect), the account is registered for that link – codes are also redeemed in the App Store
 * itself, outside the app. Only for the account's first paid subscription (`purchaseId`).
 */
export async function registerFromOfferCode(
  db: Db,
  accountId: number,
  offerIdentifier: string,
  purchaseId: number,
  now = new Date(),
): Promise<boolean> {
  const id = offerIdentifier.trim().toUpperCase();
  if (!id) return false;
  const [link] = await db<{ id: number }[]>`
    SELECT l.id FROM affiliate_links l JOIN affiliates a ON a.id = l.affiliate_id
     WHERE l.active AND a.active AND (upper(l.apple_offer_code) = ${id} OR l.code = ${id})
     ORDER BY (upper(l.apple_offer_code) = ${id}) DESC NULLS LAST LIMIT 1`;
  if (!link) return false;
  const [known] = await db`SELECT 1 FROM affiliate_registrations WHERE account_id = ${accountId}`;
  if (known || (await everPaid(db, accountId, purchaseId))) return false;
  const r = await db`
    INSERT INTO affiliate_registrations (link_id, account_id, account_public_id, registered_at, via)
    SELECT ${link.id}, id, public_id, ${now}, 'app' FROM accounts
     WHERE id = ${accountId} AND deleted_at IS NULL
    ON CONFLICT (account_id) DO NOTHING`;
  return r.count > 0;
}

/**
 * The account's first paid subscription, noted on its registration (once). The discount counts
 * as used when the website checkout carried the code, the Play purchase used the link's offer,
 * or the App Store purchase was made with an offer code (`discountUsed`).
 */
export async function noteAffiliatePurchase(
  db: Db,
  accountId: number,
  p: {
    source: 'stripe' | 'google_play' | 'app_store';
    plan: 'collector' | 'creator' | null;
    period: 'monthly' | 'yearly' | null;
    country: string | null;
    /** website: whether the checkout carried the code; App Store: whether an offer code was used */
    discountUsed?: boolean;
    /** Google Play: the offer the purchase used */
    offerId?: string | null;
    at?: Date;
  },
): Promise<boolean> {
  const country = p.country && /^[A-Z]{2}$/.test(p.country) ? p.country : null;
  const r = await db`
    UPDATE affiliate_registrations r
       SET first_purchase_at = ${p.at ?? new Date()}, first_purchase_source = ${p.source},
           first_plan = ${p.plan}, first_period = ${p.period}, first_country = ${country},
           discount_used = CASE
             WHEN ${p.discountUsed ?? null}::boolean IS NOT NULL THEN ${p.discountUsed ?? null}::boolean
             ELSE (l.google_offer_id IS NOT NULL AND l.google_offer_id = ${p.offerId ?? null})
           END
      FROM affiliate_links l
     WHERE l.id = r.link_id AND r.account_id = ${accountId} AND r.first_purchase_at IS NULL`;
  return r.count > 0;
}

// ---------------------------------------------------------------------------
// Export for the payouts
// ---------------------------------------------------------------------------

export type AffiliateExportRow = {
  registeredAt: Date;
  affiliate: string;
  affiliateCountry: string | null;
  commission: string | null;
  code: string;
  label: string | null;
  discount: string;
  via: AffiliateVia;
  account: string;
  accountDeleted: boolean;
  firstPurchaseAt: Date | null;
  source: string | null;
  plan: string | null;
  period: string | null;
  country: string | null;
  discountUsed: boolean | null;
  /** the subscription today: running, ended, none */
  now: 'running' | 'ended' | 'none';
};

export const discountLabel = (
  percent: number,
  months: number | null,
  offer: string | null,
  appleCode: string | null = null,
) =>
  [
    percent > 0
      ? `${percent} %${months ? ` für ${months} Monat${months === 1 ? '' : 'e'}` : ''}`
      : '',
    offer ? `Play-Angebot ${offer}` : '',
    appleCode ? `App-Store-Code ${appleCode}` : '',
  ]
    .filter(Boolean)
    .join(', ') || 'kein Rabatt';

/** Every registration of the period (all influencers), oldest first. `to` is exclusive. */
export async function affiliateRegistrations(
  db: Db,
  period: { from: Date; to: Date },
  now = new Date(),
): Promise<AffiliateExportRow[]> {
  const rows = await db<
    {
      registered_at: Date;
      affiliate: string;
      affiliate_country: string | null;
      commission: string | null;
      code: string;
      label: string | null;
      discount_percent: number;
      discount_months: number | null;
      google_offer_id: string | null;
      apple_offer_code: string | null;
      via: AffiliateVia;
      account_public_id: string;
      account_id: number | null;
      deleted: boolean | null;
      first_purchase_at: Date | null;
      first_purchase_source: string | null;
      first_plan: string | null;
      first_period: string | null;
      first_country: string | null;
      discount_used: boolean | null;
      web_running: boolean | null;
      store_running: boolean | null;
    }[]
  >`
    SELECT r.registered_at, a.name AS affiliate, a.country AS affiliate_country, a.commission,
           l.code, l.label, l.discount_percent, l.discount_months, l.google_offer_id,
           l.apple_offer_code, r.via,
           r.account_public_id, r.account_id, acc.deleted_at IS NOT NULL AS deleted,
           r.first_purchase_at, r.first_purchase_source, r.first_plan, r.first_period,
           r.first_country, r.discount_used,
           EXISTS (SELECT 1 FROM subscriptions s
                    WHERE s.account_id = r.account_id AND s.source = 'stripe'
                      AND s.status IN ('active', 'trialing', 'past_due')) AS web_running,
           EXISTS (SELECT 1 FROM store_purchases p
                    WHERE p.account_id = r.account_id AND p.refused IS NULL AND p.replaced_by IS NULL
                      AND p.kind = 'plan'
                      AND p.state IN ('active', 'canceled', 'grace') AND p.expires_at > ${now})
             AS store_running
      FROM affiliate_registrations r
      JOIN affiliate_links l ON l.id = r.link_id
      JOIN affiliates a ON a.id = l.affiliate_id
      LEFT JOIN accounts acc ON acc.id = r.account_id
     WHERE r.registered_at >= ${period.from} AND r.registered_at < ${period.to}
     ORDER BY r.registered_at, r.id`;
  return rows.map((r) => ({
    registeredAt: r.registered_at,
    affiliate: r.affiliate,
    affiliateCountry: r.affiliate_country,
    commission: r.commission,
    code: r.code,
    label: r.label,
    discount: discountLabel(
      r.discount_percent,
      r.discount_months,
      r.google_offer_id,
      r.apple_offer_code,
    ),
    via: r.via,
    account: r.account_public_id,
    accountDeleted: r.account_id === null || Boolean(r.deleted),
    firstPurchaseAt: r.first_purchase_at,
    source: r.first_purchase_source,
    plan: r.first_plan,
    period: r.first_period,
    country: r.first_country,
    discountUsed: r.discount_used,
    now: r.web_running || r.store_running ? 'running' : r.first_purchase_at ? 'ended' : 'none',
  }));
}

const SOURCE: Record<string, string> = {
  stripe: 'Website',
  google_play: 'Google Play',
  app_store: 'App Store',
};
const VIA: Record<AffiliateVia, string> = {
  link: 'Link',
  code: 'Code (Website)',
  app: 'App',
  admin: 'Admin',
};
const NOW = { running: 'läuft', ended: 'beendet', none: 'kein Abo' } as const;

/** The export as CSV for Excel (semicolons, UTF-8 with BOM, dates in Vienna time). */
export function affiliateCsv(rows: AffiliateExportRow[]): string {
  const day = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat('de-AT', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'Europe/Vienna',
        }).format(d)
      : '';
  const cell = (v: string | null | undefined) => {
    const s = (v ?? '').replace(/\r?\n/g, ' ');
    // no formulas when opened in Excel
    const safe = /^[=+\-@\t]/.test(s) ? `'${s}` : s;
    return /[;"]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = [
    'Registriert am',
    'Influencer',
    'Land Influencer',
    'Vergütung',
    'Code',
    'Link',
    'Rabatt des Links',
    'Weg',
    'Konto',
    'Konto gelöscht',
    'Erstes Abo am',
    'Abo über',
    'Plan',
    'Laufzeit',
    'Land Käufer',
    'Rabatt genutzt',
    'Abo heute',
  ];
  const lines = rows.map((r) =>
    [
      day(r.registeredAt),
      r.affiliate,
      r.affiliateCountry,
      r.commission,
      r.code,
      r.label,
      r.discount,
      VIA[r.via],
      r.account,
      r.accountDeleted ? 'ja' : 'nein',
      day(r.firstPurchaseAt),
      r.source ? (SOURCE[r.source] ?? r.source) : '',
      r.plan ? (r.plan === 'creator' ? 'Creator' : 'Collector') : '',
      r.period ? (r.period === 'yearly' ? 'jährlich' : 'monatlich') : '',
      r.country,
      r.discountUsed === null ? '' : r.discountUsed ? 'ja' : 'nein',
      NOW[r.now],
    ]
      .map((v) => cell(v))
      .join(';'),
  );
  return `﻿${[head.join(';'), ...lines].join('\r\n')}\r\n`;
}

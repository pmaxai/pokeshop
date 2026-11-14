// Missing cards ("wanted"): cards a customer is looking for. The shop sees the demand, makes
// offers (one copy at a price of its own, also from a draft product nobody else sees), and the
// worker mails the customer once a matching card is in the shop. Portal, app
// (docs/app-account-api.md) and admin use this module.
import { z } from 'zod';
import { CARD_LANGUAGES, FINISHES, CONDITIONS } from './catalog.ts';
import type { Db, Sql } from './db.ts';
import { enqueueMail } from './outbox.ts';
import { fieldErrors, nameLangs } from './collection.ts';
import { packCards, toCents, unitValue, type PackCard } from './pack-cards.ts';
import { accountEntitlements } from './subscriptions.ts';

/** An offer is open this many days unless the shop says otherwise. */
export const OFFER_DAYS = 7;
export const MAX_OFFER_DAYS = 60;
/** At most this many cards on one customer's list. */
export const MAX_WANTED = 500;

const LANGS = CARD_LANGUAGES as readonly string[];
const FINISH_KEYS = Object.keys(FINISHES);
const CONDITION_KEYS = Object.keys(CONDITIONS);

const optional = <T extends z.ZodType>(t: T) =>
  z.preprocess((v) => (v === '' || v === undefined ? null : v), t.nullable());

export const WantedInput = z.object({
  card_id: z.string().trim().min(1, 'required').max(80, 'too_long'),
  language: optional(
    z
      .string()
      .trim()
      .toUpperCase()
      .refine((v) => LANGS.includes(v), 'invalid'),
  ),
  finish: optional(z.string().refine((v) => FINISH_KEYS.includes(v), 'invalid')),
  min_condition: optional(
    z
      .string()
      .toUpperCase()
      .refine((v) => CONDITION_KEYS.includes(v), 'invalid'),
  ),
  max_price_cents: optional(
    z.coerce.number().int('invalid').min(1, 'invalid').max(100_000_000, 'too_large'),
  ),
  note: optional(
    z
      .string()
      .trim()
      .max(500, 'too_long')
      .transform((v) => v || null),
  ),
});
export type WantedInput = z.infer<typeof WantedInput>;

export type WantedState = 'searching' | 'offer' | 'available';

export type ShopMatch = {
  productId: number;
  slug: string;
  slugEn: string | null;
  language: string;
  finish: string;
  condition: string;
  grading: string | null;
  priceCents: number;
};

export type Offer = {
  id: number;
  wantedId: number;
  productId: number;
  priceCents: number;
  listPriceCents: number | null;
  message: string | null;
  expiresAt: Date;
  status: 'open' | 'accepted' | 'declined' | 'withdrawn' | 'expired';
  createdAt: Date;
  orderId: number | null;
  product: {
    sku: string;
    language: string;
    finish: string;
    condition: string;
    grading: string | null;
    draft: boolean;
    available: number;
  };
};

export type Wanted = {
  id: number;
  clientRef: string | null;
  cardId: string;
  language: string | null;
  finish: string | null;
  minCondition: string | null;
  maxPriceCents: number | null;
  note: string | null;
  createdAt: Date;
  card: PackCard | null;
  /** Value of a copy as wished (printing, condition), from the data pack. */
  valueCents: number | null;
  state: WantedState;
  /** Matching cards in the shop right now. */
  inShop: ShopMatch[];
  /** Open offers. */
  offers: Offer[];
};

type WantedRow = {
  id: number;
  account_id: number;
  client_ref: string | null;
  card_id: string;
  language: string | null;
  finish: string | null;
  min_condition: string | null;
  max_price_cents: number | null;
  note: string | null;
  created_at: Date;
};

// A product matches a missing card when it is that card and fits every wish the customer made.
const MATCH = `p.card_ref = w.card_id
  AND (w.language IS NULL OR p.card_language = w.language)
  AND (w.finish IS NULL OR p.finish = w.finish)
  AND (w.min_condition IS NULL OR
       array_position(ARRAY['M','NM','EX','GD','LP','PL','PO'], p.condition)
         <= array_position(ARRAY['M','NM','EX','GD','LP','PL','PO'], w.min_condition))`;
// … and it can be bought now, at a price the customer accepts.
const IN_SHOP = `p.status = 'active' AND p.price_cents IS NOT NULL AND ps.available > 0
  AND (w.max_price_cents IS NULL OR p.price_cents <= w.max_price_cents)`;
// An offer the customer can still take.
const OFFER_OPEN = `o.status = 'open' AND o.expires_at > now()`;

async function cardExists(db: Db, cardId: string): Promise<boolean> {
  const [r] = await db<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pack_cards WHERE id = ${cardId}) AS ok`;
  return Boolean(r?.ok);
}

type OfferRow = {
  id: number;
  wanted_id: number;
  product_id: number;
  price_cents: number;
  list_price_cents: number | null;
  message: string | null;
  expires_at: Date;
  status: 'open' | 'accepted' | 'declined' | 'withdrawn';
  created_at: Date;
  order_id: number | null;
  sku: string;
  card_language: string;
  finish: string;
  condition: string;
  grading_company: string | null;
  grading_grade: string | null;
  product_status: string;
  available: number;
};

const OFFER_COLUMNS = `o.id, o.wanted_id, o.product_id, o.price_cents, p.price_cents AS list_price_cents,
  o.message, o.expires_at, o.status, o.created_at, o.order_id, p.sku, p.card_language, p.finish,
  p.condition, p.grading_company, p.grading_grade, p.status AS product_status, ps.available`;

const toOffer = (r: OfferRow, now = new Date()): Offer => ({
  id: Number(r.id),
  wantedId: Number(r.wanted_id),
  productId: Number(r.product_id),
  priceCents: r.price_cents,
  listPriceCents: r.list_price_cents,
  message: r.message,
  expiresAt: r.expires_at,
  status: r.status === 'open' && r.expires_at <= now ? 'expired' : r.status,
  createdAt: r.created_at,
  orderId: r.order_id === null ? null : Number(r.order_id),
  product: {
    sku: r.sku,
    language: r.card_language,
    finish: r.finish,
    condition: r.condition,
    grading: r.grading_company ? `${r.grading_company} ${r.grading_grade}` : null,
    draft: r.product_status === 'draft',
    available: r.available,
  },
});

async function withDetails(db: Db, rows: WantedRow[], locale: 'de' | 'en'): Promise<Wanted[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => Number(r.id));
  const [matches, offers] = await Promise.all([
    db<(ShopMatch & { wanted_id: number })[]>`
      SELECT w.id AS wanted_id, p.id AS "productId", p.slug, p.slug_en AS "slugEn",
             p.card_language AS language, p.finish, p.condition,
             CASE WHEN p.grading_company IS NULL THEN NULL
                  ELSE p.grading_company || ' ' || p.grading_grade END AS grading,
             p.price_cents AS "priceCents"
        FROM wanted_cards w
        JOIN products p ON ${db.unsafe(MATCH)}
        JOIN product_stock ps ON ps.product_id = p.id
       WHERE w.id = ANY(${ids}::bigint[]) AND ${db.unsafe(IN_SHOP)}
       ORDER BY p.price_cents, p.id`,
    db<OfferRow[]>`
      SELECT ${db.unsafe(OFFER_COLUMNS)}
        FROM wanted_offers o JOIN products p ON p.id = o.product_id
        JOIN product_stock ps ON ps.product_id = p.id
       WHERE o.wanted_id = ANY(${ids}::bigint[]) AND ${db.unsafe(OFFER_OPEN)}
         AND p.status IN ('active', 'draft')
       ORDER BY o.created_at DESC`,
  ]);
  const byLang = new Map<string, string[]>();
  for (const r of rows) {
    const key = nameLangs(r.language ?? locale.toUpperCase(), locale).join(',');
    byLang.set(key, [...(byLang.get(key) ?? []), r.card_id]);
  }
  const cards = new Map<string, Map<string, PackCard>>();
  for (const [key, list] of byLang) cards.set(key, await packCards(db, list, key.split(',')));
  return rows.map((r) => {
    const id = Number(r.id);
    const card =
      cards.get(nameLangs(r.language ?? locale.toUpperCase(), locale).join(','))?.get(r.card_id) ??
      null;
    const inShop = matches
      .filter((m) => Number(m.wanted_id) === id)
      .map(({ wanted_id: _w, ...m }) => ({ ...m, productId: Number(m.productId) }));
    const open = offers.filter((o) => Number(o.wanted_id) === id).map((o) => toOffer(o));
    return {
      id,
      clientRef: r.client_ref,
      cardId: r.card_id,
      language: r.language,
      finish: r.finish,
      minCondition: r.min_condition,
      maxPriceCents: r.max_price_cents,
      note: r.note,
      createdAt: r.created_at,
      card,
      valueCents: card
        ? toCents(unitValue(card, { finish: r.finish, condition: r.min_condition ?? 'NM' }))
        : null,
      state: open.length ? 'offer' : inShop.length ? 'available' : 'searching',
      inShop,
      offers: open,
    };
  });
}

export type AddWantedResult =
  { ok: true; wanted: Wanted; created: boolean } | { ok: false; errors: Record<string, string> };

/**
 * Puts a card on the customer's list. `clientRef` makes it safe to repeat; the same card with
 * the same wishes already on the list is returned instead of a second entry. Cards that are
 * in the shop at this moment are shown at once, so no e-mail goes out for them.
 */
export async function addWanted(
  sql: Sql,
  accountId: number,
  input: unknown,
  opts: { clientRef?: string | null; locale?: 'de' | 'en' } = {},
): Promise<AddWantedResult> {
  const r = WantedInput.safeParse(input);
  if (!r.success) return { ok: false, errors: fieldErrors(r.error.issues) };
  const d = r.data;
  if (opts.clientRef != null && !/^[A-Za-z0-9-]{8,64}$/.test(opts.clientRef)) {
    return { ok: false, errors: { client_ref: 'invalid' } };
  }
  if (!(await cardExists(sql, d.card_id))) return { ok: false, errors: { card_id: 'unknown' } };
  const out = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`wanted:${accountId}`}))`;
    if (opts.clientRef) {
      const [seen] = await tx<WantedRow[]>`
        SELECT * FROM wanted_cards WHERE account_id = ${accountId} AND client_ref = ${opts.clientRef}`;
      if (seen) return { row: seen, created: false };
    }
    const [same] = await tx<WantedRow[]>`
      SELECT * FROM wanted_cards
       WHERE account_id = ${accountId} AND closed_at IS NULL AND card_id = ${d.card_id}
         AND language IS NOT DISTINCT FROM ${d.language}
         AND finish IS NOT DISTINCT FROM ${d.finish}
         AND min_condition IS NOT DISTINCT FROM ${d.min_condition}
         AND max_price_cents IS NOT DISTINCT FROM ${d.max_price_cents}
       ORDER BY id LIMIT 1`;
    if (same) return { row: same, created: false };
    const [n] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM wanted_cards WHERE account_id = ${accountId} AND closed_at IS NULL`;
    if ((n?.n ?? 0) >= MAX_WANTED) return { full: true as const };
    const [row] = await tx<WantedRow[]>`
      INSERT INTO wanted_cards (account_id, client_ref, card_id, language, finish, min_condition,
                                max_price_cents, note)
      VALUES (${accountId}, ${opts.clientRef ?? null}, ${d.card_id}, ${d.language}, ${d.finish},
              ${d.min_condition}, ${d.max_price_cents}, ${d.note})
      RETURNING *`;
    await tx`
      INSERT INTO wanted_alerts (wanted_id, product_id, mailed)
      SELECT w.id, p.id, false
        FROM wanted_cards w JOIN products p ON ${tx.unsafe(MATCH)}
        JOIN product_stock ps ON ps.product_id = p.id
       WHERE w.id = ${row!.id} AND ${tx.unsafe(IN_SHOP)}
      ON CONFLICT DO NOTHING`;
    return { row: row!, created: true };
  });
  if ('full' in out) return { ok: false, errors: { card_id: 'too_many' } };
  const [w] = await withDetails(sql, [out.row], opts.locale ?? 'en');
  return { ok: true, wanted: w!, created: out.created };
}

/** Takes a card off the list; its open offers are declined with it. */
export async function removeWanted(sql: Sql, accountId: number, id: number): Promise<boolean> {
  return sql.begin(async (tx) => {
    const r = await tx`
      UPDATE wanted_cards SET closed_at = now(), closed_reason = 'removed', updated_at = now()
       WHERE id = ${id} AND account_id = ${accountId} AND closed_at IS NULL`;
    if (r.count === 0) return false;
    await tx`
      UPDATE wanted_offers SET status = 'declined', closed_at = now()
       WHERE wanted_id = ${id} AND status = 'open'`;
    return true;
  });
}

/** The customer's open list, newest first. */
export async function listWanted(
  db: Db,
  accountId: number,
  locale: 'de' | 'en',
): Promise<Wanted[]> {
  const rows = await db<WantedRow[]>`
    SELECT * FROM wanted_cards WHERE account_id = ${accountId} AND closed_at IS NULL
     ORDER BY created_at DESC, id DESC`;
  return withDetails(db, rows, locale);
}

export async function wantedOfCard(
  db: Db,
  accountId: number,
  cardId: string,
  locale: 'de' | 'en',
): Promise<Wanted[]> {
  const rows = await db<WantedRow[]>`
    SELECT * FROM wanted_cards
     WHERE account_id = ${accountId} AND card_id = ${cardId} AND closed_at IS NULL ORDER BY id`;
  return withDetails(db, rows, locale);
}

/** Cards from the list the customer bought recently (shown as found). */
export async function recentlyFound(
  db: Db,
  accountId: number,
  locale: 'de' | 'en',
  days = 30,
): Promise<(Wanted & { foundAt: Date })[]> {
  const rows = await db<(WantedRow & { closed_at: Date })[]>`
    SELECT * FROM wanted_cards
     WHERE account_id = ${accountId} AND closed_reason = 'bought'
       AND closed_at > now() - make_interval(days => ${days})
     ORDER BY closed_at DESC`;
  const list = await withDetails(db, rows, locale);
  return list.map((w, i) => ({ ...w, state: 'searching', foundAt: rows[i]!.closed_at }));
}

/** The app's JSON for a missing card (docs/app-account-api.md). */
export function wantedJson(w: Wanted) {
  return {
    id: w.id,
    client_ref: w.clientRef,
    card_id: w.cardId,
    language: w.language,
    finish: w.finish,
    min_condition: w.minCondition,
    max_price_cents: w.maxPriceCents,
    note: w.note,
    name: w.card?.name ?? null,
    set_name: w.card?.setName ?? null,
    number: w.card?.number ?? null,
    image_url: w.card?.imageSource ?? null,
    value_cents: w.valueCents,
    state: w.state,
    created_at: w.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Offers: the customer's side
// ---------------------------------------------------------------------------

export async function declineOffer(db: Db, accountId: number, offerId: number): Promise<boolean> {
  const r = await db`
    UPDATE wanted_offers SET status = 'declined', closed_at = now()
     WHERE id = ${offerId} AND account_id = ${accountId} AND status = 'open'`;
  return r.count > 0;
}

export type OfferToCart = 'ok' | 'unknown' | 'expired' | 'sold';

/**
 * Puts the offered copy in the cart at the offer's price. The cart line stays one copy; the
 * checkout takes the offer's price only for the account the offer was made for.
 */
export async function offerToCart(
  sql: Sql,
  accountId: number,
  offerId: number,
  cartId: string,
): Promise<OfferToCart> {
  return sql.begin(async (tx) => {
    const [o] = await tx<
      {
        status: string;
        expires_at: Date;
        product_id: number;
        p_status: string;
        available: number;
      }[]
    >`
      SELECT o.status, o.expires_at, o.product_id, p.status AS p_status, ps.available
        FROM wanted_offers o JOIN products p ON p.id = o.product_id
        JOIN product_stock ps ON ps.product_id = p.id
        JOIN wanted_cards w ON w.id = o.wanted_id AND w.closed_at IS NULL
       WHERE o.id = ${offerId} AND o.account_id = ${accountId}`;
    if (!o || o.status !== 'open') return 'unknown';
    if (o.expires_at <= new Date()) return 'expired';
    if (!['active', 'draft'].includes(o.p_status) || o.available < 1) return 'sold';
    await tx`
      INSERT INTO cart_items (cart_id, product_id, quantity, offer_id)
      VALUES (${cartId}, ${o.product_id}, 1, ${offerId})
      ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = 1, offer_id = EXCLUDED.offer_id`;
    await tx`UPDATE carts SET updated_at = now() WHERE id = ${cartId}`;
    return 'ok';
  });
}

// ---------------------------------------------------------------------------
// The shop's side: demand, offers
// ---------------------------------------------------------------------------

export type Demand = {
  cardId: string;
  card: PackCard | null;
  /** customers with the card on their list */
  customers: number;
  languages: string[];
  /** the highest price a customer named (null: someone named none) */
  maxPriceCents: number | null;
  newest: Date;
  /** value of an NM copy from the data pack */
  valueCents: number | null;
  inShop: number;
  drafts: number;
  openOffers: number;
};

/** Cards customers are looking for, most wanted first. */
export async function wantedDemand(
  db: Db,
  opts: { query?: string; limit?: number } = {},
): Promise<Demand[]> {
  const q = opts.query?.trim().toLowerCase();
  const rows = await db<
    {
      card_id: string;
      customers: number;
      languages: string[];
      max_price: number | null;
      any_price: boolean;
      newest: Date;
      in_shop: number;
      drafts: number;
      open_offers: number;
    }[]
  >`
    SELECT w.card_id, count(DISTINCT w.account_id)::int AS customers,
           array_agg(DISTINCT coalesce(w.language, '*') ORDER BY coalesce(w.language, '*')) AS languages,
           max(w.max_price_cents) AS max_price, bool_or(w.max_price_cents IS NULL) AS any_price,
           max(w.created_at) AS newest,
           (SELECT count(*)::int FROM products p JOIN product_stock ps ON ps.product_id = p.id
             WHERE p.card_ref = w.card_id AND p.status = 'active' AND ps.available > 0) AS in_shop,
           (SELECT count(*)::int FROM products p JOIN product_stock ps ON ps.product_id = p.id
             WHERE p.card_ref = w.card_id AND p.status = 'draft' AND ps.available > 0) AS drafts,
           (SELECT count(*)::int FROM wanted_offers o JOIN wanted_cards w2 ON w2.id = o.wanted_id
             WHERE w2.card_id = w.card_id AND w2.closed_at IS NULL AND ${db.unsafe(OFFER_OPEN)}) AS open_offers
      FROM wanted_cards w
     WHERE w.closed_at IS NULL
       ${
         q
           ? db`AND (w.card_id ILIKE ${`%${q}%`} OR EXISTS (
                 SELECT 1 FROM pack_cards pc WHERE pc.id = w.card_id AND pc.names::text ILIKE ${`%${q}%`}))`
           : db``
       }
     GROUP BY w.card_id
     ORDER BY customers DESC, newest DESC
     LIMIT ${opts.limit ?? 200}`;
  const cards = await packCards(
    db,
    rows.map((r) => r.card_id),
    ['de', 'en'],
  );
  return rows.map((r) => {
    const card = cards.get(r.card_id) ?? null;
    return {
      cardId: r.card_id,
      card,
      customers: r.customers,
      languages: r.languages,
      maxPriceCents: r.any_price ? null : r.max_price,
      newest: r.newest,
      valueCents: card ? toCents(unitValue(card, { condition: 'NM' })) : null,
      inShop: r.in_shop,
      drafts: r.drafts,
      openOffers: r.open_offers,
    };
  });
}

export type Seeker = {
  wantedId: number;
  accountId: number;
  email: string;
  name: string | null;
  language: string | null;
  finish: string | null;
  minCondition: string | null;
  maxPriceCents: number | null;
  note: string | null;
  createdAt: Date;
  offers: Offer[];
};

/** Who is looking for a card, with what wishes and the offers made to them. */
export async function seekersOfCard(db: Db, cardId: string): Promise<Seeker[]> {
  const rows = await db<(WantedRow & { email: string; name: string | null; wanted_id: number })[]>`
    SELECT w.*, w.id AS wanted_id, a.email, a.name
      FROM wanted_cards w JOIN accounts a ON a.id = w.account_id
     WHERE w.card_id = ${cardId} AND w.closed_at IS NULL
     ORDER BY w.created_at`;
  if (rows.length === 0) return [];
  const offers = await db<OfferRow[]>`
    SELECT ${db.unsafe(OFFER_COLUMNS)}
      FROM wanted_offers o JOIN products p ON p.id = o.product_id
      JOIN product_stock ps ON ps.product_id = p.id
     WHERE o.wanted_id = ANY(${rows.map((r) => Number(r.id))}::bigint[])
     ORDER BY o.created_at DESC`;
  return rows.map((r) => ({
    wantedId: Number(r.id),
    accountId: Number(r.account_id),
    email: r.email,
    name: r.name,
    language: r.language,
    finish: r.finish,
    minCondition: r.min_condition,
    maxPriceCents: r.max_price_cents,
    note: r.note,
    createdAt: r.created_at,
    offers: offers.filter((o) => Number(o.wanted_id) === Number(r.id)).map((o) => toOffer(o)),
  }));
}

export type OfferableProduct = {
  id: number;
  sku: string;
  status: 'draft' | 'active';
  language: string;
  finish: string;
  condition: string;
  grading: string | null;
  priceCents: number | null;
  available: number;
};

/** Products of the card that could be offered: drafts and active ones with a free copy. */
export async function offerableProducts(db: Db, cardId: string): Promise<OfferableProduct[]> {
  const rows = await db<
    (Omit<OfferableProduct, 'grading'> & { gc: string | null; gg: string | null })[]
  >`
    SELECT p.id, p.sku, p.status, p.card_language AS language, p.finish, p.condition,
           p.grading_company AS gc, p.grading_grade AS gg, p.price_cents AS "priceCents", ps.available
      FROM products p JOIN product_stock ps ON ps.product_id = p.id
     WHERE p.card_ref = ${cardId} AND p.status IN ('draft', 'active') AND ps.available > 0
     ORDER BY p.status = 'draft' DESC, p.price_cents NULLS LAST, p.id`;
  return rows.map(({ gc, gg, ...r }) => ({
    ...r,
    id: Number(r.id),
    grading: gc ? `${gc} ${gg}` : null,
  }));
}

export const OfferInput = z.object({
  wantedId: z.coerce.number().int().positive(),
  productId: z.coerce.number().int().positive(),
  priceCents: z.coerce.number().int('invalid').min(1, 'invalid').max(100_000_000, 'too_large'),
  days: z.coerce.number().int('invalid').min(1, 'invalid').max(MAX_OFFER_DAYS, 'too_large'),
  message: z
    .string()
    .trim()
    .max(1000, 'too_long')
    .transform((v) => v || null)
    .nullable()
    .optional(),
});

export type CreateOfferResult =
  { ok: true; offerId: number } | { ok: false; errors: Record<string, string> };

/** The shop offers one copy of a product to a customer who is looking for that card. */
export async function createOffer(
  sql: Sql,
  input: unknown,
  opts: { by: string; now?: Date },
): Promise<CreateOfferResult> {
  const r = OfferInput.safeParse(input);
  if (!r.success) return { ok: false, errors: fieldErrors(r.error.issues) };
  const d = r.data;
  const now = opts.now ?? new Date();
  return sql.begin(async (tx): Promise<CreateOfferResult> => {
    const [w] = await tx<
      { account_id: number; card_id: string; email: string; locale: 'de' | 'en' }[]
    >`
      SELECT w.account_id, w.card_id, a.email, a.locale
        FROM wanted_cards w JOIN accounts a ON a.id = w.account_id
       WHERE w.id = ${d.wantedId} AND w.closed_at IS NULL FOR UPDATE OF w`;
    if (!w) return { ok: false, errors: { wantedId: 'unknown' } };
    const [p] = await tx<{ card_ref: string | null; status: string; available: number }[]>`
      SELECT p.card_ref, p.status, ps.available
        FROM products p JOIN product_stock ps ON ps.product_id = p.id WHERE p.id = ${d.productId}`;
    if (!p || p.card_ref !== w.card_id || !['draft', 'active'].includes(p.status)) {
      return { ok: false, errors: { productId: 'unknown' } };
    }
    if (p.available < 1) return { ok: false, errors: { productId: 'sold' } };
    const [o] = await tx<{ id: number }[]>`
      INSERT INTO wanted_offers (wanted_id, account_id, product_id, price_cents, message, expires_at,
                                 created_by, created_at)
      VALUES (${d.wantedId}, ${w.account_id}, ${d.productId}, ${d.priceCents}, ${d.message ?? null},
              ${now}::timestamptz + make_interval(days => ${d.days}), ${opts.by}, ${now})
      RETURNING id`;
    await enqueueMail(tx, {
      template: 'wanted_offer',
      to: w.email,
      locale: w.locale,
      payload: { offer_id: Number(o!.id) },
      dedupeKey: `wanted_offer:${o!.id}`,
    });
    return { ok: true, offerId: Number(o!.id) };
  });
}

export async function withdrawOffer(db: Db, offerId: number): Promise<boolean> {
  const r = await db`
    UPDATE wanted_offers SET status = 'withdrawn', closed_at = now()
     WHERE id = ${offerId} AND status = 'open'`;
  return r.count > 0;
}

/** Numbers for the admin overview. */
export async function wantedCounts(
  db: Db,
): Promise<{ cards: number; entries: number; openOffers: number }> {
  const [r] = await db<{ cards: number; entries: number; offers: number }[]>`
    SELECT (SELECT count(DISTINCT card_id)::int FROM wanted_cards WHERE closed_at IS NULL) AS cards,
           (SELECT count(*)::int FROM wanted_cards WHERE closed_at IS NULL) AS entries,
           (SELECT count(*)::int FROM wanted_offers o JOIN wanted_cards w ON w.id = o.wanted_id
             WHERE w.closed_at IS NULL AND ${db.unsafe(OFFER_OPEN)}) AS offers`;
  return { cards: r?.cards ?? 0, entries: r?.entries ?? 0, openOffers: r?.offers ?? 0 };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/**
 * "Now in the shop": for each customer, one e-mail with the cards from their list that came
 * into the shop since the last run (once per card and product). Customers whose subscription
 * has ended get nothing; their list waits.
 */
export async function sendWantedAlerts(sql: Sql): Promise<number> {
  const found = await sql<{ wanted_id: number; product_id: number; account_id: number }[]>`
    SELECT w.id AS wanted_id, p.id AS product_id, w.account_id
      FROM wanted_cards w
      JOIN products p ON ${sql.unsafe(MATCH)}
      JOIN product_stock ps ON ps.product_id = p.id
     WHERE w.closed_at IS NULL AND ${sql.unsafe(IN_SHOP)}
       AND NOT EXISTS (SELECT 1 FROM wanted_alerts a WHERE a.wanted_id = w.id AND a.product_id = p.id)
     ORDER BY w.account_id, w.id, p.price_cents`;
  const byAccount = new Map<number, { wanted_id: number; product_id: number }[]>();
  for (const f of found) {
    const k = Number(f.account_id);
    byAccount.set(k, [...(byAccount.get(k) ?? []), f]);
  }
  let mails = 0;
  for (const [accountId, list] of byAccount) {
    const [a] = await sql<{ email: string; locale: 'de' | 'en'; webshop_host: string | null }[]>`
      SELECT email, locale, webshop_host FROM accounts WHERE id = ${accountId}`;
    if (!a) continue;
    const ent = await accountEntitlements(sql, { id: accountId, webshopHost: a.webshop_host });
    if (!ent.features.wanted) continue;
    await sql.begin(async (tx) => {
      const pairs = list.map((l) => [Number(l.wanted_id), Number(l.product_id)] as const);
      const inserted = await tx<{ wanted_id: number; product_id: number }[]>`
        INSERT INTO wanted_alerts (wanted_id, product_id)
        SELECT * FROM unnest(${pairs.map((p) => p[0])}::bigint[], ${pairs.map((p) => p[1])}::bigint[])
        ON CONFLICT DO NOTHING
        RETURNING wanted_id, product_id`;
      if (inserted.length === 0) return;
      const items = inserted.map((i) => ({
        wanted_id: Number(i.wanted_id),
        product_id: Number(i.product_id),
      }));
      await enqueueMail(tx, {
        template: 'wanted_available',
        to: a.email,
        locale: a.locale,
        payload: { items },
        dedupeKey: `wanted_available:${items.map((i) => `${i.wanted_id}-${i.product_id}`).join(',')}`,
      });
      mails++;
    });
  }
  return mails;
}

/**
 * After a paid order: offers bought through it are accepted, and the cards the customer had on
 * the list are found (taken off the list).
 */
export async function syncWantedPurchases(db: Db): Promise<{ offers: number; found: number }> {
  const offers = await db`
    UPDATE wanted_offers o SET status = 'accepted', closed_at = now(), order_id = i.order_id
      FROM order_items i JOIN orders ord ON ord.id = i.order_id
     WHERE i.offer_id = o.id AND o.status = 'open'
       AND ord.status IN ('paid', 'packing', 'shipped', 'completed')`;
  const found = await db`
    UPDATE wanted_cards w SET closed_at = now(), closed_reason = 'bought', order_id = x.order_id,
                              updated_at = now()
      FROM (SELECT DISTINCT ON (w2.id) w2.id AS wanted_id, ord.id AS order_id
              FROM wanted_cards w2
              JOIN orders ord ON ord.account_id = w2.account_id
              JOIN order_items i ON i.order_id = ord.id
              JOIN products p ON p.id = i.product_id
             WHERE w2.closed_at IS NULL AND ord.kind = 'cards'
               AND ord.status IN ('paid', 'packing', 'shipped', 'completed')
               AND ord.created_at > w2.created_at
               AND p.card_ref = w2.card_id
               AND (w2.language IS NULL OR i.card_language = w2.language)
               AND i.quantity > i.refunded_quantity
             ORDER BY w2.id, ord.created_at) x
     WHERE w.id = x.wanted_id`;
  // other offers for a card that is found are no longer needed
  await db`
    UPDATE wanted_offers o SET status = 'withdrawn', closed_at = now()
      FROM wanted_cards w
     WHERE w.id = o.wanted_id AND w.closed_at IS NOT NULL AND o.status = 'open'`;
  return { offers: offers.count, found: found.count };
}

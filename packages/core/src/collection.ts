// The customer's collection: cards with language, printing (finish), condition, grading and
// quantity, valued with the app's data pack (pack-cards.ts). Used by the portal, the app
// (docs/app-account-api.md) and shares. Cards bought in the shop are added by the worker.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { CARD_LANGUAGES, FINISHES, CONDITIONS } from './catalog.ts';
import type { Db, Sql } from './db.ts';
import { enqueueMail } from './outbox.ts';
import { packCards, packLang, toCents, unitValue, type PackCard } from './pack-cards.ts';

export const MAX_QUANTITY = 999;
/** Deleted items are reported to the app's sync this long. */
export const TOMBSTONE_DAYS = 90;
/** A link for one person works this long. */
export const PERSONAL_SHARE_DAYS = 7;

const LANGS = CARD_LANGUAGES as readonly string[];
const FINISH_KEYS = Object.keys(FINISHES);
const CONDITION_KEYS = Object.keys(CONDITIONS);

export const ItemInput = z.object({
  card_id: z.string().trim().min(1, 'required').max(80, 'too_long'),
  language: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => LANGS.includes(v), 'invalid'),
  finish: z.string().refine((v) => FINISH_KEYS.includes(v), 'invalid'),
  condition: z
    .string()
    .toUpperCase()
    .refine((v) => CONDITION_KEYS.includes(v), 'invalid'),
  quantity: z.coerce
    .number()
    .int('invalid')
    .min(1, 'invalid')
    .max(MAX_QUANTITY, 'too_large')
    .default(1),
  grading: z
    .object({
      company: z.string().trim().min(1).max(20),
      grade: z.string().trim().min(1).max(10),
    })
    .nullable()
    .optional(),
  purchase_price_cents: z.coerce
    .number()
    .int('invalid')
    .min(0, 'invalid')
    .max(100_000_000, 'too_large')
    .nullable()
    .optional(),
  note: z
    .string()
    .trim()
    .max(500, 'too_long')
    .transform((v) => v || null)
    .nullable()
    .optional(),
  binder_id: z.coerce.number().int().positive().nullable().optional(),
});
export type ItemInput = z.infer<typeof ItemInput>;

/** The fields of a change; null clears an optional one. */
export const ItemPatch = ItemInput.omit({ card_id: true }).partial();

export function fieldErrors(issues: z.core.$ZodIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const k = String(i.path[0] ?? '_');
    out[k] ??=
      i.message.startsWith('Invalid') || i.message.startsWith('Too') ? 'invalid' : i.message;
  }
  return out;
}

export type Item = {
  id: number;
  clientRef: string | null;
  cardId: string;
  language: string;
  finish: string;
  condition: string;
  grading: { company: string; grade: string } | null;
  quantity: number;
  purchasePriceCents: number | null;
  note: string | null;
  binderId: number | null;
  source: 'app' | 'portal' | 'shop';
  createdAt: Date;
  updatedAt: Date;
  /** filled from the data pack */
  card: PackCard | null;
  /** value of one copy, cents (null: no price) */
  valueCents: number | null;
};

type ItemRow = {
  id: number;
  client_ref: string | null;
  card_id: string;
  language: string;
  finish: string;
  condition: string;
  grading_company: string | null;
  grading_grade: string | null;
  quantity: number;
  purchase_price_cents: number | null;
  note: string | null;
  binder_id: number | null;
  source: Item['source'];
  created_at: Date;
  updated_at: Date;
  deleted_at?: Date | null;
};

/** Names in the card's printed language first, then the page's, then English. */
export const nameLangs = (language: string, locale: 'de' | 'en') => [
  packLang(language),
  locale,
  'en',
];

async function withCards(db: Db, rows: ItemRow[], locale: 'de' | 'en'): Promise<Item[]> {
  const byLang = new Map<string, string[]>();
  for (const r of rows) {
    const key = nameLangs(r.language, locale).join(',');
    byLang.set(key, [...(byLang.get(key) ?? []), r.card_id]);
  }
  const cards = new Map<string, Map<string, PackCard>>();
  for (const [key, ids] of byLang) cards.set(key, await packCards(db, ids, key.split(',')));
  return rows.map((r) => {
    const card = cards.get(nameLangs(r.language, locale).join(','))?.get(r.card_id) ?? null;
    const grading =
      r.grading_company && r.grading_grade
        ? { company: r.grading_company, grade: r.grading_grade }
        : null;
    return {
      id: Number(r.id),
      clientRef: r.client_ref,
      cardId: r.card_id,
      language: r.language,
      finish: r.finish,
      condition: r.condition,
      grading,
      quantity: r.quantity,
      purchasePriceCents: r.purchase_price_cents,
      note: r.note,
      binderId: r.binder_id === null ? null : Number(r.binder_id),
      source: r.source,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      card,
      valueCents: card
        ? toCents(unitValue(card, { finish: r.finish, condition: r.condition, grading }))
        : null,
    };
  });
}

async function cardExists(db: Db, cardId: string): Promise<boolean> {
  const [r] = await db<
    { ok: boolean }[]
  >`SELECT EXISTS (SELECT 1 FROM pack_cards WHERE id = ${cardId}) AS ok`;
  return Boolean(r?.ok);
}

async function binderOwned(
  db: Db,
  accountId: number,
  binderId: number | null | undefined,
): Promise<boolean> {
  if (!binderId) return true;
  const [b] =
    await db`SELECT 1 FROM collection_binders WHERE id = ${binderId} AND account_id = ${accountId}`;
  return Boolean(b);
}

export type AddResult =
  { ok: true; item: Item; created: boolean } | { ok: false; errors: Record<string, string> };

/**
 * Adds a card. `clientRef` makes it safe to repeat (the same ref returns the item it made);
 * with `merge` an identical plain line (same card, language, finish, condition, grading and
 * binder, without price or note) gets the quantity added instead of a new line.
 */
export async function addItem(
  sql: Sql,
  accountId: number,
  input: unknown,
  opts: {
    source: 'app' | 'portal';
    clientRef?: string | null;
    merge?: boolean;
    locale?: 'de' | 'en';
  },
): Promise<AddResult> {
  const r = ItemInput.safeParse(input);
  if (!r.success) return { ok: false, errors: fieldErrors(r.error.issues) };
  const d = r.data;
  if (
    opts.clientRef !== undefined &&
    opts.clientRef !== null &&
    !/^[A-Za-z0-9-]{8,64}$/.test(opts.clientRef)
  ) {
    return { ok: false, errors: { client_ref: 'invalid' } };
  }
  if (!(await cardExists(sql, d.card_id))) return { ok: false, errors: { card_id: 'unknown' } };
  if (!(await binderOwned(sql, accountId, d.binder_id)))
    return { ok: false, errors: { binder_id: 'unknown' } };
  const locale = opts.locale ?? 'en';
  const out = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`collection:${accountId}`}))`;
    if (opts.clientRef) {
      const [seen] = await tx<ItemRow[]>`
        SELECT * FROM collection_items WHERE account_id = ${accountId} AND client_ref = ${opts.clientRef}`;
      if (seen) return { row: seen, created: false };
    }
    const plain = !d.purchase_price_cents && !d.note;
    if ((opts.merge ?? true) && plain) {
      const [same] = await tx<ItemRow[]>`
        UPDATE collection_items
           SET quantity = least(quantity + ${d.quantity}, ${MAX_QUANTITY}), updated_at = now()
         WHERE id = (SELECT id FROM collection_items
                      WHERE account_id = ${accountId} AND deleted_at IS NULL AND card_id = ${d.card_id}
                        AND language = ${d.language} AND finish = ${d.finish} AND condition = ${d.condition}
                        AND grading_company IS NOT DISTINCT FROM ${d.grading?.company ?? null}
                        AND grading_grade IS NOT DISTINCT FROM ${d.grading?.grade ?? null}
                        AND binder_id IS NOT DISTINCT FROM ${d.binder_id ?? null}
                        AND purchase_price_cents IS NULL AND note IS NULL
                      ORDER BY id LIMIT 1)
        RETURNING *`;
      if (same) return { row: same, created: false };
    }
    const [row] = await tx<ItemRow[]>`
      INSERT INTO collection_items (account_id, client_ref, card_id, language, finish, condition,
                                    grading_company, grading_grade, quantity, purchase_price_cents, note,
                                    binder_id, source)
      VALUES (${accountId}, ${opts.clientRef ?? null}, ${d.card_id}, ${d.language}, ${d.finish}, ${d.condition},
              ${d.grading?.company ?? null}, ${d.grading?.grade ?? null}, ${d.quantity},
              ${d.purchase_price_cents ?? null}, ${d.note ?? null}, ${d.binder_id ?? null}, ${opts.source})
      RETURNING *`;
    return { row: row!, created: true };
  });
  const [item] = await withCards(sql, [out.row], locale);
  return { ok: true, item: item!, created: out.created };
}

export async function updateItem(
  sql: Sql,
  accountId: number,
  id: number,
  input: unknown,
  locale: 'de' | 'en' = 'en',
): Promise<{ ok: true; item: Item } | { ok: false; errors: Record<string, string> } | null> {
  const r = ItemPatch.safeParse(input);
  if (!r.success) return { ok: false, errors: fieldErrors(r.error.issues) };
  const d = r.data;
  const raw = (input ?? {}) as Record<string, unknown>;
  if ('binder_id' in raw && !(await binderOwned(sql, accountId, d.binder_id))) {
    return { ok: false, errors: { binder_id: 'unknown' } };
  }
  const has = (k: string) => Object.hasOwn(raw, k);
  const [row] = await sql<ItemRow[]>`
    UPDATE collection_items SET
      quantity = ${has('quantity') ? (d.quantity ?? 1) : sql`quantity`},
      language = ${has('language') && d.language ? d.language : sql`language`},
      finish = ${has('finish') && d.finish ? d.finish : sql`finish`},
      condition = ${has('condition') && d.condition ? d.condition : sql`condition`},
      grading_company = ${has('grading') ? (d.grading?.company ?? null) : sql`grading_company`},
      grading_grade = ${has('grading') ? (d.grading?.grade ?? null) : sql`grading_grade`},
      purchase_price_cents = ${has('purchase_price_cents') ? (d.purchase_price_cents ?? null) : sql`purchase_price_cents`},
      note = ${has('note') ? (d.note ?? null) : sql`note`},
      binder_id = ${has('binder_id') ? (d.binder_id ?? null) : sql`binder_id`},
      updated_at = now()
     WHERE id = ${id} AND account_id = ${accountId} AND deleted_at IS NULL
    RETURNING *`;
  if (!row) return null;
  const [item] = await withCards(sql, [row], locale);
  return { ok: true, item: item! };
}

export async function deleteItem(db: Db, accountId: number, id: number): Promise<void> {
  await db`
    UPDATE collection_items SET deleted_at = now(), updated_at = now()
     WHERE id = ${id} AND account_id = ${accountId} AND deleted_at IS NULL`;
}

export async function itemById(
  db: Db,
  accountId: number,
  id: number,
  locale: 'de' | 'en',
): Promise<Item | null> {
  const rows = await db<ItemRow[]>`
    SELECT * FROM collection_items WHERE id = ${id} AND account_id = ${accountId} AND deleted_at IS NULL`;
  return (await withCards(db, rows, locale))[0] ?? null;
}

export async function itemsOfCard(
  db: Db,
  accountId: number,
  cardId: string,
  locale: 'de' | 'en',
): Promise<Item[]> {
  const rows = await db<ItemRow[]>`
    SELECT * FROM collection_items
     WHERE account_id = ${accountId} AND card_id = ${cardId} AND deleted_at IS NULL ORDER BY id`;
  return withCards(db, rows, locale);
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export type CollectionSort = 'value' | 'name' | 'newest' | 'set';
export const COLLECTION_SORTS: readonly CollectionSort[] = ['value', 'newest', 'name', 'set'];

export type CollectionView = {
  items: Item[];
  total: {
    cards: number;
    lines: number;
    valueCents: number;
    purchaseCents: number;
    withoutPrice: number;
  };
};

/**
 * The whole collection (or one binder, or the binders of a share), valued, filtered and sorted
 * in memory: a collection has hundreds, not millions of lines.
 */
export async function collectionView(
  db: Db,
  accountId: number,
  opts: {
    locale: 'de' | 'en';
    binderIds?: number[] | null;
    /** 0 = only items without a binder */
    binderId?: number | null;
    q?: string;
    sort?: CollectionSort;
  },
): Promise<CollectionView> {
  const binders = opts.binderIds?.length ? opts.binderIds : null;
  const rows = await db<ItemRow[]>`
    SELECT * FROM collection_items
     WHERE account_id = ${accountId} AND deleted_at IS NULL
       ${binders ? db`AND binder_id = ANY(${binders}::bigint[])` : db``}
       ${opts.binderId === 0 ? db`AND binder_id IS NULL` : opts.binderId ? db`AND binder_id = ${opts.binderId}` : db``}
     ORDER BY id`;
  let items = await withCards(db, rows, opts.locale);
  const total = {
    cards: 0,
    lines: items.length,
    valueCents: 0,
    purchaseCents: 0,
    withoutPrice: 0,
  };
  for (const i of items) {
    total.cards += i.quantity;
    if (i.valueCents === null) total.withoutPrice += i.quantity;
    else total.valueCents += i.valueCents * i.quantity;
    total.purchaseCents += (i.purchasePriceCents ?? 0) * i.quantity;
  }
  const words = (opts.q ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length) {
    items = items.filter((i) => {
      const hay = [
        i.cardId,
        i.card?.name,
        ...Object.values(i.card?.names ?? {}),
        i.card?.setName,
        i.card?.number,
        i.note,
      ]
        .filter(Boolean)
        .join(' ')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  const sort = opts.sort ?? 'value';
  const name = (i: Item) => (i.card?.name ?? i.cardId).toLowerCase();
  items.sort((a, b) => {
    if (sort === 'value')
      return (
        (b.valueCents ?? -1) * b.quantity - (a.valueCents ?? -1) * a.quantity ||
        name(a).localeCompare(name(b))
      );
    if (sort === 'newest') return b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id;
    if (sort === 'set') {
      return (
        (b.card?.releaseDate ?? '').localeCompare(a.card?.releaseDate ?? '') ||
        (a.card?.setName ?? '').localeCompare(b.card?.setName ?? '') ||
        (Number.parseInt(a.card?.localId ?? '', 10) || 0) -
          (Number.parseInt(b.card?.localId ?? '', 10) || 0)
      );
    }
    return name(a).localeCompare(name(b));
  });
  return { items, total };
}

/** For the app's sync: items changed since a time, in order, with deletions. */
export async function syncItems(
  db: Db,
  accountId: number,
  opts: {
    updatedSince?: Date | null;
    cursor?: string | null;
    limit?: number;
    locale?: 'de' | 'en';
  },
): Promise<{
  items: (Item | { id: number; deleted: true; updatedAt: Date })[];
  nextCursor: string | null;
}> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  // the cursor keeps the database's own timestamp text: microseconds, which a JS Date drops
  // (so it is passed as text: the driver would turn a timestamp parameter into a Date)
  let after: { u: string; i: number } | null = null;
  if (opts.cursor) {
    try {
      const c = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString('utf8')) as {
        u: string;
        i: number;
      };
      if (
        typeof c.u === 'string' &&
        /^\d{4}-\d{2}-\d{2}[ T][\d:.]+(Z|[+-]\d{2}(:?\d{2})?)$/.test(c.u)
      ) {
        after = { u: c.u, i: Number(c.i) };
      }
    } catch {
      after = null;
    }
  }
  const rows = await db<(ItemRow & { updated_txt: string })[]>`
    SELECT *, updated_at::text AS updated_txt FROM collection_items
     WHERE account_id = ${accountId}
       ${opts.updatedSince ? db`AND updated_at > ${opts.updatedSince}` : db`AND deleted_at IS NULL`}
       ${after ? db`AND (updated_at, id) > (${after.u}::text::timestamptz, ${after.i})` : db``}
     ORDER BY updated_at, id LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const live = await withCards(
    db,
    page.filter((r) => !r.deleted_at),
    opts.locale ?? 'en',
  );
  const liveById = new Map(live.map((i) => [i.id, i]));
  const items = page.map((r) =>
    r.deleted_at
      ? { id: Number(r.id), deleted: true as const, updatedAt: r.updated_at }
      : liveById.get(Number(r.id))!,
  );
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? Buffer.from(JSON.stringify({ u: last.updated_txt, i: Number(last.id) })).toString(
          'base64url',
        )
      : null;
  return { items, nextCursor };
}

/** The app's JSON for an item (docs/app-account-api.md). */
export function itemJson(i: Item) {
  return {
    id: i.id,
    client_ref: i.clientRef,
    card_id: i.cardId,
    language: i.language,
    finish: i.finish,
    condition: i.condition,
    grading: i.grading,
    quantity: i.quantity,
    purchase_price_cents: i.purchasePriceCents,
    note: i.note,
    binder_id: i.binderId,
    source: i.source,
    name: i.card?.name ?? null,
    set_name: i.card?.setName ?? null,
    number: i.card?.number ?? null,
    image_url: i.card?.imageSource ?? null,
    value_cents: i.valueCents,
    created_at: i.createdAt.toISOString(),
    updated_at: i.updatedAt.toISOString(),
  };
}

export async function deleteOldTombstones(db: Db): Promise<number> {
  // Lines from shop orders stay, so a card the customer removed isn't added again.
  const r = await db`
    DELETE FROM collection_items
     WHERE deleted_at < now() - make_interval(days => ${TOMBSTONE_DAYS}) AND order_item_id IS NULL`;
  return r.count;
}

// ---------------------------------------------------------------------------
// Binders
// ---------------------------------------------------------------------------

export type Binder = { id: number; name: string; cards: number };

export async function listBinders(db: Db, accountId: number): Promise<Binder[]> {
  const rows = await db<{ id: number; name: string; cards: number }[]>`
    SELECT b.id, b.name,
           coalesce((SELECT sum(quantity)::int FROM collection_items i
                      WHERE i.binder_id = b.id AND i.deleted_at IS NULL), 0) AS cards
      FROM collection_binders b WHERE b.account_id = ${accountId} ORDER BY lower(b.name), b.id`;
  return rows.map((r) => ({ id: Number(r.id), name: r.name, cards: r.cards }));
}

export const MAX_BINDERS = 50;

export async function createBinder(
  db: Db,
  accountId: number,
  name: string,
): Promise<Binder | null> {
  const n = name.trim().slice(0, 60);
  if (!n) return null;
  const [c] = await db<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM collection_binders WHERE account_id = ${accountId}`;
  if ((c?.n ?? 0) >= MAX_BINDERS) return null;
  const [b] = await db<{ id: number; name: string }[]>`
    INSERT INTO collection_binders (account_id, name) VALUES (${accountId}, ${n}) RETURNING id, name`;
  return { id: Number(b!.id), name: b!.name, cards: 0 };
}

export async function renameBinder(
  db: Db,
  accountId: number,
  id: number,
  name: string,
): Promise<void> {
  const n = name.trim().slice(0, 60);
  if (n)
    await db`UPDATE collection_binders SET name = ${n} WHERE id = ${id} AND account_id = ${accountId}`;
}

/** The binder's cards go back to the main collection. */
export async function deleteBinder(db: Db, accountId: number, id: number): Promise<void> {
  await db`DELETE FROM collection_binders WHERE id = ${id} AND account_id = ${accountId}`;
}

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------

export type Share = {
  id: number;
  token: string;
  kind: 'public' | 'personal';
  binderIds: number[];
  showPrices: boolean;
  title: string | null;
  recipientEmail: string | null;
  message: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  views: number;
  lastViewedAt: Date | null;
  createdAt: Date;
};

type ShareRow = {
  id: number;
  account_id: number;
  token: string;
  kind: Share['kind'];
  binder_ids: (number | string)[];
  show_prices: boolean;
  title: string | null;
  recipient_email: string | null;
  message: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  views: number;
  last_viewed_at: Date | null;
  created_at: Date;
};

const toShare = (r: ShareRow): Share => ({
  id: Number(r.id),
  token: r.token,
  kind: r.kind,
  binderIds: (r.binder_ids ?? []).map(Number),
  showPrices: r.show_prices,
  title: r.title,
  recipientEmail: r.recipient_email,
  message: r.message,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  views: r.views,
  lastViewedAt: r.last_viewed_at,
  createdAt: r.created_at,
});

export const ShareForm = z.object({
  kind: z.enum(['public', 'personal']),
  binderIds: z.array(z.coerce.number().int().positive()).max(MAX_BINDERS).default([]),
  showPrices: z.boolean().default(true),
  title: z
    .string()
    .trim()
    .max(80, 'too_long')
    .transform((v) => v || null)
    .optional(),
  recipientEmail: z
    .string()
    .trim()
    .toLowerCase()
    .max(200, 'too_long')
    .pipe(z.email('invalid_email'))
    .optional(),
  message: z
    .string()
    .trim()
    .max(500, 'too_long')
    .transform((v) => v || null)
    .optional(),
});

export async function listShares(db: Db, accountId: number): Promise<Share[]> {
  const rows = await db<ShareRow[]>`
    SELECT * FROM collection_shares WHERE account_id = ${accountId} AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now() - interval '30 days')
     ORDER BY created_at DESC`;
  return rows.map(toShare);
}

/**
 * Creates a share. A personal one is mailed to the recipient and works for 7 days; a public one
 * until it is revoked.
 */
export async function createShare(
  sql: Sql,
  account: { id: number; name: string | null; email: string; locale: 'de' | 'en' },
  input: unknown,
  opts: { baseUrl: string; recipientLocale?: 'de' | 'en' },
): Promise<{ ok: true; share: Share } | { ok: false; errors: Record<string, string> }> {
  const r = ShareForm.safeParse(input);
  if (!r.success) return { ok: false, errors: fieldErrors(r.error.issues) };
  const d = r.data;
  if (d.kind === 'personal' && !d.recipientEmail)
    return { ok: false, errors: { recipientEmail: 'required' } };
  if (d.recipientEmail === account.email) return { ok: false, errors: { recipientEmail: 'own' } };
  type Out = { ok: true; share: Share } | { ok: false; errors: Record<string, string> };
  return sql.begin(async (tx): Promise<Out> => {
    if (d.binderIds.length) {
      const [c] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM collection_binders
         WHERE account_id = ${account.id} AND id = ANY(${d.binderIds}::bigint[])`;
      if ((c?.n ?? 0) !== new Set(d.binderIds).size)
        return { ok: false, errors: { binderIds: 'unknown' } };
    }
    // a person can't be sent dozens of links: at most 10 personal shares a day
    if (d.kind === 'personal') {
      const [c] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM collection_shares
         WHERE account_id = ${account.id} AND kind = 'personal' AND created_at > now() - interval '1 day'`;
      if ((c?.n ?? 0) >= 10) return { ok: false, errors: { recipientEmail: 'too_many' } };
    }
    const token = randomBytes(18).toString('base64url');
    const [row] = await tx<ShareRow[]>`
      INSERT INTO collection_shares (account_id, token, kind, binder_ids, show_prices, title, recipient_email,
                                     message, expires_at)
      VALUES (${account.id}, ${token}, ${d.kind}, ${d.binderIds}::bigint[], ${d.showPrices}, ${d.title ?? null},
              ${d.kind === 'personal' ? (d.recipientEmail ?? null) : null}, ${d.kind === 'personal' ? (d.message ?? null) : null},
              ${d.kind === 'personal' ? tx`now() + make_interval(days => ${PERSONAL_SHARE_DAYS})` : null})
      RETURNING *`;
    const share = toShare(row!);
    if (share.kind === 'personal' && share.recipientEmail) {
      await enqueueMail(tx, {
        template: 'collection_shared',
        to: share.recipientEmail,
        locale: opts.recipientLocale ?? account.locale,
        replyTo: account.email,
        payload: {
          share_id: share.id,
          url: shareUrl(opts.baseUrl, share.token, opts.recipientLocale ?? account.locale),
        },
        dedupeKey: `collection_shared:${share.id}`,
      });
    }
    return { ok: true, share };
  });
}

/** The share's address; English lives at the root, German under /de. */
export const shareUrl = (baseUrl: string, token: string, locale: 'de' | 'en') =>
  `${baseUrl}${locale === 'de' ? '/de' : ''}/c/${token}`;

export async function revokeShare(db: Db, accountId: number, id: number): Promise<void> {
  await db`UPDATE collection_shares SET revoked_at = now() WHERE id = ${id} AND account_id = ${accountId}`;
}

/** A share by its token, if it is still valid; counts the view. */
export async function openShare(
  db: Db,
  token: string,
  now = new Date(),
): Promise<
  | { ok: true; share: Share; owner: { id: number; name: string | null; locale: 'de' | 'en' } }
  | { ok: false; problem: 'unknown' | 'expired' }
> {
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(token)) return { ok: false, problem: 'unknown' };
  const [r] = await db<(ShareRow & { owner_name: string | null; owner_locale: 'de' | 'en' })[]>`
    SELECT s.*, a.name AS owner_name, a.locale AS owner_locale
      FROM collection_shares s JOIN accounts a ON a.id = s.account_id
     WHERE s.token = ${token}`;
  if (!r || r.revoked_at) return { ok: false, problem: 'unknown' };
  if (r.expires_at && r.expires_at <= now) return { ok: false, problem: 'expired' };
  await db`UPDATE collection_shares SET views = views + 1, last_viewed_at = ${now} WHERE id = ${r.id}`;
  return {
    ok: true,
    share: toShare(r),
    owner: { id: Number(r.account_id), name: r.owner_name, locale: r.owner_locale },
  };
}

// ---------------------------------------------------------------------------
// Cards bought in the shop
// ---------------------------------------------------------------------------

/**
 * Adds the cards of paid shop orders to their account's collection, once per order line, and
 * takes them out again when the order is cancelled or refunded (worker, every few minutes).
 */
export async function syncShopPurchases(db: Db): Promise<{ added: number; removed: number }> {
  const added = await db`
    INSERT INTO collection_items (account_id, card_id, language, finish, condition, grading_company,
                                  grading_grade, quantity, purchase_price_cents, source, order_item_id)
    SELECT o.account_id, p.card_ref, i.card_language, i.finish, i.condition, p.grading_company,
           p.grading_grade, i.quantity - i.refunded_quantity, i.unit_price_cents, 'shop', i.id
      FROM orders o
      JOIN order_items i ON i.order_id = o.id
      JOIN products p ON p.id = i.product_id
     WHERE o.account_id IS NOT NULL AND o.kind = 'cards'
       AND o.status IN ('paid', 'packing', 'shipped', 'completed')
       AND p.card_ref IS NOT NULL
       AND i.quantity > i.refunded_quantity
       AND i.card_language IN ('DE', 'EN', 'FR', 'IT', 'ES', 'PT', 'NL', 'PL', 'RU', 'JA', 'KO', 'ZH-HANT', 'ZH-HANS', 'ID', 'TH')
       AND NOT EXISTS (SELECT 1 FROM collection_items c WHERE c.order_item_id = i.id)
    ON CONFLICT DO NOTHING`;
  const removed = await db`
    UPDATE collection_items c SET deleted_at = now(), updated_at = now()
      FROM order_items i JOIN orders o ON o.id = i.order_id
     WHERE c.order_item_id = i.id AND c.deleted_at IS NULL
       AND (o.status IN ('cancelled', 'refunded') OR i.refunded_quantity >= i.quantity)`;
  return { added: added.count, removed: removed.count };
}

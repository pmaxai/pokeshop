import type { Db, Sql } from './db.ts';
import { isPgError, SQLSTATE } from './db.ts';
import {
  buildSku,
  cardNames,
  localCardNumber,
  productSlug,
  tcgdexLocalLang,
  type CardLanguage,
  type Condition,
  type Finish,
} from './catalog.ts';
import { ApiError, notFound } from './errors.ts';
import type { IntakeRequest, ProductInput, ProductPatch, StockChange } from './api-schemas.ts';
import { syncCardDetails, syncLocalName, type TcgdexClient } from './tcgdex.ts';
import { setProductCategories } from './categories.ts';

/** Who changes stock: written to the stock ledger and the audit log. */
export type Actor = { source: 'api' | 'admin' | 'import'; id: string; reference?: string | null };

export type ProductOptions = {
  /** Used to fetch card details when a scanned card is not in the master data yet. */
  tcgdex?: TcgdexClient;
  /** For the product URL in API responses. */
  baseUrl?: string;
};

type Identity = {
  card_ref?: string | undefined;
  set_code?: string | undefined;
  card_number?: string | undefined;
  card_language: CardLanguage;
  condition: Condition;
  finish: Finish;
  grading?: { company: string; grade: string; cert?: string | null | undefined } | null | undefined;
};

type MasterRow = {
  card_ref: string;
  set_code: string;
  local_id: string;
  name_de: string | null;
  name_en: string | null;
  rarity: string | null;
  supertype: string | null;
  energy_types: string[];
  image_url: string | null;
  details_fetched_at: Date | null;
  set_name_de: string | null;
  set_name_en: string | null;
  series_de: string | null;
  series_en: string | null;
  release_date: Date | null;
  card_count: number | null;
  names_local: Record<string, string | null>;
};

type ResolvedCard = {
  sku: string;
  cardRef: string | null;
  setCode: string;
  cardNumber: string;
  master: MasterRow | null;
  /** Printed name for French, Italian … cards, from TCGdex; null for DE/EN or when unknown. */
  localName: string | null;
};

const MASTER_COLUMNS = (db: Db) => db`
  cm.card_ref, cm.set_code, cm.local_id, cm.name_de, cm.name_en, cm.rarity, cm.supertype,
  cm.energy_types, cm.image_url, cm.details_fetched_at, cs.name_de AS set_name_de,
  cs.name_en AS set_name_en, cs.series_de, cs.series_en, cs.release_date, cs.card_count,
  cm.names_local`;

async function masterByRef(db: Db, ref: string): Promise<MasterRow | null> {
  const [row] = await db<MasterRow[]>`
    SELECT ${MASTER_COLUMNS(db)} FROM card_master cm JOIN card_sets cs USING (set_code)
     WHERE cm.card_ref = ${ref}`;
  return row ?? null;
}

async function masterBySetNumber(db: Db, set: string, local: string): Promise<MasterRow | null> {
  const [row] = await db<MasterRow[]>`
    SELECT ${MASTER_COLUMNS(db)} FROM card_master cm JOIN card_sets cs USING (set_code)
     WHERE lower(cm.set_code) = lower(${set})
       AND (upper(cm.local_id) = upper(${local})
            OR ltrim(cm.local_id, '0') = ltrim(${local}, '0') AND ltrim(${local}, '0') <> '')
     ORDER BY (upper(cm.local_id) = upper(${local})) DESC
     LIMIT 1`;
  return row ?? null;
}

/** "sv03.5-199" → set "sv03.5", number "199" (TCGdex ids end with -<local id>). */
function splitCardRef(ref: string): { set: string; local: string } {
  const i = ref.lastIndexOf('-');
  if (i <= 0)
    throw new ApiError(422, 'validation', 'card_ref not understood', {
      card_ref: 'expected <set>-<number>',
    });
  return { set: ref.slice(0, i), local: ref.slice(i + 1) };
}

/** Finds the card in the master data (fetching details from TCGdex if needed) and builds the SKU. */
export async function resolveCard(
  db: Db,
  id: Identity,
  tcgdex?: TcgdexClient,
): Promise<ResolvedCard> {
  let master: MasterRow | null = null;
  if (id.card_ref) {
    master = await masterByRef(db, id.card_ref);
    if ((!master || !master.details_fetched_at) && tcgdex) {
      try {
        await syncCardDetails(db, tcgdex, id.card_ref);
        master = await masterByRef(db, id.card_ref);
      } catch {
        // TCGdex unreachable: carry on with what was sent
      }
    }
  } else if (id.set_code && id.card_number) {
    master = await masterBySetNumber(db, id.set_code, localCardNumber(id.card_number));
  }
  const lang = tcgdexLocalLang(id.card_language);
  let localName = lang && master ? (master.names_local[lang] ?? null) : null;
  if (lang && master && !(lang in master.names_local) && tcgdex) {
    try {
      localName = await syncLocalName(db, tcgdex, master.card_ref, lang);
    } catch {
      // TCGdex unreachable: the worker asks again later
    }
  }

  const fromRef = id.card_ref ? splitCardRef(id.card_ref) : null;
  const setCode = master?.set_code ?? id.set_code ?? fromRef!.set;
  const local =
    master?.local_id ?? (id.card_number ? localCardNumber(id.card_number) : fromRef!.local);
  const cardNumber =
    id.card_number ?? (master?.card_count ? `${local}/${master.card_count}` : local);

  const sku = buildSku({
    setCode,
    cardNumber: local,
    language: id.card_language,
    condition: id.condition,
    finish: id.finish,
    grading: id.grading ? { company: id.grading.company as never, grade: id.grading.grade } : null,
  });
  return { sku, cardRef: master?.card_ref ?? null, setCode, cardNumber, master, localName };
}

type Fields = Partial<
  Pick<
    IntakeRequest,
    | 'external_id'
    | 'name_de'
    | 'name_en'
    | 'name_local'
    | 'set_name_de'
    | 'set_name_en'
    | 'release_year'
    | 'rarity'
    | 'supertype'
    | 'energy_types'
    | 'price'
    | 'purchase_price'
    | 'high_value'
    | 'description_de'
    | 'description_en'
  >
>;

/** Maps API fields to columns; only fields present in the request are returned. */
function columnsFrom(f: Fields, opts: ProductOptions): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  const copy = [
    'external_id',
    'name_de',
    'name_en',
    'name_local',
    'set_name_de',
    'set_name_en',
    'release_year',
    'rarity',
    'supertype',
    'energy_types',
    'description_de',
    'description_en',
  ] as const;
  for (const k of copy) if (f[k] !== undefined) c[k] = f[k];
  if (f.price) c.price_cents = f.price.amount;
  if (f.purchase_price) c.purchase_price_cents = f.purchase_price.amount;
  void opts;
  return c;
}

/**
 * High value follows the price (more than the shop's threshold, € 20) and is set by the
 * database. A `high_value` sent by the app is accepted for compatibility and ignored.
 */
function fieldWarnings(f: { high_value?: boolean | undefined }): string[] {
  return f.high_value === undefined ? [] : ['high_value_ignored_set_by_price'];
}

function mapWriteError(e: unknown): never {
  if (isPgError(e, SQLSTATE.uniqueViolation)) {
    const constraint = (e as { constraint_name?: string }).constraint_name ?? '';
    if (constraint.includes('external_id')) {
      throw new ApiError(409, 'external_id_taken', 'another product already uses this external_id');
    }
    throw new ApiError(409, 'conflict', (e as Error).message);
  }
  if (isPgError(e, SQLSTATE.insufficientStock)) {
    throw new ApiError(
      409,
      'insufficient_stock',
      (e as { detail?: string }).detail ?? 'not enough copies in that box',
    );
  }
  if (isPgError(e, SQLSTATE.invalidArgument)) {
    throw new ApiError(422, 'validation', (e as Error).message);
  }
  throw e;
}

async function insertProduct(
  db: Db,
  card: ResolvedCard,
  input: Fields & Identity,
  opts: ProductOptions,
) {
  const m = card.master;
  const nameDe = input.name_de ?? m?.name_de ?? input.name_en ?? m?.name_en;
  const nameEn = input.name_en ?? m?.name_en ?? nameDe;
  if (!nameDe || !nameEn) {
    throw new ApiError(
      422,
      'unknown_card',
      'card not found in the master data; send name_de and name_en',
      {
        name_de: 'required for this card',
      },
    );
  }
  const row: Record<string, unknown> = {
    sku: card.sku,
    slug: productSlug(nameDe, card.setCode, card.sku),
    slug_en: productSlug(nameEn, card.setCode, card.sku),
    card_ref: card.cardRef,
    set_code: card.setCode,
    set_name_de: m?.set_name_de ?? m?.set_name_en ?? null,
    set_name_en: m?.set_name_en ?? m?.set_name_de ?? null,
    series_de: m?.series_de ?? null,
    series_en: m?.series_en ?? null,
    card_number: card.cardNumber,
    name_de: nameDe,
    name_en: nameEn,
    name_local: card.localName, // the database drops it for DE/EN cards
    card_language: input.card_language,
    release_year: m?.release_date ? new Date(m.release_date).getUTCFullYear() : null,
    rarity: m?.rarity ?? null,
    supertype: m?.supertype ?? null,
    energy_types: m?.energy_types ?? [],
    finish: input.finish,
    condition: input.condition,
    grading_company: input.grading?.company ?? null,
    grading_grade: input.grading?.grade ?? null,
    grading_cert: input.grading?.cert ?? null,
    status: 'draft',
    ...columnsFrom(input, opts),
  };
  const [p] = await db<{ id: number }[]>`
    INSERT INTO products ${db(row as never)}
    ON CONFLICT (sku) DO NOTHING
    RETURNING id`;
  return p ? p.id : null;
}

async function addImages(db: Db, productId: number, images: IntakeRequest['images']) {
  for (const img of images ?? []) {
    await db`
      INSERT INTO product_images (product_id, role, position, source_url)
      SELECT ${productId}, ${img.role}, coalesce(max(position) + 1, 0), ${img.url}
        FROM product_images WHERE product_id = ${productId}
      HAVING NOT EXISTS (
        SELECT 1 FROM product_images WHERE product_id = ${productId} AND source_url = ${img.url})`;
  }
}

/**
 * Sets the status. "active" needs a price and an image (own scan, or the card
 * image from the master data as fallback); otherwise the product stays a draft.
 */
async function applyStatus(
  db: Db,
  productId: number,
  wanted: 'draft' | 'active' | 'archived',
): Promise<string[]> {
  if (wanted !== 'active') {
    await db`UPDATE products SET status = ${wanted} WHERE id = ${productId}`;
    return [];
  }
  const [r] = await db<{ has_price: boolean; has_image: boolean }[]>`
    SELECT p.price_cents IS NOT NULL AS has_price,
           (EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id AND i.status <> 'failed')
            OR cm.image_url IS NOT NULL OR cm.image_url_de IS NOT NULL) AS has_image
      FROM products p LEFT JOIN card_master cm ON cm.card_ref = p.card_ref
     WHERE p.id = ${productId}`;
  const warnings: string[] = [];
  if (!r?.has_price) warnings.push('not_activated_no_price');
  if (!r?.has_image) warnings.push('not_activated_no_image');
  if (warnings.length === 0)
    await db`UPDATE products SET status = 'active' WHERE id = ${productId}`;
  return warnings;
}

export type IntakeResult = { created: boolean; product: ApiProduct; warnings: string[] };

/** Main scanning call: find or create the product, add copies to a box. */
export async function intake(
  sql: Sql,
  input: IntakeRequest,
  actor: Actor,
  opts: ProductOptions = {},
): Promise<IntakeResult> {
  const card = await resolveCard(sql, input, opts.tcgdex);
  try {
    return await sql.begin(async (tx) => {
      let created = false;
      let id = await insertProduct(tx, card, input, opts);
      if (id !== null) {
        created = true;
      } else {
        const [p] = await tx<
          { id: number }[]
        >`SELECT id FROM products WHERE sku = ${card.sku} FOR UPDATE`;
        id = p!.id;
        const cols = columnsFrom(input, opts);
        if (Object.keys(cols).length)
          await tx`UPDATE products SET ${tx(cols as never)} WHERE id = ${id}`;
        if (card.localName && input.name_local === undefined)
          await tx`UPDATE products SET name_local = ${card.localName}
                    WHERE id = ${id} AND name_local IS NULL`;
      }
      await tx`SELECT stock_change(${id}, ${input.storage_location}, ${input.delta}, ${actor.source},
                                   ${actor.id}, ${actor.reference ?? null}, 'intake')`;
      await addImages(tx, id, input.images);
      if (input.categories !== undefined) await setProductCategories(tx, id, input.categories);
      const wanted = input.status ?? (created ? (input.price ? 'active' : 'draft') : undefined);
      const warnings = [
        ...fieldWarnings(input),
        ...(wanted ? await applyStatus(tx, id, wanted) : []),
      ];
      return { created, product: (await getProduct(tx, card.sku, opts))!, warnings };
    });
  } catch (e) {
    mapWriteError(e);
  }
}

/**
 * PUT: creates the product or replaces all of its fields. Stock and uploaded photos are
 * untouched; URL images not listed in `images` are removed.
 */
export async function replaceProduct(
  sql: Sql,
  sku: string,
  input: ProductInput,
  actor: Actor,
  opts: ProductOptions = {},
): Promise<{ created: boolean; product: ApiProduct; warnings: string[] }> {
  const card = await resolveCard(sql, input, opts.tcgdex);
  if (card.sku !== sku) {
    throw new ApiError(
      409,
      'identity_mismatch',
      `the card fields describe ${card.sku}, not ${sku}`,
    );
  }
  try {
    return await sql.begin(async (tx) => {
      let id = await insertProduct(tx, card, input, opts);
      const created = id !== null;
      if (!created) {
        const [p] = await tx<
          { id: number }[]
        >`SELECT id FROM products WHERE sku = ${sku} FOR UPDATE`;
        id = p!.id;
        const m = card.master;
        const all: Record<string, unknown> = {
          external_id: null,
          set_name_de: m?.set_name_de ?? null,
          set_name_en: m?.set_name_en ?? null,
          release_year: m?.release_date ? new Date(m.release_date).getUTCFullYear() : null,
          rarity: m?.rarity ?? null,
          supertype: m?.supertype ?? null,
          energy_types: m?.energy_types ?? [],
          price_cents: null,
          purchase_price_cents: null,
          description_de: null,
          description_en: null,
          name_de: m?.name_de ?? input.name_en ?? null,
          name_en: m?.name_en ?? input.name_de ?? null,
          name_local: card.localName,
          grading_cert: input.grading?.cert ?? null,
          ...columnsFrom(input, opts),
        };
        if (!all.name_de || !all.name_en) {
          throw new ApiError(422, 'validation', 'name_de and name_en are required', {
            name_de: 'required',
          });
        }
        await tx`UPDATE products SET ${tx(all as never)} WHERE id = ${id}`;
        // `images` lists the URL images; photos uploaded through /images stay.
        await tx`DELETE FROM product_images WHERE product_id = ${id} AND source_url IS NOT NULL
                   AND source_url NOT LIKE 'upload:%'
                   AND source_url <> ALL(${(input.images ?? []).map((i) => i.url)}::text[])`;
      }
      await addImages(tx, id!, input.images);
      // PUT replaces: no `categories` means none
      await setProductCategories(tx, id!, input.categories ?? []);
      const warnings = [
        ...fieldWarnings(input),
        ...(await applyStatus(tx, id!, input.status ?? (input.price ? 'active' : 'draft'))),
      ];
      void actor;
      return { created, product: (await getProduct(tx, sku, opts))!, warnings };
    });
  } catch (e) {
    mapWriteError(e);
  }
}

/** PATCH: only the fields sent change; storage_location moves all free copies into that box. */
export async function patchProduct(
  sql: Sql,
  sku: string,
  patch: ProductPatch,
  actor: Actor,
  opts: ProductOptions = {},
): Promise<{ product: ApiProduct; warnings: string[] }> {
  try {
    return await sql.begin(async (tx) => {
      const [p] = await tx<{ id: number }[]>`SELECT id FROM products WHERE sku = ${sku} FOR UPDATE`;
      if (!p) throw notFound();
      const cols = columnsFrom(patch, opts);
      if (Object.keys(cols).length)
        await tx`UPDATE products SET ${tx(cols as never)} WHERE id = ${p.id}`;
      const warnings: string[] = fieldWarnings(patch);
      if (patch.storage_location) {
        const boxes = await tx<{ storage_location: string; free: number; reserved: number }[]>`
          SELECT storage_location, quantity - reserved AS free, reserved FROM stock_locations
           WHERE product_id = ${p.id} AND storage_location <> ${patch.storage_location}
           ORDER BY storage_location FOR UPDATE`;
        for (const b of boxes) {
          if (b.free > 0) {
            await tx`SELECT stock_move(${p.id}, ${b.storage_location}, ${patch.storage_location}, ${b.free},
                                       ${actor.source}, ${actor.id}, ${actor.reference ?? null})`;
          }
          if (b.reserved > 0)
            warnings.push(`copies_in_open_checkout_stay_in_${b.storage_location}`);
        }
      }
      await addImages(tx, p.id, patch.images);
      if (patch.categories !== undefined) await setProductCategories(tx, p.id, patch.categories);
      if (patch.status) warnings.push(...(await applyStatus(tx, p.id, patch.status)));
      return { product: (await getProduct(tx, sku, opts))!, warnings };
    });
  } catch (e) {
    mapWriteError(e);
  }
}

/** Adds, removes, sets or moves copies in a box. */
export async function changeStock(
  sql: Sql,
  sku: string,
  change: StockChange,
  actor: Actor,
): Promise<Stock> {
  try {
    return await sql.begin(async (tx) => {
      const [p] = await tx<{ id: number }[]>`SELECT id FROM products WHERE sku = ${sku}`;
      if (!p) throw notFound();
      const ref = actor.reference ?? null;
      if ('delta' in change) {
        await tx`SELECT stock_change(${p.id}, ${change.storage_location}, ${change.delta}, ${actor.source},
                                     ${actor.id}, ${ref}, ${change.reason ?? null})`;
      } else if ('set' in change) {
        await tx`SELECT stock_set(${p.id}, ${change.storage_location}, ${change.set}, ${actor.source},
                                  ${actor.id}, ${ref}, ${change.reason ?? null})`;
      } else {
        await tx`SELECT stock_move(${p.id}, ${change.from}, ${change.to}, ${change.move}, ${actor.source},
                                   ${actor.id}, ${ref})`;
      }
      return stockOf(tx, p.id);
    });
  } catch (e) {
    mapWriteError(e);
  }
}

export type Stock = {
  quantity: number;
  reserved: number;
  available: number;
  boxes: { storage_location: string; quantity: number; reserved: number }[];
};

export async function stockOf(db: Db, productId: number): Promise<Stock> {
  const boxes = await db<Stock['boxes']>`
    SELECT storage_location, quantity, reserved FROM stock_locations
     WHERE product_id = ${productId} AND (quantity > 0 OR reserved > 0)
     ORDER BY length(storage_location), storage_location`;
  const quantity = boxes.reduce((a, b) => a + b.quantity, 0);
  const reserved = boxes.reduce((a, b) => a + b.reserved, 0);
  const available = boxes.reduce((a, b) => a + Math.max(0, b.quantity - b.reserved), 0);
  return { quantity, reserved, available, boxes: [...boxes] };
}

export type ApiProduct = {
  sku: string;
  external_id: string | null;
  card_ref: string | null;
  set_code: string;
  set_name_de: string | null;
  set_name_en: string | null;
  card_number: string;
  name_de: string;
  name_en: string;
  /** Printed name for cards in other languages than DE/EN; null when unknown or DE/EN. */
  name_local: string | null;
  /** The name printed on the card (name_de, name_en or name_local; English when unknown). */
  name_original: string;
  card_language: string;
  condition: string;
  finish: string;
  grading: { company: string; grade: string; cert: string | null } | null;
  release_year: number | null;
  rarity: string | null;
  price: { amount: number; currency: 'EUR' } | null;
  high_value: boolean;
  status: string;
  url: string;
  stock: Stock;
  images: { id: number; role: string; status: string; url: string | null }[];
  /** Category slugs (GET /categories). */
  categories: string[];
  updated_at: string;
};

type ProductRow = {
  id: number;
  sku: string;
  slug: string;
  external_id: string | null;
  card_ref: string | null;
  set_code: string;
  set_name_de: string | null;
  set_name_en: string | null;
  card_number: string;
  name_de: string;
  name_en: string;
  name_local: string | null;
  card_language: string;
  condition: string;
  finish: string;
  grading_company: string | null;
  grading_grade: string | null;
  grading_cert: string | null;
  release_year: number | null;
  rarity: string | null;
  price_cents: number | null;
  high_value: boolean;
  status: string;
  updated_at: Date;
  images: { id: number; role: string; status: string; storage_key: string | null }[];
  categories: string[];
};

/** Public URL of a processed image in its largest size. */
export function imageUrl(storageKey: string | null, width = 1200, baseUrl = ''): string | null {
  return storageKey ? `${baseUrl}/media/${storageKey}-${width}.webp` : null;
}

async function toApi(db: Db, r: ProductRow, opts: ProductOptions): Promise<ApiProduct> {
  const base = opts.baseUrl ?? process.env.PUBLIC_BASE_URL ?? '';
  return {
    sku: r.sku,
    external_id: r.external_id,
    card_ref: r.card_ref,
    set_code: r.set_code,
    set_name_de: r.set_name_de,
    set_name_en: r.set_name_en,
    card_number: r.card_number,
    name_de: r.name_de,
    name_en: r.name_en,
    name_local: r.name_local,
    name_original: cardNames(
      {
        cardLanguage: r.card_language,
        nameDe: r.name_de,
        nameEn: r.name_en,
        nameLocal: r.name_local,
      },
      'en',
    ).original,
    card_language: r.card_language,
    condition: r.condition,
    finish: r.finish,
    grading: r.grading_company
      ? { company: r.grading_company, grade: r.grading_grade!, cert: r.grading_cert }
      : null,
    release_year: r.release_year,
    rarity: r.rarity,
    price: r.price_cents === null ? null : { amount: r.price_cents, currency: 'EUR' },
    high_value: r.high_value,
    status: r.status,
    url: `${base}/karten/${r.slug}`,
    stock: await stockOf(db, r.id),
    images: r.images.map((i) => ({
      id: i.id,
      role: i.role,
      status: i.status,
      url: imageUrl(i.storage_key, 1200, base),
    })),
    categories: r.categories,
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

const PRODUCT_SELECT = (db: Db) => db`
  SELECT p.id, p.sku, p.slug, p.external_id, p.card_ref, p.set_code, p.set_name_de, p.set_name_en,
         p.card_number, p.name_de, p.name_en, p.name_local, p.card_language, p.condition, p.finish,
         p.grading_company, p.grading_grade, p.grading_cert, p.release_year, p.rarity,
         p.price_cents, p.high_value, p.status, p.updated_at,
         coalesce((SELECT json_agg(json_build_object('id', i.id, 'role', i.role, 'status', i.status,
                                                     'storage_key', i.storage_key) ORDER BY i.position, i.id)
                     FROM product_images i WHERE i.product_id = p.id), '[]') AS images,
         coalesce((SELECT json_agg(c.slug ORDER BY c.position, c.name_de, c.id)
                     FROM product_categories pc JOIN categories c ON c.id = pc.category_id
                    WHERE pc.product_id = p.id), '[]') AS categories
    FROM products p`;

export async function getProduct(
  db: Db,
  sku: string,
  opts: ProductOptions = {},
): Promise<ApiProduct | null> {
  const [r] = await db<ProductRow[]>`${PRODUCT_SELECT(db)} WHERE p.sku = ${sku}`;
  return r ? toApi(db, r, opts) : null;
}

export type ProductQuery = {
  external_id?: string | undefined;
  card_ref?: string | undefined;
  storage_location?: string | undefined;
  status?: string | undefined;
  updated_since?: Date | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
};

export async function listProducts(
  db: Db,
  q: ProductQuery,
  opts: ProductOptions = {},
): Promise<{ items: ApiProduct[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const after = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString()) : 0;
  if (!Number.isSafeInteger(after) || after < 0)
    throw new ApiError(422, 'validation', 'bad cursor');
  const rows = await db<ProductRow[]>`
    ${PRODUCT_SELECT(db)}
     WHERE p.id > ${after}
       ${q.external_id ? db`AND p.external_id = ${q.external_id}` : db``}
       ${q.card_ref ? db`AND p.card_ref = ${q.card_ref}` : db``}
       ${q.status ? db`AND p.status = ${q.status}` : db``}
       ${q.updated_since ? db`AND p.updated_at >= ${q.updated_since}` : db``}
       ${
         q.storage_location
           ? db`AND EXISTS (SELECT 1 FROM stock_locations s WHERE s.product_id = p.id
                                             AND s.storage_location = ${q.storage_location} AND s.quantity > 0)`
           : db``
       }
     ORDER BY p.id
     LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const items = await Promise.all(page.map((r) => toApi(db, r, opts)));
  const last = page.at(-1);
  return {
    items,
    next_cursor:
      rows.length > limit && last ? Buffer.from(String(last.id)).toString('base64url') : null,
  };
}

/** Master-data lookup for the scanning app (confirming a scan). */
export async function searchMaster(
  db: Db,
  q: {
    card_ref?: string | undefined;
    set?: string | undefined;
    number?: string | undefined;
    q?: string | undefined;
    lang?: 'de' | 'en';
  },
) {
  const lang = q.lang ?? 'de';
  const local = q.number ? localCardNumber(q.number) : undefined;
  const term = q.q?.trim().toLowerCase();
  const rows = await db<
    {
      card_ref: string;
      set_code: string;
      set_name: string | null;
      local_id: string;
      card_count: number | null;
      name: string | null;
      rarity: string | null;
      image_url: string | null;
    }[]
  >`
    SELECT cm.card_ref, cm.set_code,
           ${lang === 'de' ? db`coalesce(cs.name_de, cs.name_en)` : db`coalesce(cs.name_en, cs.name_de)`} AS set_name,
           cm.local_id, cs.card_count,
           ${lang === 'de' ? db`coalesce(cm.name_de, cm.name_en)` : db`coalesce(cm.name_en, cm.name_de)`} AS name,
           ${lang === 'de' ? db`coalesce(cm.rarity_de, cm.rarity)` : db`cm.rarity`} AS rarity,
           ${lang === 'de' ? db`coalesce(cm.image_url_de, cm.image_url)` : db`coalesce(cm.image_url, cm.image_url_de)`} AS image_url
      FROM card_master cm JOIN card_sets cs USING (set_code)
     WHERE true
       ${q.card_ref ? db`AND cm.card_ref = ${q.card_ref}` : db``}
       ${q.set ? db`AND lower(cm.set_code) = lower(${q.set})` : db``}
       ${local ? db`AND (upper(cm.local_id) = upper(${local}) OR ltrim(cm.local_id, '0') = ltrim(${local}, '0'))` : db``}
       ${term ? db`AND (${term} <% shop_unaccent(lower(coalesce(cm.name_de, ''))) OR ${term} <% shop_unaccent(lower(coalesce(cm.name_en, ''))))` : db``}
     ORDER BY cs.release_date DESC NULLS LAST, cm.set_code, cm.local_id
     LIMIT 50`;
  return rows.map((r) => ({ ...r, image_url: r.image_url ? `${r.image_url}/high.webp` : null }));
}

import { cardNames, CONDITIONS, type CardNames } from './catalog.ts';
import type { Db } from './db.ts';

/**
 * Read queries for the public shop. Only active products are ever returned.
 *
 * Copies of the same card (print, card language, finish, grading) in different conditions are
 * separate products with their own SKU, price and stock. The catalog shows them as one tile
 * with the conditions to choose from; each product keeps its own page.
 */

export type Locale = 'de' | 'en';

export type CatalogFilters = {
  q?: string | undefined;
  languages?: string[];
  series?: string[];
  sets?: string[];
  rarities?: string[];
  conditions?: string[];
  finishes?: string[];
  supertypes?: string[];
  /** Category slugs; a card matches when any of its conditions is in one of them. */
  categories?: string[];
  graded?: boolean;
  priceMin?: number | undefined; // cents
  priceMax?: number | undefined; // cents
  /** Default true: sold-out cards stay reachable by link but leave the listing. */
  inStockOnly?: boolean;
  sort?: CatalogSort;
  page?: number;
  pageSize?: number;
};

export const CATALOG_SORTS = ['newest', 'price_asc', 'price_desc', 'number', 'name'] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

export type CardImage = {
  /** own scan (processed) or the TCGdex picture of the print */
  kind: 'own' | 'sample' | 'none';
  /** for own scans: media key, rendered as srcset in 320/640/1200 */
  key: string | null;
  /** for samples: path under /media/card/ */
  samplePath: string | null;
  width: number | null;
  height: number | null;
};

/** One condition of a card, as offered on its tile and product page. */
export type TileVariant = {
  id: number;
  sku: string;
  slug: string;
  condition: string;
  priceCents: number;
  available: number;
};

export type CatalogTile = {
  /** The variant the tile leads with: the cheapest one in stock. */
  id: number;
  sku: string;
  slug: string;
  /** The name printed on the card, in any shop language. */
  name: string;
  /** BCP 47 tag of `name` (for lang="…"). */
  nameLang: string;
  /** Shown smaller under the name: English, then German in the German shop. */
  nameTranslations: CardNames['translations'];
  setCode: string;
  setName: string | null;
  cardNumber: string;
  cardLanguage: string;
  condition: string;
  finish: string;
  grading: string | null;
  rarity: string | null;
  priceCents: number;
  available: number;
  highValue: boolean;
  image: CardImage;
  /** The conditions on this tile (best condition first), including the lead one. */
  variants: TileVariant[];
};

type TileRow = {
  id: number;
  sku: string;
  slug: string;
  slug_en: string | null;
  name_de: string;
  name_en: string;
  name_local: string | null;
  set_code: string;
  set_name_de: string | null;
  set_name_en: string | null;
  card_number: string;
  card_language: string;
  condition: string;
  finish: string;
  grading_company: string | null;
  grading_grade: string | null;
  rarity: string | null;
  rarity_de: string | null;
  price_cents: number;
  available: number;
  high_value: boolean;
  own_key: string | null;
  own_w: number | null;
  own_h: number | null;
  master_de: string | null;
  master_en: string | null;
};

/** TCGdex image URL → local proxy path (keeps visitors' IPs away from third parties). */
function samplePath(url: string | null): string | null {
  const m = url ? /^https:\/\/assets\.tcgdex\.net\/(.+)$/.exec(url) : null;
  return m ? m[1]! : null;
}

function tile(r: TileRow, locale: Locale): CatalogTile {
  // A German card shows the German print as sample; every other language the English one.
  const sampleUrl =
    r.card_language === 'DE' ? (r.master_de ?? r.master_en) : (r.master_en ?? r.master_de);
  const sample = samplePath(sampleUrl);
  const names = cardNames(
    {
      cardLanguage: r.card_language,
      nameDe: r.name_de,
      nameEn: r.name_en,
      nameLocal: r.name_local,
    },
    locale,
  );
  return {
    id: r.id,
    sku: r.sku,
    slug: locale === 'en' ? (r.slug_en ?? r.slug) : r.slug,
    name: names.original,
    nameLang: names.lang,
    nameTranslations: names.translations,
    setCode: r.set_code,
    setName: locale === 'en' ? (r.set_name_en ?? r.set_name_de) : (r.set_name_de ?? r.set_name_en),
    cardNumber: r.card_number,
    cardLanguage: r.card_language,
    condition: r.condition,
    finish: r.finish,
    grading: r.grading_company ? `${r.grading_company} ${r.grading_grade}` : null,
    rarity: locale === 'de' ? (r.rarity_de ?? r.rarity) : r.rarity,
    priceCents: r.price_cents,
    available: r.available,
    highValue: r.high_value,
    image: r.own_key
      ? { kind: 'own', key: r.own_key, samplePath: null, width: r.own_w, height: r.own_h }
      : sample
        ? { kind: 'sample', key: null, samplePath: sample, width: 600, height: 825 }
        : { kind: 'none', key: null, samplePath: null, width: null, height: null },
    variants: [variant(r, locale)],
  };
}

function variant(r: TileRow, locale: Locale): TileVariant {
  return {
    id: r.id,
    sku: r.sku,
    slug: locale === 'en' ? (r.slug_en ?? r.slug) : r.slug,
    condition: r.condition,
    priceCents: r.price_cents,
    available: r.available,
  };
}

const CONDITION_ORDER = Object.keys(CONDITIONS);

/** Best condition first (Mint, Near Mint …). */
export function byCondition(a: { condition: string }, b: { condition: string }): number {
  return CONDITION_ORDER.indexOf(a.condition) - CONDITION_ORDER.indexOf(b.condition);
}

/** Products with the same key are one card in different conditions. */
const GROUP_KEY = (db: Db) => db`
  concat_ws('|', p.set_code, p.card_number, p.card_language, p.finish,
            coalesce(p.grading_company, ''), coalesce(p.grading_grade, ''))`;

const TILE_COLUMNS = (db: Db) => db`
  p.id, p.sku, p.slug, p.slug_en, p.name_de, p.name_en, p.name_local, p.set_code, p.set_name_de, p.set_name_en,
  p.card_number, p.card_language, p.condition, p.finish, p.grading_company, p.grading_grade,
  p.rarity, rl.label_de AS rarity_de, p.price_cents, ps.available, p.high_value,
  img.storage_key AS own_key, img.width AS own_w, img.height AS own_h,
  cm.image_url_de AS master_de, cm.image_url AS master_en`;

const TILE_JOINS = (db: Db) => db`
  JOIN product_stock ps ON ps.product_id = p.id
  LEFT JOIN card_master cm ON cm.card_ref = p.card_ref
  LEFT JOIN rarity_labels rl ON rl.rarity = p.rarity
  LEFT JOIN LATERAL (
    SELECT storage_key, width, height FROM product_images i
     WHERE i.product_id = p.id AND i.status = 'ready'
     ORDER BY (i.role = 'front') DESC, i.position, i.id LIMIT 1) img ON true`;

function whereClause(db: Db, f: CatalogFilters, locale: Locale) {
  const q = f.q?.trim().toLowerCase().slice(0, 100);
  const series =
    locale === 'en'
      ? db`coalesce(p.series_en, p.series_de)`
      : db`coalesce(p.series_de, p.series_en)`;
  const nonEmpty = (a?: string[]) => (a && a.length ? a : null);
  return db`
    p.status = 'active' AND p.price_cents IS NOT NULL
    ${f.inStockOnly === false ? db`` : db`AND ps.available > 0`}
    ${q ? db`AND (${q} <% p.search_text OR p.search_text LIKE ${'%' + q.replace(/[%_\\]/g, '\\$&') + '%'})` : db``}
    ${nonEmpty(f.languages) ? db`AND p.card_language = ANY(${f.languages!}::text[])` : db``}
    ${nonEmpty(f.series) ? db`AND ${series} = ANY(${f.series!}::text[])` : db``}
    ${nonEmpty(f.sets) ? db`AND p.set_code = ANY(${f.sets!}::text[])` : db``}
    ${nonEmpty(f.rarities) ? db`AND p.rarity = ANY(${f.rarities!}::text[])` : db``}
    ${nonEmpty(f.conditions) ? db`AND p.condition = ANY(${f.conditions!}::text[])` : db``}
    ${nonEmpty(f.finishes) ? db`AND p.finish = ANY(${f.finishes!}::text[])` : db``}
    ${nonEmpty(f.supertypes) ? db`AND p.supertype = ANY(${f.supertypes!}::text[])` : db``}
    ${
      nonEmpty(f.categories)
        ? db`AND ${GROUP_KEY(db)} IN (
               SELECT ${GROUP_KEY(db)} FROM products p
                 JOIN product_categories pc ON pc.product_id = p.id
                 JOIN categories c ON c.id = pc.category_id
                WHERE c.slug = ANY(${f.categories!}::text[]))`
        : db``
    }
    ${f.graded ? db`AND p.grading_company IS NOT NULL` : db``}
    ${f.priceMin !== undefined ? db`AND p.price_cents >= ${f.priceMin}` : db``}
    ${f.priceMax !== undefined ? db`AND p.price_cents <= ${f.priceMax}` : db``}`;
}

/** Order of the card groups (columns of `g` in listCatalog). */
function orderBy(db: Db, f: CatalogFilters, locale: Locale) {
  const q = f.q?.trim().toLowerCase();
  switch (f.sort) {
    case 'price_asc':
      return db`g.min_price ASC, g.min_id`;
    case 'price_desc':
      return db`g.max_price DESC, g.min_id`;
    case 'number':
      return db`g.release_date DESC NULLS LAST, g.set_code,
                nullif(substring(g.card_number from '^[0-9]+'), '')::int NULLS LAST, g.card_number, g.min_id`;
    case 'name':
      return locale === 'en' ? db`g.name_en, g.min_id` : db`g.name_de, g.min_id`;
    default:
      return q ? db`g.sim DESC, g.newest DESC, g.max_id DESC` : db`g.newest DESC, g.max_id DESC`;
  }
}

export type Facet = { value: string; label: string; count: number };

export type CatalogResult = {
  items: CatalogTile[];
  /** Number of tiles (cards), not of products. */
  total: number;
  page: number;
  pages: number;
  facets: Record<
    | 'languages'
    | 'series'
    | 'sets'
    | 'rarities'
    | 'conditions'
    | 'finishes'
    | 'supertypes'
    | 'categories',
    Facet[]
  >;
};

export async function listCatalog(
  db: Db,
  f: CatalogFilters,
  locale: Locale,
): Promise<CatalogResult> {
  const pageSize = Math.min(Math.max(f.pageSize ?? 36, 1), 120);
  const page = Math.max(1, Math.floor(f.page ?? 1));
  const where = whereClause(db, f, locale);
  const q = f.q?.trim().toLowerCase().slice(0, 100);

  // Products matching the filters, grouped into cards. Each group lists its product ids with
  // the lead variant first: in stock, cheapest, best condition.
  const [groups, [{ total } = { total: 0 }], facets] = await Promise.all([
    db<{ ids: number[] }[]>`
      WITH m AS (
        SELECT p.id, ${GROUP_KEY(db)} AS gkey, p.set_code, p.card_number, p.condition,
               p.price_cents, p.created_at, p.name_de, p.name_en, ps.available, cs.release_date,
               ${q ? db`word_similarity(${q}, p.search_text)` : db`0::real`} AS sim
          FROM products p JOIN product_stock ps ON ps.product_id = p.id
          LEFT JOIN card_sets cs ON cs.set_code = p.set_code
         WHERE ${where}
      ), g AS (
        SELECT array_agg(id ORDER BY (available > 0) DESC, price_cents,
                         array_position(${CONDITION_ORDER}::text[], condition), id) AS ids,
               min(price_cents) AS min_price, max(price_cents) AS max_price,
               max(created_at) AS newest, max(id) AS max_id, min(id) AS min_id,
               max(release_date) AS release_date, min(set_code) AS set_code,
               min(card_number) AS card_number, min(name_de) AS name_de, min(name_en) AS name_en,
               max(sim) AS sim
          FROM m GROUP BY gkey
      )
      SELECT g.ids FROM g
       ORDER BY ${orderBy(db, f, locale)}
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    db<{ total: number }[]>`
      SELECT count(DISTINCT ${GROUP_KEY(db)})::int AS total
        FROM products p JOIN product_stock ps ON ps.product_id = p.id WHERE ${where}`,
    catalogFacets(db, locale),
  ]);

  const ids = groups.flatMap((g) => g.ids.map(Number));
  const rows = ids.length
    ? await db<TileRow[]>`
        SELECT ${TILE_COLUMNS(db)} FROM products p ${TILE_JOINS(db)}
         WHERE p.id = ANY(${ids}::bigint[])`
    : [];
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const items: CatalogTile[] = [];
  for (const g of groups) {
    const members = g.ids.map((id) => byId.get(Number(id))).filter((r) => r !== undefined);
    const lead = members[0];
    if (!lead) continue;
    items.push({
      ...tile(lead, locale),
      variants: members.map((r) => variant(r, locale)).sort(byCondition),
    });
  }
  return {
    items,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    facets,
  };
}

/** Filter options with counts (of cards, not products) over everything for sale right now. */
async function catalogFacets(db: Db, locale: Locale): Promise<CatalogResult['facets']> {
  const rows = await db<
    { dim: string; value: string; label: string | null; count: number; ord: number | null }[]
  >`
    WITH sale AS (
      SELECT p.*, ${GROUP_KEY(db)} AS gkey FROM products p JOIN product_stock ps ON ps.product_id = p.id
       WHERE p.status = 'active' AND p.price_cents IS NOT NULL AND ps.available > 0)
    SELECT 'languages' AS dim, card_language AS value, NULL AS label, count(DISTINCT gkey)::int AS count, NULL::int AS ord
      FROM sale GROUP BY 2
    UNION ALL
    SELECT 'series', s, s, count(DISTINCT gkey)::int, NULL FROM (
      SELECT ${locale === 'en' ? db`coalesce(series_en, series_de)` : db`coalesce(series_de, series_en)`} AS s, gkey FROM sale) x
     WHERE s IS NOT NULL GROUP BY 2
    UNION ALL
    SELECT 'sets', set_code, max(${locale === 'en' ? db`coalesce(set_name_en, set_name_de)` : db`coalesce(set_name_de, set_name_en)`}), count(DISTINCT gkey)::int, NULL
      FROM sale GROUP BY 2
    UNION ALL
    SELECT 'rarities', sale.rarity, max(${locale === 'de' ? db`coalesce(rl.label_de, sale.rarity)` : db`sale.rarity`}), count(DISTINCT gkey)::int, NULL
      FROM sale LEFT JOIN rarity_labels rl ON rl.rarity = sale.rarity WHERE sale.rarity IS NOT NULL GROUP BY 2
    UNION ALL
    SELECT 'conditions', condition, NULL, count(DISTINCT gkey)::int, NULL FROM sale GROUP BY 2
    UNION ALL
    SELECT 'finishes', finish, NULL, count(DISTINCT gkey)::int, NULL FROM sale GROUP BY 2
    UNION ALL
    SELECT 'supertypes', supertype, NULL, count(DISTINCT gkey)::int, NULL FROM sale WHERE supertype IS NOT NULL GROUP BY 2
    UNION ALL
    SELECT 'categories', c.slug, max(${locale === 'en' ? db`c.name_en` : db`c.name_de`}), count(DISTINCT sale.gkey)::int, min(c.position)
      FROM sale
      JOIN (SELECT DISTINCT ${GROUP_KEY(db)} AS gkey, pc.category_id
              FROM products p JOIN product_categories pc ON pc.product_id = p.id) pcg ON pcg.gkey = sale.gkey
      JOIN categories c ON c.id = pcg.category_id
     GROUP BY 2`;
  const out: CatalogResult['facets'] = {
    languages: [],
    series: [],
    sets: [],
    rarities: [],
    conditions: [],
    finishes: [],
    supertypes: [],
    categories: [],
  };
  const ord = new Map<string, number>();
  for (const r of rows) {
    out[r.dim as keyof typeof out].push({
      value: r.value,
      label: r.label ?? r.value,
      count: r.count,
    });
    if (r.dim === 'categories') ord.set(r.value, r.ord ?? 0);
  }
  for (const k of Object.keys(out) as (keyof typeof out)[]) {
    out[k].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }
  // Categories in the order set in the admin.
  out.categories.sort(
    (a, b) => ord.get(a.value)! - ord.get(b.value)! || a.label.localeCompare(b.label),
  );
  return out;
}

export async function newestCards(db: Db, locale: Locale, limit = 12): Promise<CatalogTile[]> {
  return (await listCatalog(db, { sort: 'newest', pageSize: limit }, locale)).items;
}

export type ProductPage = CatalogTile & {
  slugDe: string;
  slugEn: string;
  nameDe: string;
  nameEn: string;
  description: string | null;
  seriesName: string | null;
  releaseYear: number | null;
  supertype: string | null;
  energyTypes: string[];
  gradingCert: string | null;
  images: { key: string; role: string; width: number | null; height: number | null }[];
  setLogo: string | null;
  updatedAt: Date;
  /** Categories of this card (from any of its conditions), in admin order. */
  categories: { slug: string; name: string }[];
};

/** Product by slug in either language (the caller redirects to the canonical one). */
export async function productBySlug(
  db: Db,
  slug: string,
  locale: Locale,
): Promise<ProductPage | null> {
  const [r] = await db<
    (TileRow & {
      description_de: string | null;
      description_en: string | null;
      series_de: string | null;
      series_en: string | null;
      release_year: number | null;
      supertype: string | null;
      energy_types: string[];
      grading_cert: string | null;
      set_logo: string | null;
      updated_at: Date;
      images: { key: string; role: string; width: number | null; height: number | null }[];
    })[]
  >`
    SELECT ${TILE_COLUMNS(db)}, p.description_de, p.description_en, p.series_de, p.series_en,
           p.release_year, p.supertype, p.energy_types, p.grading_cert, cs.logo_url AS set_logo, p.updated_at,
           coalesce((SELECT json_agg(json_build_object('key', i.storage_key, 'role', i.role, 'width', i.width,
                                                       'height', i.height) ORDER BY (i.role = 'front') DESC, i.position, i.id)
                       FROM product_images i WHERE i.product_id = p.id AND i.status = 'ready'), '[]') AS images
      FROM products p ${TILE_JOINS(db)}
      LEFT JOIN card_sets cs ON cs.set_code = p.set_code
     WHERE (p.slug = ${slug} OR p.slug_en = ${slug}) AND p.status = 'active' AND p.price_cents IS NOT NULL
     LIMIT 1`;
  if (!r) return null;
  const [siblings, categories] = await Promise.all([
    db<TileRow[]>`
      SELECT ${TILE_COLUMNS(db)} FROM products p ${TILE_JOINS(db)}
       WHERE p.status = 'active' AND p.price_cents IS NOT NULL
         AND p.set_code = ${r.set_code} AND p.card_number = ${r.card_number}
         AND p.card_language = ${r.card_language} AND p.finish = ${r.finish}
         AND p.grading_company IS NOT DISTINCT FROM ${r.grading_company}
         AND p.grading_grade IS NOT DISTINCT FROM ${r.grading_grade}`,
    db<{ slug: string; name: string }[]>`
      SELECT c.slug, ${locale === 'en' ? db`c.name_en` : db`c.name_de`} AS name
        FROM categories c
       WHERE c.id IN (
         SELECT pc.category_id FROM product_categories pc JOIN products p ON p.id = pc.product_id
          WHERE p.set_code = ${r.set_code} AND p.card_number = ${r.card_number}
            AND p.card_language = ${r.card_language} AND p.finish = ${r.finish}
            AND p.grading_company IS NOT DISTINCT FROM ${r.grading_company}
            AND p.grading_grade IS NOT DISTINCT FROM ${r.grading_grade})
       ORDER BY c.position, c.name_de, c.id`,
  ]);
  return {
    ...tile(r, locale),
    variants: siblings.map((s) => variant(s, locale)).sort(byCondition),
    categories: [...categories],
    slugDe: r.slug,
    slugEn: r.slug_en ?? r.slug,
    nameDe: r.name_de,
    nameEn: r.name_en,
    description: locale === 'en' ? (r.description_en ?? null) : (r.description_de ?? null),
    seriesName: locale === 'en' ? (r.series_en ?? r.series_de) : (r.series_de ?? r.series_en),
    releaseYear: r.release_year,
    supertype: r.supertype,
    energyTypes: r.energy_types,
    gradingCert: r.grading_cert,
    images: r.images,
    setLogo: samplePath(r.set_logo),
    updatedAt: r.updated_at,
  };
}

export type SetSummary = {
  setCode: string;
  name: string;
  series: string | null;
  releaseDate: Date | null;
  cardCount: number | null;
  logo: string | null;
  forSale: number;
};

/** Sets that currently have cards for sale, newest first. */
export async function setsForSale(db: Db, locale: Locale): Promise<SetSummary[]> {
  const rows = await db<
    {
      set_code: string;
      name: string | null;
      series: string | null;
      release_date: Date | null;
      card_count: number | null;
      logo_url: string | null;
      for_sale: number;
    }[]
  >`
    SELECT p.set_code,
           max(${locale === 'en' ? db`coalesce(cs.name_en, cs.name_de, p.set_name_en, p.set_name_de)` : db`coalesce(cs.name_de, cs.name_en, p.set_name_de, p.set_name_en)`}) AS name,
           max(${locale === 'en' ? db`coalesce(cs.series_en, cs.series_de)` : db`coalesce(cs.series_de, cs.series_en)`}) AS series,
           max(cs.release_date) AS release_date, max(cs.card_count) AS card_count, max(cs.logo_url) AS logo_url,
           count(DISTINCT ${GROUP_KEY(db)})::int AS for_sale
      FROM products p JOIN product_stock ps ON ps.product_id = p.id
      LEFT JOIN card_sets cs ON cs.set_code = p.set_code
     WHERE p.status = 'active' AND p.price_cents IS NOT NULL AND ps.available > 0
     GROUP BY p.set_code
     ORDER BY max(cs.release_date) DESC NULLS LAST, p.set_code`;
  return rows.map((r) => ({
    setCode: r.set_code,
    name: r.name ?? r.set_code,
    series: r.series,
    releaseDate: r.release_date,
    cardCount: r.card_count,
    logo: samplePath(r.logo_url),
    forSale: r.for_sale,
  }));
}

export async function setInfo(db: Db, setCode: string, locale: Locale): Promise<SetSummary | null> {
  const [r] = await db<
    {
      set_code: string;
      name: string | null;
      series: string | null;
      release_date: Date | null;
      card_count: number | null;
      logo_url: string | null;
    }[]
  >`
    SELECT set_code,
           ${locale === 'en' ? db`coalesce(name_en, name_de)` : db`coalesce(name_de, name_en)`} AS name,
           ${locale === 'en' ? db`coalesce(series_en, series_de)` : db`coalesce(series_de, series_en)`} AS series,
           release_date, card_count, logo_url
      FROM card_sets WHERE set_code = ${setCode}`;
  if (!r) return null;
  return {
    setCode: r.set_code,
    name: r.name ?? r.set_code,
    series: r.series,
    releaseDate: r.release_date,
    cardCount: r.card_count,
    logo: samplePath(r.logo_url),
    forSale: 0,
  };
}

/** Slugs and change dates for the sitemap. */
export async function sitemapProducts(db: Db) {
  return db<{ slug: string; slug_en: string | null; updated_at: Date }[]>`
    SELECT slug, slug_en, updated_at FROM products WHERE status = 'active' AND price_cents IS NOT NULL
     ORDER BY id`;
}

/** Tiles for the given products whatever their status (cart, order pages). */
export async function tilesByIds(
  db: Db,
  ids: readonly number[],
  locale: Locale,
): Promise<Map<number, CatalogTile & { active: boolean }>> {
  if (ids.length === 0) return new Map();
  const rows = await db<(TileRow & { status: string })[]>`
    SELECT ${TILE_COLUMNS(db)}, p.status FROM products p ${TILE_JOINS(db)}
     WHERE p.id = ANY(${ids as number[]}::bigint[])`;
  return new Map(rows.map((r) => [r.id, { ...tile(r, locale), active: r.status === 'active' }]));
}

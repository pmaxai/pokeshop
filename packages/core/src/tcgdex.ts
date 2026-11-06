import { TCGDEX_LOCAL_LANGS, type TcgdexLocalLang } from './catalog.ts';
import type { Db } from './db.ts';

/**
 * Card master data from TCGdex (https://tcgdex.dev, MIT licence).
 * - syncSets: every set with its card list, names in German and English (~400 requests).
 * - syncCardDetails: rarity, category and types for one card, fetched when a product needs it.
 * - syncLocalName: the card's name in one more language (French, Italian …), for products
 *   printed in that language.
 * The shop keeps its own copy, so it never depends on TCGdex at runtime.
 */

export type Lang = 'de' | 'en' | TcgdexLocalLang;

/** Digital-only TCG Pocket sets are not physical cards. */
const EXCLUDED_SERIES = new Set(['tcgp']);

export type SetBrief = {
  id: string;
  name: string;
  cardCount?: { total?: number; official?: number };
};
export type SetDetail = {
  id: string;
  name: string;
  logo?: string;
  symbol?: string;
  releaseDate?: string;
  serie?: { id: string; name: string };
  cardCount?: { total?: number; official?: number };
  cards: { id: string; localId: string; name: string; image?: string }[];
};
export type CardDetail = {
  id: string;
  localId: string;
  name: string;
  image?: string;
  category?: string;
  rarity?: string;
  types?: string[];
  set: { id: string };
  variants?: Partial<Record<'normal' | 'reverse' | 'holo' | 'firstEdition', boolean>>;
};

export interface TcgdexClient {
  sets(lang: Lang): Promise<SetBrief[]>;
  set(lang: Lang, id: string): Promise<SetDetail | null>;
  card(lang: Lang, id: string): Promise<CardDetail | null>;
}

/** HTTP client with a simple pace limit and retries on 429/5xx. */
export function httpTcgdexClient(
  opts: { baseUrl?: string; minIntervalMs?: number; fetchImpl?: typeof fetch } = {},
): TcgdexClient {
  const base = (opts.baseUrl ?? process.env.TCGDEX_BASE_URL ?? 'https://api.tcgdex.net/v2').replace(
    /\/$/,
    '',
  );
  const minInterval = opts.minIntervalMs ?? 120;
  const doFetch = opts.fetchImpl ?? fetch;
  let last = 0;

  async function get<T>(path: string): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      const wait = last + minInterval - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const res = await doFetch(base + path, {
        headers: { Accept: 'application/json', 'User-Agent': 'pokemonkarten.at catalog sync' },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 404) return null;
      if (res.ok) return (await res.json()) as T;
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      throw new Error(`TCGdex ${path}: HTTP ${res.status}`);
    }
  }

  return {
    sets: async (lang) => (await get<SetBrief[]>(`/${lang}/sets`)) ?? [],
    set: (lang, id) => get<SetDetail>(`/${lang}/sets/${encodeURIComponent(id)}`),
    card: (lang, id) => get<CardDetail>(`/${lang}/cards/${encodeURIComponent(id)}`),
  };
}

export type SyncReport = { sets: number; cards: number; skipped: string[] };

export async function syncSets(
  db: Db,
  client: TcgdexClient,
  log: (msg: string) => void = () => {},
): Promise<SyncReport> {
  const [en, de] = await Promise.all([client.sets('en'), client.sets('de')]);
  const ids = [...new Set([...en.map((s) => s.id), ...de.map((s) => s.id)])];
  const inDe = new Set(de.map((s) => s.id));
  const inEn = new Set(en.map((s) => s.id));
  const report: SyncReport = { sets: 0, cards: 0, skipped: [] };

  for (const id of ids) {
    const dEn = inEn.has(id) ? await client.set('en', id) : null;
    const dDe = inDe.has(id) ? await client.set('de', id) : null;
    const any = dEn ?? dDe;
    if (!any) continue;
    if (any.serie && EXCLUDED_SERIES.has(any.serie.id)) {
      report.skipped.push(id);
      continue;
    }

    await db`
      INSERT INTO card_sets (set_code, name_de, name_en, series_de, series_en, release_date,
                             card_count, logo_url, symbol_url, updated_at)
      VALUES (${id}, ${dDe?.name ?? null}, ${dEn?.name ?? null}, ${dDe?.serie?.name ?? null},
              ${dEn?.serie?.name ?? null}, ${any.releaseDate ?? null},
              ${any.cardCount?.official ?? any.cardCount?.total ?? null},
              ${dDe?.logo ?? dEn?.logo ?? null}, ${any.symbol ?? null}, now())
      ON CONFLICT (set_code) DO UPDATE SET
        name_de = coalesce(EXCLUDED.name_de, card_sets.name_de),
        name_en = coalesce(EXCLUDED.name_en, card_sets.name_en),
        series_de = coalesce(EXCLUDED.series_de, card_sets.series_de),
        series_en = coalesce(EXCLUDED.series_en, card_sets.series_en),
        release_date = coalesce(EXCLUDED.release_date, card_sets.release_date),
        card_count = coalesce(EXCLUDED.card_count, card_sets.card_count),
        logo_url = coalesce(EXCLUDED.logo_url, card_sets.logo_url),
        symbol_url = coalesce(EXCLUDED.symbol_url, card_sets.symbol_url),
        updated_at = now()`;

    const cards = new Map<
      string,
      { localId: string; de?: string; en?: string; imgDe?: string; imgEn?: string }
    >();
    for (const c of dEn?.cards ?? [])
      cards.set(c.id, { localId: c.localId, en: c.name, imgEn: c.image });
    for (const c of dDe?.cards ?? []) {
      const e = cards.get(c.id) ?? { localId: c.localId };
      e.de = c.name;
      e.imgDe = c.image;
      cards.set(c.id, e);
    }
    const rows = [...cards].map(([ref, c]) => ({
      card_ref: ref,
      set_code: id,
      local_id: c.localId,
      name_de: c.de ?? null,
      name_en: c.en ?? null,
      image_url: c.imgEn ?? null,
      image_url_de: c.imgDe ?? null,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await db`
        INSERT INTO card_master ${db(chunk, 'card_ref', 'set_code', 'local_id', 'name_de', 'name_en', 'image_url', 'image_url_de')}
        ON CONFLICT (card_ref) DO UPDATE SET
          local_id = EXCLUDED.local_id,
          name_de = coalesce(EXCLUDED.name_de, card_master.name_de),
          name_en = coalesce(EXCLUDED.name_en, card_master.name_en),
          image_url = coalesce(EXCLUDED.image_url, card_master.image_url),
          image_url_de = coalesce(EXCLUDED.image_url_de, card_master.image_url_de),
          updated_at = now()`;
    }
    report.sets++;
    report.cards += rows.length;
    log(`set ${id}: ${rows.length} cards`);
  }
  await backfillProductSets(db);
  await fillLocalNames(db);
  return report;
}

const CATEGORY_TO_SUPERTYPE: Record<string, 'pokemon' | 'trainer' | 'energy'> = {
  Pokemon: 'pokemon',
  Trainer: 'trainer',
  Energy: 'energy',
};

export type CardMasterRow = {
  card_ref: string;
  set_code: string;
  local_id: string;
  name_de: string | null;
  name_en: string | null;
  rarity: string | null;
  rarity_de: string | null;
  supertype: string | null;
  energy_types: string[];
  image_url: string | null;
  image_url_de: string | null;
  details_fetched_at: Date | null;
};

/**
 * Fetches rarity, category and types for one card (English for the canonical
 * values, German for labels) and stores them. Creates the card – and a
 * minimal set row – if the full sync has not seen it yet.
 */
export async function syncCardDetails(
  db: Db,
  client: TcgdexClient,
  cardRef: string,
): Promise<CardMasterRow | null> {
  const [en, de] = await Promise.all([client.card('en', cardRef), client.card('de', cardRef)]);
  const any = en ?? de;
  if (!any) return null;
  const setCode = any.set.id;
  await db`INSERT INTO card_sets (set_code) VALUES (${setCode}) ON CONFLICT DO NOTHING`;
  await ensureSetMeta(db, client, setCode);
  const supertype = any.category ? (CATEGORY_TO_SUPERTYPE[en?.category ?? ''] ?? null) : null;
  const [row] = await db<CardMasterRow[]>`
    INSERT INTO card_master (card_ref, set_code, local_id, name_de, name_en, rarity, rarity_de,
                             category, supertype, energy_types, image_url, image_url_de, details_fetched_at)
    VALUES (${cardRef}, ${setCode}, ${any.localId}, ${de?.name ?? null}, ${en?.name ?? null},
            ${en?.rarity ?? null}, ${de?.rarity ?? null}, ${en?.category ?? null}, ${supertype},
            ${en?.types ?? []}, ${en?.image ?? null}, ${de?.image ?? null}, now())
    ON CONFLICT (card_ref) DO UPDATE SET
      name_de = coalesce(EXCLUDED.name_de, card_master.name_de),
      name_en = coalesce(EXCLUDED.name_en, card_master.name_en),
      rarity = coalesce(EXCLUDED.rarity, card_master.rarity),
      rarity_de = coalesce(EXCLUDED.rarity_de, card_master.rarity_de),
      category = coalesce(EXCLUDED.category, card_master.category),
      supertype = coalesce(EXCLUDED.supertype, card_master.supertype),
      energy_types = CASE WHEN cardinality(EXCLUDED.energy_types) > 0 THEN EXCLUDED.energy_types ELSE card_master.energy_types END,
      image_url = coalesce(EXCLUDED.image_url, card_master.image_url),
      image_url_de = coalesce(EXCLUDED.image_url_de, card_master.image_url_de),
      details_fetched_at = now(),
      updated_at = now()
    RETURNING card_ref, set_code, local_id, name_de, name_en, rarity, rarity_de, supertype,
              energy_types, image_url, image_url_de, details_fetched_at`;
  if (en?.rarity) {
    await db`
      INSERT INTO rarity_labels (rarity, label_de) VALUES (${en.rarity}, ${de?.rarity ?? null})
      ON CONFLICT (rarity) DO UPDATE SET label_de = coalesce(EXCLUDED.label_de, rarity_labels.label_de),
                                         updated_at = now()`;
  }
  return row ?? null;
}

/** Fills set names, series, release date and card count when only the set code is known. */
async function ensureSetMeta(db: Db, client: TcgdexClient, setCode: string): Promise<void> {
  const [row] = await db<{ known: boolean }[]>`
    SELECT (name_de IS NOT NULL OR name_en IS NOT NULL) AND card_count IS NOT NULL AS known
      FROM card_sets WHERE set_code = ${setCode}`;
  if (row?.known) return;
  const [en, de] = await Promise.all([client.set('en', setCode), client.set('de', setCode)]);
  const any = en ?? de;
  if (!any) return;
  await db`
    UPDATE card_sets SET
      name_de = coalesce(${de?.name ?? null}, name_de),
      name_en = coalesce(${en?.name ?? null}, name_en),
      series_de = coalesce(${de?.serie?.name ?? null}, series_de),
      series_en = coalesce(${en?.serie?.name ?? null}, series_en),
      release_date = coalesce(${any.releaseDate ?? null}::date, release_date),
      card_count = coalesce(${any.cardCount?.official ?? any.cardCount?.total ?? null}::int, card_count),
      logo_url = coalesce(${de?.logo ?? en?.logo ?? null}, logo_url),
      symbol_url = coalesce(${any.symbol ?? null}, symbol_url),
      updated_at = now()
    WHERE set_code = ${setCode}`;
}

/**
 * Asks TCGdex for the card's name in `lang` and keeps the answer (also "none") in
 * card_master.names_local; products printed in that language get it as name_local.
 */
export async function syncLocalName(
  db: Db,
  client: TcgdexClient,
  cardRef: string,
  lang: TcgdexLocalLang,
): Promise<string | null> {
  const card = await client.card(lang, cardRef);
  const name = card?.name?.trim() || null;
  await db`
    UPDATE card_master SET names_local = names_local || jsonb_build_object(${lang}::text, ${name}::text),
                           updated_at = now()
     WHERE card_ref = ${cardRef}`;
  await fillLocalNames(db, cardRef);
  return name;
}

/** Products printed in French, Italian … without their own name get it from the master data. */
export async function fillLocalNames(db: Db, cardRef?: string): Promise<number> {
  const langs = Object.entries(TCGDEX_LOCAL_LANGS).map(([card_language, code]) => ({
    card_language,
    code,
  }));
  const r = await db`
    UPDATE products p SET name_local = cm.names_local ->> l.code
      FROM card_master cm,
           jsonb_to_recordset(${db.json(langs as never)}) AS l(card_language text, code text)
     WHERE cm.card_ref = p.card_ref AND p.card_language = l.card_language
       AND p.name_local IS NULL AND cm.names_local ->> l.code IS NOT NULL
       ${cardRef ? db`AND p.card_ref = ${cardRef}` : db``}`;
  return r.count;
}

/** Card refs × languages of products whose own-language name TCGdex was never asked for. */
export async function missingLocalNames(
  db: Db,
  limit = 50,
): Promise<{ card_ref: string; lang: TcgdexLocalLang }[]> {
  const langs = Object.entries(TCGDEX_LOCAL_LANGS).map(([card_language, code]) => ({
    card_language,
    code,
  }));
  return db<{ card_ref: string; lang: TcgdexLocalLang }[]>`
    SELECT DISTINCT p.card_ref, l.code AS lang
      FROM products p
      JOIN card_master cm ON cm.card_ref = p.card_ref
      JOIN jsonb_to_recordset(${db.json(langs as never)}) AS l(card_language text, code text)
        ON l.card_language = p.card_language
     WHERE p.name_local IS NULL AND NOT cm.names_local ? l.code
     LIMIT ${limit}`;
}

/** Products created before their set was synced get the set data afterwards. */
export async function backfillProductSets(db: Db): Promise<number> {
  const r = await db`
    UPDATE products p SET
      set_name_de = coalesce(p.set_name_de, cs.name_de, cs.name_en),
      set_name_en = coalesce(p.set_name_en, cs.name_en, cs.name_de),
      series_de = coalesce(p.series_de, cs.series_de),
      series_en = coalesce(p.series_en, cs.series_en),
      release_year = coalesce(p.release_year, extract(year FROM cs.release_date)::smallint)
      FROM card_sets cs
     WHERE cs.set_code = p.set_code
       AND (p.set_name_de IS NULL OR p.set_name_en IS NULL OR p.series_de IS NULL OR p.release_year IS NULL)
       AND (cs.name_de IS NOT NULL OR cs.name_en IS NOT NULL)`;
  // "199" → "199/165" once the set's card count is known (promo numbers like SWSH029 stay as they are)
  await db`
    UPDATE products p SET card_number = p.card_number || '/' || cs.card_count
      FROM card_sets cs
     WHERE cs.set_code = p.set_code AND cs.card_count IS NOT NULL
       AND p.card_ref IS NOT NULL AND p.card_number ~ '^[0-9]+$'`;
  return r.count;
}

/** Card image in a given resolution; TCGdex images are addressed without extension. */
export function tcgdexImage(url: string | null, quality: 'high' | 'low' = 'high'): string | null {
  return url ? `${url}/${quality}.webp` : null;
}

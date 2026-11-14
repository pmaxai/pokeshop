// Cards and prices from the app's data pack (pricepack.ts imports it), with the app's rules
// (android/…/data/Catalog.kt in github.com/pmaxai/TCGdex): which printings a card has, the price
// of each, the market value for a condition, PSA prices, the price history.
import { inflateSync } from 'node:zlib';
import type { Db } from './db.ts';

/** Printing kinds of the app; collection items use the shop's finish codes. */
export type PrintingKind = 'normal' | 'holo' | 'reverse' | 'first';

export const FINISH_TO_KIND: Record<string, PrintingKind | undefined> = {
  normal: 'normal',
  holo: 'holo',
  reverse_holo: 'reverse',
  first_edition: 'first',
  // Poké Ball / Master Ball patterns are reverse holos; the others have no price of their own.
  pokeball: 'reverse',
  masterball: 'reverse',
};
export const KIND_TO_FINISH: Record<PrintingKind, string> = {
  normal: 'normal',
  holo: 'holo',
  reverse: 'reverse_holo',
  first: 'first_edition',
};

/** Trading mode's condition factors: NM 100 · EX 85 · GD 75 · LP 65 · PL 50 · PO 30 %. */
export const CONDITION_FACTOR: Record<string, number> = {
  M: 1,
  NM: 1,
  EX: 0.85,
  GD: 0.75,
  LP: 0.65,
  PL: 0.5,
  PO: 0.3,
};
export const CONDITION_ORDER = ['M', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'] as const;

/** Shop card language → the pack's language of names (Korean cards are the Japanese ones). */
export function packLang(language: string | null | undefined): string {
  switch ((language ?? '').toUpperCase()) {
    case 'DE':
      return 'de';
    case 'JA':
    case 'KO':
      return 'ja';
    case 'ZH-HANT':
      return 'zh-tw';
    case 'ZH-HANS':
      return 'zh-cn';
    default:
      return 'en';
  }
}

export type Printing = {
  kind: PrintingKind;
  finish: string;
  /** Cardmarket EUR: trend (else 30-day / average), 30-day average, lowest offer */
  eur: number | null;
  eur30: number | null;
  eurLow: number | null;
  /** TCGplayer market price, USD, and in EUR at the pack's rate */
  usd: number | null;
  usdEur: number | null;
  /** The price to judge it by: Cardmarket, else TCGplayer in EUR (else USD). */
  value: number | null;
};

export type Graded = {
  psa10: number | null;
  psa10n: number | null;
  psa9: number | null;
  psa9n: number | null;
  psa8: number | null;
  psa8n: number | null;
  updated: string | null;
};

export type PriceCheck = {
  status: 'dropped' | 'uncertain' | 'disagree';
  cmTrend: number | null;
  tpLo: number | null;
  tpHi: number | null;
  others: string[];
};

export type PackCard = {
  id: string;
  /** Language of `name` (pack language: en, de, ja, zh-tw, zh-cn). */
  lang: string;
  name: string;
  /** Names by pack language. */
  names: Record<string, string>;
  setId: string | null;
  setName: string | null;
  series: string | null;
  /** "199/165", or the bare number when the set size is unknown. */
  number: string;
  localId: string | null;
  releaseDate: string | null;
  rarity: string | null;
  category: string | null;
  /** Picture through the shop's image route (/media/card/…), small and large. */
  image: { small: string; large: string } | null;
  /** The picture's original address for the app (TCGdex base without size, or the second source). */
  imageSource: string | null;
  printings: Printing[];
  priceCheck: PriceCheck | null;
  /** PSA prices (USD) by printing kind; '' = printing unknown. */
  graded: Record<string, Graded>;
  pricesUpdated: string | null;
  usdPerEur: number | null;
};

type Prices = {
  trend: number | null;
  avg: number | null;
  low: number | null;
  avg30: number | null;
  trend_holo: number | null;
  avg_holo: number | null;
  low_holo: number | null;
  avg30_holo: number | null;
  updated: string | null;
};

const round2 = (v: number) => Math.round(v * 100) / 100;

/** TCGplayer market price per printing key (normal, holofoil, reverse-holofoil, …), lower case. */
function tcgMap(data: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!data || typeof data !== 'object') return out;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    let p: number | null = null;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const f of ['marketPrice', 'midPrice', 'lowPrice']) {
        const x = o[f];
        if (typeof x === 'number' && x > 0) {
          p = x;
          break;
        }
      }
    } else if (typeof v === 'number' && v > 0) p = v;
    if (p !== null) out[k.toLowerCase()] = p;
  }
  return out;
}

/**
 * Which printings exist and their prices, as the app works them out: TCGplayer's printing list
 * where it has one, TCGdex's variants otherwise; Cardmarket's standard price is the holo price
 * when there is no non-holo printing; its "holo" columns are the reverse holo.
 */
export function printings(input: {
  variants: Record<string, boolean> | null;
  rarity: string | null;
  prices: Prices | null;
  tcgplayer: unknown;
  usdPerEur: number | null;
}): Printing[] {
  const v = input.variants;
  const has = (k: string) => v?.[k] === true;
  const holoRarity = /holo/i.test(input.rarity ?? '');
  const tcg = tcgMap(input.tcgplayer);
  const p = input.prices;
  const headline = p ? (p.trend ?? p.avg30 ?? p.avg) : null;
  const headlineHolo = p ? (p.trend_holo ?? p.avg30_holo ?? p.avg_holo) : null;
  const tcgNormal = tcg['normal'] ?? tcg['unlimited'] ?? null;
  const tcgHolo = tcg['holofoil'] ?? tcg['unlimited-holofoil'] ?? null;
  const tcgReverse = tcg['reverse-holofoil'] ?? tcg['reverseholofoil'] ?? null;
  const tcgFirst =
    tcg['1st-edition-holofoil'] ??
    tcg['1st-edition'] ??
    tcg['1stedition'] ??
    tcg['1st-edition-normal'] ??
    null;
  const fromTcg = Object.keys(tcg).length > 0;
  const normal = fromTcg
    ? tcgNormal !== null || (has('normal') && tcgHolo === null)
    : has('normal') || (v === null && !holoRarity);
  const holo = fromTcg ? tcgHolo !== null : has('holo') || (v === null && holoRarity);
  const reverse = has('reverse') || tcgReverse !== null;
  const first = has('firstEdition') || tcgFirst !== null;
  const make = (
    kind: PrintingKind,
    eur: number | null,
    eur30: number | null,
    eurLow: number | null,
    usd: number | null,
  ): Printing => {
    const usdEur = usd !== null && input.usdPerEur ? round2(usd / input.usdPerEur) : null;
    return {
      kind,
      finish: KIND_TO_FINISH[kind],
      eur,
      eur30,
      eurLow,
      usd,
      usdEur,
      value: eur ?? usdEur ?? usd,
    };
  };
  const out: Printing[] = [];
  if (normal) out.push(make('normal', headline, p?.avg30 ?? null, p?.low ?? null, tcgNormal));
  if (holo) {
    out.push(
      make(
        'holo',
        normal ? null : headline,
        normal ? null : (p?.avg30 ?? null),
        normal ? null : (p?.low ?? null),
        tcgHolo,
      ),
    );
  }
  if (reverse)
    out.push(make('reverse', headlineHolo, p?.avg30_holo ?? null, p?.low_holo ?? null, tcgReverse));
  if (first) out.push(make('first', null, null, null, tcgFirst));
  if (out.length === 0) {
    const any = Object.values(tcg);
    out.push(
      make(
        'normal',
        headline,
        p?.avg30 ?? null,
        p?.low ?? null,
        any.length ? Math.max(...any) : null,
      ),
    );
  }
  return out;
}

/** The printing of a finish, else the card's first printing (as the app does). */
export function printingFor(card: Pick<PackCard, 'printings'>, finish: string | null | undefined) {
  const kind = finish ? FINISH_TO_KIND[finish] : undefined;
  return card.printings.find((p) => p.kind === kind) ?? card.printings[0] ?? null;
}

const GRADED_CODE: Record<PrintingKind, string> = {
  normal: 'normal',
  holo: 'holo',
  reverse: 'reverse',
  first: '1st',
};

/**
 * Value of one copy in EUR: the printing's price times the condition; for PSA 10/9/8 the PSA
 * sold price of that printing (USD at the pack's rate). Null when there is no price.
 */
export function unitValue(
  card: PackCard,
  item: {
    finish?: string | null;
    condition?: string | null;
    grading?: { company: string; grade: string } | null;
  },
): number | null {
  const pr = printingFor(card, item.finish);
  if (item.grading) {
    if (item.grading.company.toUpperCase() !== 'PSA') return null;
    const g = card.graded[pr ? GRADED_CODE[pr.kind] : ''] ?? card.graded[''];
    const grade = item.grading.grade.replace(/\s/g, '');
    const usd =
      grade === '10' ? g?.psa10 : grade === '9' ? g?.psa9 : grade === '8' ? g?.psa8 : undefined;
    if (usd == null || !card.usdPerEur) return null;
    return round2(usd / card.usdPerEur);
  }
  if (!pr || pr.value === null) return null;
  const factor = CONDITION_FACTOR[(item.condition ?? 'NM').toUpperCase()] ?? 1;
  return round2(pr.value * factor);
}

export const toCents = (eur: number | null) => (eur === null ? null : Math.round(eur * 100));

// ---------------------------------------------------------------------------
// Loading cards
// ---------------------------------------------------------------------------

type CardRow = {
  id: string;
  lang: string;
  set_id: string | null;
  local_id: string | null;
  name: string | null;
  image_url: string | null;
  image_alt: string | null;
  image_alt_large: string | null;
  set_name: string | null;
  serie_name: string | null;
  official: number | null;
  release_date: string | null;
};

const TCGDEX_ASSETS = 'https://assets.tcgdex.net/';

/**
 * TCGdex pictures through the shop's own image route (/media/card/…), so visitors' browsers
 * never contact a third party. Pictures from the pack's second source aren't proxied: those
 * cards show the card back on the web (the app shows them).
 */
function imageOf(r: CardRow): PackCard['image'] {
  if (r.image_url?.startsWith(TCGDEX_ASSETS)) {
    const path = r.image_url.slice(TCGDEX_ASSETS.length).replace(/\/$/, '');
    if (/^[A-Za-z0-9._/-]+$/.test(path) && !path.includes('..')) {
      return { small: `/media/card/${path}/low.webp`, large: `/media/card/${path}/high.webp` };
    }
  }
  return null;
}

let rateCache: { at: number; value: number | null } | null = null;

async function usdPerEur(db: Db): Promise<number | null> {
  if (rateCache && Date.now() - rateCache.at < 10 * 60_000) return rateCache.value;
  const [m] = await db<{ value: string | null }[]>`
    SELECT value FROM pack_meta WHERE key = 'usd_per_eur'`;
  const v = Number(m?.value);
  rateCache = { at: Date.now(), value: Number.isFinite(v) && v > 0 ? v : null };
  return rateCache.value;
}

/**
 * Cards by id, named in the first of `langs` the pack has (then English, then any).
 * Ids the pack doesn't know are missing from the map.
 */
export async function packCards(
  db: Db,
  ids: readonly string[],
  langs: readonly string[] = ['en'],
): Promise<Map<string, PackCard>> {
  const unique = [...new Set(ids)].filter((i) => typeof i === 'string' && i.length <= 80);
  const out = new Map<string, PackCard>();
  if (unique.length === 0) return out;
  const [rows, info, prices, tcg, graded, checks, rate] = await Promise.all([
    db<CardRow[]>`
      SELECT c.id, c.lang, c.set_id, c.local_id, c.name, c.image_url, c.image_alt, c.image_alt_large,
             s.name AS set_name, s.serie_name, s.official, s.release_date
        FROM pack_cards c LEFT JOIN pack_sets s ON s.id = c.set_id AND s.lang = c.lang
       WHERE c.id = ANY(${unique}::text[])`,
    db<
      {
        id: string;
        rarity: string | null;
        variants: Record<string, boolean> | null;
        category: string | null;
      }[]
    >`
      SELECT id, rarity, variants, category FROM pack_card_info WHERE id = ANY(${unique}::text[])`,
    db<(Prices & { id: string })[]>`
      SELECT id, updated, trend, avg, low, avg30, trend_holo, avg_holo, low_holo, avg30_holo
        FROM pack_prices WHERE id = ANY(${unique}::text[])`,
    db<{ id: string; data: unknown }[]>`
      SELECT id, data FROM pack_tcgplayer WHERE id = ANY(${unique}::text[])`,
    db<
      {
        id: string;
        printing: string;
        psa10: number | null;
        psa10_n: number | null;
        psa9: number | null;
        psa9_n: number | null;
        psa8: number | null;
        psa8_n: number | null;
        updated: string | null;
      }[]
    >`
      SELECT id, printing, psa10, psa10_n, psa9, psa9_n, psa8, psa8_n, updated
        FROM pack_graded WHERE id = ANY(${unique}::text[])`,
    db<
      {
        id: string;
        status: PriceCheck['status'];
        cm_trend: number | null;
        tp_lo: number | null;
        tp_hi: number | null;
        others: string | null;
      }[]
    >`
      SELECT id, status, cm_trend, tp_lo, tp_hi, others FROM pack_price_check
       WHERE id = ANY(${unique}::text[])`,
    usdPerEur(db),
  ]);
  const byId = new Map<string, CardRow[]>();
  for (const r of rows) {
    const list = byId.get(r.id) ?? [];
    list.push(r);
    byId.set(r.id, list);
  }
  const infoOf = new Map(info.map((r) => [r.id, r]));
  const priceOf = new Map(prices.map((r) => [r.id, r]));
  const tcgOf = new Map(tcg.map((r) => [r.id, r.data]));
  const checkOf = new Map(checks.map((r) => [r.id, r]));
  const gradedOf = new Map<string, Record<string, Graded>>();
  for (const g of graded) {
    const m = gradedOf.get(g.id) ?? {};
    m[g.printing] = {
      psa10: g.psa10,
      psa10n: g.psa10_n,
      psa9: g.psa9,
      psa9n: g.psa9_n,
      psa8: g.psa8,
      psa8n: g.psa8_n,
      updated: g.updated,
    };
    gradedOf.set(g.id, m);
  }
  const order = [...langs, 'en'];
  for (const [id, list] of byId) {
    const rank = (l: string) => {
      const i = order.indexOf(l);
      return i < 0 ? order.length : i;
    };
    const named = [...list].sort((a, b) => rank(a.lang) - rank(b.lang));
    const main = named.find((r) => r.name) ?? named[0]!;
    // set name, image: the shown language first, then English, then any
    const withSet = named.find((r) => r.set_name) ?? main;
    const withImage = named.find((r) => r.image_url || r.image_alt);
    const inf = infoOf.get(id);
    const pr = priceOf.get(id) ?? null;
    const check = checkOf.get(id);
    const official = withSet.official;
    const names: Record<string, string> = {};
    for (const r of list) if (r.name) names[r.lang] = r.name;
    out.set(id, {
      id,
      lang: main.lang,
      name: main.name ?? id,
      names,
      setId: main.set_id,
      setName: withSet.set_name,
      series: withSet.serie_name,
      localId: main.local_id,
      number: main.local_id
        ? official && official > 0 && /^\d+$/.test(main.local_id)
          ? `${main.local_id}/${official}`
          : main.local_id
        : '',
      releaseDate: withSet.release_date,
      rarity: inf?.rarity ?? null,
      category: inf?.category ?? null,
      image: withImage ? imageOf(withImage) : null,
      imageSource: withImage ? (withImage.image_url ?? withImage.image_alt) : null,
      printings: printings({
        variants: inf?.variants ?? null,
        rarity: inf?.rarity ?? null,
        prices: pr,
        tcgplayer: tcgOf.get(id) ?? null,
        usdPerEur: rate,
      }),
      priceCheck: check
        ? {
            status: check.status,
            cmTrend: check.cm_trend,
            tpLo: check.tp_lo,
            tpHi: check.tp_hi,
            others: (check.others ?? '').split(',').filter(Boolean),
          }
        : null,
      graded: gradedOf.get(id) ?? {},
      pricesUpdated: pr?.updated ?? null,
      usdPerEur: rate,
    });
  }
  return out;
}

export async function packCard(
  db: Db,
  id: string,
  langs: readonly string[] = ['en'],
): Promise<PackCard | null> {
  return (await packCards(db, [id], langs)).get(id) ?? null;
}

/** The highest value among a card's printings (EUR), for lists. */
export const topValue = (c: PackCard) =>
  c.printings.reduce<number | null>(
    (m, p) => (p.value !== null && (m === null || p.value > m) ? p.value : m),
    null,
  );

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Card search like the app's: name in any language, set, number and id, e.g. "glurak 4",
 * "charizard base", "darumaka 034/167", "sv03.5-199". Every word must match.
 */
export async function searchPackCards(
  db: Db,
  query: string,
  opts: { langs?: readonly string[]; limit?: number } = {},
): Promise<PackCard[]> {
  const words = fold(query)
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 6);
  if (words.length === 0) return [];
  const limit = Math.min(Math.max(opts.limit ?? 48, 1), 100);
  const conds = words.map((w) => {
    const frac = /^0*(\d+[a-z]?)\/0*(\d+)$/.exec(w);
    if (frac) {
      return db`(ltrim(c.local_id, '0') = ${frac[1]!} AND (s.official = ${Number(frac[2])} OR s.total = ${Number(frac[2])}))`;
    }
    if (/^\d+[a-z]?$/.test(w)) {
      return db`(ltrim(c.local_id, '0') = ${w.replace(/^0+(?=.)/, '')} OR c.search LIKE ${`%${w}%`})`;
    }
    const like = `%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    return db`c.search LIKE ${like}`;
  });
  let where = conds[0]!;
  for (const c of conds.slice(1)) where = db`${where} AND ${c}`;
  const first = words.filter((w) => !/\d/.test(w)).join(' ');
  // a bare number is most likely the card number, not part of a set id
  const numberWord = words.find((w) => /^\d+[a-z]?$/.test(w))?.replace(/^0+(?=.)/, '');
  const hits = await db<{ id: string }[]>`
    SELECT c.id
      FROM pack_cards c LEFT JOIN pack_sets s ON s.id = c.set_id AND s.lang = c.lang
     WHERE ${where}
     GROUP BY c.id
     ORDER BY bool_or(${numberWord ? db`ltrim(c.local_id, '0') = ${numberWord}` : db`false`}) DESC,
              bool_or(${first ? db`shop_unaccent(lower(c.name)) = ${first}` : db`false`}) DESC,
              bool_or(${first ? db`shop_unaccent(lower(c.name)) LIKE ${`${first}%`}` : db`false`}) DESC,
              max(s.release_date) DESC NULLS LAST, c.id
     LIMIT ${limit}`;
  const cards = await packCards(
    db,
    hits.map((h) => h.id),
    opts.langs,
  );
  return hits.map((h) => cards.get(h.id)).filter((c): c is PackCard => Boolean(c));
}

// ---------------------------------------------------------------------------
// Price history
// ---------------------------------------------------------------------------

/** IEEE 754 half precision → number (NaN stays NaN). */
function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** One series: zlib-compressed little-endian float16, or float32 when it has `size` × 4 bytes. */
export function decodeSeries(blob: Uint8Array, size: number): (number | null)[] {
  const raw = inflateSync(blob);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: (number | null)[] = [];
  if (raw.byteLength === size * 4) {
    for (let i = 0; i < size; i++) {
      const v = dv.getFloat32(i * 4, true);
      out.push(Number.isNaN(v) ? null : round2(v));
    }
  } else {
    for (let i = 0; i < raw.byteLength / 2; i++) {
      const v = half(dv.getUint16(i * 2, true));
      out.push(Number.isNaN(v) ? null : round2(v));
    }
  }
  return out;
}

export type CardHistory = {
  /** weekly for a year, then daily for the last 90 days */
  dates: string[];
  /** cm_trend (normal / holo without normal), cm_trend_h (reverse), tp_normal, tp_holo, tp_reverse, tp_first (USD) */
  series: Record<string, (number | null)[]>;
  /** ECB USD per EUR per date */
  rates: (number | null)[];
};

export async function cardHistory(db: Db, id: string): Promise<CardHistory | null> {
  const [meta, rows] = await Promise.all([
    db<{ key: string; value: string | null }[]>`
      SELECT key, value FROM pack_meta WHERE key IN ('history_dates', 'history_rates')`,
    db<
      { field: string; data: Uint8Array }[]
    >`SELECT field, data FROM pack_history WHERE id = ${id}`,
  ]);
  const dates = (meta.find((m) => m.key === 'history_dates')?.value ?? '')
    .split(',')
    .filter(Boolean);
  if (dates.length === 0 || rows.length === 0) return null;
  const rates = (meta.find((m) => m.key === 'history_rates')?.value ?? '')
    .split(',')
    .map((r) => (r ? Number(r) : null));
  const series: Record<string, (number | null)[]> = {};
  for (const r of rows) {
    try {
      series[r.field] = decodeSeries(r.data, dates.length).slice(0, dates.length);
    } catch {
      // a broken series is left out
    }
  }
  return { dates, series, rates };
}

/** The EUR line of a printing, as the app's chart picks it (TCGplayer converted where needed). */
export function historyLine(
  h: CardHistory,
  kind: PrintingKind | null,
  hasNormal: boolean,
): { source: 'cardmarket' | 'tcgplayer'; values: (number | null)[] } | null {
  const cm =
    kind === 'reverse'
      ? h.series['cm_trend_h']
      : kind === 'holo'
        ? hasNormal
          ? undefined
          : h.series['cm_trend']
        : kind === 'first'
          ? undefined
          : h.series['cm_trend'];
  if (cm && cm.filter((v) => v !== null).length >= 2) return { source: 'cardmarket', values: cm };
  const tp =
    kind === 'holo'
      ? h.series['tp_holo']
      : kind === 'reverse'
        ? h.series['tp_reverse']
        : kind === 'first'
          ? h.series['tp_first']
          : h.series['tp_normal'];
  if (!tp) return null;
  const last = [...h.rates].reverse().find((r) => r) ?? null;
  return {
    source: 'tcgplayer',
    values: tp.map((v, i) => {
      const r = h.rates[i] ?? last;
      return v !== null && r ? round2(v / r) : null;
    }),
  };
}

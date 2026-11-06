/**
 * Card attributes, SKU building and storage-box validation.
 * One SKU = one card print × card language × condition × finish (× grading).
 */

export const CARD_LANGUAGES = [
  'DE',
  'EN',
  'FR',
  'IT',
  'ES',
  'PT',
  'NL',
  'PL',
  'RU',
  'JA',
  'KO',
  'ZH-HANT',
  'ZH-HANS',
  'ID',
  'TH',
] as const;
export type CardLanguage = (typeof CARD_LANGUAGES)[number];

/** BCP 47 tag of each card language, for lang="…" on the printed name (CJK glyphs differ). */
export const CARD_LANGUAGE_TAGS: Record<CardLanguage, string> = {
  DE: 'de',
  EN: 'en',
  FR: 'fr',
  IT: 'it',
  ES: 'es',
  PT: 'pt',
  NL: 'nl',
  PL: 'pl',
  RU: 'ru',
  JA: 'ja',
  KO: 'ko',
  'ZH-HANT': 'zh-Hant',
  'ZH-HANS': 'zh-Hans',
  ID: 'id',
  TH: 'th',
};

/**
 * Card languages whose printed name TCGdex keeps on the international card, with the TCGdex
 * language code. Asian prints (JA, KO, ZH, ID, TH) are separate cards in separate sets there,
 * so their names come from the scanning app or the admin.
 */
export const TCGDEX_LOCAL_LANGS = {
  FR: 'fr',
  IT: 'it',
  ES: 'es',
  PT: 'pt',
  NL: 'nl',
  PL: 'pl',
  RU: 'ru',
} as const satisfies Partial<Record<CardLanguage, string>>;
export type TcgdexLocalLang = (typeof TCGDEX_LOCAL_LANGS)[keyof typeof TCGDEX_LOCAL_LANGS];

export function tcgdexLocalLang(cardLanguage: string): TcgdexLocalLang | null {
  return (TCGDEX_LOCAL_LANGS as Record<string, TcgdexLocalLang>)[cardLanguage] ?? null;
}

export type CardNames = {
  /** The name printed on the card. */
  original: string;
  /** BCP 47 tag of `original`. */
  lang: string;
  /** Shown smaller under it: the English name, then (German shop) the German one; no repeats. */
  translations: { text: string; lang: string }[];
};

/** "Charizard-ex" and "Charizard ex" are the same name for this purpose. */
function nameKey(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * How a card is named in the shop: always the printed name, whatever the shop language,
 * then the English name and – in the German shop – the German one.
 * Without a known printed name (e.g. a Japanese card nobody named yet) the English name leads.
 */
export function cardNames(
  card: { cardLanguage: string; nameDe: string; nameEn: string; nameLocal?: string | null },
  shopLocale: 'de' | 'en',
): CardNames {
  const L = card.cardLanguage.toUpperCase();
  let original = card.nameEn;
  let lang = 'en';
  if (L === 'DE') {
    original = card.nameDe;
    lang = 'de';
  } else if (L !== 'EN' && card.nameLocal?.trim()) {
    original = card.nameLocal.trim();
    lang = CARD_LANGUAGE_TAGS[L as CardLanguage] ?? 'und';
  }
  const seen = new Set([nameKey(original)]);
  const translations: CardNames['translations'] = [];
  const candidates: [string, string][] = [[card.nameEn, 'en']];
  if (shopLocale === 'de') candidates.push([card.nameDe, 'de']);
  for (const [text, tag] of candidates) {
    const key = text ? nameKey(text) : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    translations.push({ text, lang: tag });
  }
  return { original, lang, translations };
}

/** cardNames for a database row (card_language, name_de, name_en, name_local). */
export function rowNames(
  r: { card_language: string; name_de: string; name_en: string; name_local?: string | null },
  shopLocale: 'de' | 'en',
): CardNames {
  return cardNames(
    {
      cardLanguage: r.card_language,
      nameDe: r.name_de,
      nameEn: r.name_en,
      nameLocal: r.name_local,
    },
    shopLocale,
  );
}

/** One line of text: "リザードンex (Charizard ex, Glurak-ex)". */
export function cardNameText(names: CardNames): string {
  return names.translations.length
    ? `${names.original} (${names.translations.map((t) => t.text).join(', ')})`
    : names.original;
}

export const CONDITIONS = {
  M: { de: 'Mint', en: 'Mint' },
  NM: { de: 'Near Mint', en: 'Near Mint' },
  EX: { de: 'Excellent', en: 'Excellent' },
  GD: { de: 'Good', en: 'Good' },
  LP: { de: 'Light Played', en: 'Light Played' },
  PL: { de: 'Played', en: 'Played' },
  PO: { de: 'Poor', en: 'Poor' },
} as const;
export type Condition = keyof typeof CONDITIONS;

export const FINISHES = {
  normal: { code: 'N', de: 'Normal', en: 'Normal' },
  holo: { code: 'H', de: 'Holo', en: 'Holo' },
  reverse_holo: { code: 'R', de: 'Reverse Holo', en: 'Reverse Holo' },
  first_edition: { code: '1E', de: '1. Edition', en: '1st Edition' },
  shadowless: { code: 'SL', de: 'Shadowless', en: 'Shadowless' },
  stamped: { code: 'ST', de: 'Gestempelt', en: 'Stamped' },
  pokeball: { code: 'PB', de: 'Pokéball-Muster', en: 'Poké Ball pattern' },
  masterball: { code: 'MB', de: 'Meisterball-Muster', en: 'Master Ball pattern' },
} as const;
export type Finish = keyof typeof FINISHES;

export const SUPERTYPES = ['pokemon', 'trainer', 'energy'] as const;
export type Supertype = (typeof SUPERTYPES)[number];

export const GRADING_COMPANIES = ['PSA', 'BGS', 'CGC', 'SGC', 'TAG', 'ACE'] as const;
export type GradingCompany = (typeof GRADING_COMPANIES)[number];

export type Grading = { company: GradingCompany; grade: string; cert?: string | null };

export function isCardLanguage(v: string): v is CardLanguage {
  return (CARD_LANGUAGES as readonly string[]).includes(v);
}
export function isCondition(v: string): v is Condition {
  return Object.hasOwn(CONDITIONS, v);
}
export function isFinish(v: string): v is Finish {
  return Object.hasOwn(FINISHES, v);
}

/**
 * Storage box number as sent by the scanning app: digits only, at least
 * three ("001", "014", "1203"). Kept as text so leading zeros survive.
 */
const STORAGE_LOCATION = /^\d{3,10}$/;

export function isStorageLocation(v: unknown): v is string {
  return typeof v === 'string' && STORAGE_LOCATION.test(v);
}

/** Sort key so boxes order numerically: "014" < "100" < "1203". */
export function compareStorageLocations(a: string, b: string): number {
  const na = BigInt(a);
  const nb = BigInt(b);
  if (na !== nb) return na < nb ? -1 : 1;
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** Card number as printed ("199/165", "TG05/TG30", "SWSH050") → its own part ("199"). */
export function localCardNumber(cardNumber: string): string {
  const own = cardNumber.trim().split('/')[0] ?? '';
  return own.replace(/\s+/g, '');
}

export type SkuParts = {
  setCode: string;
  cardNumber: string;
  language: CardLanguage;
  condition: Condition;
  finish: Finish;
  grading?: Grading | null;
};

/**
 * Builds the immutable SKU, e.g. "sv03.5-199-DE-NM-H" or
 * "base1-4-EN-NM-1E-PSA10" for a graded card.
 */
export function buildSku(p: SkuParts): string {
  const set = p.setCode
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '');
  const num = localCardNumber(p.cardNumber)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
  if (!set) throw new Error('setCode is empty');
  if (!num) throw new Error('cardNumber is empty');
  const parts = [set, num, p.language, p.condition, FINISHES[p.finish].code];
  if (p.grading) {
    const grade = p.grading.grade.replace(/[^0-9A-Za-z.]+/g, '').toUpperCase();
    parts.push(`${p.grading.company}${grade}`);
  }
  return parts.join('-');
}

/** URL slug for product pages: name, set, number and the SKU tail for uniqueness. */
export function productSlug(name: string, setCode: string, sku: string): string {
  const base = `${name} ${setCode}`
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const tail = sku
    .split('-')
    .slice(1)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '');
  return `${base}-${tail}`.replace(/-+/g, '-');
}

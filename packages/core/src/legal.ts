// Legal texts (terms, withdrawal, privacy): Markdown files in packages/core/legal, loaded into
// legal_texts on every migrate (legal-sync.ts). A changed file becomes a new version, and each
// order stores the versions the buyer accepted.
import { Marked } from 'marked';
import type { Db } from './db.ts';

export const LEGAL_KINDS = ['agb', 'withdrawal', 'privacy'] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];
export type LegalLocale = 'de' | 'en';

export type LegalText = {
  kind: LegalKind;
  locale: LegalLocale;
  version: number;
  title: string;
  body_md: string;
  published_at: Date;
};

export async function currentLegal(
  db: Db,
  kind: LegalKind,
  locale: LegalLocale,
): Promise<LegalText | null> {
  const [t] = await db<LegalText[]>`
    SELECT kind, locale, version, title, body_md, published_at FROM legal_texts
     WHERE kind = ${kind} AND locale = ${locale} AND published_at <= now()
     ORDER BY version DESC LIMIT 1`;
  return t ?? null;
}

/** Versions of the German (binding) texts, stored on the order at checkout. */
export async function currentLegalVersions(db: Db): Promise<Record<LegalKind, number | null>> {
  const rows = await db<{ kind: LegalKind; version: number }[]>`
    SELECT DISTINCT ON (kind) kind, version FROM legal_texts
     WHERE locale = 'de' AND published_at <= now() ORDER BY kind, version DESC`;
  const out: Record<LegalKind, number | null> = { agb: null, withdrawal: null, privacy: null };
  for (const r of rows) out[r.kind] = r.version;
  return out;
}

export type LegalContext = {
  company: Record<string, unknown>;
  baseUrl: string;
  locale: LegalLocale;
};

/** Fills {{company.name}}, {{company.address}}, {{shop_url}}, {{withdraw_url}} … */
export function fillPlaceholders(md: string, ctx: LegalContext): string {
  const c = ctx.company as Record<string, string | undefined>;
  const values: Record<string, string> = {
    'company.name': c.name ?? '',
    'company.address': [
      c.street,
      [c.postcode, c.city].filter(Boolean).join(' '),
      c.country === 'AT' ? (ctx.locale === 'de' ? 'Österreich' : 'Austria') : c.country,
    ]
      .filter(Boolean)
      .join(', '),
    'company.email': c.email ?? '',
    'company.phone': c.phone ?? '',
    'company.register': [c.register_number, c.register_court].filter(Boolean).join(', '),
    'company.vat_id': c.vat_id ?? '',
    shop_url: ctx.baseUrl,
    withdraw_url: `${ctx.baseUrl}${ctx.locale === 'de' ? '/vertrag-widerrufen' : '/en/withdraw'}`,
    privacy_url: `${ctx.baseUrl}${ctx.locale === 'de' ? '/datenschutz' : '/en/privacy'}`,
    terms_url: `${ctx.baseUrl}${ctx.locale === 'de' ? '/agb' : '/en/terms'}`,
    withdrawal_url: `${ctx.baseUrl}${ctx.locale === 'de' ? '/widerrufsbelehrung' : '/en/right-of-withdrawal'}`,
    shipping_url: `${ctx.baseUrl}${ctx.locale === 'de' ? '/versand-und-zahlung' : '/en/shipping-and-payment'}`,
    conditions_url: `${ctx.baseUrl}${ctx.locale === 'de' ? '/zustand' : '/en/condition-guide'}`,
  };
  return md.replace(/\{\{\s*([a-z_.]+)\s*\}\}/g, (m, k: string) => values[k] ?? m);
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const marked = new Marked({
  gfm: true,
  renderer: {
    // Raw HTML in the texts is shown as text, never rendered.
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

export function legalHtml(md: string, ctx: LegalContext): string {
  return marked.parse(fillPlaceholders(md, ctx), { async: false });
}

// Storefront paths for links built outside the web app (mails, PDFs, legal texts). The web app's
// routing (apps/web/src/i18n/routing.ts) is the source: English at the root, German under /de.

export type ShopLocale = 'de' | 'en';

/** The language at the domain root; the other one gets its code as a path prefix. */
export const DEFAULT_LOCALE: ShopLocale = 'en';

/** The path of a page in one language, given its German and English paths. */
export function localePath(locale: ShopLocale, paths: { de: string; en: string }): string {
  const p = paths[locale];
  if (locale === DEFAULT_LOCALE) return p;
  return p === '/' ? `/${locale}` : `/${locale}${p}`;
}

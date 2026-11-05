import type { MetadataRoute } from 'next';
import { sitemapProducts, setsForSale } from '@pokeshop/core/storefront';
import { getPathname } from '@/i18n/navigation';
import { config, db } from '@/server/config';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = config.baseUrl;
  const both = (href: Parameters<typeof getPathname>[0]['href']) => ({
    de: base + getPathname({ href, locale: 'de' }),
    en: base + getPathname({ href, locale: 'en' }),
  });
  const entries: MetadataRoute.Sitemap = [];
  for (const href of [
    '/',
    '/karten',
    '/sets',
    '/zustand',
    '/versand',
    '/agb',
    '/widerrufsbelehrung',
    '/datenschutz',
    '/impressum',
  ] as const) {
    const u = both(href);
    entries.push({ url: u.de, alternates: { languages: u } });
  }
  for (const s of await setsForSale(db(), 'de')) {
    const u = both({ pathname: '/sets/[set]', params: { set: s.setCode } });
    entries.push({ url: u.de, alternates: { languages: u } });
  }
  for (const p of await sitemapProducts(db())) {
    const u = {
      de:
        base +
        getPathname({
          href: { pathname: '/karten/[slug]', params: { slug: p.slug } },
          locale: 'de',
        }),
      en:
        base +
        getPathname({
          href: { pathname: '/karten/[slug]', params: { slug: p.slug_en ?? p.slug } },
          locale: 'en',
        }),
    };
    entries.push({ url: u.de, lastModified: p.updated_at, alternates: { languages: u } });
  }
  return entries;
}

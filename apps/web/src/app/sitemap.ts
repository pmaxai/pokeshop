import type { MetadataRoute } from 'next';
import { sitemapProducts, setsForSale } from '@pokeshop/core/storefront';
import { upcomingEvents } from '@pokeshop/core/events';
import { getPathname } from '@/i18n/navigation';
import { config, db } from '@/server/config';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = config.baseUrl;
  // English is the default (x-default); every entry lists both languages.
  const langs = (en: string, de: string) => ({ en, de, 'x-default': en });
  const both = (href: Parameters<typeof getPathname>[0]['href']) =>
    langs(base + getPathname({ href, locale: 'en' }), base + getPathname({ href, locale: 'de' }));
  const entries: MetadataRoute.Sitemap = [];
  for (const href of [
    '/',
    '/karten',
    '/sets',
    '/gutscheine',
    '/zustand',
    '/versand',
    '/kontakt',
    '/agb',
    '/widerrufsbelehrung',
    '/datenschutz',
    '/impressum',
  ] as const) {
    const u = both(href);
    entries.push({ url: u.en, alternates: { languages: u } });
  }
  for (const s of await setsForSale(db(), 'en')) {
    const u = both({ pathname: '/sets/[set]', params: { set: s.setCode } });
    entries.push({ url: u.en, alternates: { languages: u } });
  }
  for (const e of await upcomingEvents(db())) {
    const u = both({ pathname: '/veranstaltungen/[slug]', params: { slug: e.slug } });
    entries.push({ url: u.en, alternates: { languages: u } });
  }
  for (const p of await sitemapProducts(db())) {
    const u = langs(
      base +
        getPathname({
          href: { pathname: '/karten/[slug]', params: { slug: p.slug_en ?? p.slug } },
          locale: 'en',
        }),
      base +
        getPathname({
          href: { pathname: '/karten/[slug]', params: { slug: p.slug } },
          locale: 'de',
        }),
    );
    entries.push({ url: u.en, lastModified: p.updated_at, alternates: { languages: u } });
  }
  return entries;
}

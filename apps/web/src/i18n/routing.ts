import { defineRouting } from 'next-intl/routing';

/**
 * German at the domain root, English under /en with translated paths.
 * No automatic redirect by browser language (localeDetection: false).
 */
export const routing = defineRouting({
  locales: ['de', 'en'],
  defaultLocale: 'de',
  localePrefix: 'as-needed',
  localeDetection: false,
  pathnames: {
    '/': '/',
    '/karten': { de: '/karten', en: '/cards' },
    '/karten/[slug]': { de: '/karten/[slug]', en: '/cards/[slug]' },
    '/sets': '/sets',
    '/sets/[set]': '/sets/[set]',
    '/zustand': { de: '/zustand', en: '/condition-guide' },
    '/versand': { de: '/versand-und-zahlung', en: '/shipping-and-payment' },
    '/impressum': { de: '/impressum', en: '/legal-notice' },
    '/datenschutz': { de: '/datenschutz', en: '/privacy' },
  },
});

export type Locale = (typeof routing.locales)[number];
export type AppPathname = keyof typeof routing.pathnames;

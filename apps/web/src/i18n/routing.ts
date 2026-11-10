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
    '/agb': { de: '/agb', en: '/terms' },
    '/widerrufsbelehrung': { de: '/widerrufsbelehrung', en: '/right-of-withdrawal' },
    '/vertrag-widerrufen': { de: '/vertrag-widerrufen', en: '/withdraw' },
    '/veranstaltungen': { de: '/veranstaltungen', en: '/events' },
    '/veranstaltungen/[slug]': { de: '/veranstaltungen/[slug]', en: '/events/[slug]' },
    '/warenkorb': { de: '/warenkorb', en: '/cart' },
    '/kasse': { de: '/kasse', en: '/checkout' },
    '/bestellung/[token]': { de: '/bestellung/[token]', en: '/order/[token]' },
    '/app': '/app',
    '/gutscheine': { de: '/gutscheine', en: '/gift-vouchers' },
    '/gutscheine/[token]': { de: '/gutscheine/[token]', en: '/gift-vouchers/[token]' },
    '/app/lizenzbedingungen': { de: '/app/lizenzbedingungen', en: '/app/license-terms' },
    '/app/lizenz/[token]': { de: '/app/lizenz/[token]', en: '/app/license/[token]' },
  },
});

export type Locale = (typeof routing.locales)[number];
export type AppPathname = keyof typeof routing.pathnames;

import { defineRouting } from 'next-intl/routing';

/**
 * English at the domain root, German under /de with translated paths (packages/core/src/
 * locale-paths.ts mirrors this for mails and legal texts). No automatic redirect by browser
 * language (localeDetection: false); the language switch in the header changes it.
 */
export const routing = defineRouting({
  locales: ['en', 'de'],
  defaultLocale: 'en',
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
    '/kontakt': { de: '/kontakt', en: '/contact' },
    '/veranstaltungen': { de: '/veranstaltungen', en: '/events' },
    '/veranstaltungen/[slug]': { de: '/veranstaltungen/[slug]', en: '/events/[slug]' },
    '/warenkorb': { de: '/warenkorb', en: '/cart' },
    '/kasse': { de: '/kasse', en: '/checkout' },
    '/bestellung/[token]': { de: '/bestellung/[token]', en: '/order/[token]' },
    '/app': '/app',
    '/gutscheine': { de: '/gutscheine', en: '/gift-vouchers' },
    '/gutscheine/[token]': { de: '/gutscheine/[token]', en: '/gift-vouchers/[token]' },
    '/app/lizenzbedingungen': { de: '/app/abo-bedingungen', en: '/app/subscription-terms' },
    '/app/lizenz/[token]': { de: '/app/lizenz/[token]', en: '/app/license/[token]' },
    '/anmelden': { de: '/anmelden', en: '/login' },
    '/anmelden/link': { de: '/anmelden/link', en: '/login/link' },
    '/konto': { de: '/konto', en: '/account' },
    '/konto/bestellungen': { de: '/konto/bestellungen', en: '/account/orders' },
    '/konto/adresse': { de: '/konto/adresse', en: '/account/address' },
    '/konto/einstellungen': { de: '/konto/einstellungen', en: '/account/settings' },
    '/konto/abo': { de: '/konto/abo', en: '/account/subscription' },
    '/konto/geraete': { de: '/konto/geraete', en: '/account/devices' },
    '/pair/[code]': '/pair/[code]',
    '/konto/sammlung': { de: '/konto/sammlung', en: '/account/collection' },
    '/konto/sammlung/[id]': { de: '/konto/sammlung/[id]', en: '/account/collection/[id]' },
    '/konto/karten': { de: '/konto/karten', en: '/account/cards' },
    '/konto/karten/[card]': { de: '/konto/karten/[card]', en: '/account/cards/[card]' },
    '/konto/teilen': { de: '/konto/teilen', en: '/account/sharing' },
    '/c/[token]': '/c/[token]',
  },
});

export type Locale = (typeof routing.locales)[number];
export type AppPathname = keyof typeof routing.pathnames;

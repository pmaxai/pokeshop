import { toShippingSettings, type CountryRow } from '@pokeshop/core/cart';
import { quoteShipping } from '@pokeshop/core/shipping';
import { getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';

type Href = Parameters<typeof getPathname>[0]['href'];

/**
 * Canonical and hreflang links of a page: its own language as canonical, both languages as
 * alternates, and English (the default at the root) as x-default.
 */
export function pageAlternates(href: Href, locale: Locale) {
  const en = getPathname({ href, locale: 'en' });
  const de = getPathname({ href, locale: 'de' });
  return langAlternates({ en, de }, locale);
}

/** The same from paths built by hand (cards have their own slug per language). */
export function langAlternates(paths: { en: string; de: string }, locale: Locale) {
  return {
    canonical: paths[locale],
    languages: { en: paths.en, de: paths.de, 'x-default': paths.en },
  };
}

// ---------------------------------------------------------------------------
// Structured data (schema.org JSON-LD) shared by the home and card pages.

/** "4–10 working days" → [4, 10]; null when the text has no range. */
const dayRange = (text: string | null): readonly [number, number] | null => {
  const m = text?.match(/(\d+)\s*[–-]\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

/**
 * Shipping of one card on its own to every delivery country: the same price and transit time
 * share one entry. Handling is up to three working days (AGB § 6).
 */
export function offerShipping(countries: CountryRow[], priceCents: number, highValue: boolean) {
  const groups = new Map<
    string,
    { rate: number; days: readonly [number, number] | null; codes: string[] }
  >();
  for (const c of countries) {
    const rate = quoteShipping({
      goodsSubtotal: priceCents,
      hasHighValue: highValue,
      country: toShippingSettings(c),
    }).price;
    const days = dayRange(c.delivery_time_en);
    const key = `${rate}|${days?.join('-') ?? ''}`;
    const g = groups.get(key) ?? { rate, days, codes: [] };
    g.codes.push(c.code);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({
    '@type': 'OfferShippingDetails',
    shippingRate: { '@type': 'MonetaryAmount', value: (g.rate / 100).toFixed(2), currency: 'EUR' },
    shippingDestination: g.codes.map((code) => ({
      '@type': 'DefinedRegion',
      addressCountry: code,
    })),
    ...(g.days && {
      deliveryTime: {
        '@type': 'ShippingDeliveryTime',
        handlingTime: { '@type': 'QuantitativeValue', minValue: 0, maxValue: 3, unitCode: 'DAY' },
        transitTime: {
          '@type': 'QuantitativeValue',
          minValue: g.days[0],
          maxValue: g.days[1],
          unitCode: 'DAY',
        },
      },
    }),
  }));
}

/** 14 days to withdraw and send the cards back by post, return postage paid by the buyer. */
export function returnPolicy(countries: string[]) {
  return {
    '@type': 'MerchantReturnPolicy',
    applicableCountry: countries,
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
    merchantReturnDays: 14,
    returnMethod: 'https://schema.org/ReturnByMail',
    returnFees: 'https://schema.org/ReturnFeesCustomerResponsibility',
  };
}

/** The site and the shop behind it, for the home page: name, search, contact, returns. */
export function siteJsonLd(input: {
  baseUrl: string;
  name: string;
  email: string;
  searchPath: string;
  countries: string[];
}) {
  const url = `${input.baseUrl}/`;
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: input.name,
      alternateName: new URL(input.baseUrl).host,
      url,
      inLanguage: ['en', 'de'],
      potentialAction: {
        '@type': 'SearchAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: `${input.baseUrl}${input.searchPath}?q={search_term_string}`,
        },
        'query-input': 'required name=search_term_string',
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'OnlineStore',
      name: input.name,
      url,
      logo: `${input.baseUrl}/icon.svg`,
      email: input.email,
      areaServed: input.countries,
      hasMerchantReturnPolicy: returnPolicy(input.countries),
    },
  ];
}

// The add-ons: price data sold beside a plan, monthly or yearly (docs/app-account-api.md › Plans
// and features). Each has a feature flag the app knows, so a new add-on needs an app that knows its
// flag; which plans may have it and its store products are set in the admin (store_products).
// No imports beyond zod: store.ts and addons.ts both use it.
import { z } from 'zod';

export const ADDONS = {
  psa_prices: {
    feature: 'psa_prices',
    name: { en: 'PSA prices', de: 'PSA-Preise' },
    /** what it is, for the admin and the mails */
    about: {
      en: 'what PSA 10, 9 and 8 copies sold for on eBay',
      de: 'wofür PSA 10, 9 und 8 auf eBay verkauft wurden',
    },
  },
} as const;
export type AddonId = keyof typeof ADDONS;
export const ADDON_IDS = Object.keys(ADDONS) as AddonId[];
export type AddonFeature = (typeof ADDONS)[AddonId]['feature'];

export const isAddonId = (v: unknown): v is AddonId =>
  typeof v === 'string' && Object.hasOwn(ADDONS, v);

const empty = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const appleId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/, 'invalid')
  .nullable();

const AddonConfig = z.object({
  /** off: left out of /store/offers; accounts that have it keep it */
  on_sale: z.boolean().default(true),
  /** the plans it can be added to (it counts only with one of them) */
  plans: z.array(z.enum(['collector', 'creator'])).default(['collector', 'creator']),
  /** App Store: its own subscription group, one product per period */
  apple: z
    .object({ monthly: z.preprocess(empty, appleId), yearly: z.preprocess(empty, appleId) })
    .default({ monthly: null, yearly: null }),
});
export type AddonConfig = z.infer<typeof AddonConfig>;

const DEFAULT_ADDON: AddonConfig = {
  on_sale: true,
  plans: ['collector', 'creator'],
  apple: { monthly: null, yearly: null },
};

export const AddonsConfig = z
  .object({ psa_prices: AddonConfig.default(DEFAULT_ADDON) })
  .default({ psa_prices: DEFAULT_ADDON });
export type AddonsConfig = z.infer<typeof AddonsConfig>;
export const EMPTY_ADDONS: AddonsConfig = { psa_prices: DEFAULT_ADDON };

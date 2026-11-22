/**
 * The Overpriced Cardboard app as the shop presents it: its name, where to get it (Google Play,
 * the App Store) and Antalyse GmbH, which sells its subscriptions (Stripe account of its own,
 * subscription terms, legal notice). Installing and buying happen in the stores; the shop sells
 * the same plans on the website (subscriptions.ts).
 */
import { z } from 'zod';
import type { Db, Sql } from './db.ts';

export const APP_NAME = 'Overpriced Cardboard';

// ---------------------------------------------------------------------------
// The seller
// ---------------------------------------------------------------------------

/** Antalyse GmbH, seller of the app subscriptions (setting license_seller, a name kept from the licences). */
export type GmbhSeller = {
  name: string;
  street: string;
  postcode: string;
  city: string;
  country: string;
  email: string;
  register_number: string;
  register_court: string;
  vat_id: string;
  managing_director: string;
  chamber?: string;
  supervisory_authority?: string;
};

export async function gmbhSeller(db: Db): Promise<GmbhSeller> {
  const [r] = await db<{ value: Partial<GmbhSeller> }[]>`
    SELECT value FROM settings WHERE key = 'license_seller'`;
  const v = r?.value ?? {};
  return {
    name: v.name ?? 'Antalyse GmbH',
    street: v.street ?? '',
    postcode: v.postcode ?? '',
    city: v.city ?? '',
    country: v.country ?? 'AT',
    email: v.email ?? '',
    register_number: v.register_number ?? '',
    register_court: v.register_court ?? '',
    vat_id: v.vat_id ?? '',
    managing_director: v.managing_director ?? '',
    chamber: v.chamber,
    supervisory_authority: v.supervisory_authority,
  };
}

// ---------------------------------------------------------------------------
// Where to get the app
// ---------------------------------------------------------------------------

export type AppStores = {
  /** the app's Google Play page */
  play: string | null;
  /** the app's App Store page; null until the iPhone app is out */
  apple: string | null;
};

const PLAY_URL = /^https:\/\/play\.google\.com\/store\/apps\/details\?id=[\w.]+/;
const APPLE_URL = /^https:\/\/apps\.apple\.com\/[\w/.-]*id\d+/;

export async function appStores(db: Db): Promise<AppStores> {
  const rows = await db<{ key: string; value: unknown }[]>`
    SELECT key, value FROM settings WHERE key IN ('app_play_store_url', 'app_app_store_url')`;
  const get = (key: string, re: RegExp) => {
    const v = rows.find((r) => r.key === key)?.value;
    return typeof v === 'string' && re.test(v) ? v : null;
  };
  return { play: get('app_play_store_url', PLAY_URL), apple: get('app_app_store_url', APPLE_URL) };
}

/** A Play link that hands an influencer's code to the app (install referrer `aff=CODE`). */
export function playWithReferrer(play: string, affiliateCode: string): string {
  return `${play}${play.includes('?') ? '&' : '?'}referrer=${encodeURIComponent(`aff=${affiliateCode}`)}`;
}

const storeUrl = (re: RegExp, problem: string) =>
  z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === '' || re.test(v), { message: problem });

/** Admin › App. */
export const AppSettings = z.object({
  /** The GmbH's address for its e-mails (sender and replies). */
  senderEmail: z.email('invalid_email').trim().toLowerCase().max(200).optional(),
  playStoreUrl: storeUrl(PLAY_URL, 'play_store_url'),
  appStoreUrl: storeUrl(APPLE_URL, 'app_store_url'),
});

export async function saveAppSettings(sql: Sql, input: z.input<typeof AppSettings>): Promise<void> {
  const v = AppSettings.parse(input);
  await sql.begin(async (tx) => {
    for (const [key, value] of [
      ['app_play_store_url', v.playStoreUrl || null],
      ['app_app_store_url', v.appStoreUrl || null],
    ] as const) {
      const json = value === null ? tx`'null'::jsonb` : tx`${tx.json(value)}`;
      await tx`INSERT INTO settings (key, value) VALUES (${key}, ${json})
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    }
    if (v.senderEmail) {
      await tx`UPDATE settings SET value = jsonb_set(value, '{email}', ${tx.json(v.senderEmail)})
                WHERE key = 'license_seller'`;
    }
  });
}

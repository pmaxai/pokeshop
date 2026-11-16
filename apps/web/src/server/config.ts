import 'server-only';
import { parseMasterKey } from '@pokeshop/core/secrets';
import { getSql } from '@pokeshop/core/db';
import { httpTcgdexClient, type TcgdexClient } from '@pokeshop/core/tcgdex';
import { remoteKeys, type KeyLookup } from '@pokeshop/core/jwt';
import { GOOGLE_KEYS_URL } from '@pokeshop/core/app-signin';

/** Server-side configuration from the environment, read lazily so `next build` works without it. */
export const config = {
  get baseUrl(): string {
    return (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  },
  get mediaDir(): string {
    return process.env.MEDIA_DIR ?? './.media';
  },
  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  },
  /** OAuth client ids a Google ID token from the app may be issued for (comma-separated). */
  get googleClientIds(): string[] {
    return (process.env.GOOGLE_OAUTH_CLIENT_IDS ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  },
  /**
   * Staging only: test sign-ins, test codes and test purchases (docs/app-account-api.md,
   * "Testing"). Never on the live shop, whatever the variable says.
   */
  get storeTestHooks(): boolean {
    return (
      process.env.STORE_TEST_HOOKS === '1' &&
      !/^https:\/\/(www\.)?overpricedcardboard\.com$/.test(this.baseUrl)
    );
  },
  /** The account for Google's and Apple's reviewers: a fixed code, valid only for it. */
  get review(): { email: string; code: string } | null {
    const code = process.env.REVIEW_LOGIN_CODE?.trim() ?? '';
    if (code.length < 6) return null;
    return {
      email: (process.env.REVIEW_EMAIL ?? 'review@overpricedcardboard.com').trim().toLowerCase(),
      code,
    };
  },
};

let googleKeys: KeyLookup | undefined;
/** Google's public keys for ID tokens and Pub/Sub push tokens. */
export function googleSigningKeys(): KeyLookup {
  googleKeys ??= remoteKeys(GOOGLE_KEYS_URL);
  return googleKeys;
}

let masterKey: Buffer | undefined;
export function apiMasterKey(): Buffer {
  masterKey ??= parseMasterKey(process.env.API_KEY_MASTER_KEY);
  return masterKey;
}

let tcgdex: TcgdexClient | undefined;
export function tcgdexClient(): TcgdexClient {
  tcgdex ??= httpTcgdexClient();
  return tcgdex;
}

export const db = getSql;

/** App licences can be sold only when the shop can reach the licence service. */
export function licenseServiceConfigured(): boolean {
  return Boolean(process.env.LICENSE_SERVICE_URL?.trim() && process.env.LICENSE_SHOP_TOKEN?.trim());
}

/**
 * Licences are on sale when the licence service is reachable and the GmbH's Stripe account
 * is set up (STRIPE_LICENSE_SECRET_KEY; the stand-in on localhost).
 */
export function licenseSalesConfigured(): boolean {
  if (!licenseServiceConfigured()) return false;
  if (process.env.STRIPE_LICENSE_SECRET_KEY?.trim()) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(config.baseUrl);
}

/** Admin settings with sensible defaults. */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const [row] = await db()<{ value: T }[]>`SELECT value FROM settings WHERE key = ${key}`;
  return row?.value ?? fallback;
}

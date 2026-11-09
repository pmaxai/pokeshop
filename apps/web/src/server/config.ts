import 'server-only';
import { parseMasterKey } from '@pokeshop/core/secrets';
import { getSql } from '@pokeshop/core/db';
import { httpTcgdexClient, type TcgdexClient } from '@pokeshop/core/tcgdex';

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
};

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

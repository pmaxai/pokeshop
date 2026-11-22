import 'server-only';
import { parseMasterKey } from '@pokeshop/core/secrets';
import { getSql } from '@pokeshop/core/db';
import { httpTcgdexClient, type TcgdexClient } from '@pokeshop/core/tcgdex';
import { remoteKeys, type KeyLookup } from '@pokeshop/core/jwt';
import { GOOGLE_KEYS_URL } from '@pokeshop/core/app-signin';
import {
  googlePlayClient,
  googlePlayPackage,
  parseServiceAccount,
  type GooglePlay,
} from '@pokeshop/core/store';
import {
  APPLE_KEYS_URL,
  appleBundleId,
  appleSignInKeyFromEnv,
  appStoreClient,
  appStoreKeyFromEnv,
  type AppleSignInKey,
  type AppStore,
} from '@pokeshop/core/apple';

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
  /** The iPhone app's bundle id: the audience of Sign in with Apple, the App Store's app. */
  get appleBundleId(): string {
    return appleBundleId(process.env);
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

let appleKeys: KeyLookup | undefined;
/** Apple's public keys for Sign in with Apple identity tokens. */
export function appleSigningKeys(): KeyLookup {
  appleKeys ??= remoteKeys(APPLE_KEYS_URL);
  return appleKeys;
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

/** Admin settings with sensible defaults. */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const [row] = await db()<{ value: T }[]>`SELECT value FROM settings WHERE key = ${key}`;
  return row?.value ?? fallback;
}

let play: GooglePlay | null | undefined;
/**
 * The Google Play Developer API with the company's service account (GOOGLE_PLAY_SERVICE_ACCOUNT),
 * or null while it isn't set up.
 */
export function googlePlay(): GooglePlay | null {
  if (play === undefined) {
    const account = parseServiceAccount(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT);
    play = account ? googlePlayClient({ packageName: googlePlayPackage(), account }) : null;
  }
  return play;
}

/** Who may push Google's notifications: the audience and (optionally) the push account. */
export function pubSubAuth(): { audience: string; email: string | null } {
  return {
    audience:
      process.env.GOOGLE_PUBSUB_AUDIENCE?.trim() ||
      `${config.baseUrl}/api/store/google/notifications`,
    email: process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT?.trim().toLowerCase() || null,
  };
}

let appStoreApi: AppStore | null | undefined;
/**
 * The App Store Server API with the in-app purchase key (APPLE_IAP_*), or null while it isn't set
 * up. Also checks what Apple signs (transactions, notifications).
 */
export function appStore(): AppStore | null {
  if (appStoreApi === undefined) {
    const key = appStoreKeyFromEnv(process.env);
    appStoreApi = key ? appStoreClient(key) : null;
  }
  return appStoreApi;
}

let signInKey: AppleSignInKey | null | undefined;
/** The Sign in with Apple key (APPLE_TEAM_ID, APPLE_SIGNIN_*), or null while it isn't set up. */
export function appleSignInKey(): AppleSignInKey | null {
  if (signInKey === undefined) signInKey = appleSignInKeyFromEnv(process.env);
  return signInKey;
}

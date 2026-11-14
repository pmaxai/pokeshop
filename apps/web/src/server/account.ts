import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  createAccountSession,
  endAccountSession,
  SESSION_DAYS,
  sessionAccount,
  type Account,
} from '@pokeshop/core/accounts';
import { getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { config, db } from './config';

export const ACCOUNT_COOKIE = 'oc_account';
/** Carries the address to the "check your inbox" view, so it is not in the URL. */
export const LOGIN_SENT_COOKIE = 'oc_login_sent';
/** The pairing code just made in the portal ("code.expiresMs"), for the devices page. */
export const PAIR_COOKIE = 'oc_pair';

/** The logged-in customer of this request (one lookup per request). */
export const currentAccount = cache(async (): Promise<Account | null> => {
  const token = (await cookies()).get(ACCOUNT_COOKIE)?.value;
  return sessionAccount(db(), token);
});

export function loginPath(locale: Locale, next?: string): string {
  const path = getPathname({ href: '/anmelden', locale });
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}

/** For account pages: the customer, or a redirect to the login page that comes back here. */
export async function requireAccount(locale: Locale, here: string): Promise<Account> {
  const a = await currentAccount();
  if (!a) redirect(loginPath(locale, here));
  return a;
}

/** Logs the customer in. No IP address or browser details are stored with the session. */
export async function startAccountSession(accountId: number): Promise<void> {
  const token = await createAccountSession(db(), accountId);
  (await cookies()).set(ACCOUNT_COOKIE, token, {
    httpOnly: true,
    secure: config.baseUrl.startsWith('https://'),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}

export async function endCurrentSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(ACCOUNT_COOKIE)?.value;
  if (token) await endAccountSession(db(), token);
  jar.delete({ name: ACCOUNT_COOKIE, path: '/' });
}

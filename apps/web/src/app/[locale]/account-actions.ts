'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  deleteAccount,
  LoginRequest,
  requestLoginLink,
  safeNextPath,
  saveProfile,
  saveShippingAddress,
  redeemLoginLink,
} from '@pokeshop/core/accounts';
import { getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { config, db } from '@/server/config';
import {
  currentAccount,
  endCurrentSession,
  LOGIN_SENT_COOKIE,
  loginPath,
  startAccountSession,
} from '@/server/account';
import { clientIp, rateLimited } from '@/server/rate-limit';

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
const localeOf = (f: FormData): Locale => (str(f, 'locale') === 'de' ? 'de' : 'en');
const pack = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export async function loginRequestAction(form: FormData) {
  const locale = localeOf(form);
  const next = safeNextPath(str(form, 'next'));
  const back = (q: Record<string, string>) => {
    const s = new URLSearchParams({ ...(next ? { next } : {}), ...q });
    redirect(`${getPathname({ href: '/anmelden', locale })}?${s}`);
  };
  const jar = await cookies();
  const sent = (email: string) => {
    jar.set(LOGIN_SENT_COOKIE, email, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.baseUrl.startsWith('https://'),
      path: '/',
      maxAge: 30 * 60,
    });
    back({ sent: '1' });
  };
  const v = LoginRequest.safeParse({ email: str(form, 'email') });
  // Honeypot: people never see this field; pretend it worked.
  if (str(form, 'website')) sent(v.success ? v.data.email : '');
  if (!v.success) {
    const code = v.error.issues[0]?.message ?? 'invalid_email';
    back({
      e: code === 'too_long' ? 'too_long' : 'invalid_email',
      email: str(form, 'email').slice(0, 200),
    });
    return;
  }
  const ip = clientIp(await headers());
  if (rateLimited(`login:${ip}`, 10, 15 * 60_000)) back({ e: 'too_many' });
  // 'throttled' (too many links for the address) answers the same as 'sent'.
  await requestLoginLink(db(), {
    email: v.data.email,
    locale,
    next,
    baseUrl: config.baseUrl,
  });
  sent(v.data.email);
}

export async function loginConfirmAction(form: FormData) {
  const locale = localeOf(form);
  const token = str(form, 't');
  const r = await redeemLoginLink(db(), token);
  if (!r.ok) {
    redirect(
      `${getPathname({ href: '/anmelden/link', locale })}?t=${encodeURIComponent(token)}&e=${r.problem}`,
    );
  }
  await startAccountSession(r.account.id);
  (await cookies()).delete({ name: LOGIN_SENT_COOKIE, path: '/' });
  // The account's language from now on is the one it was opened in, unless chosen otherwise.
  redirect(r.next ?? getPathname({ href: '/konto', locale }));
}

export async function logoutAction(form: FormData) {
  const locale = localeOf(form);
  await endCurrentSession();
  redirect(getPathname({ href: '/', locale }));
}

async function signedIn(locale: Locale, here: string) {
  const a = await currentAccount();
  if (!a) redirect(loginPath(locale, here));
  return a;
}

export async function saveAddressAction(form: FormData) {
  const locale = localeOf(form);
  const here = getPathname({ href: '/konto/adresse', locale });
  const account = await signedIn(locale, here);
  if (str(form, 'remove') === '1') {
    await saveShippingAddress(db(), account.id, null);
    redirect(`${here}?removed=1`);
  }
  const values = {
    name: str(form, 'name'),
    company: str(form, 'company'),
    street: str(form, 'street'),
    postcode: str(form, 'postcode'),
    city: str(form, 'city'),
    country: str(form, 'country'),
  };
  const phone = str(form, 'phone');
  const r = await saveShippingAddress(db(), account.id, values);
  if (!r.ok) redirect(`${here}?e=${pack({ errors: r.errors, values: { ...values, phone } })}`);
  const p = await saveProfile(db(), account.id, {
    name: account.name ?? values.name,
    phone,
    locale: account.locale,
  });
  if (!p.ok) redirect(`${here}?e=${pack({ errors: p.errors, values: { ...values, phone } })}`);
  const next = safeNextPath(str(form, 'next'));
  redirect(next ?? `${here}?saved=1`);
}

export async function saveSettingsAction(form: FormData) {
  const locale = localeOf(form);
  const here = getPathname({ href: '/konto/einstellungen', locale });
  const account = await signedIn(locale, here);
  const values = {
    name: str(form, 'name'),
    phone: account.phone ?? '',
    locale: str(form, 'language'),
  };
  const r = await saveProfile(db(), account.id, values);
  if (!r.ok) redirect(`${here}?e=${pack({ errors: r.errors, values })}`);
  // Show the page in the language just chosen.
  const lang: Locale = values.locale === 'de' ? 'de' : 'en';
  redirect(`${getPathname({ href: '/konto/einstellungen', locale: lang })}?saved=1`);
}

export async function deleteAccountAction(form: FormData) {
  const locale = localeOf(form);
  const here = getPathname({ href: '/konto/einstellungen', locale });
  const account = await signedIn(locale, here);
  if (str(form, 'confirm') !== 'on')
    redirect(`${here}?e=${pack({ errors: { confirm: 'confirm' } })}#delete`);
  await deleteAccount(db(), account.id);
  await endCurrentSession();
  redirect(`${getPathname({ href: '/', locale })}?account_deleted=1`);
}

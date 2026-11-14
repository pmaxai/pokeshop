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
import {
  changeSubscription,
  ChangeRejected,
  checkSubscriber,
  entitlements,
  MAX_EXTRA_DEVICES,
  setCancelAtPeriodEnd,
  startSubscription,
  SubscribeRejected,
  subscriptionOf,
  validateSubscribe,
} from '@pokeshop/core/subscriptions';
import { createPairingCode, endDevice, PAIRING_MINUTES } from '@pokeshop/core/devices';
import { getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { config, db } from '@/server/config';
import {
  currentAccount,
  endCurrentSession,
  LOGIN_SENT_COOKIE,
  loginPath,
  PAIR_COOKIE,
  startAccountSession,
} from '@/server/account';
import { billing } from '@/server/billing';
import { viesCheck } from '@/server/payments';
import { clientIp, rateLimited } from '@/server/rate-limit';

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
const localeOf = (f: FormData): Locale => (str(f, 'locale') === 'de' ? 'de' : 'en');
const pack = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** next/navigation's redirect() throws; let it through a catch. */
const isRedirect = (e: unknown) =>
  typeof (e as { digest?: unknown })?.digest === 'string' &&
  (e as { digest: string }).digest.startsWith('NEXT_REDIRECT');

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
  // A paid subscription is cancelled first; it ends with its month.
  const sub = await subscriptionOf(db(), account.id);
  if (sub?.source === 'stripe' && entitlements(sub, account).active) {
    redirect(`${here}?e=${pack({ errors: { confirm: 'subscription' } })}#delete`);
  }
  await deleteAccount(db(), account.id);
  await endCurrentSession();
  redirect(`${getPathname({ href: '/', locale })}?account_deleted=1`);
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

const subscriptionPath = (locale: Locale) => getPathname({ href: '/konto/abo', locale });
const devicesPath = (locale: Locale) => getPathname({ href: '/konto/geraete', locale });

/** Carries what was typed back to the subscription form, so nothing is lost. */
export async function subscribeAction(form: FormData) {
  const locale = localeOf(form);
  const here = subscriptionPath(locale);
  const account = await signedIn(locale, here);
  const values = {
    plan: str(form, 'plan'),
    extraDevices: str(form, 'extraDevices') || '0',
    buyer: str(form, 'buyer') === 'business' ? 'business' : 'consumer',
    name: str(form, 'name'),
    company: str(form, 'company'),
    vatId: str(form, 'vatId'),
    street: str(form, 'street'),
    postcode: str(form, 'postcode'),
    city: str(form, 'city'),
    country: str(form, 'country'),
  };
  const fail = (errors: Record<string, string>): never =>
    redirect(`${here}?e=${pack({ errors, values })}#abo`);
  const v = validateSubscribe({
    ...values,
    acceptTerms: str(form, 'accept_terms') === 'on',
    immediateStart: str(form, 'immediate_start') === 'on',
  });
  if (!v.ok) fail(v.errors);
  const data = (v as { ok: true; data: Parameters<typeof checkSubscriber>[0] }).data;
  const b = billing();
  if (!b) fail({ _: 'payment_unavailable' });
  const tax = await checkSubscriber(data, viesCheck());
  if (!tax.ok) fail(tax.errors);
  let url: string;
  try {
    url = await startSubscription(db(), b!, {
      account,
      form: data,
      tax: tax as Extract<typeof tax, { ok: true }>,
      locale,
      successUrl: `${config.baseUrl}${here}?welcome=1&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${config.baseUrl}${here}?cancelled=1`,
    });
  } catch (e) {
    if (isRedirect(e)) throw e;
    if (e instanceof SubscribeRejected) redirect(here);
    const code = (e as { code?: string }).code ?? (e as Error).message;
    if (code === 'tax_id_invalid') fail({ vatId: 'vat_id_invalid' });
    if (code === 'customer_tax_location_invalid') fail({ postcode: 'invalid_address' });
    console.error('[subscribe]', (e as Error).message);
    fail({ _: 'payment_unavailable' });
  }
  redirect(url!);
}

export async function changeSubscriptionAction(form: FormData) {
  const locale = localeOf(form);
  const here = subscriptionPath(locale);
  const account = await signedIn(locale, here);
  const b = billing();
  const plan = str(form, 'plan') === 'creator' ? 'creator' : 'collector';
  const extra = Number(str(form, 'extraDevices'));
  if (!b || !Number.isInteger(extra) || extra < 0 || extra > MAX_EXTRA_DEVICES) {
    redirect(`${here}?change=invalid#change`);
  }
  try {
    await changeSubscription(db(), b!, account, { plan, extraDevices: extra });
  } catch (e) {
    if (isRedirect(e)) throw e;
    if (e instanceof ChangeRejected) {
      redirect(`${here}?change=${e.reason}${e.inUse ? `&in_use=${e.inUse}` : ''}#change`);
    }
    console.error('[subscription change]', (e as Error).message);
    redirect(`${here}?change=failed#change`);
  }
  redirect(`${here}?change=done#change`);
}

export async function cancelSubscriptionAction(form: FormData) {
  const locale = localeOf(form);
  const here = subscriptionPath(locale);
  const account = await signedIn(locale, here);
  const b = billing();
  if (!b) redirect(here);
  const cancel = str(form, 'resume') !== '1';
  try {
    await setCancelAtPeriodEnd(db(), b!, account, cancel);
  } catch (e) {
    if (isRedirect(e)) throw e;
    console.error('[subscription cancel]', (e as Error).message);
    redirect(`${here}?change=failed`);
  }
  redirect(`${here}?${cancel ? 'cancelled_sub=1' : 'resumed=1'}`);
}

/** Stripe's customer portal: payment method and invoices. */
export async function billingPortalAction(form: FormData) {
  const locale = localeOf(form);
  const here = subscriptionPath(locale);
  await signedIn(locale, here);
  const account = await currentAccount();
  const [row] = await db()<{ stripe_customer_id: string | null }[]>`
    SELECT stripe_customer_id FROM accounts WHERE id = ${account!.id}`;
  const b = billing();
  if (!b || !row?.stripe_customer_id) redirect(here);
  redirect(await b!.portalUrl(row!.stripe_customer_id!, `${config.baseUrl}${here}`, locale));
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/** The pairing code travels to the devices page in a short cookie, not in the URL. */
export async function connectDeviceAction(form: FormData) {
  const locale = localeOf(form);
  const here = devicesPath(locale);
  const account = await signedIn(locale, here);
  const r = await createPairingCode(db(), account);
  if (!r.ok) redirect(`${here}?e=${r.problem}`);
  (await cookies()).set(PAIR_COOKIE, `${r.code}.${r.expiresAt.getTime()}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.baseUrl.startsWith('https://'),
    path: '/',
    maxAge: PAIRING_MINUTES * 60,
  });
  redirect(`${here}?connect=1#connect`);
}

export async function removeDeviceAction(form: FormData) {
  const locale = localeOf(form);
  const here = devicesPath(locale);
  const account = await signedIn(locale, here);
  await endDevice(db(), account.id, str(form, 'device'), 'removed');
  redirect(`${here}?removed=1`);
}

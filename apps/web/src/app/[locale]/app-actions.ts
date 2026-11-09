'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  appSales,
  createLicenseOrder,
  LicenseCheckoutRejected,
  requestLicenseResend,
  validateLicenseCheckout,
} from '@pokeshop/core/licenses';
import { startPayment } from '@pokeshop/core/orders';
import { getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { APP_FORM_FLASH } from '@/server/app-form';
import { config, db, getSetting, licenseServiceConfigured } from '@/server/config';
import { payments } from '@/server/payments';

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
const localeOf = (f: FormData): Locale => (str(f, 'locale') === 'en' ? 'en' : 'de');

async function back(
  locale: Locale,
  values: Record<string, string>,
  errors: Record<string, string>,
): Promise<never> {
  const path = getPathname({ href: '/app', locale });
  (await cookies()).set(
    APP_FORM_FLASH,
    Buffer.from(JSON.stringify({ values, errors })).toString('base64url'),
    {
      httpOnly: true,
      sameSite: 'lax',
      path,
      maxAge: 120,
      secure: config.baseUrl.startsWith('https://'),
    },
  );
  redirect(`${path}?e=1#kaufen`);
}

export async function buyLicenseAction(form: FormData) {
  const locale = localeOf(form);
  const values = {
    name: str(form, 'name'),
    company: str(form, 'company'),
    email: str(form, 'email'),
    street: str(form, 'street'),
    postcode: str(form, 'postcode'),
    city: str(form, 'city'),
    country: str(form, 'country'),
    quantity: str(form, 'quantity') || '1',
  };
  const v = validateLicenseCheckout({
    ...values,
    acceptTerms: str(form, 'accept_terms') === 'on',
    immediateDelivery: str(form, 'immediate_delivery') === 'on',
  });
  if (!v.ok) return back(locale, values, v.errors);

  const sales = await appSales(db(), licenseServiceConfigured());
  const provider = payments();
  if (!sales.open || !provider) return back(locale, values, { _: 'payment_unavailable' });

  let url: string;
  try {
    const order = await createLicenseOrder(db(), {
      locale,
      details: v.data,
      priceCents: sales.priceCents,
      ossEnabled: await getSetting<boolean>('oss_enabled', false),
      smallBusiness: await getSetting<boolean>('small_business', false),
    });
    const thanks = getPathname({
      href: { pathname: '/app/lizenz/[token]', params: { token: order.token } },
      locale,
    });
    url = await startPayment(db(), provider, order, {
      email: v.data.email,
      locale,
      successUrl: `${config.baseUrl}${thanks}?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${config.baseUrl}/api/checkout/cancel?o=${order.token}&l=${locale}&app=1`,
    });
  } catch (e) {
    if (e instanceof LicenseCheckoutRejected) return back(locale, values, { country: 'country' });
    console.error('[app checkout]', (e as Error).message);
    return back(locale, values, { _: 'payment_unavailable' });
  }
  (await cookies()).delete({ name: APP_FORM_FLASH, path: getPathname({ href: '/app', locale }) });
  redirect(url);
}

export async function resendLicenseAction(form: FormData) {
  const locale = localeOf(form);
  await requestLicenseResend(db(), str(form, 'email'), locale);
  // The same answer whether or not the address has a licence.
  redirect(`${getPathname({ href: '/app', locale })}?sent=1#verloren`);
}

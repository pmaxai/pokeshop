'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  appSales,
  checkLicenseBuyer,
  createLicenseOrder,
  LicenseCheckoutRejected,
  requestLicenseResend,
  startLicensePayment,
  validateLicenseCheckout,
} from '@pokeshop/core/licenses';
import { CustomerRejected } from '@pokeshop/core/payments';
import { getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { APP_FORM_FLASH } from '@/server/app-form';
import { config, db, licenseSalesConfigured } from '@/server/config';
import { payments, viesCheck } from '@/server/payments';

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
    buyer: str(form, 'buyer') === 'business' ? 'business' : 'consumer',
    name: str(form, 'name'),
    company: str(form, 'company'),
    vatId: str(form, 'vatId'),
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

  // Licences are sold by Antalyse GmbH and paid to its own Stripe account.
  const sales = await appSales(db(), licenseSalesConfigured());
  const provider = payments('gmbh');
  if (!sales.open || !provider) return back(locale, values, { _: 'payment_unavailable' });

  const checked = await checkLicenseBuyer(db(), v.data, {
    grossCents: sales.priceCents,
    vies: viesCheck(),
  });
  if (!checked.ok) return back(locale, values, checked.errors);

  let url: string;
  try {
    const order = await createLicenseOrder(db(), {
      locale,
      details: v.data,
      buyer: checked.buyer,
    });
    const thanks = getPathname({
      href: { pathname: '/app/lizenz/[token]', params: { token: order.token } },
      locale,
    });
    url = await startLicensePayment(db(), provider, order, {
      details: v.data,
      buyer: checked.buyer,
      locale,
      successUrl: `${config.baseUrl}${thanks}?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${config.baseUrl}/api/checkout/cancel?o=${order.token}&l=${locale}&app=1`,
    });
  } catch (e) {
    if (e instanceof LicenseCheckoutRejected) return back(locale, values, { country: 'country' });
    if (e instanceof CustomerRejected) {
      return back(
        locale,
        values,
        e.field === 'tax_id' ? { vatId: 'invalid_tax_id' } : { postcode: 'invalid_address' },
      );
    }
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

'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createGiftVoucherOrder, validateGiftVoucher } from '@pokeshop/core/gift-vouchers';
import { startPayment } from '@pokeshop/core/orders';
import { getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { VOUCHER_FORM_FLASH } from '@/server/app-form';
import { config, db } from '@/server/config';
import { payments } from '@/server/payments';

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

async function back(
  locale: Locale,
  values: Record<string, string>,
  errors: Record<string, string>,
): Promise<never> {
  const path = getPathname({ href: '/gutscheine', locale });
  (await cookies()).set(
    VOUCHER_FORM_FLASH,
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

/** "Zahlungspflichtig bestellen" for a gift voucher: the shop's Stripe, then the PDF by e-mail. */
export async function buyVoucherAction(form: FormData) {
  const locale: Locale = str(form, 'locale') === 'en' ? 'en' : 'de';
  const values = {
    amount: str(form, 'amount'),
    recipientName: str(form, 'recipientName'),
    message: str(form, 'message'),
    name: str(form, 'name'),
    email: str(form, 'email'),
  };
  const v = validateGiftVoucher({
    amountCents: values.amount,
    recipientName: values.recipientName,
    message: values.message,
    name: values.name,
    email: values.email,
    acceptTerms: str(form, 'accept_terms') === 'on',
  });
  if (!v.ok) return back(locale, values, v.errors);
  const provider = payments('shop');
  if (!provider) return back(locale, values, { _: 'payment_unavailable' });
  let url: string;
  try {
    const order = await createGiftVoucherOrder(db(), { locale, details: v.data });
    const thanks = getPathname({
      href: { pathname: '/gutscheine/[token]', params: { token: order.token } },
      locale,
    });
    url = await startPayment(db(), provider, order, {
      email: v.data.email,
      locale,
      successUrl: `${config.baseUrl}${thanks}?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${config.baseUrl}/api/checkout/cancel?o=${order.token}&l=${locale}&voucher=1`,
    });
  } catch (e) {
    console.error('[voucher checkout]', (e as Error).message);
    return back(locale, values, { _: 'payment_unavailable' });
  }
  (await cookies()).delete({
    name: VOUCHER_FORM_FLASH,
    path: getPathname({ href: '/gutscheine', locale }),
  });
  redirect(url);
}

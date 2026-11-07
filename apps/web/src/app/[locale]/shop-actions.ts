'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { addToCart, saveCheckoutDraft, setCartCountry, setCartQuantity } from '@pokeshop/core/cart';
import {
  CheckoutRejected,
  createCheckoutOrder,
  startPayment,
  validateCheckout,
} from '@pokeshop/core/orders';
import { recordWithdrawal, validateWithdrawal } from '@pokeshop/core/withdrawals';
import { getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { config, db, getSetting } from '@/server/config';
import { ensureCartId } from '@/server/cart';
import { payments } from '@/server/payments';

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
const localeOf = (f: FormData): Locale => (str(f, 'locale') === 'en' ? 'en' : 'de');
const cartPath = (locale: Locale) => getPathname({ href: '/warenkorb', locale });
const checkoutPath = (locale: Locale) => getPathname({ href: '/kasse', locale });

/** Encodes a small object for the query string (error codes after a redirect). */
const pack = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export async function addToCartAction(form: FormData) {
  const locale = localeOf(form);
  const cart = await ensureCartId(locale);
  const r = await addToCart(
    db(),
    cart,
    Number(str(form, 'product_id')),
    Number(str(form, 'quantity') || 1),
  );
  const flag = r.unavailable ? 'unavailable=1' : `added=1${r.limited ? '&limited=1' : ''}`;
  revalidatePath('/', 'layout');
  redirect(`${cartPath(locale)}?${flag}`);
}

export async function updateCartAction(form: FormData) {
  const locale = localeOf(form);
  const cart = await ensureCartId(locale);
  const remove = str(form, 'remove');
  if (remove) {
    await setCartQuantity(db(), cart, Number(remove), 0);
  } else {
    for (const [k, v] of form.entries()) {
      const m = /^qty_(\d+)$/.exec(k);
      if (m && typeof v === 'string') await setCartQuantity(db(), cart, Number(m[1]), Number(v));
    }
  }
  const country = str(form, 'country');
  if (country) await setCartCountry(db(), cart, country);
  revalidatePath('/', 'layout');
  redirect(cartPath(locale));
}

function address(form: FormData, prefix: string) {
  return {
    name: str(form, `${prefix}.name`),
    company: str(form, `${prefix}.company`),
    street: str(form, `${prefix}.street`),
    postcode: str(form, `${prefix}.postcode`),
    city: str(form, `${prefix}.city`),
    country: str(form, `${prefix}.country`),
  };
}

export async function checkoutAction(form: FormData) {
  const locale = localeOf(form);
  const cart = await ensureCartId(locale);
  const billingDiffers = str(form, 'billing_differs') === 'on';
  const input = {
    email: str(form, 'email'),
    phone: str(form, 'phone'),
    shipping: address(form, 'shipping'),
    billing: billingDiffers ? address(form, 'billing') : undefined,
    acceptTerms: str(form, 'accept_terms') === 'on',
  };
  // Keep what was typed, so nothing is lost when a field needs fixing.
  await saveCheckoutDraft(db(), cart, { ...input, acceptTerms: undefined, billingDiffers });
  const v = validateCheckout(input);
  if (!v.ok) redirect(`${checkoutPath(locale)}?e=${pack(v.errors)}`);

  const provider = payments();
  if (!provider) redirect(`${checkoutPath(locale)}?e=${pack({ _: 'payment_unavailable' })}`);

  let url: string;
  try {
    const order = await createCheckoutOrder(db(), {
      cartId: cart,
      locale,
      details: v.data,
      reservationMinutes: await getSetting<number>('reservation_minutes', 10),
      ossEnabled: await getSetting<boolean>('oss_enabled', false),
      smallBusiness: await getSetting<boolean>('small_business', false),
    });
    const orderPath = getPathname({
      href: { pathname: '/bestellung/[token]', params: { token: order.token } },
      locale,
    });
    url = await startPayment(db(), provider, order, {
      email: v.data.email,
      locale,
      successUrl: `${config.baseUrl}${orderPath}?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${config.baseUrl}/api/checkout/cancel?o=${order.token}&l=${locale}`,
    });
  } catch (e) {
    if (e instanceof CheckoutRejected) redirect(cartPath(locale));
    console.error('[checkout]', (e as Error).message);
    redirect(`${checkoutPath(locale)}?e=${pack({ _: 'payment_unavailable' })}`);
  }
  redirect(url);
}

const WITHDRAW_FLASH = 'pk_withdraw';

export async function withdrawAction(form: FormData) {
  const locale = localeOf(form);
  const values = {
    name: str(form, 'name'),
    email: str(form, 'email'),
    order_number: str(form, 'order_number'),
    order_date: str(form, 'order_date'),
    items: str(form, 'items'),
    message: str(form, 'message'),
  };
  const path = getPathname({ href: '/vertrag-widerrufen', locale });
  const v = validateWithdrawal(values);
  const jar = await cookies();
  if (!v.ok) {
    jar.set(WITHDRAW_FLASH, pack({ values, errors: v.errors }), {
      httpOnly: true,
      sameSite: 'lax',
      path,
      maxAge: 120,
      secure: config.baseUrl.startsWith('https://'),
    });
    redirect(`${path}?e=1`);
  }
  const w = await recordWithdrawal(db(), v.data, locale);
  jar.delete({ name: WITHDRAW_FLASH, path });
  redirect(`${path}?ok=${encodeURIComponent(w.receivedAt.toISOString())}`);
}

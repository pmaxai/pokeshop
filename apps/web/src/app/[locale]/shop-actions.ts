'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  addToCart,
  loadCart,
  saveCheckoutDraft,
  setCartCountry,
  setCartQuantity,
} from '@pokeshop/core/cart';
import {
  CheckoutRejected,
  completeWithoutPayment,
  createCheckoutOrder,
  startPayment,
  validateCheckout,
} from '@pokeshop/core/orders';
import { addCartCode, removeCartCode } from '@pokeshop/core/vouchers';
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
const localeOf = (f: FormData): Locale => (str(f, 'locale') === 'de' ? 'de' : 'en');
const cartPath = (locale: Locale) => getPathname({ href: '/warenkorb', locale });
const checkoutPath = (locale: Locale) => getPathname({ href: '/kasse', locale });

/** next/navigation's redirect() throws; let it through a catch. */
const isRedirect = (e: unknown) =>
  typeof (e as { digest?: unknown })?.digest === 'string' &&
  (e as { digest: string }).digest.startsWith('NEXT_REDIRECT');

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

export type QuickAddState = {
  status: 'idle' | 'added' | 'limited' | 'unavailable';
  /** The product (condition) the action was for. */
  productId?: number;
  /** Copies of this product in the cart after the action. */
  quantity: number;
};

/**
 * "In den Warenkorb" on a catalog tile: adds one copy and stays on the page, so a visitor can
 * fill the cart straight from the list. The header count updates with the re-render.
 */
export async function quickAddAction(_prev: QuickAddState, form: FormData): Promise<QuickAddState> {
  const cart = await ensureCartId(localeOf(form));
  const productId = Number(str(form, 'product_id'));
  const r = await addToCart(db(), cart, productId, 1);
  revalidatePath('/', 'layout');
  return {
    status: r.unavailable ? 'unavailable' : r.limited ? 'limited' : 'added',
    productId,
    quantity: r.quantity,
  };
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

/**
 * "Einlösen" in the cart: a voucher or discount code (one form for both). The cart page then
 * shows what it does, or why it does nothing.
 */
export async function cartCodeAction(form: FormData) {
  const locale = localeOf(form);
  const cart = await ensureCartId(locale);
  const remove = str(form, 'remove_code');
  if (remove) {
    await removeCartCode(db(), cart, remove);
    revalidatePath('/', 'layout');
    redirect(`${cartPath(locale)}#codes`);
  }
  const view = await loadCart(db(), cart, locale);
  const r = await addCartCode(db(), cart, str(form, 'code'), view.check.goodsSubtotal);
  revalidatePath('/', 'layout');
  const q = r.ok
    ? `code=${r.replaced ? 'replaced' : r.kind}`
    : `code_error=${r.problem}${r.minGoodsCents ? `&min=${r.minGoodsCents}` : ''}&typed=${encodeURIComponent(str(form, 'code').slice(0, 40))}`;
  redirect(`${cartPath(locale)}?${q}#codes`);
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
    if (order.dueCents === 0) {
      // Code and vouchers pay it all: no payment page.
      const r = await completeWithoutPayment(db(), order.id);
      if (r === 'unavailable') redirect(`${cartPath(locale)}?unavailable=1`);
      redirect(orderPath);
    }
    url = await startPayment(db(), provider, order, {
      email: v.data.email,
      locale,
      successUrl: `${config.baseUrl}${orderPath}?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${config.baseUrl}/api/checkout/cancel?o=${order.token}&l=${locale}`,
    });
  } catch (e) {
    if (isRedirect(e)) throw e;
    if (e instanceof CheckoutRejected) {
      const p = e.problems.find((x) => x.code === 'code_problem');
      redirect(
        p && p.code === 'code_problem'
          ? `${cartPath(locale)}?code_error=${p.problem}&typed=${encodeURIComponent(p.entry)}#codes`
          : cartPath(locale),
      );
    }
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

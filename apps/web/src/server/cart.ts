import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { createCart, findCart, CART_RETENTION_DAYS } from '@pokeshop/core/cart';
import { config, db } from './config';

export const CART_COOKIE = 'pk_cart';

/** The visitor's cart, if the cookie points to one that still exists. */
export async function currentCartId(): Promise<string | null> {
  const value = (await cookies()).get(CART_COOKIE)?.value;
  return value ? findCart(db(), value) : null;
}

/**
 * Server actions only: returns the cart, creating it on first use. The cookie is renewed on
 * every change (30 days from the last change), which also makes Next.js re-render the header
 * with the new cart count.
 */
export async function ensureCartId(locale: 'de' | 'en'): Promise<string> {
  const id = (await currentCartId()) ?? (await createCart(db(), locale));
  (await cookies()).set(CART_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.baseUrl.startsWith('https://'),
    path: '/',
    maxAge: CART_RETENTION_DAYS * 24 * 3600,
  });
  return id;
}

/** Copies per product in the visitor's cart; one query per request, shared by all tiles. */
export const cartQuantities = cache(async (): Promise<Map<number, number>> => {
  const id = await currentCartId();
  if (!id) return new Map();
  const rows = await db()<{ product_id: number; quantity: number }[]>`
    SELECT product_id, quantity FROM cart_items WHERE cart_id = ${id}`;
  return new Map(rows.map((r) => [Number(r.product_id), r.quantity]));
});

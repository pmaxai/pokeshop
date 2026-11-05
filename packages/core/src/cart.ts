// Shopping cart: a list of cards and a delivery country. Nothing is reserved here –
// cards are held only once the buyer starts the payment (see orders.ts).
import type { Db } from './db.ts';
import { checkCheckout, type CartLine, type CheckoutCheck } from './checkout.ts';
import type { CountryShippingSettings } from './shipping.ts';
import { tilesByIds, type CatalogTile, type Locale } from './storefront.ts';

export const MAX_LINE_QUANTITY = 99;
/** Carts nobody touched for this long are deleted by the worker. */
export const CART_RETENTION_DAYS = 30;

export type CountryRow = {
  code: string;
  delivery_enabled: boolean;
  min_order_cents: number;
  standard_shipping_cents: number;
  insured_rate_bp: number;
  insured_minimum_cents: number;
  insured_max_order_cents: number | null;
  insured_max_charge_cents: number | null;
  vat_rate_bp: number;
  delivery_time_de: string | null;
  delivery_time_en: string | null;
};

export function toShippingSettings(r: CountryRow): CountryShippingSettings {
  return {
    code: r.code,
    deliveryEnabled: r.delivery_enabled,
    minOrder: r.min_order_cents,
    standardShipping: r.standard_shipping_cents,
    insuredRate: r.insured_rate_bp,
    insuredMinimum: r.insured_minimum_cents,
    insuredMaxOrder: r.insured_max_order_cents,
    insuredMaxCharge: r.insured_max_charge_cents,
  };
}

const COUNTRY_COLUMNS = `code, delivery_enabled, min_order_cents, standard_shipping_cents, insured_rate_bp,
  insured_minimum_cents, insured_max_order_cents, insured_max_charge_cents, vat_rate_bp,
  delivery_time_de, delivery_time_en`;

/** Countries we deliver to, Austria first. */
export async function deliveryCountries(db: Db): Promise<CountryRow[]> {
  return db<CountryRow[]>`
    SELECT ${db.unsafe(COUNTRY_COLUMNS)} FROM countries
     WHERE delivery_enabled ORDER BY code = 'AT' DESC, code`;
}

export async function countryRow(db: Db, code: string): Promise<CountryRow | null> {
  const [r] = await db<CountryRow[]>`
    SELECT ${db.unsafe(COUNTRY_COLUMNS)} FROM countries WHERE code = ${code.toUpperCase()}`;
  return r ?? null;
}

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export async function createCart(db: Db, locale: Locale): Promise<string> {
  const [c] = await db<{ id: string }[]>`
    INSERT INTO carts (locale, country) VALUES (${locale}, 'AT') RETURNING id`;
  return c!.id;
}

/** The cart behind a cookie value, or null if it is unknown or expired. */
export async function findCart(db: Db, id: string | undefined | null): Promise<string | null> {
  if (!id || !isUuid(id)) return null;
  const [c] = await db<{ id: string }[]>`SELECT id FROM carts WHERE id = ${id}`;
  return c?.id ?? null;
}

export type AddResult = { quantity: number; limited: boolean; unavailable: boolean };

/**
 * Adds copies of a card. The line never exceeds what is free right now, so the buyer sees
 * at once when the last copy is already in somebody's payment.
 */
export async function addToCart(
  db: Db,
  cartId: string,
  productId: number,
  quantity: number,
): Promise<AddResult> {
  const [p] = await db<{ available: number; status: string; in_cart: number | null }[]>`
    SELECT ps.available, p.status,
           (SELECT quantity FROM cart_items WHERE cart_id = ${cartId} AND product_id = p.id) AS in_cart
      FROM products p JOIN product_stock ps ON ps.product_id = p.id
     WHERE p.id = ${productId}`;
  if (!p || p.status !== 'active' || p.available < 1) {
    return { quantity: p?.in_cart ?? 0, limited: false, unavailable: true };
  }
  const wanted = (p.in_cart ?? 0) + Math.max(1, Math.trunc(quantity));
  const qty = Math.min(wanted, p.available, MAX_LINE_QUANTITY);
  await db`
    INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (${cartId}, ${productId}, ${qty})
    ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity`;
  await db`UPDATE carts SET updated_at = now() WHERE id = ${cartId}`;
  return { quantity: qty, limited: qty < wanted, unavailable: false };
}

/** Sets a line's quantity; 0 removes it. */
export async function setCartQuantity(
  db: Db,
  cartId: string,
  productId: number,
  quantity: number,
): Promise<void> {
  const q = Math.min(Math.max(0, Math.trunc(quantity)), MAX_LINE_QUANTITY);
  if (q === 0) {
    await db`DELETE FROM cart_items WHERE cart_id = ${cartId} AND product_id = ${productId}`;
  } else {
    await db`UPDATE cart_items SET quantity = ${q}
              WHERE cart_id = ${cartId} AND product_id = ${productId}`;
  }
  await db`UPDATE carts SET updated_at = now() WHERE id = ${cartId}`;
}

export async function setCartCountry(db: Db, cartId: string, code: string): Promise<boolean> {
  const c = await countryRow(db, code);
  if (!c?.delivery_enabled) return false;
  await db`UPDATE carts SET country = ${c.code} WHERE id = ${cartId}`;
  return true;
}

export async function saveCheckoutDraft(db: Db, cartId: string, draft: unknown): Promise<void> {
  await db`UPDATE carts SET checkout = ${db.json(draft as never)} WHERE id = ${cartId}`;
}

export async function cartCount(db: Db, cartId: string | null): Promise<number> {
  if (!cartId) return 0;
  const [r] = await db<{ n: number }[]>`
    SELECT coalesce(sum(quantity), 0)::int AS n FROM cart_items WHERE cart_id = ${cartId}`;
  return r?.n ?? 0;
}

export async function emptyCart(db: Db, cartId: string): Promise<void> {
  await db`DELETE FROM cart_items WHERE cart_id = ${cartId}`;
  await db`UPDATE carts SET checkout = NULL WHERE id = ${cartId}`;
}

export type CartViewLine = CatalogTile & {
  quantity: number;
  active: boolean;
  lineTotal: number;
};

export type CartView = {
  id: string;
  country: string;
  countries: CountryRow[];
  lines: CartViewLine[];
  check: CheckoutCheck;
  checkoutDraft: Record<string, unknown> | null;
};

/** Everything the cart and checkout pages show, with the checks run against current stock. */
export async function loadCart(db: Db, cartId: string, locale: Locale): Promise<CartView> {
  const [cart] = await db<{ country: string | null; checkout: Record<string, unknown> | null }[]>`
    SELECT country, checkout FROM carts WHERE id = ${cartId}`;
  const items = await db<{ product_id: number; quantity: number }[]>`
    SELECT product_id, quantity FROM cart_items WHERE cart_id = ${cartId} ORDER BY added_at`;
  const tiles = await tilesByIds(
    db,
    items.map((i) => i.product_id),
    locale,
  );
  const countries = await deliveryCountries(db);
  const code =
    cart?.country && countries.some((c) => c.code === cart.country)
      ? cart.country
      : (countries[0]?.code ?? 'AT');
  const country = countries.find((c) => c.code === code) ?? null;

  const lines: CartViewLine[] = [];
  const checkLines: CartLine[] = [];
  for (const i of items) {
    const t = tiles.get(i.product_id);
    if (!t) continue;
    lines.push({ ...t, quantity: i.quantity, lineTotal: t.priceCents * i.quantity });
    checkLines.push({
      productId: t.id,
      quantity: i.quantity,
      unitPrice: t.priceCents,
      highValue: t.highValue,
      available: t.available,
      active: t.active,
    });
  }
  return {
    id: cartId,
    country: code,
    countries,
    lines,
    check: checkCheckout({
      lines: checkLines,
      country: country ? toShippingSettings(country) : null,
      countryCode: code,
    }),
    checkoutDraft: cart?.checkout ?? null,
  };
}

/** Worker: forget carts nobody touched for 30 days. */
export async function deleteStaleCarts(db: Db): Promise<number> {
  const r = await db`
    DELETE FROM carts WHERE updated_at < now() - make_interval(days => ${CART_RETENTION_DAYS})`;
  return r.count;
}

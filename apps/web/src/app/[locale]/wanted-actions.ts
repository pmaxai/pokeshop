'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { safeNextPath } from '@pokeshop/core/accounts';
import { addWanted, declineOffer, offerToCart, removeWanted } from '@pokeshop/core/wanted';
import { getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { requirePortal } from '@/server/account';
import { ensureCartId } from '@/server/cart';

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
const localeOf = (f: FormData): Locale => (str(f, 'locale') === 'de' ? 'de' : 'en');
const pack = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const sep = (path: string) => (path.includes('?') ? '&' : '?');
const listPath = (locale: Locale) => getPathname({ href: '/konto/fehlend', locale });

/** After a change: fresh pages, then on to `to`. */
function go(to: string): never {
  revalidatePath('/', 'layout');
  redirect(to);
}

/** "300" / "12,50" → cents; "" → null; nonsense → -1 (rejected by the check). */
function euroCents(v: string): number | null {
  if (!v) return null;
  const n = Number(v.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : -1;
}

async function portal(form: FormData, here: string) {
  const locale = localeOf(form);
  const p = await requirePortal(locale, here);
  if (!p.portal) redirect(getPathname({ href: '/konto/abo', locale }));
  return { ...p, locale };
}

export async function addWantedAction(form: FormData) {
  const back = safeNextPath(str(form, 'back')) ?? '/';
  const { account, locale } = await portal(form, back);
  const r = await addWanted(
    db(),
    account.id,
    {
      card_id: str(form, 'card_id'),
      language: str(form, 'language'),
      finish: str(form, 'finish'),
      min_condition: str(form, 'min_condition'),
      max_price_cents: euroCents(str(form, 'max_price')),
      note: str(form, 'note'),
    },
    { locale },
  );
  if (!r.ok) go(`${back}${sep(back)}we=${pack(r.errors)}#wanted`);
  go(`${back}${sep(back)}wanted=1#wanted`);
}

export async function removeWantedAction(form: FormData) {
  const locale = localeOf(form);
  const back = safeNextPath(str(form, 'back')) ?? listPath(locale);
  const { account } = await portal(form, back);
  await removeWanted(db(), account.id, Number(str(form, 'id')));
  go(`${back}${sep(back)}removed=1#wanted`);
}

/** Puts the offered card in the cart at the offer's price and opens the cart. */
export async function offerToCartAction(form: FormData) {
  const locale = localeOf(form);
  const list = listPath(locale);
  const { account } = await portal(form, list);
  const cart = await ensureCartId(locale);
  const r = await offerToCart(db(), account.id, Number(str(form, 'id')), cart);
  if (r !== 'ok') go(`${list}?offer=${r}#offers`);
  go(`${getPathname({ href: '/warenkorb', locale })}?added=1`);
}

export async function declineOfferAction(form: FormData) {
  const locale = localeOf(form);
  const list = listPath(locale);
  const { account } = await portal(form, list);
  await declineOffer(db(), account.id, Number(str(form, 'id')));
  go(`${list}?declined=1#offers`);
}

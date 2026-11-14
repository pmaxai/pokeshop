'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  addItem,
  createBinder,
  createShare,
  deleteBinder,
  deleteItem,
  renameBinder,
  revokeShare,
  updateItem,
} from '@pokeshop/core/collection';
import { safeNextPath } from '@pokeshop/core/accounts';
import { getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { config, db } from '@/server/config';
import { requirePortal } from '@/server/account';

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
const localeOf = (f: FormData): Locale => (str(f, 'locale') === 'de' ? 'de' : 'en');
const pack = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const sep = (path: string) => (path.includes('?') ? '&' : '?');

/**
 * After a change: drop the cached pages (the router would otherwise keep showing the old list
 * when only the #fragment differs), then on to `to`.
 */
function go(to: string): never {
  revalidatePath('/', 'layout');
  redirect(to);
}

/** "12,50" / "12.50" / "" → cents, null, or NaN for nonsense. */
function euroCents(v: string): number | null {
  if (!v) return null;
  const n = Number(v.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : Number.NaN;
}

/** The customer with a subscription that includes the portal; else to the subscription page. */
async function portal(form: FormData, here: string) {
  const locale = localeOf(form);
  const p = await requirePortal(locale, here);
  if (!p.portal) redirect(getPathname({ href: '/konto/abo', locale }));
  return { ...p, locale };
}

function itemFields(form: FormData) {
  const price = euroCents(str(form, 'purchase_price'));
  const binder = str(form, 'binder');
  const company = str(form, 'grading_company');
  return {
    language: str(form, 'language'),
    finish: str(form, 'finish'),
    condition: str(form, 'condition'),
    quantity: str(form, 'quantity') || '1',
    purchase_price_cents: Number.isNaN(price) ? -1 : price,
    note: str(form, 'note'),
    binder_id: binder ? Number(binder) : null,
    grading: company ? { company, grade: str(form, 'grading_grade') } : null,
  };
}

export async function addToCollectionAction(form: FormData) {
  const back = safeNextPath(str(form, 'back')) ?? '/';
  const { account, locale } = await portal(form, back);
  const r = await addItem(
    db(),
    account.id,
    { card_id: str(form, 'card_id'), ...itemFields(form) },
    { source: 'portal', merge: true, locale },
  );
  if (!r.ok) go(`${back}${sep(back)}e=${pack(r.errors)}#add`);
  go(`${back}${sep(back)}added=${r.item.id}#add`);
}

export async function updateItemAction(form: FormData) {
  const id = Number(str(form, 'id'));
  const locale = localeOf(form);
  const here = getPathname({
    href: { pathname: '/konto/sammlung/[id]', params: { id: String(id) } },
    locale,
  });
  const { account } = await portal(form, here);
  const fields = itemFields(form);
  const r = await updateItem(db(), account.id, id, fields, locale);
  if (!r) go(getPathname({ href: '/konto/sammlung', locale }));
  if (!r.ok) go(`${here}?e=${pack(r.errors)}`);
  go(`${getPathname({ href: '/konto/sammlung', locale })}?saved=${id}#item-${id}`);
}

export async function deleteItemAction(form: FormData) {
  const locale = localeOf(form);
  const list = getPathname({ href: '/konto/sammlung', locale });
  const { account } = await portal(form, list);
  await deleteItem(db(), account.id, Number(str(form, 'id')));
  go(`${list}?deleted=1`);
}

export async function binderAction(form: FormData) {
  const locale = localeOf(form);
  const list = getPathname({ href: '/konto/sammlung', locale });
  const { account } = await portal(form, list);
  const op = str(form, 'op');
  const id = Number(str(form, 'id'));
  if (op === 'create') {
    const b = await createBinder(db(), account.id, str(form, 'name'));
    go(b ? `${list}#binders` : `${list}?binder_error=1#binders`);
  }
  if (op === 'rename') await renameBinder(db(), account.id, id, str(form, 'name'));
  if (op === 'delete') await deleteBinder(db(), account.id, id);
  go(`${list}#binders`);
}

export async function createShareAction(form: FormData) {
  const locale = localeOf(form);
  const here = getPathname({ href: '/konto/teilen', locale });
  const { account } = await portal(form, here);
  const kind = str(form, 'kind') === 'personal' ? 'personal' : 'public';
  const binderIds = form
    .getAll('binders')
    .map((v) => Number(v))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  const values = {
    kind,
    binderIds,
    showPrices: str(form, 'show_prices') === 'on',
    title: str(form, 'title'),
    ...(kind === 'personal'
      ? { recipientEmail: str(form, 'email'), message: str(form, 'message') }
      : {}),
  };
  const r = await createShare(db(), account, values, { baseUrl: config.baseUrl });
  if (!r.ok) go(`${here}?e=${pack({ kind, errors: r.errors, values })}#${kind}`);
  go(`${here}?created=${r.share.id}`);
}

export async function revokeShareAction(form: FormData) {
  const locale = localeOf(form);
  const here = getPathname({ href: '/konto/teilen', locale });
  const { account } = await portal(form, here);
  await revokeShare(db(), account.id, Number(str(form, 'id')));
  go(`${here}?revoked=1`);
}

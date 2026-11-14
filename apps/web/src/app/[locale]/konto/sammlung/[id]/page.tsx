import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import { itemById, listBinders } from '@pokeshop/core/collection';
import { getPathname, Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { requirePortal } from '@/server/account';
import { AccountShell } from '@/components/account/AccountShell';
import { PortalLocked } from '@/components/account/PortalLocked';
import { ItemFields } from '@/components/account/ItemFields';
import { deleteItemAction, updateItemAction } from '../../../collection-actions';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale; id: string }>;
  searchParams: Promise<{ e?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Portal' });
  return { title: t('edit.title'), robots: { index: false } };
}

function unpack(s: string | undefined): Record<string, string> {
  if (!s) return {};
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export default async function EditItemPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const here = getPathname({ href: { pathname: '/konto/sammlung/[id]', params: { id } }, locale });
  const { account, portal } = await requirePortal(locale, here);
  const t = await getTranslations('Portal');
  if (!portal) {
    return (
      <AccountShell account={account} active="collection" title={t('edit.title')} locale={locale}>
        <PortalLocked />
      </AccountShell>
    );
  }
  const n = Number(id);
  const item = Number.isSafeInteger(n) ? await itemById(db(), account.id, n, locale) : null;
  if (!item) notFound();
  const binders = await listBinders(db(), account.id);
  const errors = unpack((await searchParams).e);
  const price =
    item.purchasePriceCents !== null
      ? (item.purchasePriceCents / 100).toFixed(2).replace('.', locale === 'de' ? ',' : '.')
      : '';
  return (
    <AccountShell
      account={account}
      active="collection"
      title={item.card?.name ?? item.cardId}
      locale={locale}
    >
      <p className="small">
        <Link href="/konto/sammlung">← {t('edit.back')}</Link>
      </p>
      <div className="edit-item">
        <div className="edit-item__img">
          {item.card?.image ? (
            <img src={item.card.image.small} alt="" width={245} height={342} />
          ) : (
            <span className="pack-tile__none" />
          )}
        </div>
        <div>
          <p>
            {item.card?.setName} · <span className="num">{item.card?.number}</span>
          </p>
          <p className="muted small">
            {t('edit.value', {
              value: item.valueCents !== null ? formatEuro(item.valueCents, locale) : '–',
            })}{' '}
            <Link href={{ pathname: '/konto/karten/[card]', params: { card: item.cardId } }}>
              {t('edit.prices')}
            </Link>
          </p>
          {item.source === 'shop' && <p className="muted small">{t('edit.fromShop')}</p>}
        </div>
      </div>
      {Object.keys(errors).length > 0 && (
        <p className="notice notice--warn" role="alert">
          {t('errorsTitle')}
        </p>
      )}
      <form action={updateItemAction} className="stack account-panel">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="id" value={item.id} />
        <ItemFields
          idPrefix="edit"
          values={{
            language: item.language,
            finish: item.finish,
            condition: item.condition,
            quantity: item.quantity,
            purchasePrice: price,
            binderId: item.binderId,
            note: item.note,
            gradingCompany: item.grading?.company,
            gradingGrade: item.grading?.grade,
          }}
          finishes={item.card?.printings.map((p) => p.finish) ?? ['normal']}
          binders={binders}
          errors={errors}
        />
        <button type="submit" className="btn btn--accent">
          {t('edit.save')}
        </button>
      </form>
      <form action={deleteItemAction} className="edit-item__delete">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="id" value={item.id} />
        <button type="submit" className="btn btn--danger-outline">
          {t('edit.delete')}
        </button>
      </form>
    </AccountShell>
  );
}

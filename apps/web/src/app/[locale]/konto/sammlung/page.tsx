import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import {
  COLLECTION_SORTS,
  collectionView,
  listBinders,
  type CollectionSort,
} from '@pokeshop/core/collection';
import { getPathname, Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { requirePortal } from '@/server/account';
import { AccountShell } from '@/components/account/AccountShell';
import { PortalLocked } from '@/components/account/PortalLocked';
import { binderAction } from '../../collection-actions';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{
    q?: string;
    sort?: string;
    binder?: string;
    saved?: string;
    deleted?: string;
    binder_error?: string;
  }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Portal' });
  return { title: t('collection.title'), robots: { index: false } };
}

export default async function CollectionPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const q = await searchParams;
  const here = getPathname({ href: '/konto/sammlung', locale });
  const { account, portal } = await requirePortal(locale, here);
  const t = await getTranslations('Portal');
  const tf = await getTranslations('Finishes');
  const tl = await getTranslations('Languages');
  if (!portal) {
    return (
      <AccountShell
        account={account}
        active="collection"
        title={t('collection.title')}
        locale={locale}
      >
        <PortalLocked />
      </AccountShell>
    );
  }
  const sort: CollectionSort = COLLECTION_SORTS.find((s) => s === q.sort) ?? 'value';
  const binderId = q.binder === 'main' ? 0 : q.binder ? Number(q.binder) || null : null;
  const [binders, view] = await Promise.all([
    listBinders(db(), account.id),
    collectionView(db(), account.id, { locale, binderId, q: q.q, sort }),
  ]);
  const eur = (c: number) => formatEuro(c, locale);
  const tot = view.total;
  const gain = tot.purchaseCents > 0 ? tot.valueCents - tot.purchaseCents : null;
  const binderName = (id: number | null) => binders.find((b) => b.id === id)?.name;

  return (
    <AccountShell
      account={account}
      active="collection"
      title={t('collection.title')}
      locale={locale}
    >
      {q.deleted && (
        <p className="notice" role="status">
          {t('collection.deleted')}
        </p>
      )}
      <section className="collection-sum" aria-label={t('collection.summary')}>
        <div>
          <span className="collection-sum__value num">{eur(tot.valueCents)}</span>
          <span className="muted small">{t('collection.value')}</span>
        </div>
        <div>
          <span className="num">{tot.cards}</span>
          <span className="muted small">{t('collection.cards', { lines: tot.lines })}</span>
        </div>
        {gain !== null && (
          <div>
            <span className={`num ${gain >= 0 ? 'price-up' : 'price-down'}`}>
              {gain >= 0 ? '+' : '−'}
              {eur(Math.abs(gain))}
            </span>
            <span className="muted small">
              {t('collection.gain', { paid: eur(tot.purchaseCents) })}
            </span>
          </div>
        )}
        {tot.withoutPrice > 0 && (
          <p className="small muted collection-sum__note">
            {t('collection.withoutPrice', { count: tot.withoutPrice })}
          </p>
        )}
      </section>

      <div className="collection-actions">
        <Link href="/konto/karten" className="btn btn--accent">
          {t('collection.add')}
        </Link>
        <Link href="/konto/teilen" className="btn btn--quiet">
          {t('collection.share')}
        </Link>
      </div>

      <form className="collection-filter" method="get">
        <label className="field" htmlFor="cf-q">
          <span>{t('collection.filter')}</span>
          <input
            id="cf-q"
            name="q"
            type="search"
            defaultValue={q.q ?? ''}
            placeholder={t('collection.filterPlaceholder')}
          />
        </label>
        <label className="field" htmlFor="cf-binder">
          <span>{t('item.binder')}</span>
          <select id="cf-binder" name="binder" defaultValue={q.binder ?? ''}>
            <option value="">{t('collection.allBinders')}</option>
            <option value="main">{t('item.mainCollection')}</option>
            {binders.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.cards})
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="cf-sort">
          <span>{t('collection.sort')}</span>
          <select id="cf-sort" name="sort" defaultValue={sort}>
            {COLLECTION_SORTS.map((s) => (
              <option key={s} value={s}>
                {t(`collection.sorts.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" type="submit">
          {t('collection.apply')}
        </button>
      </form>

      {view.items.length === 0 ? (
        <p className="account-empty">
          {q.q || q.binder ? t('collection.noneFiltered') : t('collection.empty')}
        </p>
      ) : (
        <ul className="collection-list">
          {view.items.map((i) => (
            <li
              key={i.id}
              id={`item-${i.id}`}
              className={q.saved === String(i.id) ? 'is-saved' : undefined}
            >
              <Link
                href={{ pathname: '/konto/karten/[card]', params: { card: i.cardId } }}
                className="collection-list__img"
                tabIndex={-1}
                aria-hidden="true"
              >
                {i.card?.image ? (
                  <img
                    src={i.card.image.small}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    width={245}
                    height={342}
                  />
                ) : (
                  <span className="pack-tile__none" />
                )}
              </Link>
              <div className="collection-list__what">
                <Link
                  href={{ pathname: '/konto/karten/[card]', params: { card: i.cardId } }}
                  className="collection-list__name"
                >
                  {i.card?.name ?? i.cardId}
                </Link>
                <span className="muted small">
                  {i.card?.setName} · <span className="num">{i.card?.number}</span>
                </span>
                <span className="collection-list__tags">
                  <span className="tag">{tl(i.language as never)}</span>
                  <span className="tag">{tf(i.finish as never)}</span>
                  <span className="tag">
                    {i.grading ? `${i.grading.company} ${i.grading.grade}` : i.condition}
                  </span>
                  {i.binderId && <span className="tag tag--binder">{binderName(i.binderId)}</span>}
                  {i.source === 'shop' && (
                    <span className="tag tag--shop">{t('collection.fromShop')}</span>
                  )}
                </span>
              </div>
              <div className="collection-list__value">
                <span className="num">
                  {i.valueCents !== null ? eur(i.valueCents * i.quantity) : t('noPrice')}
                </span>
                <span className="muted small">
                  {i.quantity} × {i.valueCents !== null ? eur(i.valueCents) : '–'}
                </span>
              </div>
              <Link
                href={{ pathname: '/konto/sammlung/[id]', params: { id: String(i.id) } }}
                className="collection-list__edit"
              >
                {t('collection.edit')}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <section className="account-panel" id="binders" aria-labelledby="binders-title">
        <h2 id="binders-title">{t('binders.title')}</h2>
        <p className="muted small">{t('binders.text')}</p>
        {q.binder_error && <p className="notice notice--warn">{t('binders.error')}</p>}
        {binders.length > 0 && (
          <ul className="binder-list">
            {binders.map((b) => (
              <li key={b.id}>
                <form action={binderAction} className="binder-list__form">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="id" value={b.id} />
                  <input
                    name="name"
                    defaultValue={b.name}
                    maxLength={60}
                    aria-label={t('binders.name')}
                  />
                  <span className="muted small">{t('binders.cards', { count: b.cards })}</span>
                  <button
                    className="btn btn--small btn--quiet"
                    type="submit"
                    name="op"
                    value="rename"
                  >
                    {t('binders.rename')}
                  </button>
                  <button
                    className="btn btn--small btn--quiet"
                    type="submit"
                    name="op"
                    value="delete"
                  >
                    {t('binders.delete')}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form action={binderAction} className="binder-list__form">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="op" value="create" />
          <input
            name="name"
            maxLength={60}
            placeholder={t('binders.placeholder')}
            aria-label={t('binders.name')}
            required
          />
          <button className="btn btn--small" type="submit">
            {t('binders.create')}
          </button>
        </form>
      </section>
    </AccountShell>
  );
}

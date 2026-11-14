import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import { collectionView, openShare } from '@pokeshop/core/collection';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: Locale; token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Shared' });
  return { title: t('title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

/** A collection someone shared: by public link, or with one person for 7 days. */
export default async function SharedCollectionPage({ params }: Props) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Shared');
  const tf = await getTranslations('Finishes');
  const tl = await getTranslations('Languages');
  const r = await openShare(db(), token);
  if (!r.ok) {
    return (
      <div className="wrap login-page">
        <div className="login-card">
          <h1>{t('title')}</h1>
          <p className="notice notice--warn">
            {r.problem === 'expired' ? t('expired') : t('unknown')}
          </p>
        </div>
      </div>
    );
  }
  const { share, owner } = r;
  const view = await collectionView(db(), owner.id, {
    locale,
    binderIds: share.binderIds,
    sort: 'value',
  });
  // the owner may have the same card in several lines (bought at different prices); a visitor
  // only needs to see it once, with the number of copies
  const lines = new Map<string, (typeof view.items)[number]>();
  for (const i of view.items) {
    const k = [
      i.cardId,
      i.language,
      i.finish,
      i.condition,
      i.grading?.company,
      i.grading?.grade,
    ].join('|');
    const had = lines.get(k);
    lines.set(k, had ? { ...had, quantity: had.quantity + i.quantity } : i);
  }
  const items = [...lines.values()];
  const eur = (c: number) => formatEuro(c, locale);
  const who = owner.name || t('someone');
  const until = share.expiresAt
    ? new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
        dateStyle: 'long',
        timeStyle: 'short',
        timeZone: 'Europe/Vienna',
      }).format(share.expiresAt)
    : null;
  return (
    <div className="wrap shared">
      {share.title && <p className="muted">{t('by', { who })}</p>}
      <h1>{share.title ?? t('defaultTitle', { who })}</h1>
      <p className="shared__facts">
        {t('cards', { count: view.total.cards })}
        {share.showPrices && (
          <>
            {' · '}
            <strong className="num">{eur(view.total.valueCents)}</strong> {t('value')}
          </>
        )}
      </p>
      {until && <p className="small muted">{t('until', { date: until })}</p>}
      {share.message && <blockquote className="shared__message">{share.message}</blockquote>}
      {items.length === 0 ? (
        <p className="account-empty">{t('empty')}</p>
      ) : (
        <ul className="pack-grid shared__grid">
          {items.map((i) => (
            <li key={i.id} className="pack-tile">
              <span className="pack-tile__img">
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
                {i.quantity > 1 && <span className="pack-tile__qty">×{i.quantity}</span>}
              </span>
              <span className="pack-tile__name">{i.card?.name ?? i.cardId}</span>
              <span className="pack-tile__set muted">
                {i.card?.setName} · <span className="num">{i.card?.number}</span>
              </span>
              <span className="pack-tile__set muted">
                {tl(i.language as never)} · {tf(i.finish as never)} ·{' '}
                {i.grading ? `${i.grading.company} ${i.grading.grade}` : i.condition}
              </span>
              {share.showPrices && (
                <span className="pack-tile__price num">
                  {i.valueCents !== null ? eur(i.valueCents) : '–'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="small muted shared__note">{t('note')}</p>
    </div>
  );
}

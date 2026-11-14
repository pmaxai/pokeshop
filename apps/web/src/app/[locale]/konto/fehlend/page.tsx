import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import { listWanted, recentlyFound, type Wanted } from '@pokeshop/core/wanted';
import { getPathname, Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { requirePortal } from '@/server/account';
import { AccountShell } from '@/components/account/AccountShell';
import { PortalLocked } from '@/components/account/PortalLocked';
import { WishTags } from '@/components/account/Wanted';
import { declineOfferAction, offerToCartAction, removeWantedAction } from '../../wanted-actions';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ removed?: string; declined?: string; offer?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Portal' });
  return { title: t('wanted.title'), robots: { index: false } };
}

function CardThumb({ w }: { w: Wanted }) {
  return (
    <Link
      href={{ pathname: '/konto/karten/[card]', params: { card: w.cardId } }}
      className="collection-list__img"
      tabIndex={-1}
      aria-hidden="true"
    >
      {w.card?.image ? (
        <img
          src={w.card.image.small}
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
  );
}

/** The customer's missing cards: offers from the shop, matches in the shop, the list itself. */
export default async function MissingCardsPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const q = await searchParams;
  const here = getPathname({ href: '/konto/fehlend', locale });
  const { account, portal } = await requirePortal(locale, here);
  const t = await getTranslations('Portal');
  const tf = await getTranslations('Finishes');
  const tl = await getTranslations('Languages');
  if (!portal) {
    return (
      <AccountShell account={account} active="missing" title={t('wanted.title')} locale={locale}>
        <PortalLocked />
      </AccountShell>
    );
  }
  const [list, found] = await Promise.all([
    listWanted(db(), account.id, locale),
    recentlyFound(db(), account.id, locale),
  ]);
  const eur = (c: number) => formatEuro(c, locale);
  const when = (d: Date) =>
    new Intl.DateTimeFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Europe/Vienna',
    }).format(d);
  const offers = list.flatMap((w) => w.offers.map((o) => ({ o, w })));
  const problem =
    q.offer === 'expired' || q.offer === 'sold' || q.offer === 'unknown' ? q.offer : null;

  return (
    <AccountShell account={account} active="missing" title={t('wanted.title')} locale={locale}>
      <p className="muted account-lead">{t('wanted.lead')}</p>
      {q.removed && (
        <p className="notice" role="status">
          {t('wanted.removed')}
        </p>
      )}
      {q.declined && (
        <p className="notice" role="status">
          {t('wanted.declined')}
        </p>
      )}
      {problem && (
        <p className="notice notice--warn" role="alert">
          {t(`wanted.offerProblem.${problem}`)}
        </p>
      )}

      {offers.length > 0 && (
        <section className="account-panel offers" id="offers" aria-labelledby="offers-title">
          <h2 id="offers-title">{t('wanted.offersTitle')}</h2>
          <ul className="collection-list">
            {offers.map(({ o, w }) => (
              <li key={o.id} className="offer">
                <CardThumb w={w} />
                <div className="collection-list__what">
                  <span className="collection-list__name">{w.card?.name ?? w.cardId}</span>
                  <span className="muted small">
                    {w.card?.setName} · <span className="num">{w.card?.number}</span>
                  </span>
                  <span className="collection-list__tags">
                    <span className="tag">{tl(o.product.language as never)}</span>
                    <span className="tag">{tf(o.product.finish as never)}</span>
                    <span className="tag">{o.product.grading ?? o.product.condition}</span>
                  </span>
                  {o.message && <blockquote className="offer__message">{o.message}</blockquote>}
                  <span className="muted small">
                    {t('wanted.offerUntil', { date: when(o.expiresAt) })}{' '}
                    {o.product.draft ? t('wanted.offerHeld') : t('wanted.offerOpen')}
                  </span>
                </div>
                <div className="collection-list__value">
                  {o.listPriceCents && o.listPriceCents > o.priceCents && !o.product.draft ? (
                    <s className="muted small">{eur(o.listPriceCents)}</s>
                  ) : null}
                  <span className="num offer__price">{eur(o.priceCents)}</span>
                  <span className="muted small">{t('wanted.yourPrice')}</span>
                </div>
                <div className="offer__actions">
                  <form action={offerToCartAction}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="id" value={o.id} />
                    <button type="submit" className="btn btn--accent">
                      {t('wanted.toCart')}
                    </button>
                  </form>
                  <form action={declineOfferAction}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="id" value={o.id} />
                    <button type="submit" className="btn btn--quiet">
                      {t('wanted.decline')}
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section id="wanted" aria-labelledby="wanted-list-title">
        <div className="collection-actions">
          <h2 id="wanted-list-title" className="collection-actions__title">
            {t('wanted.listTitle', { count: list.length })}
          </h2>
          <Link href="/konto/karten" className="btn btn--quiet">
            {t('wanted.add')}
          </Link>
        </div>
        {list.length === 0 ? (
          <p className="account-empty">{t('wanted.empty')}</p>
        ) : (
          <ul className="collection-list">
            {list.map((w) => (
              <li key={w.id} id={`wanted-${w.id}`}>
                <CardThumb w={w} />
                <div className="collection-list__what">
                  <Link
                    href={{ pathname: '/konto/karten/[card]', params: { card: w.cardId } }}
                    className="collection-list__name"
                  >
                    {w.card?.name ?? w.cardId}
                  </Link>
                  <span className="muted small">
                    {w.card?.setName} · <span className="num">{w.card?.number}</span>
                  </span>
                  <WishTags w={w} locale={locale} />
                  {w.note && <span className="muted small">{w.note}</span>}
                  <span className={`wanted-state wanted-state--${w.state}`}>
                    {w.state === 'offer'
                      ? t('wanted.state.offer')
                      : w.state === 'available'
                        ? t('wanted.state.available')
                        : t('wanted.state.searching')}
                  </span>
                  {w.inShop.length > 0 && (
                    <ul className="wanted-matches" aria-label={t('wanted.inShop')}>
                      <li className="muted small">{t('wanted.inShop')}:</li>
                      {w.inShop.slice(0, 3).map((m) => (
                        <li key={m.productId}>
                          <Link
                            href={{
                              pathname: '/karten/[slug]',
                              params: { slug: locale === 'en' ? (m.slugEn ?? m.slug) : m.slug },
                            }}
                          >
                            {tl(m.language as never)} · {tf(m.finish as never)} ·{' '}
                            {m.grading ?? m.condition}
                          </Link>{' '}
                          <span className="num">{eur(m.priceCents)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="collection-list__value">
                  <span className="num">{w.valueCents !== null ? eur(w.valueCents) : '–'}</span>
                  <span className="muted small">{t('wanted.marketValue')}</span>
                </div>
                <form action={removeWantedAction} className="collection-list__edit">
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="id" value={w.id} />
                  <input type="hidden" name="back" value={here} />
                  <button type="submit" className="link-button">
                    {t('wanted.remove')}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      {found.length > 0 && (
        <section className="account-panel" aria-labelledby="found-title">
          <h2 id="found-title">{t('wanted.foundTitle')}</h2>
          <ul className="mini-lines">
            {found.map((w) => (
              <li key={w.id}>
                <Link href={{ pathname: '/konto/karten/[card]', params: { card: w.cardId } }}>
                  {w.card?.name ?? w.cardId} <span className="num">{w.card?.number}</span>
                </Link>
                <span className="muted small">{when(w.foundAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </AccountShell>
  );
}

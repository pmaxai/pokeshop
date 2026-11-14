import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import { searchPackCards, toCents, topValue } from '@pokeshop/core/pack-cards';
import { getPathname, Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { requirePortal } from '@/server/account';
import { AccountShell } from '@/components/account/AccountShell';
import { PortalLocked } from '@/components/account/PortalLocked';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: Locale }>; searchParams: Promise<{ q?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Portal' });
  return { title: t('search.title'), robots: { index: false } };
}

const EXAMPLES = ['glurak 4', 'pikachu 58/102', 'mew ex 151', 'sv03.5-199'];

export default async function CardSearchPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const q = ((await searchParams).q ?? '').slice(0, 80);
  const here = getPathname({ href: '/konto/karten', locale });
  const { account, portal } = await requirePortal(
    locale,
    here + (q ? `?q=${encodeURIComponent(q)}` : ''),
  );
  const t = await getTranslations('Portal');
  const results =
    portal && q.trim() ? await searchPackCards(db(), q, { langs: [locale, 'en'], limit: 48 }) : [];
  return (
    <AccountShell account={account} active="cards" title={t('search.title')} locale={locale}>
      {!portal ? (
        <PortalLocked />
      ) : (
        <>
          <form className="card-search" role="search" method="get">
            <label className="field" htmlFor="cs-q">
              <span>{t('search.label')}</span>
              <input
                id="cs-q"
                name="q"
                type="search"
                defaultValue={q}
                placeholder={t('search.placeholder')}
                autoComplete="off"
              />
            </label>
            <button className="btn btn--accent" type="submit">
              {t('search.submit')}
            </button>
          </form>
          {!q.trim() ? (
            <p className="muted">
              {t('search.hint')}{' '}
              {EXAMPLES.map((e, i) => (
                <span key={e}>
                  {i > 0 && ', '}
                  <Link href={{ pathname: '/konto/karten', query: { q: e } }}>{e}</Link>
                </span>
              ))}
            </p>
          ) : results.length === 0 ? (
            <p className="account-empty">{t('search.none', { q })}</p>
          ) : (
            <>
              <p className="muted small">{t('search.count', { count: results.length })}</p>
              <ul className="pack-grid">
                {results.map((c) => {
                  const v = toCents(topValue(c));
                  return (
                    <li key={c.id}>
                      <Link
                        href={{ pathname: '/konto/karten/[card]', params: { card: c.id } }}
                        className="pack-tile"
                      >
                        <span className="pack-tile__img">
                          {c.image ? (
                            <img
                              src={c.image.small}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              width={245}
                              height={342}
                            />
                          ) : (
                            <span className="pack-tile__none" />
                          )}
                        </span>
                        <span className="pack-tile__name">{c.name}</span>
                        <span className="pack-tile__set muted">
                          {c.setName} · <span className="num">{c.number}</span>
                        </span>
                        <span className="pack-tile__price num">
                          {v !== null
                            ? t('search.upTo', { price: formatEuro(v, locale) })
                            : t('noPrice')}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
    </AccountShell>
  );
}

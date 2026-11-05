import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { CATALOG_SORTS, listCatalog, type CatalogSort } from '@pokeshop/core/storefront';
import { getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { many, one } from '@/server/shop';
import { CardTile } from '@/components/CardTile';
import { Filters, type FilterState } from '@/components/Filters';
import { SortSelect } from '@/components/SortSelect';

export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;

function euroToCents(v?: string): number | undefined {
  if (!v) return undefined;
  const n = Number(v.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
}

function stateFrom(sp: Search): FilterState {
  return {
    q: one(sp.q)?.trim().slice(0, 100) || undefined,
    lang: many(sp.lang),
    series: many(sp.series),
    set: many(sp.set),
    rarity: many(sp.rarity),
    cond: many(sp.cond),
    finish: many(sp.finish),
    type: many(sp.type),
    graded: one(sp.graded) === '1',
    all: one(sp.all) === '1',
    min: one(sp.min),
    max: one(sp.max),
    sort: one(sp.sort),
  };
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<Search>;
}): Promise<Metadata> {
  const { locale } = await params;
  const sp = await searchParams;
  const t = await getTranslations({ locale, namespace: 'Meta' });
  const q = one(sp.q);
  const filtered = Object.keys(sp).length > 0;
  return {
    title: q ? t('searchTitle', { q }) : t('cardsTitle'),
    description: t('cardsDescription'),
    // filtered and searched lists are not indexed; the plain list is
    robots: filtered ? { index: false, follow: true } : undefined,
    alternates: {
      canonical: getPathname({ href: '/karten', locale }),
      languages: {
        de: getPathname({ href: '/karten', locale: 'de' }),
        en: getPathname({ href: '/karten', locale: 'en' }),
      },
    },
  };
}

export default async function Cards({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<Search>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const t = await getTranslations('Catalog');
  const state = stateFrom(sp);
  const sort = (CATALOG_SORTS as readonly string[]).includes(state.sort ?? '')
    ? (state.sort as CatalogSort)
    : 'newest';
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const result = await listCatalog(
    db(),
    {
      q: state.q,
      languages: state.lang,
      series: state.series,
      sets: state.set,
      rarities: state.rarity,
      conditions: state.cond,
      finishes: state.finish,
      supertypes: state.type,
      graded: state.graded,
      priceMin: euroToCents(state.min),
      priceMax: euroToCents(state.max),
      inStockOnly: !state.all,
      sort,
      page,
    },
    locale,
  );
  const action = getPathname({ href: '/karten', locale });

  const keep = (extra: Record<string, string>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (k === 'page' || v === undefined) continue;
      for (const x of Array.isArray(v) ? v : [v]) u.append(k, x);
    }
    for (const [k, v] of Object.entries(extra)) u.set(k, v);
    return `${action}?${u.toString()}`;
  };

  return (
    <div className="wrap catalog">
      <aside aria-label={t('filters')}>
        <Filters action={action} facets={result.facets} state={state} />
      </aside>
      <section aria-labelledby="catalog-title">
        <div className="catalog__head">
          <div>
            <h1 id="catalog-title">
              {state.q ? t('searchResults', { count: result.total, q: state.q }) : t('title')}
            </h1>
            {!state.q && <p className="muted">{t('results', { count: result.total })}</p>}
          </div>
          <form action={action} method="get">
            {Object.entries(sp).flatMap(([k, v]) =>
              k === 'sort' || k === 'page' || v === undefined
                ? []
                : (Array.isArray(v) ? v : [v]).map((x, i) => (
                    <input key={`${k}-${i}`} type="hidden" name={k} value={x} />
                  )),
            )}
            <SortSelect
              label={t('sort')}
              value={sort}
              options={[
                { value: 'newest', label: t('sortNewest') },
                { value: 'price_asc', label: t('sortPriceAsc') },
                { value: 'price_desc', label: t('sortPriceDesc') },
                { value: 'number', label: t('sortNumber') },
                { value: 'name', label: t('sortName') },
              ]}
            />
            <noscript>
              <button className="btn btn--quiet" type="submit">
                {t('sort')}
              </button>
            </noscript>
          </form>
        </div>

        {result.items.length === 0 ? (
          <p className="empty">{state.q ? t('noneSearch', { q: state.q }) : t('none')}</p>
        ) : (
          <ul className="card-grid">
            {result.items.map((c, i) => (
              <CardTile key={c.id} card={c} locale={locale} priority={i < 4} />
            ))}
          </ul>
        )}

        {result.pages > 1 && (
          <nav className="pager" aria-label={t('page', { page: result.page, pages: result.pages })}>
            {result.page > 1 ? (
              <a href={keep({ page: String(result.page - 1) })} rel="prev">
                {t('prev')}
              </a>
            ) : (
              <span />
            )}
            <span className="muted">{t('page', { page: result.page, pages: result.pages })}</span>
            {result.page < result.pages ? (
              <a href={keep({ page: String(result.page + 1) })} rel="next">
                {t('next')}
              </a>
            ) : (
              <span />
            )}
          </nav>
        )}
      </section>
    </div>
  );
}

import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { newestCards, setsForSale, listCatalog } from '@pokeshop/core/storefront';
import { Link, getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { config, db } from '@/server/config';
import { deliveryCountries } from '@pokeshop/core/cart';
import { getCompany } from '@/server/shop';
import { JsonLd } from '@/components/JsonLd';
import { CardTile } from '@/components/CardTile';
import { CardImage } from '@/components/CardImage';
import { SetList } from '@/components/SetList';
import { pageAlternates, siteJsonLd } from '@/server/seo';

export const dynamic = 'force-dynamic';

/** Cards under "Neu eingetroffen"; the hero fan picks from a few more. */
const NEWEST_SHOWN = 4;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return {
    alternates: pageAlternates('/', locale),
  };
}

export default async function Home({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Home');
  const tl = await getTranslations('Languages');
  const ts = await getTranslations('Sets');
  const [cards, sets, all] = await Promise.all([
    newestCards(db(), locale, 12),
    setsForSale(db(), locale),
    listCatalog(db(), { pageSize: 1 }, locale),
  ]);
  // The fan: the three most valuable of the recent cards that have a picture.
  const fan = [...cards]
    .filter((c) => c.image.kind !== 'none')
    .sort((a, b) => b.priceCents - a.priceCents)
    .slice(0, 3);

  const [countries, company] = await Promise.all([deliveryCountries(db()), getCompany()]);
  return (
    <div className="wrap">
      <JsonLd
        data={siteJsonLd({
          baseUrl: config.baseUrl,
          name: String(company.public_name),
          email: String(company.email),
          searchPath: getPathname({ href: '/karten', locale }),
          countries: countries.map((c) => c.code),
        })}
      />
      <section className="hero">
        <div>
          <h1>{t('title')}</h1>
          <p className="hero__lead">{t('lead')}</p>
          <p className="hero__actions">
            <Link className="btn btn--accent" href="/karten">
              {t('allCards')}
            </Link>
            <Link className="btn btn--quiet" href="/sets">
              {t('bySet')}
            </Link>
          </p>
        </div>
        {fan.length === 3 && (
          <div className="fan" aria-hidden="true">
            {fan.map((c, i) => (
              <CardImage
                key={c.id}
                image={c.image}
                alt=""
                priority={i === 1}
                large
                noImageLabel=""
                sizes="(min-width: 60rem) 15rem, 40vw"
              />
            ))}
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="newest">
        <div className="section__head">
          <h2 id="newest">{t('newest')}</h2>
          {cards.length > 0 && <Link href="/karten">{t('allCards')}</Link>}
        </div>
        {cards.length === 0 ? (
          <p className="empty">{t('empty')}</p>
        ) : (
          <ul className="card-grid card-grid--four">
            {cards.slice(0, NEWEST_SHOWN).map((c) => (
              <CardTile key={c.id} card={c} locale={locale} priority />
            ))}
          </ul>
        )}
      </section>

      {all.facets.languages.length > 0 && (
        <section className="section" aria-labelledby="by-language">
          <h2 id="by-language" className="section__head">
            {t('byLanguage')}
          </h2>
          <ul className="lang-list">
            {all.facets.languages.map((l) => (
              <li key={l.value}>
                <Link href={{ pathname: '/karten', query: { lang: l.value } }}>
                  {tl(l.value as never)} <span>{ts('forSale', { count: l.count })}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sets.length > 0 && (
        <section className="section" aria-labelledby="by-set">
          <div className="section__head">
            <h2 id="by-set">{t('bySet')}</h2>
            <Link href="/sets">{t('allSets')}</Link>
          </div>
          <SetList sets={sets.slice(0, 9)} locale={locale} />
        </section>
      )}
    </div>
  );
}

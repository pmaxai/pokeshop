import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import { listCatalog, productBySlug, type ProductPage } from '@pokeshop/core/storefront';
import { Link, getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { config, db, getSetting } from '@/server/config';
import { AltNames, namesText } from '@/components/AltNames';
import { CardImage } from '@/components/CardImage';
import { CardTile } from '@/components/CardTile';
import { ZoomCard } from '@/components/ZoomCard';
import { addToCartAction } from '../../shop-actions';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: Locale; slug: string }> };

const paths = (p: ProductPage) => ({
  de: getPathname({
    href: { pathname: '/karten/[slug]', params: { slug: p.slugDe } },
    locale: 'de',
  }),
  en: getPathname({
    href: { pathname: '/karten/[slug]', params: { slug: p.slugEn } },
    locale: 'en',
  }),
});

function largeImage(p: ProductPage): string | null {
  const own = p.images[0];
  if (own) return `/media/${own.key}-1200.webp`;
  if (p.image.kind === 'sample' && p.image.samplePath)
    return `/media/card/${p.image.samplePath}/high.webp`;
  return null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const p = await productBySlug(db(), decodeURIComponent(slug), locale);
  if (!p) return {};
  const t = await getTranslations({ locale, namespace: 'Card' });
  const tl = await getTranslations({ locale, namespace: 'Languages' });
  const img = largeImage(p);
  const title = `${namesText(p.name, p.nameTranslations)} ${p.cardNumber} ${p.setName ?? ''} – ${tl(p.cardLanguage as never)}, ${p.condition}`;
  return {
    title,
    description: `${namesText(p.name, p.nameTranslations)}, ${p.setName ?? p.setCode} ${p.cardNumber}. ${t('language')}: ${tl(p.cardLanguage as never)}, ${t('condition')}: ${p.condition}. ${formatEuro(p.priceCents, locale)}.`,
    alternates: { canonical: paths(p)[locale], languages: paths(p) },
    openGraph: img ? { images: [{ url: img }] } : undefined,
  };
}

export default async function CardPage({ params }: Props) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const p = await productBySlug(db(), decodeURIComponent(slug), locale);
  if (!p) notFound();
  if (p.slug !== decodeURIComponent(slug)) permanentRedirect(paths(p)[locale]);

  const t = await getTranslations('Card');
  const tl = await getTranslations('Languages');
  const smallBusiness = await getSetting<boolean>('small_business', false);
  const tc = await getTranslations('Conditions');
  const tf = await getTranslations('Finishes');
  const tt = await getTranslations('Supertypes');
  const nav = await getTranslations('Nav');

  const more = (
    await listCatalog(db(), { sets: [p.setCode], pageSize: 9, sort: 'number' }, locale)
  ).items
    .filter((c) => c.id !== p.id)
    .slice(0, 8);
  const big = largeImage(p);
  const alt = `${namesText(p.name, p.nameTranslations)}, ${p.setName ?? p.setCode} ${p.cardNumber}`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: `${p.name} ${p.cardNumber}`,
    ...(p.nameTranslations.length
      ? { alternateName: p.nameTranslations.map((n) => `${n.text} ${p.cardNumber}`) }
      : {}),
    sku: p.sku,
    image: big ? [`${config.baseUrl}${big}`] : undefined,
    category: 'Pokémon TCG single card',
    offers: {
      '@type': 'Offer',
      url: `${config.baseUrl}${paths(p)[locale]}`,
      price: (p.priceCents / 100).toFixed(2),
      priceCurrency: 'EUR',
      availability: p.available > 0 ? 'https://schema.org/InStock' : 'https://schema.org/SoldOut',
      itemCondition: ['M', 'NM'].includes(p.condition)
        ? 'https://schema.org/NewCondition'
        : 'https://schema.org/UsedCondition',
    },
  };

  const imageBlock = (
    <CardImage
      image={p.image}
      alt={alt}
      priority
      large
      sizes="(min-width: 52rem) 26rem, 90vw"
      noImageLabel={t('noImage')}
    />
  );

  return (
    <div className="wrap">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <article className="product">
        <div className="product__media">
          {big ? (
            <ZoomCard src={big} alt={alt} openLabel={t('zoom')} closeLabel={t('close')}>
              {imageBlock}
            </ZoomCard>
          ) : (
            imageBlock
          )}
          {p.image.kind === 'sample' && <p className="note">{t('sampleImage')}</p>}
          {p.images.length > 1 && (
            <div className="thumbs">
              {p.images.map((i) => (
                <a key={i.key} href={`/media/${i.key}-1200.webp`}>
                  <img
                    src={`/media/${i.key}-320.webp`}
                    alt={`${alt} (${i.role})`}
                    loading="lazy"
                    width={72}
                    height={100}
                  />
                </a>
              ))}
            </div>
          )}
        </div>

        <div>
          <nav className="crumbs" aria-label="Breadcrumb">
            <Link href="/karten">{nav('cards')}</Link>
            {' / '}
            <Link href={{ pathname: '/sets/[set]', params: { set: p.setCode } }}>
              {p.setName ?? p.setCode}
            </Link>
          </nav>
          <h1 lang={p.nameLang}>{p.name}</h1>
          <AltNames translations={p.nameTranslations} className="product__alt" />
          <p className="product__sub">
            {p.setName ?? p.setCode} <span className="num">{p.cardNumber}</span>
          </p>
          <ul className="tags" style={{ marginTop: 'var(--s-3)' }}>
            <li className="tag">{tl(p.cardLanguage as never)}</li>
            <li className="tag">
              {p.condition} {tc(p.condition as never)}
            </li>
            <li className={p.finish !== 'normal' ? 'tag tag--holo' : 'tag'}>
              {tf(p.finish as never)}
            </li>
            {p.grading && <li className="tag">{p.grading}</li>}
          </ul>

          <div className="buybox">
            <span className="price">{formatEuro(p.priceCents, locale)}</span>
            <small>
              {smallBusiness
                ? p.highValue
                  ? t('noVatInsured')
                  : `${t('noVat')}, ${t('freeShipping')}`
                : p.highValue
                  ? t('inclVatInsured')
                  : `${t('inclVat')}, ${t('freeShipping')}`}
            </small>
            {p.available > 0 ? (
              <span className={p.available === 1 ? 'stock stock--last' : 'stock'}>
                {t('available', { count: p.available })}
              </span>
            ) : (
              <span className="stock muted">{t('soldOut')}</span>
            )}
            {p.available > 0 && (
              <form action={addToCartAction} className="buy">
                <input type="hidden" name="product_id" value={p.id} />
                <input type="hidden" name="locale" value={locale} />
                {p.available > 1 && (
                  <label className="buy__qty">
                    <span className="visually-hidden">{t('quantity')}</span>
                    <select name="quantity" defaultValue="1">
                      {Array.from({ length: Math.min(p.available, 10) }, (_, i) => i + 1).map(
                        (n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                )}
                <button type="submit" className="btn btn--accent">
                  {t('addToCart')}
                </button>
              </form>
            )}
            {p.highValue && <p>{t('highValue')}</p>}
            <p className="muted">{t('shippingNote')}</p>
          </div>

          <dl className="facts">
            <dt>{t('set')}</dt>
            <dd>
              <Link href={{ pathname: '/sets/[set]', params: { set: p.setCode } }}>
                {p.setName ?? p.setCode}
              </Link>
            </dd>
            <dt>{t('number')}</dt>
            <dd className="num">{p.cardNumber}</dd>
            {p.seriesName && (
              <>
                <dt>{t('series')}</dt>
                <dd>{p.seriesName}</dd>
              </>
            )}
            <dt>{t('language')}</dt>
            <dd>{tl(p.cardLanguage as never)}</dd>
            <dt>{t('condition')}</dt>
            <dd>
              {p.condition} {tc(p.condition as never)}
              <br />
              <Link href="/zustand" className="muted" style={{ fontWeight: 400 }}>
                {t('conditionGuide')}
              </Link>
            </dd>
            <dt>{t('finish')}</dt>
            <dd>{tf(p.finish as never)}</dd>
            {p.rarity && (
              <>
                <dt>{t('rarity')}</dt>
                <dd>{p.rarity}</dd>
              </>
            )}
            {p.supertype && (
              <>
                <dt>{t('type')}</dt>
                <dd>{tt(p.supertype as never)}</dd>
              </>
            )}
            {p.releaseYear && (
              <>
                <dt>{t('year')}</dt>
                <dd className="num">{p.releaseYear}</dd>
              </>
            )}
            {p.grading && (
              <>
                <dt>{t('grading')}</dt>
                <dd>
                  {p.grading}
                  {p.gradingCert ? `, ${t('cert')} ${p.gradingCert}` : ''}
                </dd>
              </>
            )}
          </dl>

          {p.description && <p className="description">{p.description}</p>}
        </div>
      </article>

      {more.length > 0 && (
        <section className="section" aria-labelledby="more">
          <div className="section__head">
            <h2 id="more">{t('moreFromSet', { set: p.setName ?? p.setCode })}</h2>
          </div>
          <ul className="card-grid">
            {more.map((c) => (
              <CardTile key={c.id} card={c} locale={locale} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

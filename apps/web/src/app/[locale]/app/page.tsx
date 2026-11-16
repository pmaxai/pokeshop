import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import { APP_NAME, currentRelease, licenseSeller } from '@pokeshop/core/licenses';
import { netPrice, subscriptionPrices } from '@pokeshop/core/subscriptions';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db, getSetting } from '@/server/config';
import { cookieAffiliate } from '@/server/affiliate';
import { getCompany } from '@/server/shop';
import { pageAlternates } from '@/server/seo';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'App' });
  return {
    title: { absolute: t('metaTitle') },
    description: t('metaDescription'),
    alternates: pageAlternates('/app', locale),
  };
}

const FEATURES = [
  'recognise',
  'prices',
  'history',
  'offline',
  'alert',
  'trading',
  'youtube',
  'webshop',
] as const;

const ACP_POINTS = ['cut', 'voice', 'music', 'out'] as const;
const WAAS_POINTS = ['domain', 'mail', 'stripe'] as const;

function megabytes(bytes: number, locale: Locale): string {
  return `${new Intl.NumberFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
    maximumFractionDigits: 0,
  }).format(bytes / 1_000_000)} MB`;
}

export default async function AppPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('App');
  const tSub = await getTranslations('Subscription');
  const [prices, seller, { email }, release, playStore] = await Promise.all([
    subscriptionPrices(db()),
    licenseSeller(db()),
    getCompany(),
    currentRelease(db()),
    getSetting<string | null>('app_play_store_url', null),
  ]);
  const eur = (c: number) => formatEuro(c, locale);
  const price = eur(prices.collector);
  const netFrom = eur(netPrice(prices.collector));
  const sales = {
    release,
    playStoreUrl:
      typeof playStore === 'string' && playStore.startsWith('https://') ? playStore : null,
  };
  const store = sales.playStoreUrl !== null;
  // came through an influencer's link (/r/<code>): their code and discount
  const affiliate = await cookieAffiliate();
  const playWithReferrer =
    affiliate && sales.playStoreUrl
      ? `${sales.playStoreUrl}${sales.playStoreUrl.includes('?') ? '&' : '?'}referrer=${encodeURIComponent(`aff=${affiliate.code}`)}`
      : null;
  // The services are the GmbH's; enquiries go to its mailbox.
  const ask = (service: string) =>
    `mailto:${seller.email || email}?subject=${encodeURIComponent(t('services.askSubject', { service }))}`;

  return (
    <div className="wrap app-page">
      <section className="app-hero" aria-labelledby="app-title">
        <div className="app-hero__text">
          <h1 id="app-title" className="app-hero__title">
            {APP_NAME} <span className="app-beta">{t('beta')}</span>
          </h1>
          <p className="app-hero__tagline">{t('tagline')}</p>
          <p className="hero__lead">{t('lead')}</p>
          {affiliate && (
            <p className="notice app-affiliate" role="status">
              {affiliate.discountPercent > 0
                ? t('affiliate.discount', {
                    code: affiliate.code,
                    percent: affiliate.discountPercent,
                    months: affiliate.discountMonths ?? 0,
                  })
                : t('affiliate.noDiscount', { code: affiliate.code })}
              {playWithReferrer && (
                <>
                  {' '}
                  <a href={playWithReferrer}>{t('affiliate.play')}</a>
                </>
              )}
            </p>
          )}
          <p className="app-hero__price">
            <strong>{t('price', { price })}</strong>
            <span>{t('priceNote')}</span>
            <span className="app-hero__net">{t('priceBusiness', { net: netFrom })}</span>
          </p>
          <p className="hero__actions">
            <a className="btn btn--accent" href="#abos">
              {t('buy')}
            </a>
            <a className="btn btn--quiet" href="#funktionen">
              {t('seeFeatures')}
            </a>
          </p>
          <p className="app-hero__platform">{store ? t('platformStore') : t('platformApk')}</p>
        </div>
        <figure className="app-shot">
          <img
            src="/images/app-scan-720.webp"
            srcSet="/images/app-scan-480.webp 480w, /images/app-scan-720.webp 720w, /images/app-scan-960.webp 960w"
            sizes="(min-width: 48rem) 20rem, 82vw"
            width={720}
            height={1246}
            alt={t('screenshotAlt')}
            fetchPriority="high"
          />
        </figure>
      </section>

      <section className="section" id="funktionen" aria-labelledby="features-title">
        <h2 id="features-title" className="section__head">
          {t('featuresTitle')}
        </h2>
        <dl className="app-features">
          {FEATURES.map((f) => (
            <div key={f}>
              <dt>{t(`features.${f}.title`)}</dt>
              <dd>{t(`features.${f}.text`)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="section" id="dienste" aria-labelledby="services-title">
        <h2 id="services-title" className="section__head">
          {t('services.title')}
        </h2>
        <p className="app-services__intro">{t('services.intro', { seller: seller.name })}</p>
        <div className="app-services">
          <section className="app-service" aria-labelledby="acp-title">
            <h3 id="acp-title">{t('services.acp.title')}</h3>
            <p>{t('services.acp.text')}</p>
            <ul className="app-ticks">
              {ACP_POINTS.map((k) => (
                <li key={k}>{t(`services.acp.points.${k}`)}</li>
              ))}
            </ul>
            <a className="btn btn--quiet" href={ask(t('services.acp.title'))}>
              {t('services.ask')}
            </a>
          </section>
          <section className="app-service" aria-labelledby="waas-title">
            <h3 id="waas-title">{t('services.waas.title')}</h3>
            <p>{t('services.waas.text')}</p>
            <p className="app-service__needs">{t('services.waas.needsTitle')}</p>
            <ul className="app-ticks">
              {WAAS_POINTS.map((k) => (
                <li key={k}>{t(`services.waas.points.${k}`)}</li>
              ))}
            </ul>
            <a className="btn btn--quiet" href={ask(t('services.waas.title'))}>
              {t('services.ask')}
            </a>
          </section>
        </div>
      </section>

      <div className="app-columns">
        <section className="app-beta-box" aria-labelledby="beta-title">
          <h2 id="beta-title">{t('betaTitle')}</h2>
          <p>{t('betaIntro')}</p>
          <ul>
            <li>{t('betaPoints.recognition')}</li>
            <li>{t('betaPoints.prices')}</li>
            <li>{t('betaPoints.english')}</li>
            <li>
              {t.rich('betaPoints.updates', {
                email,
                mail: (chunks) => <a href={`mailto:${email}`}>{chunks}</a>,
              })}
            </li>
          </ul>
        </section>
        <section aria-labelledby="licence-title">
          <h2 id="licence-title">{t('licenceTitle')}</h2>
          <ul className="app-ticks">
            <li>{t('subPoints.monthly', { price })}</li>
            <li>{t('subPoints.portal')}</li>
            <li>{t('subPoints.device')}</li>
            <li>{t('subPoints.online')}</li>
          </ul>
          <h3 className="app-sub">{t('needsTitle')}</h3>
          <ul className="app-ticks">
            <li>{t('needs.android')}</li>
            <li>
              {sales.release
                ? t('needs.space', { size: megabytes(sales.release.sizeBytes, locale) })
                : t('needs.spaceUnknown')}
            </li>
            <li>{t('needs.internet')}</li>
          </ul>
        </section>
      </div>

      <section className="section" aria-labelledby="how-title">
        <h2 id="how-title" className="section__head">
          {t('howTitle')}
        </h2>
        <ol className="app-steps">
          <li>{t('steps.subscribe')}</li>
          <li>{store ? t('steps.installStore') : t('steps.download')}</li>
          <li>{t('steps.connect')}</li>
        </ol>
        {!store && <p className="app-store-note">{t('storeTarget')}</p>}
      </section>

      <section className="section app-buy" id="abos" aria-labelledby="buy-title">
        <h2 id="buy-title" className="section__head">
          {t('plansTitle')}
        </h2>
        <p className="app-services__intro">{t('plansIntro')}</p>
        <div className="plan-cards">
          {(['collector', 'creator'] as const).map((k) => (
            <section key={k} className={`plan-card plan-card--${k}`} aria-labelledby={`plan-${k}`}>
              <h3 id={`plan-${k}`}>{tSub(`plans.${k}.name`)}</h3>
              <p className="plan-card__price">
                <span className="num">{eur(prices[k])}</span> {tSub('perMonth')}
              </p>
              <ul className="app-ticks">
                {(tSub.raw(`plans.${k}.points`) as string[]).map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <p className="small muted">
                {tSub('extraDevice', { price: eur(prices[`${k}_device`]) })}
              </p>
              <p>
                <Link
                  href={{ pathname: '/konto/abo', query: { plan: k } }}
                  className={k === 'creator' ? 'btn btn--accent' : 'btn'}
                >
                  {t('planCta', { plan: tSub(`plans.${k}.name`) })}
                </Link>
              </p>
            </section>
          ))}
        </div>
        <p className="small muted">{t('plansNote', { net: netFrom, seller: seller.name })}</p>
      </section>
    </div>
  );
}

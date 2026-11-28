import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import { APP_NAME, appStores, gmbhSeller, playWithReferrer } from '@pokeshop/core/app';
import { netPrice, subscriptionPrices } from '@pokeshop/core/subscriptions';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { cookieAffiliate } from '@/server/affiliate';
import { getCompany } from '@/server/shop';
import { pageAlternates } from '@/server/seo';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'App' });
  const [prices, stores] = await Promise.all([subscriptionPrices(db()), appStores(db())]);
  // Safari on an iPhone offers the App Store app in a banner.
  const appleId = stores.apple?.match(/\/id(\d+)/)?.[1];
  return {
    title: { absolute: t('metaTitle') },
    description: t('metaDescription', { price: formatEuro(prices.collector, locale) }),
    alternates: pageAlternates('/app', locale),
    ...(appleId ? { itunes: { appId: appleId } } : {}),
  };
}

const SCREENS = ['search', 'prices', 'cart', 'free'] as const;

const FEATURES = [
  'recognise',
  'prices',
  'history',
  'search',
  'offline',
  'alert',
  'trading',
  'collection',
  'youtube',
  'webshop',
] as const;

const ACP_POINTS = ['cut', 'voice', 'music', 'out'] as const;
const WAAS_POINTS = ['domain', 'mail', 'stripe'] as const;

export default async function AppPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('App');
  const tSub = await getTranslations('Subscription');
  const [prices, seller, { email }, stores, affiliate] = await Promise.all([
    subscriptionPrices(db()),
    gmbhSeller(db()),
    getCompany(),
    appStores(db()),
    // came through an influencer's link (/r/<code>): their code goes with the install
    cookieAffiliate(),
  ]);
  const eur = (c: number) => formatEuro(c, locale);
  const price = eur(prices.collector);
  const netFrom = eur(netPrice(prices.collector));
  const play =
    stores.play && affiliate ? playWithReferrer(stores.play, affiliate.code) : stores.play;
  // The services are the GmbH's; enquiries go to its mailbox.
  const ask = (service: string) =>
    `mailto:${seller.email || email}?subject=${encodeURIComponent(t('services.askSubject', { service }))}`;

  const storeButtons = (primary: boolean) => (
    <p className="app-stores">
      {play && (
        <a className={primary ? 'btn btn--accent' : 'btn'} href={play} rel="noopener noreferrer">
          {t('play')}
        </a>
      )}
      {stores.apple ? (
        <a className="btn" href={stores.apple} rel="noopener noreferrer">
          {t('appStore')}
        </a>
      ) : (
        <span className="app-store-soon">{t('appStoreSoon')}</span>
      )}
    </p>
  );

  return (
    <div className="wrap app-page">
      <section className="app-hero" aria-labelledby="app-title">
        <div className="app-hero__text">
          <p className="app-id">
            <img
              src="/images/app-icon-128.webp"
              srcSet="/images/app-icon-128.webp 2x, /images/app-icon-192.webp 3x"
              width={56}
              height={56}
              alt=""
            />
            <span>
              <strong>{APP_NAME}</strong>
              <span>{stores.apple ? t('platformsBoth') : t('platforms')}</span>
            </span>
          </p>
          <h1 id="app-title" className="app-hero__title">
            {t('title')}
          </h1>
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
            </p>
          )}
          {storeButtons(true)}
          <p className="app-hero__free">
            {t('freeLine', { price })} <a href="#abos">{t('comparePlans')}</a>
          </p>
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
        <ul className="app-screens">
          {SCREENS.map((s) => (
            <li key={s}>
              <figure>
                <img
                  src={`/images/app-screen-${s}.webp`}
                  width={320}
                  height={616}
                  alt={t(`screens.${s}.alt`)}
                  loading="lazy"
                />
                <figcaption>{t(`screens.${s}.caption`)}</figcaption>
              </figure>
            </li>
          ))}
        </ul>
        <dl className="app-features">
          {FEATURES.map((f) => (
            <div key={f}>
              <dt>{t(`features.${f}.title`)}</dt>
              <dd>{t(`features.${f}.text`)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="section" id="abos" aria-labelledby="plans-title">
        <h2 id="plans-title" className="section__head">
          {t('plansTitle')}
        </h2>
        <p className="app-services__intro">{t('plansIntro')}</p>
        <div className="plan-cards">
          <section className="plan-card plan-card--free" aria-labelledby="plan-free">
            <h3 id="plan-free">{t('free.name')}</h3>
            <p className="plan-card__price">
              <span className="num">{t('free.price')}</span>
            </p>
            <ul className="app-ticks">
              {(t.raw('free.points') as string[]).map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            {play && (
              <p>
                <a className="btn" href={play} rel="noopener noreferrer">
                  {t('play')}
                </a>
              </p>
            )}
          </section>
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
        <p className="small muted app-plans__note">
          {t('plansNote', { net: netFrom, seller: seller.name })}
        </p>
      </section>

      <section className="section" aria-labelledby="how-title">
        <h2 id="how-title" className="section__head">
          {t('howTitle')}
        </h2>
        <ol className="app-steps">
          <li>{stores.apple ? t('steps.installBoth') : t('steps.install')}</li>
          <li>{t('steps.free')}</li>
          <li>{t('steps.subscribe')}</li>
        </ol>
        {storeButtons(false)}
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
        <section className="app-notes" aria-labelledby="notes-title">
          <h2 id="notes-title">{t('notesTitle')}</h2>
          <ul>
            <li>{t('notes.recognition')}</li>
            <li>{t('notes.prices')}</li>
            <li>{t('notes.english')}</li>
            <li>
              {t.rich('notes.feedback', {
                email,
                mail: (chunks) => <a href={`mailto:${email}`}>{chunks}</a>,
              })}
            </li>
          </ul>
        </section>
        <section aria-labelledby="needs-title">
          <h2 id="needs-title">{t('needsTitle')}</h2>
          <ul className="app-ticks">
            <li>{t('needs.android')}</li>
            <li>{t('needs.space')}</li>
            <li>{t('needs.internet')}</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

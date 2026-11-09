import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro } from '@pokeshop/core';
import { appSales, APP_NAME, MAX_LICENSES_PER_ORDER } from '@pokeshop/core/licenses';
import { SMALL_BUSINESS_NOTE } from '@pokeshop/core/vat';
import { Link, getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db, getSetting, licenseServiceConfigured } from '@/server/config';
import { getCompany } from '@/server/shop';
import { LicenseQuantity } from '@/components/LicenseQuantity';
import { APP_FORM_FLASH } from '@/server/app-form';
import { buyLicenseAction, resendLicenseAction } from '../app-actions';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ e?: string; sent?: string; cancelled?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'App' });
  return {
    title: { absolute: t('metaTitle') },
    description: t('metaDescription'),
    alternates: {
      canonical: getPathname({ href: '/app', locale }),
      languages: {
        de: getPathname({ href: '/app', locale: 'de' }),
        en: getPathname({ href: '/app', locale: 'en' }),
      },
    },
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
] as const;

function megabytes(bytes: number, locale: Locale): string {
  return `${new Intl.NumberFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
    maximumFractionDigits: 0,
  }).format(bytes / 1_000_000)} MB`;
}

type Flash = { values?: Record<string, string>; errors?: Record<string, string> };

export default async function AppPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const t = await getTranslations('App');
  const tc = await getTranslations('Checkout');
  const sales = await appSales(db(), licenseServiceConfigured());
  const smallBusiness = await getSetting<boolean>('small_business', false);
  const { email } = await getCompany();
  const price = formatEuro(sales.priceCents, locale);

  let flash: Flash = {};
  if (sp.e) {
    const raw = (await cookies()).get(APP_FORM_FLASH)?.value;
    try {
      flash = raw ? (JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Flash) : {};
    } catch {
      flash = {};
    }
  }
  const values = flash.values ?? {};
  const errors = flash.errors ?? {};
  const err = (k: string) =>
    errors[k]
      ? (t as (key: string, v?: Record<string, number>) => string)(`form.errors.${errors[k]}`, {
          max: MAX_LICENSES_PER_ORDER,
        })
      : null;

  const names = new Intl.DisplayNames([locale === 'de' ? 'de-AT' : 'en'], { type: 'region' });
  const countries = (await db()<{ code: string }[]>`SELECT code FROM countries WHERE is_eu`)
    .map((c) => ({ code: c.code, name: names.of(c.code) ?? c.code }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));
  const defaultCountry = values.country || (locale === 'de' ? 'AT' : '');
  const quantity = Math.min(Math.max(Number(values.quantity) || 1, 1), MAX_LICENSES_PER_ORDER);
  const store = sales.playStoreUrl !== null;

  const field = (
    name: string,
    label: string,
    opts: { type?: string; autoComplete?: string; required?: boolean; hint?: string } = {},
  ) => {
    const e = err(name);
    const id = `app-${name}`;
    return (
      <label className={e ? 'field field--error' : 'field'} htmlFor={id}>
        <span>{label}</span>
        <input
          id={id}
          name={name}
          type={opts.type ?? 'text'}
          defaultValue={values[name] ?? ''}
          autoComplete={opts.autoComplete}
          required={opts.required ?? true}
          aria-invalid={e ? true : undefined}
          aria-describedby={e ? `${id}-err` : opts.hint ? `${id}-hint` : undefined}
        />
        {e ? (
          <small id={`${id}-err`} className="field__error">
            {e}
          </small>
        ) : (
          opts.hint && (
            <small id={`${id}-hint`} className="muted">
              {opts.hint}
            </small>
          )
        )}
      </label>
    );
  };

  return (
    <div className="wrap app-page">
      <section className="app-hero" aria-labelledby="app-title">
        <div className="app-hero__text">
          <h1 id="app-title" className="app-hero__title">
            {APP_NAME} <span className="app-beta">{t('beta')}</span>
          </h1>
          <p className="app-hero__tagline">{t('tagline')}</p>
          <p className="hero__lead">{t('lead')}</p>
          <p className="app-hero__price">
            <strong>{t('price', { price })}</strong>
            <span>{t('priceNote')}</span>
          </p>
          <p className="hero__actions">
            <a className="btn btn--accent" href="#kaufen">
              {t('buy')}
            </a>
            <a className="btn btn--quiet" href="#funktionen">
              {t('seeFeatures')}
            </a>
          </p>
          <p className="app-hero__platform">{store ? t('platformStore') : t('platformApk')}</p>
        </div>
        <PhoneMock
          label={t('mock.label')}
          sure={t('mock.sure')}
          trend={t('mock.trend')}
          change={t('mock.change')}
          avg={t('mock.avg')}
          low={t('mock.low')}
          locale={locale}
        />
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
            <li>{t('licencePoints.once', { price })}</li>
            <li>{t('licencePoints.updates')}</li>
            <li>{t('licencePoints.device')}</li>
            <li>{t('licencePoints.online')}</li>
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
          <li>{t('steps.buy')}</li>
          <li>{t('steps.mail')}</li>
          <li>{store ? t('steps.installStore') : t('steps.installApk')}</li>
          <li>{t('steps.activate')}</li>
        </ol>
        {!store && <p className="app-store-note">{t('storeTarget')}</p>}
      </section>

      <section className="section app-buy" id="kaufen" aria-labelledby="buy-title">
        <h2 id="buy-title" className="section__head">
          {t('form.title')}
        </h2>
        {sp.cancelled && (
          <p className="notice notice--warn" role="status">
            {t('thanks.unpaidText')}
          </p>
        )}
        {Object.keys(errors).length > 0 && (
          <p className="notice notice--warn" role="alert">
            {errors._ === 'payment_unavailable'
              ? t('form.paymentUnavailable')
              : t('form.errorsTitle')}
          </p>
        )}
        {sales.open ? (
          <form action={buyLicenseAction} className="checkout" noValidate>
            <input type="hidden" name="locale" value={locale} />
            <div className="checkout__fields">
              <fieldset>
                <legend className="visually-hidden">{t('form.title')}</legend>
                {field('name', t('form.name'), { autoComplete: 'name' })}
                {field('company', t('form.company'), {
                  autoComplete: 'organization',
                  required: false,
                })}
                {field('email', t('form.email'), {
                  type: 'email',
                  autoComplete: 'email',
                  hint: t('form.emailHint'),
                })}
                {field('street', t('form.street'), {
                  autoComplete: 'billing street-address',
                  hint: t('form.streetHint'),
                })}
                <div className="field-row">
                  {field('postcode', t('form.postcode'), { autoComplete: 'billing postal-code' })}
                  {field('city', t('form.city'), { autoComplete: 'billing address-level2' })}
                </div>
                <label
                  className={err('country') ? 'field field--error' : 'field'}
                  htmlFor="app-country"
                >
                  <span>{t('form.country')}</span>
                  <select
                    id="app-country"
                    name="country"
                    defaultValue={defaultCountry}
                    autoComplete="country"
                    required
                  >
                    {!defaultCountry && <option value="">–</option>}
                    {countries.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {err('country') && <small className="field__error">{err('country')}</small>}
                </label>
              </fieldset>
            </div>
            <aside className="summary" aria-labelledby="app-sum-title">
              <h3 id="app-sum-title">
                {APP_NAME} <span className="app-beta">{t('beta')}</span>
              </h3>
              <p className="small muted">{t('priceNote')}</p>
              <LicenseQuantity
                priceCents={sales.priceCents}
                locale={locale}
                max={MAX_LICENSES_PER_ORDER}
                initial={quantity}
                error={err('quantity')}
              />
              {smallBusiness && <p className="small muted">{SMALL_BUSINESS_NOTE[locale]}</p>}
              <label className={errors.acceptTerms ? 'check check--error' : 'check'}>
                <input
                  type="checkbox"
                  name="accept_terms"
                  required
                  aria-invalid={errors.acceptTerms ? true : undefined}
                />
                <span>
                  {tc.rich('terms', {
                    terms: (c) => (
                      <Link href="/agb" target="_blank">
                        {c}
                      </Link>
                    ),
                    withdrawal: (c) => (
                      <Link href="/widerrufsbelehrung" target="_blank">
                        {c}
                      </Link>
                    ),
                    privacy: (c) => (
                      <Link href="/datenschutz" target="_blank">
                        {c}
                      </Link>
                    ),
                  })}
                </span>
              </label>
              {errors.acceptTerms && (
                <small className="field__error">{t('form.errors.terms')}</small>
              )}
              <label className={errors.immediateDelivery ? 'check check--error' : 'check'}>
                <input
                  type="checkbox"
                  name="immediate_delivery"
                  required
                  aria-invalid={errors.immediateDelivery ? true : undefined}
                />
                <span>{t('form.consent')}</span>
              </label>
              {errors.immediateDelivery && (
                <small className="field__error">{t('form.errors.consent')}</small>
              )}
              <button type="submit" className="btn btn--accent btn--wide">
                {tc('submit')}
              </button>
              <p className="muted small">{t('form.submitNote')}</p>
            </aside>
          </form>
        ) : (
          <p className="notice notice--warn">{t('form.closed')}</p>
        )}
      </section>

      <section className="section app-lost" id="verloren" aria-labelledby="lost-title">
        <h2 id="lost-title">{t('lost.title')}</h2>
        {sp.sent ? (
          <p className="notice" role="status">
            {t('lost.done')}
          </p>
        ) : (
          <>
            <p>{t('lost.text')}</p>
            <form action={resendLicenseAction} className="app-lost__form">
              <input type="hidden" name="locale" value={locale} />
              <label className="field" htmlFor="lost-email">
                <span>{t('lost.email')}</span>
                <input id="lost-email" name="email" type="email" autoComplete="email" required />
              </label>
              <button type="submit" className="btn">
                {t('lost.submit')}
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * The hero picture: a phone mid-scan. Drawn with HTML and CSS (no card artwork), so it shows
 * the idea – card in the green frame, price below – without any third-party image.
 */
function PhoneMock({
  label,
  sure,
  trend,
  change,
  avg,
  low,
  locale,
}: {
  label: string;
  sure: string;
  trend: string;
  change: string;
  avg: string;
  low: string;
  locale: Locale;
}) {
  const eur = (c: number) => formatEuro(c, locale);
  return (
    <figure className="phone" role="img" aria-label={label}>
      <div className="phone__screen" aria-hidden="true">
        <div className="phone__camera">
          <div className="phone__card">
            <span className="phone__card-art" />
            <span className="phone__card-line" />
            <span className="phone__card-line phone__card-line--short" />
          </div>
          <span className="phone__frame" />
          <span className="phone__sure">{sure}</span>
        </div>
        <div className="phone__panel">
          <p className="phone__name">
            Glurak-ex <span>199/165</span>
          </p>
          <p className="phone__set">151 · DE · 2023</p>
          <p className="phone__price">{eur(5200)}</p>
          <p className="phone__trend">
            {trend} <strong>{change}</strong>
          </p>
          <svg className="phone__spark" viewBox="0 0 120 28" preserveAspectRatio="none">
            <polyline
              points="0,22 12,20 24,21 36,17 48,18 60,14 72,15 84,11 96,9 108,10 120,5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
          <p className="phone__chips">
            <span className="phone__chip phone__chip--on">Holo</span>
            <span className="phone__chip">Reverse</span>
          </p>
          <p className="phone__more">
            <span>
              {avg} {eur(4890)}
            </span>
            <span>
              {low} {eur(4450)}
            </span>
          </p>
        </div>
      </div>
    </figure>
  );
}

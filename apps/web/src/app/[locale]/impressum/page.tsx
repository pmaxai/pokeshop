import type { Metadata } from 'next';
import { Fragment } from 'react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { SMALL_BUSINESS_NOTE } from '@pokeshop/core/vat';
import type { Locale } from '@/i18n/routing';
import { getSetting } from '@/server/config';
import { getCompany } from '@/server/shop';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Imprint' });
  return { title: t('title') };
}

/** The only shop page that names the operator (§ 5 ECG, § 25 MedienG). */
export default async function Imprint({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Imprint');
  const c = await getCompany();
  const smallBusiness = await getSetting<boolean>('small_business', false);
  const country = new Intl.DisplayNames([locale === 'de' ? 'de-AT' : 'en'], { type: 'region' }).of(
    c.country,
  );
  // Only what applies: a sole trader has no company register entry or managing director.
  const rows: [string, React.ReactNode][] = [
    [t('contact'), <a href={`mailto:${c.email}`}>{c.email}</a>],
    ...(c.trade ? [[t('trade'), c.trade] as [string, React.ReactNode]] : []),
    ...(c.register_number ? [[t('register'), c.register_number] as [string, React.ReactNode]] : []),
    ...(c.register_court ? [[t('court'), c.register_court] as [string, React.ReactNode]] : []),
    ...(c.vat_id ? [[t('vat'), c.vat_id] as [string, React.ReactNode]] : []),
    ...(smallBusiness
      ? [[t('smallBusiness'), SMALL_BUSINESS_NOTE[locale]] as [string, React.ReactNode]]
      : []),
    ...(c.managing_director
      ? [[t('director'), c.managing_director] as [string, React.ReactNode]]
      : []),
    ...(c.chamber ? [[t('chamber'), c.chamber] as [string, React.ReactNode]] : []),
    ...(c.supervisory_authority
      ? [[t('authority'), c.supervisory_authority] as [string, React.ReactNode]]
      : []),
    [
      t('law_trade'),
      t.rich('law_trade_text', {
        link: (chunks) => <a href="https://www.ris.bka.gv.at">{chunks}</a>,
      }),
    ],
  ];
  return (
    <div className="wrap prose legal">
      <h1>{t('title')}</h1>
      <p className="muted">{t('law')}</p>
      <h2>{t('owner')}</h2>
      <p>
        {c.name}
        <br />
        {c.street}
        <br />
        {c.postcode} {c.city}
        <br />
        {country}
      </p>
      <dl>
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

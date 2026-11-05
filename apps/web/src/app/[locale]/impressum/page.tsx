import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Locale } from '@/i18n/routing';
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

export default async function Imprint({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Imprint');
  const c = await getCompany();
  const country = new Intl.DisplayNames([locale === 'de' ? 'de-AT' : 'en'], { type: 'region' }).of(
    c.country,
  );
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
        <dt>{t('contact')}</dt>
        <dd>
          <a href={`mailto:${c.email}`}>{c.email}</a>
        </dd>
        <dt>{t('register')}</dt>
        <dd>{c.register_number}</dd>
        <dt>{t('court')}</dt>
        <dd>{c.register_court}</dd>
        <dt>{t('vat')}</dt>
        <dd>{c.vat_id}</dd>
        <dt>{t('director')}</dt>
        <dd>{c.managing_director}</dd>
        <dt>{t('chamber')}</dt>
        <dd>{c.chamber}</dd>
        <dt>{t('authority')}</dt>
        <dd>{c.supervisory_authority}</dd>
      </dl>
    </div>
  );
}

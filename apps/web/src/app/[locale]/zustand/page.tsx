import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { CONDITIONS } from '@pokeshop/core';
import type { Locale } from '@/i18n/routing';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Conditions' });
  return { title: t('title') };
}

export default async function ConditionGuide({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Conditions');
  return (
    <div className="wrap prose">
      <h1>{t('title')}</h1>
      <p>{t('lead')}</p>
      <dl className="grade-list">
        {Object.keys(CONDITIONS).map((c) => (
          <div key={c}>
            <dt>{c}</dt>
            <dd>
              <strong>{t(c as never)}</strong>
              {t(`${c}_text` as never)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

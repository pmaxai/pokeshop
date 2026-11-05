import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro, formatRate } from '@pokeshop/core';
import type { Locale } from '@/i18n/routing';
import { db, getSetting } from '@/server/config';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Shipping' });
  return { title: t('title') };
}

export default async function Shipping({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Shipping');
  const countries = await db()<
    {
      code: string;
      min_order_cents: number;
      delivery_time_de: string | null;
      delivery_time_en: string | null;
      insured_rate_bp: number;
      insured_minimum_cents: number;
      insured_max_order_cents: number | null;
    }[]
  >`
    SELECT code, min_order_cents, delivery_time_de, delivery_time_en, insured_rate_bp, insured_minimum_cents, insured_max_order_cents
      FROM countries WHERE delivery_enabled ORDER BY code = 'AT' DESC, code`;
  const names = new Intl.DisplayNames([locale === 'de' ? 'de-AT' : 'en'], { type: 'region' });
  const first = countries[0];
  const threshold = await getSetting<number | null>('high_value_threshold_cents', null);
  return (
    <div className="wrap prose">
      <h1>{t('title')}</h1>
      <h2>{t('countries')}</h2>
      <dl className="grade-list">
        {countries.map((c) => (
          <div key={c.code} style={{ gridTemplateColumns: '10rem 1fr' }}>
            <dt style={{ fontSize: 'var(--t-md)', fontStretch: '100%' }}>{names.of(c.code)}</dt>
            <dd>
              {t('minimum', { amount: formatEuro(c.min_order_cents, locale) })}
              {(locale === 'de' ? c.delivery_time_de : c.delivery_time_en) && (
                <>
                  .{' '}
                  {t('deliveryTime', {
                    time: (locale === 'de' ? c.delivery_time_de : c.delivery_time_en)!,
                  })}
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p style={{ marginTop: 'var(--s-4)' }}>{t('free')}</p>
      {first && threshold !== null && (
        <p>
          {t('insured', {
            threshold: formatEuro(threshold, locale),
            rate: formatRate(first.insured_rate_bp, locale),
            minimum: formatEuro(first.insured_minimum_cents, locale),
            limit: formatEuro(first.insured_max_order_cents ?? 50000, locale),
          })}
        </p>
      )}
      <p>{t('payment')}</p>
    </div>
  );
}

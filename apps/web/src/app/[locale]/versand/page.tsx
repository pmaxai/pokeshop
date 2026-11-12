import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { formatEuro, formatRate } from '@pokeshop/core';
import type { Locale } from '@/i18n/routing';
import { db, getSetting } from '@/server/config';
import { getCompany } from '@/server/shop';
import { pageAlternates } from '@/server/seo';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Shipping' });
  const m = await getTranslations({ locale, namespace: 'Meta' });
  return {
    title: t('title'),
    description: m('shippingDescription'),
    alternates: pageAlternates('/versand', locale),
  };
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
  const { email } = await getCompany();
  // Countries on the same terms share a row, so 27 EU countries stay readable: Austria and
  // Germany on their own, the rest together with their names listed.
  type Country = (typeof countries)[number];
  const timeOf = (c: Country) => (locale === 'de' ? c.delivery_time_de : c.delivery_time_en) ?? '';
  const groups = new Map<string, Country[]>();
  for (const c of countries) {
    const key = `${c.min_order_cents}|${timeOf(c)}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const byName = (a: string, b: string) => a.localeCompare(b, locale);
  const rows = [...groups.values()].sort((a, b) => a.length - b.length);
  return (
    <div className="wrap prose">
      <h1>{t('title')}</h1>
      <h2>{t('countries')}</h2>
      <dl className="grade-list">
        {rows.map((group) => {
          const c = group[0]!;
          const list = group.map((g) => names.of(g.code) ?? g.code).sort(byName);
          const many = group.length > 3;
          return (
            <div key={c.code} style={{ gridTemplateColumns: '10rem 1fr' }}>
              <dt style={{ fontSize: 'var(--t-md)', fontStretch: '100%' }}>
                {many ? t('otherEu') : list.join(', ')}
              </dt>
              <dd>
                {t('minimum', { amount: formatEuro(c.min_order_cents, locale) })}
                {timeOf(c) && <>. {t('deliveryTime', { time: timeOf(c) })}</>}
                {many && (
                  <>
                    <br />
                    <small className="muted">{list.join(', ')}</small>
                  </>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      <p style={{ marginTop: 'var(--s-4)' }}>
        {t.rich('otherCountries', {
          email,
          mail: (chunks) => <a href={`mailto:${email}`}>{chunks}</a>,
        })}
      </p>
      <p>{t('free')}</p>
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

import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { setsForSale } from '@pokeshop/core/storefront';
import { getPathname } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { db } from '@/server/config';
import { SetList } from '@/components/SetList';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Meta' });
  return {
    title: t('setsTitle'),
    description: t('setsDescription'),
    alternates: { canonical: getPathname({ href: '/sets', locale }) },
  };
}

export default async function Sets({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Sets');
  const sets = await setsForSale(db(), locale);
  return (
    <div className="wrap prose" style={{ maxWidth: 'var(--page)' }}>
      <h1>{t('title')}</h1>
      <p className="muted">{t('lead')}</p>
      <div style={{ marginTop: 'var(--s-6)' }}>
        {sets.length ? (
          <SetList sets={sets} locale={locale} />
        ) : (
          <p className="empty">{t('empty')}</p>
        )}
      </div>
    </div>
  );
}

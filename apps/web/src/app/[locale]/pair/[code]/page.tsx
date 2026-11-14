import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: Locale; code: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Pair' });
  return { title: t('title'), robots: { index: false }, referrer: 'no-referrer' };
}

/**
 * Where a pairing QR code leads when it is scanned with the phone's normal camera instead of
 * the app: it explains what to do. The code itself is not used here.
 */
export default async function PairInfoPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Pair');
  return (
    <div className="wrap login-page">
      <div className="login-card">
        <h1>{t('title')}</h1>
        <p className="lead">{t('text')}</p>
        <ol className="pair-steps">
          <li>{t('step1')}</li>
          <li>{t('step2')}</li>
        </ol>
        <p className="muted small">{t('noApp')}</p>
        <p>
          <Link href="/app" className="btn">
            {t('toApp')}
          </Link>
        </p>
      </div>
    </div>
  );
}

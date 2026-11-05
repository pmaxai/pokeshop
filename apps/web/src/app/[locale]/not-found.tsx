import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

export default async function NotFound() {
  const t = await getTranslations('NotFound');
  return (
    <div className="wrap prose">
      <h1>{t('title')}</h1>
      <p>{t('text')}</p>
      <p style={{ marginTop: 'var(--s-5)' }}>
        <Link className="btn" href="/karten">
          {t('cta')}
        </Link>
      </p>
    </div>
  );
}

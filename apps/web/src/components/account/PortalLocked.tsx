import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

/** Shown on portal pages without a subscription that includes the portal. */
export async function PortalLocked() {
  const t = await getTranslations('Portal');
  return (
    <section className="account-panel account-panel--app" aria-labelledby="locked-title">
      <h2 id="locked-title">{t('lockedTitle')}</h2>
      <p>{t('lockedText')}</p>
      <p>
        <Link href="/konto/abo" className="btn btn--accent">
          {t('lockedLink')}
        </Link>
      </p>
    </section>
  );
}

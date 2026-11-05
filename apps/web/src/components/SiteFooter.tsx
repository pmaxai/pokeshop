import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

export async function SiteFooter({ companyName }: { companyName: string }) {
  const t = await getTranslations('Footer');
  const nav = await getTranslations('Nav');
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="site-footer__grid">
          <div>
            <h2>{t('shop')}</h2>
            <ul>
              <li>
                <Link href="/karten">{nav('cards')}</Link>
              </li>
              <li>
                <Link href="/sets">{nav('sets')}</Link>
              </li>
            </ul>
          </div>
          <div>
            <h2>{t('info')}</h2>
            <ul>
              <li>
                <Link href="/zustand">{t('conditionGuide')}</Link>
              </li>
              <li>
                <Link href="/versand">{t('shipping')}</Link>
              </li>
              <li>
                <Link href="/impressum">{t('imprint')}</Link>
              </li>
              <li>
                <Link href="/datenschutz">{t('privacy')}</Link>
              </li>
              <li>
                <Link href="/agb">{t('terms')}</Link>
              </li>
              <li>
                <Link href="/widerrufsbelehrung">{t('withdrawalInfo')}</Link>
              </li>
            </ul>
          </div>
          <div>
            <Link href="/vertrag-widerrufen" className="withdraw-link">
              {t('withdraw')}
            </Link>
          </div>
        </div>
        <p className="fine">
          {t('company', { name: companyName })}. {t('trademark')}
        </p>
      </div>
    </footer>
  );
}

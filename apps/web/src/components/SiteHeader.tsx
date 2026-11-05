import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { LanguageSwitch } from './LanguageSwitch';
import { SearchForm } from './SearchForm';

export async function SiteHeader({ active, query }: { active?: 'cards' | 'sets'; query?: string }) {
  const t = await getTranslations('Nav');
  return (
    <header className="site-header">
      <a className="skip" href="#main">
        {t('skip')}
      </a>
      <div className="wrap site-header__row">
        <Link href="/" className="logo">
          pokemonkarten<span>.at</span>
        </Link>
        <nav className="site-nav" aria-label="Shop">
          <Link href="/karten" aria-current={active === 'cards' ? 'page' : undefined}>
            {t('cards')}
          </Link>
          <Link href="/sets" aria-current={active === 'sets' ? 'page' : undefined}>
            {t('sets')}
          </Link>
        </nav>
        <SearchForm
          query={query}
          label={t('searchLabel')}
          placeholder={t('searchPlaceholder')}
          button={t('searchButton')}
        />
        <Suspense fallback={<span className="lang-switch">{t('switchLanguage')}</span>}>
          <LanguageSwitch label={t('switchLanguage')} title={t('switchLanguageLabel')} />
        </Suspense>
      </div>
    </header>
  );
}

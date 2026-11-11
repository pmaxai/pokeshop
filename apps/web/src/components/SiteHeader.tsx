import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { cartCount } from '@pokeshop/core/cart';
import { Link } from '@/i18n/navigation';
import { db } from '@/server/config';
import { currentCartId } from '@/server/cart';
import { LanguageSwitch } from './LanguageSwitch';
import { SearchForm } from './SearchForm';

export async function SiteHeader({ active, query }: { active?: 'cards' | 'sets'; query?: string }) {
  const t = await getTranslations('Nav');
  // Reading the cookie makes every page dynamic, which the shop pages are anyway.
  const cartId = await currentCartId();
  const count = cartId ? await cartCount(db(), cartId) : 0;
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
          {/* App and events are only in the footer for now. */}
          <Link href="/gutscheine">{t('vouchers')}</Link>
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
        <Link href="/warenkorb" className="cart-link" aria-label={t('cartCount', { count })}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <path
              d="M3 4h2l2.4 10.2a1.5 1.5 0 0 0 1.5 1.1h8.6a1.5 1.5 0 0 0 1.5-1.1L21 7H6.2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="9.5" cy="19.5" r="1.4" fill="currentColor" />
            <circle cx="17" cy="19.5" r="1.4" fill="currentColor" />
          </svg>
          <span className="cart-link__label">{t('cart')}</span>
          {count > 0 && <span className="cart-link__count">{count}</span>}
        </Link>
      </div>
    </header>
  );
}

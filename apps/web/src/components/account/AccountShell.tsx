import { getTranslations } from 'next-intl/server';
import type { Account } from '@pokeshop/core/accounts';
import { Link } from '@/i18n/navigation';
import type { AppPathname, Locale } from '@/i18n/routing';
import { logoutAction } from '@/app/[locale]/account-actions';

export type AccountSection =
  | 'overview'
  | 'collection'
  | 'cards'
  | 'subscription'
  | 'devices'
  | 'orders'
  | 'address'
  | 'settings';

const NAV: { key: AccountSection; href: AppPathname }[] = [
  { key: 'overview', href: '/konto' },
  { key: 'collection', href: '/konto/sammlung' },
  { key: 'cards', href: '/konto/karten' },
  { key: 'subscription', href: '/konto/abo' },
  { key: 'devices', href: '/konto/geraete' },
  { key: 'orders', href: '/konto/bestellungen' },
  { key: 'address', href: '/konto/adresse' },
  { key: 'settings', href: '/konto/einstellungen' },
];

/** Frame of every account page: who is logged in, the sections, log out. */
export async function AccountShell({
  account,
  active,
  title,
  locale,
  children,
}: {
  account: Account;
  active: AccountSection;
  title: string;
  locale: Locale;
  children: React.ReactNode;
}) {
  const t = await getTranslations('Account');
  return (
    <div className="wrap account">
      <div className="account__head">
        <p className="account__who muted">{account.email}</p>
        <h1>{title}</h1>
      </div>
      <div className="account__body">
        <nav className="account-nav" aria-label={t('nav.label')}>
          <ul>
            {NAV.map((n) => (
              <li key={n.key}>
                <Link href={n.href as never} aria-current={n.key === active ? 'page' : undefined}>
                  {t(`nav.${n.key}`)}
                </Link>
              </li>
            ))}
          </ul>
          <form action={logoutAction}>
            <input type="hidden" name="locale" value={locale} />
            <button type="submit" className="account-nav__logout">
              {t('nav.logout')}
            </button>
          </form>
        </nav>
        <div className="account__main">{children}</div>
      </div>
    </div>
  );
}
